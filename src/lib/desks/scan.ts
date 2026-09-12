/**
 * scan.ts — `scan-desk` (L300). The scan budget as a computable artifact.
 *
 * This is C0.L5's arithmetic turned into a reference model. The shape of that
 * lesson is the shape of this file, deliberately:
 *
 *   per-query bytes  =  table bytes × columns projected × (1 − pruned)
 *   daily bytes      =  per-query bytes × queries per day
 *   split            =  recurring | ad-hoc
 *   growth           =  data growth × adoption growth, SEPARATELY
 *
 * The two structural claims the model exists to enforce:
 *
 *   1. RECURRING IS COMPUTED, AD-HOC IS BOUNDED. A recurring class has fixed
 *      columns, predicates and a schedule, so its bytes are arithmetic. An
 *      ad-hoc class has a long tail and no schedule; multiplying a central
 *      estimate by a query count produces a number that is wrong in an
 *      unbounded direction. So ad-hoc classes are reported as a CEILING —
 *      a per-query quota and a daily pool cap — and the model refuses to
 *      pretend otherwise.
 *
 *   2. GROWTH IS TWO TERMS. Data growth is smaller and predictable; adoption
 *      growth is larger and vaguer, and it is the one that breaks budgets.
 *      One blended percentage hides the dangerous term, which is why
 *      `growth_modelled` fails an omission even when the point estimate is
 *      good.
 *
 * NO PRICES. This desk computes BYTES. The pricing SHAPE is a name the learner
 * must state — because a bytes-scanned figure means one thing when you pay per
 * byte scanned and almost nothing when you pay for provisioned compute — but
 * the rate itself is the caller's, and the caller multiplies.
 */

import { GB, TB, bandAround, clamp, fail, fmtBytes, inBand, pass, toGB, toTB } from './kit'
import type { Band, Check, DeskReport } from './kit'

/**
 * How the platform charges. A NAME, not a rate. The shape determines which
 * count is the one that matters: per-byte-scanned makes bytes the bill,
 * provisioned-compute makes concurrency the bill and bytes merely the reason
 * you ran out of it.
 */
export type PricingShape =
  | 'per-byte-scanned'
  | 'provisioned-compute'
  | 'per-node-hour'
  | 'credits-per-warehouse-second'

export const PRICING_SHAPES: PricingShape[] = [
  'per-byte-scanned',
  'provisioned-compute',
  'per-node-hour',
  'credits-per-warehouse-second',
]

/** Which count the bill is actually a function of, per shape. */
export const SHAPE_BILLED_COUNT: Record<PricingShape, string> = {
  'per-byte-scanned': 'bytes scanned',
  'provisioned-compute': 'concurrent slots held',
  'per-node-hour': 'nodes provisioned',
  'credits-per-warehouse-second': 'warehouse-seconds of a sized warehouse',
}

export type ClassKind = 'recurring' | 'adhoc'

export interface ScanQueryClass {
  id: string
  kind: ClassKind
  /** Total bytes of the table(s) this class reads, uncompressed on disk. */
  tableBytes: number
  /** Bytes of the columns projected ÷ bytes of all columns. 1.0 is SELECT *. */
  projectedFraction: number
  /**
   * Row groups skipped ÷ row groups the class could have read, per C2.L6. Per
   * class, never per table: a table-level average hides the class that prunes
   * nothing.
   */
  pruningRatio: number
  queriesPerDay: number
  /** Ad-hoc only: the per-query fence. A quota, not a forecast. */
  perQueryQuotaBytes?: number
  /** Ad-hoc only: the daily pool ceiling. This is the number you report. */
  dailyPoolCeilingBytes?: number
}

export interface ScanInput {
  classes: ScanQueryClass[]
  /** Table growth per year, as a fraction. ~0.4 in C0.L5's worked example. */
  dataGrowthPerYear: number
  /** Dashboards and analysts added per year, as a fraction. The larger term. */
  adoptionGrowthPerYear: number
  /** Horizon for the growth projection. Counted in months, not billed in them. */
  horizonMonths: number
}

export interface ScanClassResult {
  id: string
  kind: ClassKind
  /** True for recurring classes: the number is arithmetic. */
  computed: boolean
  /** Reference per-query bytes. For ad-hoc classes this is the quota. */
  perQueryBytes: number
  /** Reference daily bytes. For ad-hoc classes this is a CEILING. */
  dailyBytes: number
  /** The three factors, itemised so a learner can see which one they missed. */
  factors: { projectedFraction: number; readFraction: number; queriesPerDay: number }
}

