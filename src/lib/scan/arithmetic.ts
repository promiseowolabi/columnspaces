/**
 * arithmetic.ts — the model behind the C0 browser lab, `scan-arithmetic`.
 *
 * C0.L1 states the bill as a product of three factors:
 *
 *     bytes scanned = bytes per row you actually need
 *                   × rows the engine could not skip
 *                   × how often the query runs
 *
 * and then makes the claim that the whole lab exists to turn into a number the
 * reader moved themselves: **the weakest factor dominates**. A factor sitting at
 * 1× is untouched headroom, and improving a factor that is already 14× while a
 * 1× factor sits beside it is the mistake the lesson names.
 *
 * Three decisions carry the pedagogy, borrowed from the layout designer because
 * they worked there for the same reasons:
 *
 *   1. THE PRODUCT IS ALWAYS ON SCREEN, factor by factor, with each factor
 *      written as the division that produced it — 28 B of 400 B, 100 blocks of
 *      2,000, 288 runs of 1,440. Every number in this file can be redone on
 *      paper, which is the point of a lesson whose subject is arithmetic.
 *   2. HEADROOM IS COMPUTED, NOT ASSERTED. `mostHeadroom` is the axis with the
 *      largest remaining multiplier available on it, and the model is built so
 *      that whenever any factor is at 1×, that axis IS the one with the most
 *      headroom (the test suite sweeps all 48 configurations to keep it true).
 *      So "fix the factor at 1× first" is a fact about the space rather than
 *      advice from a paragraph.
 *   3. THE TARGET IS PAIRED WITH A FRESHNESS CEILING. Exactly two of the 48
 *      configurations satisfy both, and the configuration that minimises bytes
 *      per day is not one of them: it misses the ceiling by 4×. Frequency is
 *      the factor every team reaches for first, and the ceiling is what stops
 *      the reader answering the whole lab with it.
 *
 * Everything here is a COUNT — bytes, blocks, runs per day — and everything is
 * deterministic. There is no wall-clock and no `Math.random`; the sample
 * workload at the bottom is drawn from the seeded xorshift in `desks/kit`.
 */

import { Rng } from '@/lib/desks/kit'

/* ------------------------------- the table ------------------------------ */

/** The fact table from C0.L1, unchanged, so the two can be read together. */
export const ROWS = 2_000_000_000
export const COLUMN_COUNT = 60
export const ROW_BYTES = 400

/**
 * Blocks (row groups) the table is written in. Fixed, because pruning here is
 * expressed as "what fraction of blocks could not be excluded" — making the
 * block count a knob as well would mix in C3's metadata tax, which the footer
 * walk is for.
 */
export const BLOCKS = 2_000
export const ROWS_PER_BLOCK = ROWS / BLOCKS

/** One refresh a minute: the frequency a dashboard has before anyone thinks about it. */
export const BASELINE_RUNS_PER_DAY = 1_440

export interface SchemaColumn {
  name: string
  bytes: number
  note: string
}

/**
 * The twelve columns this workload ever names, with their widths. The other 48
 * are real and are the reason `SELECT *` costs what it does, but they are not
 * worth twelve more rows of table: their combined width is stated once, below.
 */
export const SCHEMA: SchemaColumn[] = [
  { name: 'order_ts', bytes: 8, note: 'the predicate column, and the only candidate for physical order' },
  { name: 'region', bytes: 12, note: 'the group-by key — a short string' },
  { name: 'net_revenue', bytes: 8, note: 'the measure' },
  { name: 'order_id', bytes: 8, note: 'unique, high entropy, compresses badly' },
  { name: 'customer_id', bytes: 8, note: 'the join key most ad-hoc queries reach for' },
  { name: 'sku', bytes: 16, note: 'a string, and the widest thing anyone groups by' },
  { name: 'quantity', bytes: 4, note: 'a small integer that costs 4 bytes because nobody narrowed it' },
  { name: 'discount', bytes: 8, note: 'mostly zero, and therefore mostly free once encoded' },
  { name: 'channel', bytes: 10, note: 'a low-cardinality enum stored as text' },
  { name: 'status', bytes: 10, note: 'six values, stored as text' },
  { name: 'ship_country', bytes: 12, note: 'two useful characters in a twelve-byte field' },
  { name: 'payment_method', bytes: 12, note: 'another enum stored as text' },
]

