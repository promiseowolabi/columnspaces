/**
 * mix.ts — the query MIX the layout-designer browser lab designs against.
 *
 * The Warehouse (`src/lib/warehouse/*`) already models a columnar engine: it
 * prices one trace against one layout and reports counts. This file does not
 * re-model any of that. It adds the one thing the C2 lesson needs and the
 * Warehouse deliberately does not have: a *mix* of query classes priced
 * side by side against the SAME physical layout, so the reader can see the
 * constraint that a table has exactly one physical order.
 *
 * Five classes, chosen so that no single layout can serve them all:
 *
 *   dashboard      recent time window + one tenant   → wants day partitions
 *   tenant-audit   one tenant, all of history        → wants tenant partitions
 *   region-rollup  one region, a wide time window    → wants region partitions
 *   needle         one user id, anywhere             → wants user_id sort order
 *   adhoc          wide projection, weak predicate   → wants a quota
 *
 * The first four each have a layout that makes them cheap, and those layouts
 * are mutually exclusive: one partition key, one sort key. The fifth has no
 * layout at all — which is the architectural point of C0.L5, and the reason
 * `quotaClassId()` exists below as a computed fact rather than an opinion.
 *
 * STARVATION is measured as a RATIO, not as absolute bytes:
 *
 *     starvation = bytes this class scans here ÷ the fewest bytes this class
 *                  could scan under ANY design in the grid
 *
 * Absolute bytes would make the answer a constant — `adhoc` projects a 96-byte
 * payload column, so it scans the most bytes under every layout, and "which
 * class does your design starve" would have one answer forever. The ratio asks
 * the question that actually teaches: relative to the best you could have done
 * FOR THIS CLASS, how badly does this design treat it? That number moves when
 * the design moves, which is what makes the tradeoff visible.
 *
 * Everything here is a COUNT (bytes, row groups, files) and everything is
 * deterministic: the queries come from the seeded xorshift in `desks/kit`, the
 * traces are built once at module load, and every cost is memoised by design
 * key. No wall-clock, no Math.random, no dates.
 */

import { Rng, clamp } from '@/lib/desks/kit'
import { REFERENCE_LAYOUT, cloneLayout, runTrace, type Layout } from '@/lib/warehouse/engine'
import { column, partitionKey, type ColumnId, type PartitionKeyId } from '@/lib/warehouse/table'
import type { Predicate, Query, Trace, TraceModeId } from '@/lib/warehouse/trace'

/* ------------------------------- the knobs ------------------------------ */

/**
 * The three decisions the reader gets. Clustering is NOT one of them: it is
 * pinned at the reference layout's 0.9 so that every difference on screen is
 * attributable to a choice the reader made. Clustering is the subject of forge
 * lab 02 and of the C2 zone-map work, where it is the knob rather than a
 * constant, and mixing the two would let a reader "fix" a starved class by
 * turning a dial that in production is set by an upstream writer they do not
 * control.
 */
export interface Design {
  partitionKey: PartitionKeyId
  sortKey: ColumnId | 'none'
  rowGroupRows: number
}

export const PARTITION_CHOICES: PartitionKeyId[] = ['day', 'tenant', 'region', 'none']

/**
 * Sort keys worth offering: the columns some class in the mix actually filters
 * on, plus `none`. Offering `payload` would be offering a choice with no
 * mechanism behind it — the model would price it, and the reader would learn
 * nothing from the number.
 */
export const SORT_KEY_CHOICES: (ColumnId | 'none')[] = [
  'ts',
  'tenant_id',
  'region',
  'event_type',
  'user_id',
  'none',
]

/** Rows per row group: two orders of magnitude, because both ends are traps. */
export const ROW_GROUP_CHOICES: number[] = [8_192, 32_768, 131_072, 524_288, 2_097_152]