export interface ScanOutput {
  perClass: ScanClassResult[]
  /** Sum over recurring classes. Computed. */
  recurringDailyBytes: number
  /** Sum over ad-hoc classes. A bound, reported as a bound. */
  adhocBoundBytes: number
  /** recurring + ad-hoc bound. The headline number. */
  dailyTotalBytes: number
  /** (1 + dataGrowth) ^ years. Kept separate on purpose. */
  dataGrowthFactor: number
  /** (1 + adoptionGrowth) ^ years. The larger, vaguer term. */
  adoptionGrowthFactor: number
  /** Recurring daily bytes at the horizon, both growth terms applied. */
  horizonRecurringDailyBytes: number
  horizonDailyTotalBytes: number
  /** The class contributing the most daily bytes — the line to defend first. */
  largestClassId: string
}

/**
 * Per-query bytes for one class. Three factors, and the whole takeaway of the
 * desk is that improving two of them by 3× each is a 9× cut while the factor
 * still sitting at 1× is the entire story.
 */
export function perQueryBytes(c: ScanQueryClass): number {
  const readFraction = clamp(1 - c.pruningRatio, 0, 1)
  return Math.max(0, c.tableBytes) * clamp(c.projectedFraction, 0, 1) * readFraction
}

export function modelScanBudget(input: ScanInput): ScanOutput {
  const { classes, dataGrowthPerYear, adoptionGrowthPerYear, horizonMonths } = input
  if (classes.length === 0) throw new Error('modelScanBudget: at least one query class is required')
  if (horizonMonths < 0) throw new Error('modelScanBudget: horizonMonths must be >= 0')

  const perClass: ScanClassResult[] = classes.map((c) => {
    if (c.queriesPerDay < 0) throw new Error(`modelScanBudget: ${c.id} has negative queriesPerDay`)
    const readFraction = clamp(1 - c.pruningRatio, 0, 1)
    const computed = c.kind === 'recurring'

    /*
     * Ad-hoc classes are NOT computed from a central estimate. Their per-query
     * figure is the quota, and their daily figure is the pool ceiling if one
     * was set, else quota × queries. A class with no fence at all falls back to
     * the computed form, which `shape_stated` and the grader's own message will
     * call out as an estimate masquerading as a bound.
     */
    const q = computed
      ? perQueryBytes(c)
      : (c.perQueryQuotaBytes ?? perQueryBytes(c))
    const daily = computed
      ? q * c.queriesPerDay
      : (c.dailyPoolCeilingBytes ?? q * c.queriesPerDay)

    return {
      id: c.id,
      kind: c.kind,
      computed,
      perQueryBytes: q,
      dailyBytes: daily,
      factors: { projectedFraction: clamp(c.projectedFraction, 0, 1), readFraction, queriesPerDay: c.queriesPerDay },
    }
  })

  const recurringDailyBytes = perClass.filter((r) => r.computed).reduce((s, r) => s + r.dailyBytes, 0)
  const adhocBoundBytes = perClass.filter((r) => !r.computed).reduce((s, r) => s + r.dailyBytes, 0)
  const dailyTotalBytes = recurringDailyBytes + adhocBoundBytes

  const years = horizonMonths / 12
  const dataGrowthFactor = Math.pow(1 + Math.max(-0.99, dataGrowthPerYear), years)
  const adoptionGrowthFactor = Math.pow(1 + Math.max(-0.99, adoptionGrowthPerYear), years)
  const horizonRecurringDailyBytes = recurringDailyBytes * dataGrowthFactor * adoptionGrowthFactor

  const largest = perClass.reduce((a, b) => (b.dailyBytes > a.dailyBytes ? b : a), perClass[0])

  return {
    perClass,
    recurringDailyBytes,
    adhocBoundBytes,
    dailyTotalBytes,
    dataGrowthFactor,
    adoptionGrowthFactor,
    horizonRecurringDailyBytes,
    /* The ad-hoc bound is a fence: it does not grow with adoption, it is the
     * thing that stops adoption growing the bill. So it is added flat. */
    horizonDailyTotalBytes: horizonRecurringDailyBytes + adhocBoundBytes,
    largestClassId: largest.id,
  }
}

/* ------------------------------- grading ------------------------------- */