export const NAMED_BYTES = SCHEMA.reduce((n, c) => n + c.bytes, 0)
export const OTHER_COLUMNS = COLUMN_COUNT - SCHEMA.length
export const OTHER_BYTES = ROW_BYTES - NAMED_BYTES

/* ------------------------------ the factors ----------------------------- */

export type FactorId = 'projection' | 'pruning' | 'frequency'

/** Fixed order: it is the order of the product in C0.L1, and it breaks ties. */
export const FACTOR_IDS: FactorId[] = ['projection', 'pruning', 'frequency']

export const FACTOR_LABEL: Record<FactorId, string> = {
  projection: 'projection',
  pruning: 'pruning',
  frequency: 'frequency',
}

export const FACTOR_ATTACKS: Record<FactorId, string> = {
  projection: 'bytes per row the query needs',
  pruning: 'rows the engine could not skip',
  frequency: 'how often the query runs',
}

/* ------------------------------- projection ----------------------------- */

export type ProjectionId = 'star' | 'wide' | 'lean' | 'needle'

export interface ProjectionSpec {
  id: ProjectionId
  label: string
  /** Named columns projected, or `null` for "all sixty". */
  columns: string[] | null
  columnCount: number
  bytesPerRow: number
  line: string
}

const projectionOf = (
  id: ProjectionId,
  label: string,
  columns: string[] | null,
  line: string,
): ProjectionSpec => {
  if (columns === null) {
    return { id, label, columns, columnCount: COLUMN_COUNT, bytesPerRow: ROW_BYTES, line }
  }
  const bytesPerRow = columns.reduce((n, name) => {
    const col = SCHEMA.find((c) => c.name === name)
    /* A typo here would silently make the arithmetic unfalsifiable, so it throws. */
    if (!col) throw new Error(`scan-arithmetic: no column named ${name}`)
    return n + col.bytes
  }, 0)
  return { id, label, columns, columnCount: columns.length, bytesPerRow, line }
}

export const PROJECTIONS: ProjectionSpec[] = [
  projectionOf('star', 'select *', null, 'sixty columns, 400 B per row — the layout advantage handed back'),
  projectionOf(
    'wide',
    'the twelve named columns',
    SCHEMA.map((c) => c.name),
    'the whole named schema: what a "let me have the useful ones" query costs',
  ),
  projectionOf(
    'lean',
    'ts + region + net_revenue',
    ['order_ts', 'region', 'net_revenue'],
    'the three columns the dashboard query actually reads',
  ),
  projectionOf(
    'needle',
    'ts + net_revenue',
    ['order_ts', 'net_revenue'],
    'drop the group-by key and it is two columns — the floor for this query shape',
  ),
]

export const projection = (id: ProjectionId): ProjectionSpec => {
  const spec = PROJECTIONS.find((p) => p.id === id)
  if (!spec) throw new Error(`scan-arithmetic: no projection ${id}`)
  return spec
}

/* -------------------------------- pruning ------------------------------- */

export type PruningId = 'none' | 'weak' | 'good' | 'fine'

export interface PruningSpec {
  id: PruningId
  label: string
  blocksRead: number
  line: string
}

export const PRUNINGS: PruningSpec[] = [
  {
    id: 'none',
    label: '0% pruned',
    blocksRead: 2_000,
    line: 'the filter column is not the physical order, so every block’s min/max spans the window',
  },
  {
    id: 'weak',
    label: '80% pruned',
    blocksRead: 400,
    line: 'loaded in roughly arrival order, which correlates with time without being sorted by it',
  },
  {
    id: 'good',
    label: '95% pruned',
    blocksRead: 100,
    line: 'physically clustered on order_ts — the ratio the scan-bill duck lab measures',
  },
  {
    id: 'fine',
    label: '99% pruned',
    blocksRead: 20,
    line: 'clustered on order_ts and written in smaller row groups, so the window edges waste less',
  },
]

export const pruning = (id: PruningId): PruningSpec => {
  const spec = PRUNINGS.find((p) => p.id === id)
  if (!spec) throw new Error(`scan-arithmetic: no pruning ${id}`)
  return spec
}

/* ------------------------------- frequency ------------------------------ */

export type FrequencyId = 'minute' | 'cached' | 'hourly'