/**
 * Files are eight row groups, always. Tying file size to row-group size is what
 * makes the row-group knob honest: shrinking a row group buys finer pruning AND
 * multiplies the footers every query must open to prune at all. Decoupling them
 * would hand the reader a free win and hide the metadata tax that C3 is about.
 */
export const GROUPS_PER_FILE = 8

export const fileRowsFor = (rowGroupRows: number): number => rowGroupRows * GROUPS_PER_FILE

/**
 * Where the lab opens: a competent, conventional design for the dashboard —
 * day partitions, tenant sort key, 128Ki-row groups. It is the layout the
 * Warehouse ships as its reference, and it already starves something.
 */
export const OPENING_DESIGN: Design = {
  partitionKey: 'day',
  sortKey: 'tenant_id',
  rowGroupRows: 131_072,
}

/** The reader's three choices, expanded into a full engine layout. */
export function toLayout(d: Design): Layout {
  const l = cloneLayout(REFERENCE_LAYOUT)
  l.partitionKey = d.partitionKey
  l.sortKey = d.sortKey
  l.rowGroupRows = d.rowGroupRows
  l.fileRows = fileRowsFor(d.rowGroupRows)
  return l
}

export const designKey = (d: Design): string => `${d.partitionKey}|${d.sortKey}|${d.rowGroupRows}`

/** Every design the reader can express: 4 × 6 × 5 = 120. */
export const DESIGN_GRID: Design[] = PARTITION_CHOICES.flatMap((partitionKey) =>
  SORT_KEY_CHOICES.flatMap((sortKey) =>
    ROW_GROUP_CHOICES.map((rowGroupRows) => ({ partitionKey, sortKey, rowGroupRows })),
  ),
)

/* ------------------------------ the classes ----------------------------- */

export type QueryClassId = 'dashboard' | 'tenant-audit' | 'region-rollup' | 'needle' | 'adhoc'

export interface QueryClassSpec {
  id: QueryClassId
  name: string
  /** What the class is, in one clause. */
  line: string
  /** The layout decision this class is asking for. Shown next to its bill. */
  wants: string
  /** Runs per day — the multiplier that turns a per-query bill into a budget. */
  runsPerDay: number
  /** The nearest Warehouse trace mode, so the report carries an honest label. */
  mode: TraceModeId
  /** Queries generated for this class. Six is enough to average the placements. */
  count: number
  build: (rng: Rng, id: number) => Query
}

const DAYS = partitionKey('day').count
const TENANTS = column('tenant_id').cardinality
const REGIONS = column('region').cardinality
const USERS = column('user_id').cardinality

/** A window of `width` (as a fraction of the domain) placed inside [floor, ceiling). */
function window_(rng: Rng, col: ColumnId, width: number, floor = 0, ceiling = 1): Predicate {
  const w = clamp(Math.min(width, ceiling - floor), 1e-9, 1)
  const lo = rng.uniform(floor, Math.max(floor, ceiling - w))
  return { column: col, lo, hi: Math.min(1, lo + w) }
}

/** `span` consecutive buckets of a discrete domain — one day, one tenant, one region. */
function slice(rng: Rng, col: ColumnId, buckets: number, span = 1): Predicate {
  const k = rng.below(Math.max(1, buckets - span))
  return { column: col, lo: k / buckets, hi: (k + span) / buckets }
}

const scan = (
  id: number,
  label: string,
  columns: ColumnId[],
  predicates: Predicate[],
): Query => ({ id, kind: 'scan', label, columns, predicates, shuffle: null, rowsWritten: 0 })

/* dashboard — four tiles, refreshed all day. Narrow and repetitive. */
const DASHBOARD_TILES: { label: string; columns: ColumnId[] }[] = [
  { label: 'tile · revenue by hour', columns: ['ts', 'tenant_id', 'amount'] },
  { label: 'tile · event mix', columns: ['ts', 'tenant_id', 'event_type'] },
  { label: 'tile · regional split', columns: ['ts', 'tenant_id', 'region', 'amount'] },
  { label: 'tile · device breakdown', columns: ['ts', 'tenant_id', 'device'] },
]