export interface ScanSubmission {
  input: ScanInput
  /** Per-query bytes claimed, keyed by class id. Every class must appear. */
  claimedPerQueryBytes: Record<string, number>
  /** The headline: recurring computed plus the ad-hoc bound. */
  claimedDailyTotalBytes: number
  /** The pricing shape, by name. null = not stated. */
  statedShape: PricingShape | null
  /** Did they name data growth as its own term? */
  statedDataGrowth: boolean
  /** Did they name adoption growth as its own term, separately? */
  statedAdoptionGrowth: boolean
}

/** Generous on purpose: this is a model, not a measurement. */
export const SCAN_TOLERANCE_PCT = 15

const gb = (b: number): string => `${toGB(b).toFixed(1)} GB`

export function gradeScan(sub: ScanSubmission): DeskReport {
  const checks: Check[] = []
  const out = modelScanBudget(sub.input)

  /* ---- per_query: every class, banded, itemised on failure ---- */
  const missing = out.perClass.filter((r) => sub.claimedPerQueryBytes[r.id] === undefined).map((r) => r.id)
  const offBand = out.perClass.filter((r) => {
    const claimed = sub.claimedPerQueryBytes[r.id]
    return claimed !== undefined && !inBand(claimed, bandAround(r.perQueryBytes, SCAN_TOLERANCE_PCT))
  })

  if (missing.length > 0) {
    checks.push(
      fail(
        'per_query',
        'per-query bytes, per class',
        `no per-query figure for ${missing.join(', ')}. A budget is per query CLASS, never per table: an average over classes hides the class that prunes nothing. Reference: ${out.perClass
          .map((r) => `${r.id} ${gb(r.perQueryBytes)}`)
          .join(', ')}.`,
      ),
    )
  } else if (offBand.length > 0) {
    checks.push(
      fail(
        'per_query',
        'per-query bytes, per class',
        `${offBand
          .map((r) => {
            const band = bandAround(r.perQueryBytes, SCAN_TOLERANCE_PCT)
            return `${r.id}: claimed ${gb(sub.claimedPerQueryBytes[r.id])}, reference ${gb(r.perQueryBytes)} (band ${gb(band.lo)}–${gb(band.hi)})`
          })
          .join('; ')}. Itemise the three factors: table bytes × columns projected × (1 − pruned). For ${offBand[0].id} that is ${fmtBytes(
          sub.input.classes.find((c) => c.id === offBand[0].id)?.tableBytes ?? 0,
        )} × ${offBand[0].factors.projectedFraction.toFixed(3)} × ${offBand[0].factors.readFraction.toFixed(4)}. A factor left at 1.0 is usually the missed term.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'per_query',
        'per-query bytes, per class',
        `${out.perClass.length} classes within ±${SCAN_TOLERANCE_PCT}%; largest is ${out.largestClassId} at ${gb(
          out.perClass.find((r) => r.id === out.largestClassId)?.perQueryBytes ?? 0,
        )}/query`,
      ),
    )
  }

  /* ---- daily_total: recurring computed + ad-hoc bound, banded ---- */
  const totalBand: Band = bandAround(out.dailyTotalBytes, SCAN_TOLERANCE_PCT)
  checks.push(
    inBand(sub.claimedDailyTotalBytes, totalBand)
      ? pass(
          'daily_total',
          'daily total within band',
          `claimed ${gb(sub.claimedDailyTotalBytes)}/day against reference ${gb(out.dailyTotalBytes)}/day (recurring ${gb(
            out.recurringDailyBytes,
          )} computed + ad-hoc ${gb(out.adhocBoundBytes)} bounded)`,
        )
      : fail(
          'daily_total',
          'daily total within band',
          `claimed ${gb(sub.claimedDailyTotalBytes)}/day, reference ${gb(out.dailyTotalBytes)}/day (band ${gb(totalBand.lo)}–${gb(
            totalBand.hi,
          )}). Itemise: ${out.perClass
            .map((r) => `${r.id} ${gb(r.dailyBytes)}${r.computed ? ' computed' : ' BOUND'}`)
            .join(' + ')}. Recurring subtotal ${gb(out.recurringDailyBytes)} + ad-hoc ceiling ${gb(
            out.adhocBoundBytes,
          )}. If your number is low, the usual cause is omitting the ad-hoc ceiling entirely — an unbounded workload left out of the total is the largest line in the budget you did not write.`,
        ),
  )

  /* ---- shape_stated: DISCIPLINE. A byte count with no shape is not a budget. ---- */
  checks.push(
    sub.statedShape !== null
      ? pass(
          'shape_stated',
          'pricing shape named',
          `${sub.statedShape} — so the billed count is ${SHAPE_BILLED_COUNT[sub.statedShape]}. ${
            sub.statedShape === 'per-byte-scanned'
              ? `${toTB(out.dailyTotalBytes).toFixed(2)} TB/day is the billed quantity directly; multiply by your own rate.`
              : `bytes are the reason you run out of capacity rather than the bill itself; ${toTB(out.dailyTotalBytes).toFixed(2)} TB/day sizes the pool, and the rate is yours.`
          }`,
        )
      : fail(
          'shape_stated',
          'pricing shape named',
          `pricing shape not stated, and without it ${toTB(out.dailyTotalBytes).toFixed(
            2,
          )} TB/day is a measurement rather than a budget. The same byte count is the entire bill under per-byte-scanned and merely a capacity input under provisioned-compute, where the billed count is concurrent slots held. Name one of: ${PRICING_SHAPES.join(
            ', ',
          )}. The omission is the problem, not the estimate — your point figure can be exact and still un-actionable, because nobody can multiply it by anything.`,
        ),
  )

  /* ---- growth_modelled: DISCIPLINE. Two terms, separately. ---- */
  const bothStated = sub.statedDataGrowth && sub.statedAdoptionGrowth
  if (bothStated) {
    checks.push(
      pass(
        'growth_modelled',
        'growth as two separate terms',
        `data ${(sub.input.dataGrowthPerYear * 100).toFixed(0)}%/yr × adoption ${(
          sub.input.adoptionGrowthPerYear * 100
        ).toFixed(0)}%/yr over ${sub.input.horizonMonths} months → recurring ${gb(out.recurringDailyBytes)} → ${gb(
          out.horizonRecurringDailyBytes,
        )}/day (×${(out.dataGrowthFactor * out.adoptionGrowthFactor).toFixed(2)})`,
      ),
    )
  } else {
    const omitted: string[] = []
    if (!sub.statedDataGrowth) omitted.push('data growth')
    if (!sub.statedAdoptionGrowth) omitted.push('adoption growth')
    checks.push(
      fail(
        'growth_modelled',
        'growth as two separate terms',
        `omitted: ${omitted.join(' and ')}. ${
          !sub.statedAdoptionGrowth
            ? `Adoption growth is the LARGER and less predictable term — here ×${out.adoptionGrowthFactor.toFixed(
                2,
              )} against data growth's ×${out.dataGrowthFactor.toFixed(
                2,
              )} — and it is the one that actually breaks budgets, because more dashboards and more analysts arrive without a migration or a ticket. `
            : `Data growth is ×${out.dataGrowthFactor.toFixed(2)} over this horizon and compounds against every recurring line. `
        }Blending the two into one percentage hides the dangerous one, and omitting either makes today's ${gb(
          out.recurringDailyBytes,
        )}/day a snapshot rather than a plan: with both terms it is ${gb(
          out.horizonRecurringDailyBytes,
        )}/day at month ${sub.input.horizonMonths}. The omission fails this check even where the point estimate for today is exact.`,
      ),
    )
  }

  return { desk: 'scan-desk', version: 1, checks }
}

/** Handy for lessons and tests: C0.L5's worked example, in this model's terms. */
export const SCAN_WORKED_EXAMPLE: ScanInput = {
  classes: [
    {
      id: 'dashboards',
      kind: 'recurring',
      tableBytes: 40 * TB,
      projectedFraction: 0.09,
      pruningRatio: 0.95,
      queriesPerDay: 996,
    },
    {
      id: 'pipelines',
      kind: 'recurring',
      tableBytes: 40 * TB,
      projectedFraction: 0.02,
      pruningRatio: 0.97,
      queriesPerDay: 96,
    },
    {
      id: 'analysts',
      kind: 'adhoc',
      tableBytes: 40 * TB,
      projectedFraction: 0.25,
      pruningRatio: 0.6,
      queriesPerDay: 120,
      perQueryQuotaBytes: 200 * GB,
      dailyPoolCeilingBytes: 1.5 * TB,
    },
  ],
  dataGrowthPerYear: 0.4,
  adoptionGrowthPerYear: 0.6,
  horizonMonths: 12,
}