export interface FrequencySpec {
  id: FrequencyId
  label: string
  runsPerDay: number
  /** How stale the answer on the dashboard can be, in minutes. A count of minutes of data, not a clock reading. */
  stalenessMinutes: number
  line: string
}

export const FREQUENCIES: FrequencySpec[] = [
  {
    id: 'minute',
    label: 'every minute',
    runsPerDay: 1_440,
    stalenessMinutes: 1,
    line: 'one refresh per minute per dashboard — nobody decided this, it is the default',
  },
  {
    id: 'cached',
    label: 'every 5 minutes',
    runsPerDay: 288,
    stalenessMinutes: 5,
    line: 'a five-minute result cache in front of the same query',
  },
  {
    id: 'hourly',
    label: 'hourly, from a rollup',
    runsPerDay: 24,
    stalenessMinutes: 60,
    line: 'materialised hourly — the cheapest bill in the space, and the answer is up to an hour old',
  },
]

export const frequency = (id: FrequencyId): FrequencySpec => {
  const spec = FREQUENCIES.find((f) => f.id === id)
  if (!spec) throw new Error(`scan-arithmetic: no frequency ${id}`)
  return spec
}

/* -------------------------------- the bill ------------------------------ */

export interface ScanChoice {
  projection: ProjectionId
  pruning: PruningId
  frequency: FrequencyId
}

export const OPENING_CHOICE: ScanChoice = {
  projection: 'lean',
  pruning: 'none',
  frequency: 'cached',
}

export const choiceKey = (c: ScanChoice): string => `${c.projection}/${c.pruning}/${c.frequency}`

/** The whole space: 4 × 4 × 3. Small enough to sweep, large enough to hide two answers in. */
export const CHOICE_GRID: ScanChoice[] = PROJECTIONS.flatMap((p) =>
  PRUNINGS.flatMap((r) =>
    FREQUENCIES.map((f) => ({ projection: p.id, pruning: r.id, frequency: f.id })),
  ),
)

export interface FactorReport {
  id: FactorId
  label: string
  /** The multiplier itself — always ≥ 1, and exactly 1 when the factor is untouched. */
  value: number
  /** The division that produced it, so the reader can redo it. */
  numerator: number
  denominator: number
  unit: string
  atOne: boolean
  /** The best value available on this axis. */
  max: number
  /** How much multiplier is still on the table here: max ÷ value. */
  headroom: number
}

export interface ScanBill {
  choice: ScanChoice
  key: string

  bytesPerRowTotal: number
  bytesPerRowProjected: number
  columnsProjected: number
  projectionFactor: number

  blocksTotal: number
  blocksRead: number
  rowsRead: number
  prunedRatio: number
  pruningFactor: number

  runsPerDay: number
  stalenessMinutes: number
  frequencyFactor: number

  /** The product, literally: projection × pruning × frequency. */
  totalFactor: number

  bytesPerPass: number
  bytesPerDay: number
  baselineBytesPerPass: number
  baselineBytesPerDay: number

  factors: FactorReport[]
  /** Smallest factor. Ties break in FACTOR_IDS order. */
  weakest: FactorId
  /** Largest factor. Ties break in FACTOR_IDS order. */
  strongest: FactorId
  factorsAtOne: FactorId[]
  /** Axis with the most multiplier still available. Always an axis at 1× when one exists. */
  mostHeadroom: FactorId

  targetOk: boolean
  freshOk: boolean
  ok: boolean
}

const MAX_PROJECTION = Math.max(...PROJECTIONS.map((p) => ROW_BYTES / p.bytesPerRow))
const MAX_PRUNING = Math.max(...PRUNINGS.map((p) => BLOCKS / p.blocksRead))
const MAX_FREQUENCY = Math.max(...FREQUENCIES.map((f) => BASELINE_RUNS_PER_DAY / f.runsPerDay))

export const FACTOR_MAX: Record<FactorId, number> = {
  projection: MAX_PROJECTION,
  pruning: MAX_PRUNING,
  frequency: MAX_FREQUENCY,
}

/**
 * The graded pair. The target alone is answerable by frequency — which is the
 * lever every team already pulled — so it is paired with a freshness ceiling
 * that bars the hourly rollup. Under the ceiling, every factor must be above 1×
 * to reach the target at all, and exactly two configurations do.
 */