/* adhoc — the analyst's projections. Wide, and payload lands in a third of them. */
const ADHOC_SHAPES: { label: string; columns: ColumnId[]; on: ColumnId; width: number }[] = [
  { label: 'exploration · funnel by device', columns: ['ts', 'tenant_id', 'device', 'event_type', 'amount'], on: 'device', width: 0.45 },
  { label: 'exploration · raw bodies', columns: ['ts', 'tenant_id', 'event_type', 'payload'], on: 'event_type', width: 0.6 },
  { label: 'exploration · value distribution', columns: ['ts', 'tenant_id', 'user_id', 'amount', 'region'], on: 'amount', width: 0.8 },
  { label: 'exploration · everything, briefly', columns: ['ts', 'tenant_id', 'region', 'event_type', 'user_id', 'device', 'amount'], on: 'ts', width: 0.5 },
  { label: 'exploration · body text search', columns: ['ts', 'tenant_id', 'user_id', 'payload'], on: 'user_id', width: 0.7 },
  { label: 'exploration · no predicate at all', columns: ['ts', 'tenant_id', 'region', 'event_type', 'amount'], on: 'ts', width: 1 },
]

export const QUERY_CLASSES: QueryClassSpec[] = [
  {
    id: 'dashboard',
    name: 'the dashboard',
    line: 'Four tiles over the last two days for one tenant, refreshed every quarter hour.',
    wants: 'day partitions, and a sort key the tile predicate names',
    runsPerDay: 64,
    mode: 'dashboard',
    count: 6,
    build: (rng, id) => {
      const tile = DASHBOARD_TILES[(id - 1) % DASHBOARD_TILES.length]
      return scan(id, tile.label, tile.columns, [
        /* Two days out of ninety, always in the newest quarter of the table. */
        window_(rng, 'ts', 2 / DAYS, 0.75, 1),
        slice(rng, 'tenant_id', TENANTS),
      ])
    },
  },
  {
    id: 'tenant-audit',
    name: 'the tenant audit',
    line: 'One customer account, all of history, no time filter. Billing disputes and support escalations.',
    wants: 'tenant partitions — a time partition prunes nothing here',
    runsPerDay: 12,
    mode: 'dashboard',
    count: 6,
    build: (rng, id) => {
      const columns: ColumnId[] =
        id % 2 === 0
          ? ['ts', 'tenant_id', 'event_type', 'amount']
          : ['ts', 'tenant_id', 'region', 'event_type', 'amount']
      return scan(id, 'audit · one tenant, full history', columns, [slice(rng, 'tenant_id', TENANTS)])
    },
  },
  {
    id: 'region-rollup',
    name: 'the regional rollup',
    line: 'One deployment region over a month. The report a regional GM opens on a Monday.',
    wants: 'region partitions, or region as the sort key',
    runsPerDay: 8,
    mode: 'dashboard',
    count: 6,
    build: (rng, id) =>
      scan(
        id,
        id % 3 === 0 ? 'rollup · region × device' : 'rollup · region monthly totals',
        id % 3 === 0
          ? ['ts', 'region', 'device', 'amount']
          : ['ts', 'region', 'event_type', 'amount'],
        [slice(rng, 'region', REGIONS), window_(rng, 'ts', 30 / DAYS)],
      ),
  },
  {
    id: 'needle',
    name: 'the needle',
    line: 'One end user, anywhere in the table: a support ticket, a GDPR request, an abuse report.',
    wants: 'user_id sort order — no partition key in the menu touches it',
    runsPerDay: 40,
    mode: 'adhoc',
    count: 6,
    build: (rng, id) =>
      scan(
        id,
        id % 2 === 0 ? 'needle · one user, full trail' : 'needle · one user, raw bodies',
        id % 2 === 0
          ? ['ts', 'tenant_id', 'user_id', 'event_type', 'device']
          : ['ts', 'tenant_id', 'user_id', 'payload'],
        /* Four user ids out of four million. As selective as a predicate gets —
         * and worth nothing unless the physical order knows about user_id. */
        [slice(rng, 'user_id', USERS, 4)],
      ),
  },
  {
    id: 'adhoc',
    name: 'the analyst',
    line: 'Wide projections and weak predicates, written by somebody who does not yet know which column matters.',
    wants: 'nothing a layout can give it. This class needs a quota.',
    runsPerDay: 120,
    mode: 'adhoc',
    count: 6,
    build: (rng, id) => {
      const shape = ADHOC_SHAPES[(id - 1) % ADHOC_SHAPES.length]
      /* Width 1 means "no predicate at all" — the query that no statistic can
       * help, and the reason this class is fenced rather than optimised. */
      const predicates = shape.width >= 1 ? [] : [window_(rng, shape.on, shape.width)]
      return scan(id, shape.label, shape.columns, predicates)
    },
  },
]

