/**
 * tenancy.ts — `tenancy-desk` (L400). Many uneven tenants, one catalog.
 *
 * The premise, and the reason this desk exists at all: TENANT SIZES ARE ZIPF
 * DISTRIBUTED, so the mean is a fiction. One tenant sets your capacity ceiling
 * and the smallest ones set your per-query metadata overhead. A model built on
 * the average tenant is wrong at both ends simultaneously, and it is wrong in
 * the direction that looks fine in a spreadsheet.
 *
 * So the model reports the ENDS, never the middle:
 *
 *   largest tenant  → capacity ceiling, noisy-neighbour blast radius
 *   smallest tenant → metadata amplification, because a 4 MiB tenant still
 *                     opens whole footers to answer a query
 *   skew = largest ÷ mean → the number that makes "average tenant" unsayable
 *
 * And the catalog, which is the limit people meet first: objects grow with
 * tenants × tables × partitions × files, and a table-per-tenant model
 * multiplies every one of those by the tenant count. Storage grows with data;
 * metadata grows with file count; those are different curves.
 *
 * `attribution` is a DISCIPLINE check. An unattributed shared pool means every
 * tenant's cost is the mean, and the mean is a fiction — so a submission with a
 * correct worst-tenant figure and no attribution method still fails, because
 * the figure cannot be defended to the tenant it describes.
 *
 * NO PRICES. Bytes, objects, slots and files; the caller multiplies.
 */

import { GIB, MIB, Rng, bandAround, ceilDiv, fail, fmtBytes, fmtCount, inBand, pass, pct, round2 } from './kit'
import type { Band, Check, DeskReport } from './kit'

export type TenancyModel =
  | 'table-per-tenant'
  | 'schema-per-tenant'
  | 'shared-table-partitioned'
  | 'shared-table-clustered'
  | 'account-per-tenant'

export type IsolationBoundary = 'none' | 'row-filter' | 'partition' | 'table' | 'schema' | 'account'

/**
 * The strongest boundary each model can actually enforce. A boundary claimed
 * above this line is a boundary that does not exist: you cannot enforce a
 * partition boundary on a table whose tenant column is merely a sort key, and a
 * row filter on a shared table is a query-planner promise rather than a
 * storage-level one.
 */
export const MODEL_MAX_BOUNDARY: Record<TenancyModel, IsolationBoundary> = {
  'table-per-tenant': 'table',
  'schema-per-tenant': 'schema',
  'shared-table-partitioned': 'partition',
  'shared-table-clustered': 'row-filter',
  'account-per-tenant': 'account',
}

const BOUNDARY_STRENGTH: Record<IsolationBoundary, number> = {
  none: 0,
  'row-filter': 1,
  partition: 2,
  table: 3,
  schema: 4,
  account: 5,
}

export type AttributionMethod =
  | 'per-tenant-query-tags'
  | 'per-tenant-compute-pool'
  | 'bytes-scanned-per-tenant-from-query-log'
  | 'storage-bytes-by-partition'
  | 'account-level-billing'

export interface TenancyInput {
  model: TenancyModel
  tenants: number
  /** Total bytes across all tenants. Distributed Zipf, not evenly. */
  totalBytes: number
  /** Zipf exponent. ~1.1 is typical of real tenant populations. */
  zipfExponent: number
  /** Seed for the shared xorshift, so every learner sees the same tenants. */
  seed: number
  tablesPerTenant: number
  /** Partitions per table, per tenant. */
  partitionsPerTenantTable: number
  filesPerPartition: number
  /** Footer bytes a reader must open per file to plan. */
  footerBytes: number
  /** Catalog object ceiling. A COUNT, caller-supplied — every catalog has one. */
  catalogObjectCeiling: number
  /** Shared compute pool capacity, counted in concurrent slots. */
  poolSlots: number
  /** Per-tenant concurrency cap, in slots. null = uncapped. */
  perTenantSlotCap: number | null
}