export const TARGETS = {
  totalFactor: 5_000,
  stalenessMinutes: 15,
}

/**
 * The bill, from counts only. Every field is either a count or a ratio of two
 * counts printed beside it.
 */
export function scanBill(choice: ScanChoice): ScanBill {
  const p = projection(choice.projection)
  const r = pruning(choice.pruning)
  const f = frequency(choice.frequency)

  const projectionFactor = ROW_BYTES / p.bytesPerRow
  const pruningFactor = BLOCKS / r.blocksRead
  const frequencyFactor = BASELINE_RUNS_PER_DAY / f.runsPerDay
  const totalFactor = projectionFactor * pruningFactor * frequencyFactor

  const rowsRead = ROWS_PER_BLOCK * r.blocksRead
  const bytesPerPass = rowsRead * p.bytesPerRow
  const bytesPerDay = bytesPerPass * f.runsPerDay
  const baselineBytesPerPass = ROWS * ROW_BYTES
  const baselineBytesPerDay = baselineBytesPerPass * BASELINE_RUNS_PER_DAY

  const factors: FactorReport[] = [
    {
      id: 'projection',
      label: FACTOR_LABEL.projection,
      value: projectionFactor,
      numerator: ROW_BYTES,
      denominator: p.bytesPerRow,
      unit: 'B per row',
      atOne: projectionFactor === 1,
      max: MAX_PROJECTION,
      headroom: MAX_PROJECTION / projectionFactor,
    },
    {
      id: 'pruning',
      label: FACTOR_LABEL.pruning,
      value: pruningFactor,
      numerator: BLOCKS,
      denominator: r.blocksRead,
      unit: 'blocks read',
      atOne: pruningFactor === 1,
      max: MAX_PRUNING,
      headroom: MAX_PRUNING / pruningFactor,
    },
    {
      id: 'frequency',
      label: FACTOR_LABEL.frequency,
      value: frequencyFactor,
      numerator: BASELINE_RUNS_PER_DAY,
      denominator: f.runsPerDay,
      unit: 'runs per day',
      atOne: frequencyFactor === 1,
      max: MAX_FREQUENCY,
      headroom: MAX_FREQUENCY / frequencyFactor,
    },
  ]

  /* argmin / argmax with the tie broken by FACTOR_IDS order: a graded pick
   * needs exactly one right answer, so "whichever came first" is written down
   * rather than left to sort stability. */
  const pickBy = (better: (a: FactorReport, b: FactorReport) => boolean): FactorId =>
    factors.reduce((best, cur) => (better(cur, best) ? cur : best)).id

  const targetOk = totalFactor >= TARGETS.totalFactor
  const freshOk = f.stalenessMinutes <= TARGETS.stalenessMinutes

  return {
    choice,
    key: choiceKey(choice),

    bytesPerRowTotal: ROW_BYTES,
    bytesPerRowProjected: p.bytesPerRow,
    columnsProjected: p.columnCount,
    projectionFactor,

    blocksTotal: BLOCKS,
    blocksRead: r.blocksRead,
    rowsRead,
    prunedRatio: (BLOCKS - r.blocksRead) / BLOCKS,
    pruningFactor,

    runsPerDay: f.runsPerDay,
    stalenessMinutes: f.stalenessMinutes,
    frequencyFactor,

    totalFactor,

    bytesPerPass,
    bytesPerDay,
    baselineBytesPerPass,
    baselineBytesPerDay,

    factors,
    weakest: pickBy((a, b) => a.value < b.value),
    strongest: pickBy((a, b) => a.value > b.value),
    factorsAtOne: factors.filter((x) => x.atOne).map((x) => x.id),
    mostHeadroom: pickBy((a, b) => a.headroom > b.headroom),

    targetOk,
    freshOk,
    ok: targetOk && freshOk,
  }
}

/* ------------------------------- the axes ------------------------------- */

/** Which axis differs between two choices, or null when they are the same choice. */
export function axisChanged(a: ScanChoice, b: ScanChoice): FactorId | null {
  if (a.projection !== b.projection) return 'projection'
  if (a.pruning !== b.pruning) return 'pruning'
  if (a.frequency !== b.frequency) return 'frequency'
  return null
}