export const CLASS_IDS: QueryClassId[] = QUERY_CLASSES.map((c) => c.id)

const CLASS_BY_ID: Record<QueryClassId, QueryClassSpec> = QUERY_CLASSES.reduce(
  (acc, c) => {
    acc[c.id] = c
    return acc
  },
  {} as Record<QueryClassId, QueryClassSpec>,
)

export const queryClass = (id: QueryClassId): QueryClassSpec => CLASS_BY_ID[id]

/**
 * The mix's seed. One constant, exported, for the same reason the Warehouse
 * exports its own: a lesson that quotes a byte count from this lab is quoting
 * THIS seed's queries, so changing it should be a visible line in a diff.
 */
export const MIX_SEED = 0xc2_1a_40_07

/* --------------------------------- traces ------------------------------- */

/**
 * Built once, at module load, and never rebuilt: the trace is the experiment's
 * control. Every design the reader tries is priced against byte-identical
 * queries, so any difference on screen is caused by the layout and nothing
 * else. Rebuilding per render would still be deterministic, but it would be
 * work repeated on every keystroke for no gain.
 */
const TRACES: Record<QueryClassId, Trace> = QUERY_CLASSES.reduce(
  (acc, c, i) => {
    /* Each class gets its own stream rather than a shared one, so adding a
     * class cannot shift the queries of the classes after it. */
    const rng = new Rng(BigInt(MIX_SEED) ^ (BigInt(i + 1) << 24n))
    const queries: Query[] = []
    for (let id = 1; id <= c.count; id++) queries.push(c.build(rng, id))
    acc[c.id] = { mode: c.mode, seed: MIX_SEED, name: c.name, line: c.line, queries }
    return acc
  },
  {} as Record<QueryClassId, Trace>,
)

export const traceFor = (id: QueryClassId): Trace => TRACES[id]

/* ---------------------------------- cost -------------------------------- */

export interface ClassCost {
  id: QueryClassId
  name: string
  /** Bytes read by one pass of the class's queries. */
  bytesScanned: number
  /** Bytes per day: one pass × the class's runs per day ÷ queries in the pass. */
  bytesPerDay: number
  rowGroupsRead: number
  rowGroupsPruned: number
  /** Row groups skipped ÷ row groups the class could have read. */
  pruningRatio: number
  filesTouched: number
  /** Footer bytes inside `bytesScanned` — the tax the row-group knob levies. */
  metadataBytes: number
  /** The fewest bytes this class can scan under ANY design in the grid. */
  bestBytes: number
  /** bytesScanned ÷ bestBytes. 1.0 = this design is the best one for this class. */
  starvation: number
}

export interface MixReport {
  design: Design
  classes: ClassCost[]
  /** The class this design treats worst, by starvation ratio. Always defined. */
  worst: ClassCost
  /** The second-worst, so the UI (and the tests) can show the gap is real. */
  runnerUp: ClassCost
  /** The class this design serves best — there is always one of those too. */
  best: ClassCost
  totalBytes: number
  totalBytesPerDay: number
}