export interface TenancyOutput {
  /** Tenant byte counts, descending. The distribution, not its mean. */
  tenantBytes: number[]
  largestTenantBytes: number
  smallestTenantBytes: number
  medianTenantBytes: number
  meanTenantBytes: number
  /** largest ÷ mean. The number that makes "the average tenant" unsayable. */
  skewRatio: number
  /** Share of all bytes held by the top 1% of tenants. */
  topPercentShare: number
  tables: number
  partitions: number
  files: number
  /** tables + partitions + files. What the catalog must track. */
  catalogObjects: number
  catalogHeadroom: number
  catalogFits: boolean
  /** Footers opened to answer one query for the SMALLEST tenant. */
  metadataBytesPerSmallTenantQuery: number
  /**
   * Metadata bytes ÷ data bytes for the smallest tenant. Above 1.0 the tenant
   * costs more to plan than to read, which is where the long tail bites.
   */
  smallTenantMetadataAmplification: number
  /** Slots the largest tenant can occupy if uncapped. */
  worstTenantSlotsUncapped: number
  /** Slots left for everyone else while the largest tenant runs. */
  slotsLeftForOthers: number
  noisyNeighbourBounded: boolean
}

/**
 * Zipf tenant sizes from the shared xorshift, normalised to the total. Sorted
 * descending because every number this desk reports comes from an end of the
 * distribution rather than its middle.
 */
export function drawTenantBytes(tenants: number, totalBytes: number, zipfExponent: number, seed: number): number[] {
  if (tenants < 1) throw new Error('drawTenantBytes: tenants must be >= 1')
  if (totalBytes <= 0) throw new Error('drawTenantBytes: totalBytes must be positive')
  const rng = new Rng(seed)
  const weights: number[] = []
  for (let i = 0; i < tenants; i++) weights.push(rng.zipfSize(Math.max(2, tenants * 100), zipfExponent))
  const sum = weights.reduce((a, b) => a + b, 0)
  return weights
    .map((w) => (w / sum) * totalBytes)
    .sort((a, b) => b - a)
}

export function modelTenancy(input: TenancyInput): TenancyOutput {
  const {
    model,
    tenants,
    totalBytes,
    zipfExponent,
    seed,
    tablesPerTenant,
    partitionsPerTenantTable,
    filesPerPartition,
    footerBytes,
    catalogObjectCeiling,
    poolSlots,
    perTenantSlotCap,
  } = input

  if (tablesPerTenant < 1 || partitionsPerTenantTable < 1 || filesPerPartition < 1) {
    throw new Error('modelTenancy: tables, partitions and files per unit must be >= 1')
  }
  if (poolSlots < 1) throw new Error('modelTenancy: poolSlots must be >= 1')

  const tenantBytes = drawTenantBytes(tenants, totalBytes, zipfExponent, seed)
  const largestTenantBytes = tenantBytes[0]
  const smallestTenantBytes = tenantBytes[tenantBytes.length - 1]
  const medianTenantBytes = tenantBytes[Math.floor(tenantBytes.length / 2)]
  const meanTenantBytes = totalBytes / tenants

  const topCount = Math.max(1, Math.round(tenants * 0.01))
  const topPercentShare = tenantBytes.slice(0, topCount).reduce((a, b) => a + b, 0) / totalBytes

  /*
   * Catalog objects. A shared table keeps ONE logical table and gives each
   * tenant partitions inside it; a table-per-tenant model multiplies the table
   * count too. The files term dominates either way, which is the point: storage
   * grows with data and metadata grows with file count.
   */
  const sharedTable = model === 'shared-table-partitioned' || model === 'shared-table-clustered'
  const tables = sharedTable ? tablesPerTenant : tenants * tablesPerTenant
  const partitions = sharedTable
    ? tables * partitionsPerTenantTable * tenants
    : tables * partitionsPerTenantTable
  const files = partitions * filesPerPartition
  const catalogObjects = tables + partitions + files

  /*
   * The small-tenant end. A tiny tenant's query still opens whole footers, and
   * in a clustered shared table it cannot even restrict itself to its own
   * partitions — its tenant column is a sort key, not a boundary, so the
   * planner opens footers across the shared partition set.
   */
  const filesPerTenantQuery =
    model === 'shared-table-clustered'
      ? Math.max(1, ceilDiv(files, tenants) * 2)
      : Math.max(1, ceilDiv(files, tenants))
  const metadataBytesPerSmallTenantQuery = filesPerTenantQuery * footerBytes
  const smallTenantMetadataAmplification =
    smallestTenantBytes > 0 ? metadataBytesPerSmallTenantQuery / smallestTenantBytes : 0

  /* The large-tenant end. Uncapped, one tenant's share of the bytes is its
   * share of the pool, and a Zipf head means that share is most of it. */
  const largestShare = largestTenantBytes / totalBytes
  const worstTenantSlotsUncapped = Math.min(poolSlots, Math.max(1, Math.round(poolSlots * largestShare)))
  const effectiveWorstSlots = perTenantSlotCap === null ? worstTenantSlotsUncapped : Math.min(perTenantSlotCap, poolSlots)
  const slotsLeftForOthers = Math.max(0, poolSlots - effectiveWorstSlots)

  return {
    tenantBytes,
    largestTenantBytes,
    smallestTenantBytes,
    medianTenantBytes,
    meanTenantBytes,
    skewRatio: largestTenantBytes / meanTenantBytes,
    topPercentShare,
    tables,
    partitions,
    files,
    catalogObjects,
    catalogHeadroom: catalogObjectCeiling - catalogObjects,
    catalogFits: catalogObjects <= catalogObjectCeiling,
    metadataBytesPerSmallTenantQuery,
    smallTenantMetadataAmplification,
    worstTenantSlotsUncapped,
    slotsLeftForOthers,
    /* Bounded means a cap exists AND it leaves the pool usable by others. */
    noisyNeighbourBounded: perTenantSlotCap !== null && slotsLeftForOthers > 0,
  }
}