export function factorValue(choice: ScanChoice, axis: FactorId): number {
  const bill = scanBill(choice)
  if (axis === 'projection') return bill.projectionFactor
  if (axis === 'pruning') return bill.pruningFactor
  return bill.frequencyFactor
}

/** The ordered options on an axis, weakest first — the order the UI draws them in. */
export const AXIS_OPTIONS: Record<FactorId, string[]> = {
  projection: [...PROJECTIONS]
    .sort((a, b) => b.bytesPerRow - a.bytesPerRow)
    .map((p) => p.id),
  pruning: [...PRUNINGS].sort((a, b) => b.blocksRead - a.blocksRead).map((p) => p.id),
  frequency: [...FREQUENCIES].sort((a, b) => b.runsPerDay - a.runsPerDay).map((f) => f.id),
}

/** One step up the named axis, or null when already at the top of it. */
export function stepUp(choice: ScanChoice, axis: FactorId): ScanChoice | null {
  const options = AXIS_OPTIONS[axis]
  const current = choice[axis] as string
  const i = options.indexOf(current)
  if (i < 0 || i + 1 >= options.length) return null
  const next = options[i + 1]
  if (axis === 'projection') return { ...choice, projection: next as ProjectionId }
  if (axis === 'pruning') return { ...choice, pruning: next as PruningId }
  return { ...choice, frequency: next as FrequencyId }
}

/** What one step up that axis multiplies the total by. 1 when the axis is exhausted. */
export function stepGain(choice: ScanChoice, axis: FactorId): number {
  const next = stepUp(choice, axis)
  if (!next) return 1
  return scanBill(next).totalFactor / scanBill(choice).totalFactor
}

/* ----------------------------- the whole space -------------------------- */

export const solvingChoices = (): ScanChoice[] => CHOICE_GRID.filter((c) => scanBill(c).ok)

/** The configuration with the smallest bytes-per-day in the space, freshness ignored. */
export function cheapestChoice(): ScanChoice {
  return CHOICE_GRID.reduce((best, cur) =>
    scanBill(cur).bytesPerDay < scanBill(best).bytesPerDay ? cur : best,
  )
}

/**
 * The best total factor reachable with one axis pinned to its 1× setting.
 * With `freshOnly`, only configurations inside the freshness ceiling count —
 * and then no axis may sit at 1× and still reach the target, which is the
 * structural claim the graded task rests on.
 */
export function bestWithAxisAtOne(axis: FactorId, freshOnly = false): number {
  const pinned = CHOICE_GRID.filter(
    (c) => factorValue(c, axis) === 1 && (!freshOnly || scanBill(c).freshOk),
  )
  return Math.max(...pinned.map((c) => scanBill(c).totalFactor))
}

/* --------------------------- the sample workload ------------------------ */

/**
 * Eight queries from a real-ish workload, drawn from the seeded xorshift so
 * that every reader sees the same eight. Their point is that the weakest factor
 * differs per query: there is no single fix for a workload, which is why the
 * lab grades identifying the 1× factor rather than applying a recipe.
 */
export interface SampleQuery {
  name: string
  choice: ScanChoice
  bill: ScanBill
}

const SAMPLE_NAMES = [
  'exec dashboard',
  'regional rollup',
  'ops alerting',
  'finance close',
  'ad-hoc notebook',
  'customer export',
  'anomaly sweep',
  'retention cohort',
]

let sampleCache: SampleQuery[] | null = null

export function sampleWorkload(): SampleQuery[] {
  if (sampleCache) return sampleCache
  const rng = new Rng(0x5eed_5ca4)
  sampleCache = SAMPLE_NAMES.map((name) => {
    const choice: ScanChoice = {
      projection: PROJECTIONS[rng.below(PROJECTIONS.length)].id,
      pruning: PRUNINGS[rng.below(PRUNINGS.length)].id,
      frequency: FREQUENCIES[rng.below(FREQUENCIES.length)].id,
    }
    return { name, choice, bill: scanBill(choice) }
  })
  return sampleCache
}

/** How many of the sample queries have each axis as their weakest factor. */
export function weakestHistogram(): Record<FactorId, number> {
  const out: Record<FactorId, number> = { projection: 0, pruning: 0, frequency: 0 }
  for (const q of sampleWorkload()) out[q.bill.weakest] += 1
  return out
}