const COST_CACHE = new Map<string, ClassCost[]>()

/** Bytes + counts for one class under one design. Memoised on the design key. */
function rawCosts(d: Design): Omit<ClassCost, 'bestBytes' | 'starvation'>[] {
  const layout = toLayout(d)
  return QUERY_CLASSES.map((c) => {
    const r = runTrace(traceFor(c.id), layout)
    const passes = c.runsPerDay / c.count
    return {
      id: c.id,
      name: c.name,
      bytesScanned: r.metrics.bytesScanned,
      bytesPerDay: r.metrics.bytesScanned * passes,
      rowGroupsRead: r.metrics.rowGroupsRead,
      rowGroupsPruned: r.metrics.rowGroupsPruned,
      pruningRatio: r.metrics.pruningRatio,
      filesTouched: r.metrics.filesTouched,
      metadataBytes: r.detail.metadataBytes,
    }
  })
}

let BEST: Record<QueryClassId, number> | null = null

/**
 * The best bytes each class can achieve anywhere in the grid.
 *
 * Computed once by sweeping all 120 designs — 600 model runs, all arithmetic,
 * no allocation of data. It is the denominator of every starvation ratio, so it
 * has to be a property of the whole design space rather than of whatever the
 * reader happened to try first: "you are 6× off the best possible for this
 * class" is a claim about the space, and the reader can go and check it.
 */
function bestBytes(): Record<QueryClassId, number> {
  if (BEST) return BEST
  const out = {} as Record<QueryClassId, number>
  for (const id of CLASS_IDS) out[id] = Number.POSITIVE_INFINITY
  for (const d of DESIGN_GRID) {
    for (const c of rawCosts(d)) {
      if (c.bytesScanned < out[c.id]) out[c.id] = c.bytesScanned
    }
  }
  BEST = out
  return out
}

export const bestBytesFor = (id: QueryClassId): number => bestBytes()[id]

/**
 * Price the whole mix against one design.
 *
 * The ordering of `classes` is the class order, not a sort, so the table on
 * screen does not reshuffle itself while the reader is reading it. `worst` and
 * `runnerUp` are picked out separately.
 */
export function costMix(d: Design): MixReport {
  const key = designKey(d)
  const cached = COST_CACHE.get(key)
  const best = bestBytes()
  const classes: ClassCost[] =
    cached ??
    rawCosts(d).map((c) => ({
      ...c,
      bestBytes: best[c.id],
      /* best[c.id] is a finite positive byte count for every class: every query
       * in every class reads at least one row group and one footer, so this can
       * be neither 0/0 nor a division by zero. */
      starvation: c.bytesScanned / best[c.id],
    }))
  if (!cached) COST_CACHE.set(key, classes)

  const ranked = [...classes].sort(compareStarvation)
  return {
    design: d,
    classes,
    worst: ranked[0],
    runnerUp: ranked[1],
    best: ranked[ranked.length - 1],
    totalBytes: classes.reduce((n, c) => n + c.bytesScanned, 0),
    totalBytesPerDay: classes.reduce((n, c) => n + c.bytesPerDay, 0),
  }
}

/**
 * Worst first. Starvation decides it; the tie-breaks exist only so the ordering
 * is a total one — a UI that cannot name a single worst class cannot ask the
 * reader to name it either, and "two classes tied" would be a true but useless
 * answer to the question this lab asks.
 */
function compareStarvation(a: ClassCost, b: ClassCost): number {
  if (b.starvation !== a.starvation) return b.starvation - a.starvation
  if (b.bytesScanned !== a.bytesScanned) return b.bytesScanned - a.bytesScanned
  return CLASS_IDS.indexOf(a.id) - CLASS_IDS.indexOf(b.id)
}