/* ------------------------------- grading ------------------------------- */

export interface TenancySubmission {
  input: TenancyInput
  /** The boundary the design claims to enforce. */
  statedBoundary: IsolationBoundary
  /** How per-tenant cost is attributed. null = not stated, which fails. */
  attributionMethod: AttributionMethod | null
  /** Bytes for the largest tenant. Not the mean, and not the median. */
  claimedWorstTenantBytes: number
  /** Catalog objects the design will create. */
  claimedCatalogObjects: number
}

export const TENANT_TOLERANCE_PCT = 20
export const CATALOG_TOLERANCE_PCT = 15

/** Attribution methods that can actually separate tenants under each model. */
export function attributionWorks(model: TenancyModel, method: AttributionMethod): boolean {
  switch (method) {
    case 'account-level-billing':
      return model === 'account-per-tenant'
    case 'storage-bytes-by-partition':
      return model !== 'shared-table-clustered'
    case 'per-tenant-compute-pool':
    case 'per-tenant-query-tags':
    case 'bytes-scanned-per-tenant-from-query-log':
      return true
  }
}

export function gradeTenancy(sub: TenancySubmission): DeskReport {
  const checks: Check[] = []
  const out = modelTenancy(sub.input)
  const i = sub.input
  const maxBoundary = MODEL_MAX_BOUNDARY[i.model]

  /* ---- isolation: the claimed boundary must exist in the chosen model ---- */
  if (sub.statedBoundary === 'none') {
    checks.push(
      fail(
        'isolation',
        'boundary exists in the chosen model',
        `no isolation boundary stated. With ${fmtCount(i.tenants)} tenants sharing one ${
          i.model
        } design, "no boundary" means a planner bug is a data breach rather than a wrong number, and the largest tenant holds ${pct(
          out.largestTenantBytes / i.totalBytes,
        )} of the bytes. The strongest boundary this model can enforce is ${maxBoundary}.`,
      ),
    )
  } else if (BOUNDARY_STRENGTH[sub.statedBoundary] > BOUNDARY_STRENGTH[maxBoundary]) {
    checks.push(
      fail(
        'isolation',
        'boundary exists in the chosen model',
        `claimed a ${sub.statedBoundary} boundary, but ${i.model} can enforce at most ${maxBoundary}. ${
          i.model === 'shared-table-clustered'
            ? 'In a clustered shared table the tenant column is a SORT KEY, not a boundary: it changes which blocks are read, never which blocks may be read, so the only enforcement point left is a row filter applied by the planner.'
            : 'A boundary claimed above what the storage layout can enforce is enforced by convention, and convention is not an access control.'
        } Either change the model or downgrade the claim — a boundary that does not exist is worse than a weak one, because it stops anyone looking for the compensating control.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'isolation',
        'boundary exists in the chosen model',
        `${sub.statedBoundary} boundary under ${i.model} (ceiling for this model is ${maxBoundary})`,
      ),
    )
  }

  /* ---- attribution: DISCIPLINE. The mean is a fiction; unattributed cost is the mean. ---- */
  if (sub.attributionMethod === null) {
    checks.push(
      fail(
        'attribution',
        'per-tenant cost attributable',
        `no attribution method stated. Without one, every tenant's cost is the mean — ${fmtBytes(
          out.meanTenantBytes,
        )} — and the mean is a fiction here: the largest tenant holds ${fmtBytes(
          out.largestTenantBytes,
        )}, which is ${round2(out.skewRatio)}× the mean, while the median tenant holds ${fmtBytes(
          out.medianTenantBytes,
        )} and the smallest ${fmtBytes(
          out.smallestTenantBytes,
        )}. The omission is the problem and not the estimate: your worst-tenant figure can be exact and still undefendable, because you cannot show a tenant the bytes that were theirs. This is also how a noisy neighbour becomes invisible — an unattributed pool reports one aggregate that never names the tenant consuming it.`,
      ),
    )
  } else if (!attributionWorks(i.model, sub.attributionMethod)) {
    checks.push(
      fail(
        'attribution',
        'per-tenant cost attributable',
        `${sub.attributionMethod} does not separate tenants under ${i.model}. ${
          sub.attributionMethod === 'storage-bytes-by-partition'
            ? 'There is no per-tenant partition to sum: the tenant column is a sort key, so tenant bytes are interleaved inside shared files and the smallest unit you can attribute is a file that holds many tenants.'
            : 'Account-level billing only attributes when each tenant has its own account; here they share one.'
        } Reference skew is ${round2(out.skewRatio)}× (largest ${fmtBytes(out.largestTenantBytes)} against mean ${fmtBytes(
          out.meanTenantBytes,
        )}), so an attribution method that collapses to the mean loses the entire signal.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'attribution',
        'per-tenant cost attributable',
        `${sub.attributionMethod} works under ${i.model}; skew ${round2(out.skewRatio)}× means attribution is the difference between a bill and a guess`,
      ),
    )
  }

  /* ---- worst_tenant: banded, on the LARGEST tenant ---- */
  const worstBand: Band = bandAround(out.largestTenantBytes, TENANT_TOLERANCE_PCT)
  const quotedMean = inBand(sub.claimedWorstTenantBytes, bandAround(out.meanTenantBytes, 15))
  const quotedMedian = inBand(sub.claimedWorstTenantBytes, bandAround(out.medianTenantBytes, 15))
  checks.push(
    inBand(sub.claimedWorstTenantBytes, worstBand)
      ? pass(
          'worst_tenant',
          'capacity set by the largest tenant',
          `claimed ${fmtBytes(sub.claimedWorstTenantBytes)} against reference ${fmtBytes(
            out.largestTenantBytes,
          )} — ${round2(out.skewRatio)}× the mean, and the top 1% of tenants hold ${pct(out.topPercentShare)} of all bytes`,
        )
      : fail(
          'worst_tenant',
          'capacity set by the largest tenant',
          `claimed ${fmtBytes(sub.claimedWorstTenantBytes)}, reference ${fmtBytes(out.largestTenantBytes)} (band ${fmtBytes(
            worstBand.lo,
          )}–${fmtBytes(worstBand.hi)}).${
            quotedMean
              ? ` Your figure is the MEAN (${fmtBytes(
                  out.meanTenantBytes,
                )}), and a Zipf population has no typical member: capacity is set by the head, so a mean-sized plan is short by ${round2(
                  out.skewRatio,
                )}×.`
              : quotedMedian
                ? ` Your figure is the MEDIAN (${fmtBytes(
                    out.medianTenantBytes,
                  )}), which describes the tenant you will never have trouble with.`
                : ''
          } Itemise both ends: largest ${fmtBytes(out.largestTenantBytes)} sets the capacity ceiling; smallest ${fmtBytes(
            out.smallestTenantBytes,
          )} sets metadata overhead at ${round2(
            out.smallTenantMetadataAmplification,
          )}× its own data (${fmtBytes(out.metadataBytesPerSmallTenantQuery)} of footers per query). Model both ends, never the average.`,
        ),
  )

  /* ---- catalog_ceiling: banded on the claim, absolute on the ceiling ---- */
  const catalogBand: Band = bandAround(out.catalogObjects, CATALOG_TOLERANCE_PCT)
  if (!out.catalogFits) {
    checks.push(
      fail(
        'catalog_ceiling',
        'catalog objects under the ceiling',
        `the design needs ${fmtCount(out.catalogObjects)} catalog objects against a ceiling of ${fmtCount(
          i.catalogObjectCeiling,
        )} — over by ${fmtCount(-out.catalogHeadroom)}. Itemise: ${fmtCount(out.tables)} tables + ${fmtCount(
          out.partitions,
        )} partitions + ${fmtCount(out.files)} files, from ${fmtCount(i.tenants)} tenants × ${
          i.tablesPerTenant
        } tables × ${i.partitionsPerTenantTable} partitions × ${
          i.filesPerPartition
        } files. Storage grows with data and metadata grows with FILE COUNT, so the catalog is usually the first limit rather than the disk — and it is reached without any tenant growing at all, simply by adding tenants or halving a commit interval.`,
      ),
    )
  } else if (!inBand(sub.claimedCatalogObjects, catalogBand)) {
    checks.push(
      fail(
        'catalog_ceiling',
        'catalog objects under the ceiling',
        `claimed ${fmtCount(sub.claimedCatalogObjects)} catalog objects, reference ${fmtCount(
          out.catalogObjects,
        )} (band ${fmtCount(catalogBand.lo)}–${fmtCount(catalogBand.hi)}). Itemise: ${fmtCount(
          out.tables,
        )} tables + ${fmtCount(out.partitions)} partitions + ${fmtCount(
          out.files,
        )} files. The term most often dropped is files: it is the product of every other term, and it is what the planner actually enumerates.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'catalog_ceiling',
        'catalog objects under the ceiling',
        `${fmtCount(out.catalogObjects)} objects (${fmtCount(out.tables)} tables + ${fmtCount(
          out.partitions,
        )} partitions + ${fmtCount(out.files)} files) with ${fmtCount(out.catalogHeadroom)} of headroom under ${fmtCount(
          i.catalogObjectCeiling,
        )}`,
      ),
    )
  }

  /* ---- noisy_neighbour: a cap, and a pool still usable by everyone else ---- */
  checks.push(
    out.noisyNeighbourBounded
      ? pass(
          'noisy_neighbour',
          'largest tenant cannot take the pool',
          `capped at ${fmtCount(i.perTenantSlotCap ?? 0)} of ${fmtCount(i.poolSlots)} slots, leaving ${fmtCount(
            out.slotsLeftForOthers,
          )} for everyone else; uncapped this tenant's byte share (${pct(
            out.largestTenantBytes / i.totalBytes,
          )}) would claim ${fmtCount(out.worstTenantSlotsUncapped)} slots`,
        )
      : fail(
          'noisy_neighbour',
          'largest tenant cannot take the pool',
          i.perTenantSlotCap === null
            ? `no per-tenant concurrency cap. The largest tenant holds ${pct(
                out.largestTenantBytes / i.totalBytes,
              )} of the bytes, so on demand it claims about ${fmtCount(out.worstTenantSlotsUncapped)} of ${fmtCount(
                i.poolSlots,
              )} pool slots and every other tenant queues behind one customer's backfill. A cap is a COUNT of slots, and it is the only control that turns a shared pool from a shared fate into a shared resource.`
            : `the cap of ${fmtCount(i.perTenantSlotCap)} slots is not smaller than the pool of ${fmtCount(
                i.poolSlots,
              )}, so it leaves ${fmtCount(
                out.slotsLeftForOthers,
              )} slots for the other ${fmtCount(
                i.tenants - 1,
              )} tenants. A cap equal to the pool is not a cap; size it so the head tenant's worst hour still leaves the tail able to plan.`,
        ),
  )

  return { desk: 'tenancy-desk', version: 1, checks }
}

/** A realistic tenant population: heavy head, very long tail. */
export const TENANCY_WORKED_EXAMPLE: TenancyInput = {
  model: 'shared-table-partitioned',
  tenants: 400,
  totalBytes: 180 * 1024 * GIB,
  zipfExponent: 1.1,
  seed: 20_260_912,
  tablesPerTenant: 3,
  partitionsPerTenantTable: 90,
  filesPerPartition: 6,
  footerBytes: 24 * 1024,
  catalogObjectCeiling: 1_000_000,
  poolSlots: 64,
  perTenantSlotCap: 16,
}

/** The smallest tenant's footprint, for lessons that want the tail's number. */
export const SMALL_TENANT_REFERENCE_BYTES = 4 * MIB