/** The class a given design starves most. */
export const worstServed = (d: Design): ClassCost => costMix(d).worst

/**
 * One class's line out of a mix report. `classes` is in `CLASS_IDS` order and
 * every class is always priced, so this is an index rather than a search and
 * cannot return undefined.
 */
export const classCost = (r: MixReport, id: QueryClassId): ClassCost =>
  r.classes[CLASS_IDS.indexOf(id)]

/**
 * The design that serves one class best. Ties resolve to the first in grid
 * order, so this is stable. The UI uses it for the reveal that makes the
 * constraint concrete: here is the design the class you starved actually
 * wanted, and here is what it would have cost the other four.
 */
export function bestDesignFor(id: QueryClassId): Design {
  let winner = DESIGN_GRID[0]
  let fewest = Number.POSITIVE_INFINITY
  for (const d of DESIGN_GRID) {
    const bytes = classCost(costMix(d), id).bytesScanned
    if (bytes < fewest) {
      fewest = bytes
      winner = d
    }
  }
  return winner
}

/**
 * The class that needs a QUOTA rather than a layout: the one whose *best case*,
 * over the entire design space, is still the largest bill in the mix. This is
 * computed, not asserted — which is what lets the lab grade the reader's answer
 * to "which of these is not a layout problem?" without appealing to taste.
 */
export function quotaClassId(): QueryClassId {
  const best = bestBytes()
  let winner = CLASS_IDS[0]
  for (const id of CLASS_IDS) if (best[id] > best[winner]) winner = id
  return winner
}

/* -------------------------------- targets ------------------------------- */

/**
 * The graded tradeoff.
 *
 * A target on the dashboard alone would be a free win: partition by tenant,
 * sort by ts, take the smallest row group, and the dashboard bill lands at
 * 17.9 MiB. The ceiling on the starved class is what turns it into a design
 * problem, because that same design abandons the needle class at 71.5 GiB —
 * fourteen times the ceiling.
 *
 * Both numbers were chosen by sweeping the grid rather than by taste. Exactly
 * two of the 120 designs satisfy both, the opening design misses the ceiling
 * (6.56 GiB against 5 GiB), and every design that minimises the dashboard bill
 * misses it by more than an order of magnitude. So the reader has to give up
 * roughly 4.6× on the dashboard to keep the starved class alive — which is the
 * shape of every real layout review, and the reason this task is not "make the
 * dashboard fast".
 */
export interface MixTargets {
  /** Bytes the dashboard class must come in under, for one pass of its queries. */
  dashboardBytes: number
  /** Bytes the worst-served class must stay under, for one pass of its queries. */
  starvedCeiling: number
}

export const TARGETS: MixTargets = {
  dashboardBytes: 128 * 1024 * 1024,
  starvedCeiling: 5 * 1024 * 1024 * 1024,
}

export interface TargetResult {
  dashboardBytes: number
  dashboardOk: boolean
  starvedId: QueryClassId
  starvedBytes: number
  starvedOk: boolean
  ok: boolean
}

/** Grade a design against `TARGETS`. Pure, and a count on both sides. */
export function meetsTargets(d: Design, targets: MixTargets = TARGETS): TargetResult {
  const mix = costMix(d)
  const dashboardBytes = classCost(mix, 'dashboard').bytesScanned
  const dashboardOk = dashboardBytes <= targets.dashboardBytes
  const starvedOk = mix.worst.bytesScanned <= targets.starvedCeiling
  return {
    dashboardBytes,
    dashboardOk,
    starvedId: mix.worst.id,
    starvedBytes: mix.worst.bytesScanned,
    starvedOk,
    ok: dashboardOk && starvedOk,
  }
}

/** Designs in the grid that satisfy both targets. Used by the tests, and by nobody else. */
export const solvingDesigns = (targets: MixTargets = TARGETS): Design[] =>
  DESIGN_GRID.filter((d) => meetsTargets(d, targets).ok)
