/**
 * machine.ts — the execution model the `batch-machine` browser lab counts.
 *
 * One column, one query, three ways to execute it:
 *
 *   tuple      volcano / iterator model: every row is pulled through every
 *              operator, and the per-tuple overhead is counted explicitly
 *   batch      batch-at-a-time with a SELECTION VECTOR: the same per-operator
 *              overhead, paid once per batch instead of once per row, and
 *              surviving rows are addressed rather than copied
 *   compressed execute-on-compressed: the column is run-length encoded, so the
 *              filter is evaluated once per RUN and `SUM` of a constant run is
 *              value × length — work proportional to runs, not to rows
 *
 * Two rules govern everything below, and both are load-bearing.
 *
 * **The answer never changes.** All three modes return the identical
 * `{ matched, sum }` — not just at the end but at every row cursor, which is
 * what lets the lab step them side by side. `tests/batch-machine.test.ts`
 * asserts it across every shape, seed, batch size and prefix. This is the point:
 * a fast path that disagrees with the reference is not an optimisation, it is a
 * correctness bug with better benchmarks (C1.L5, and `compressed_path` in forge
 * lab 03).
 *
 * **Cost is a COUNT.** Every number here is a count of modelled operations —
 * virtual calls, null checks, comparisons, branches, selection writes, index
 * lookups, row copies, allocations, arithmetic ops. There is no wall-clock
 * anywhere and no `Math.random`: the columns come from the seeded xorshift in
 * `desks/kit`, so the same knobs produce the same counts on every machine.
 *
 * What this model therefore CANNOT tell you, and the lab says so on screen:
 * a real vectorised engine's win is also cache residency and SIMD width, and
 * neither is a count of operations issued. Counting is honest about the work you
 * stopped *issuing*; it is silent about what the memory system did with the work
 * that remains. The counts here are a model of an engine, not a measurement of
 * one.
 */

import { Rng } from '@/lib/desks/kit'

/* ------------------------------ the column ------------------------------ */

export type ColumnShapeId = 'random' | 'clustered' | 'constant'

export const SHAPE_IDS: ColumnShapeId[] = ['random', 'clustered', 'constant']

export interface ShapeSpec {
  id: ColumnShapeId
  name: string
  /** What the data looks like. */
  line: string
  /** Where a column like this comes from in a real table. */
  origin: string
}

export const SHAPES: ShapeSpec[] = [
  {
    id: 'random',
    name: 'random',
    line: 'a fresh value on almost every row, nulls sprinkled through',
    origin: 'a measure column written in arrival order — the case where RLE has nothing to hold on to',
  },
  {
    id: 'clustered',
    name: 'clustered',
    line: 'long stretches of one value, because the table was sorted on something correlated',
    origin: 'a status or region column in a table clustered by time — the ordinary case',
  },
  {
    id: 'constant',
    name: 'constant',
    line: 'one value for the whole column, one run',
    origin: 'a partition-constant column, or a tenant id inside a per-tenant file',
  },
]

export const shapeSpec = (id: ColumnShapeId): ShapeSpec =>
  SHAPES.find((s) => s.id === id) ?? SHAPES[0]

/** Rows in the column. 128Ki, matching the row-group sizes used across C2. */
export const ROWS = 131_072

/** Values live in [0, VALUE_MAX). Integers, so every sum below is exact. */
export const VALUE_MAX = 1_000

/**
 * The query: `SELECT count(*), sum(v) FROM col WHERE v >= 300 AND v <= 700`.
 * Two predicates rather than one, because a single predicate cannot show a
 * selection vector COMPOSING — the second predicate is evaluated only over the
 * rows the first one kept, by reading through the selection rather than by
 * building a new batch.
 */
export const PREDICATE = { lo: 300, hi: 700 } as const

/** One canonical run: no two adjacent runs share a value, and null is a value. */
export interface Run {
  /** null means "this run is nulls" — nulls never satisfy a predicate. */
  value: number | null
  start: number
  length: number
}

export interface Column {
  shape: ColumnShapeId
  seed: number
  rows: number
  values: Int32Array
  /** 1 where the row is null. */
  nulls: Uint8Array
  /** Canonical RLE. `runs.length` is what the compressed path pays for. */
  runs: Run[]
  /** nullPrefix[i] = nulls in [0, i). Lets a batch ask "am I all-valid?" in O(1). */
  nullPrefix: Int32Array
  nullCount: number
}

/** Canonical RLE of an already-materialised column. Adjacent equals merge. */
function runsOf(values: Int32Array, nulls: Uint8Array): Run[] {
  const runs: Run[] = []
  for (let i = 0; i < values.length; i++) {
    const value = nulls[i] === 1 ? null : values[i]
    const last = runs[runs.length - 1]
    if (last !== undefined && last.value === value) last.length++
    else runs.push({ value, start: i, length: 1 })
  }
  return runs
}

const COLUMNS = new Map<string, Column>()

/**
 * Build a column. Memoised by shape+seed, because the lab rebuilds on every
 * render and the tests sweep the space.
 */
export function buildColumn(shape: ColumnShapeId, seed = 20260911): Column {
  const key = `${shape}|${seed}`
  const hit = COLUMNS.get(key)
  if (hit) return hit

  const rng = new Rng(seed)
  const values = new Int32Array(ROWS)
  const nulls = new Uint8Array(ROWS)

  if (shape === 'constant') {
    /* Inside the predicate range on purpose: a constant column that matched
     * nothing would make the compressed path look free for the wrong reason. */
    values.fill(512)
  } else if (shape === 'random') {
    for (let i = 0; i < ROWS; i++) {
      values[i] = rng.below(VALUE_MAX)
      if (rng.below(64) === 0) nulls[i] = 1
    }
  } else {
    let i = 0
    while (i < ROWS) {
      const isNull = rng.below(12) === 0
      const span = isNull
        ? Math.round(rng.uniform(8, 64))
        : Math.round(rng.uniform(96, 1_024))
      const length = Math.min(span, ROWS - i)
      const value = rng.below(VALUE_MAX)
      for (let k = 0; k < length; k++) {
        values[i + k] = value
        nulls[i + k] = isNull ? 1 : 0
      }
      i += length
    }
  }

  const nullPrefix = new Int32Array(ROWS + 1)
  for (let i = 0; i < ROWS; i++) nullPrefix[i + 1] = nullPrefix[i] + nulls[i]

  const col: Column = {
    shape,
    seed,
    rows: ROWS,
    values,
    nulls,
    runs: runsOf(values, nulls),
    nullPrefix,
    nullCount: nullPrefix[ROWS],
  }
  COLUMNS.set(key, col)
  return col
}

/* ------------------------------- the answer ------------------------------ */

export interface Answer {
  matched: number
  sum: number
}

export const sameAnswer = (a: Answer, b: Answer): boolean =>
  a.matched === b.matched && a.sum === b.sum

/**
 * The reference answer, computed the dumbest possible way over the first
 * `limitRows` rows. Nothing grades against a mode; every mode grades against
 * this.
 */
export function referenceAnswer(col: Column, limitRows = col.rows): Answer {
  const end = Math.min(limitRows, col.rows)
  let matched = 0
  let sum = 0
  for (let i = 0; i < end; i++) {
    if (col.nulls[i] === 1) continue
    const v = col.values[i]
    if (v >= PREDICATE.lo && v <= PREDICATE.hi) {
      matched++
      sum += v
    }
  }
  return { matched, sum }
}

/** The row indices the query keeps — the thing a selection vector must equal. */
export function referenceIndices(col: Column, limitRows = col.rows): number[] {
  const end = Math.min(limitRows, col.rows)
  const out: number[] = []
  for (let i = 0; i < end; i++) {
    if (col.nulls[i] === 1) continue
    const v = col.values[i]
    if (v >= PREDICATE.lo && v <= PREDICATE.hi) out.push(i)
  }
  return out
}

/* -------------------------------- the knobs ------------------------------ */

export type ModeId = 'tuple' | 'batch' | 'compressed'

export const MODE_IDS: ModeId[] = ['tuple', 'batch', 'compressed']

export interface ModeSpec {
  id: ModeId
  name: string
  line: string
  /** The honest limit of this mode, shown next to its counts. */
  caveat: string
}

export const MODES: ModeSpec[] = [
  {
    id: 'tuple',
    name: 'tuple-at-a-time',
    line: 'one row pulled through three operators, over and over',
    caveat:
      'Nothing here is wrong — it is the reference. Every overhead it pays is paid once per row, which is the only thing the other two modes change.',
  },
  {
    id: 'batch',
    name: 'batch + selection vector',
    line: 'per-operator overhead paid once per batch; survivors addressed, not copied',
    caveat:
      'The selection vector costs an indirection every time a later operator reads a surviving row. Compact the batch and you pay copies instead — which is cheaper only if enough operators read it.',
  },
  {
    id: 'compressed',
    name: 'execute-on-compressed',
    line: 'one predicate per run; sum of a constant run is value × length',
    caveat:
      'Only because the filter and the aggregate are on the run-length-encoded column itself. A predicate on a different column would not line up with these runs, and the fast path would not apply.',
  },
]

export const modeSpec = (id: ModeId): ModeSpec => MODES.find((m) => m.id === id) ?? MODES[0]

/**
 * Batch sizes the reader can choose. Deliberately includes 1 — a batch of one
 * row is a volcano engine with extra bookkeeping, and the counts say so — and
 * runs up to the whole column, where the per-batch overhead has stopped
 * mattering to three decimal places. 2,048 is DuckDB's standard vector size.
 */
export const BATCH_CHOICES = [1, 8, 64, 256, 1_024, 2_048, 8_192, 32_768, 131_072]

/** Where the lab opens: small enough that the per-batch overhead is visible. */
export const DEFAULT_BATCH = 64

/**
 * How many aggregate expressions read the surviving rows —
 * `count(*)`, `sum(v)`, `min(v)`, `max(v)`. This is the knob that makes the
 * selection-vector-versus-compaction choice a real tradeoff instead of a
 * foregone conclusion: a selection vector pays one indirection per consumer,
 * while compaction pays one copy once. With a single consumer the selection
 * vector wins; add consumers and the copy amortises.
 */
export const DOWNSTREAM_CHOICES = [1, 2, 4]

export interface Config {
  shape: ColumnShapeId
  batchSize: number
  /** Aggregate expressions consuming the surviving rows. */
  downstream: number
  /** Copy survivors into a dense batch instead of addressing them in place. */
  compact: boolean
  seed?: number
}

export const DEFAULT_CONFIG: Config = {
  shape: 'clustered',
  batchSize: DEFAULT_BATCH,
  downstream: 1,
  compact: false,
}

/* -------------------------------- the counts ----------------------------- */

/**
 * Every operation the model charges for. Nine named counters rather than one
 * opaque score, because "it is faster" is not a teachable claim and
 * "you stopped issuing 131,072 null checks" is.
 */
export interface Ops {
  /** `next()` through an operator boundary. Per row in tuple mode, per batch otherwise. */
  virtualCalls: number
  /** Validity checks. A vectorised batch checks "all valid" once and skips the rest. */
  nullChecks: number
  /** Predicate comparisons. */
  predicateEvals: number
  /** Data-dependent branches — the ones a batched loop does not take per row. */
  branches: number
  /** Indices appended to a selection vector. */
  selectionWrites: number
  /** Reads through a selection vector: the indirection it costs to not copy. */
  selectionLookups: number
  /** Surviving values copied into a new dense batch. Zero unless you compact. */
  rowCopies: number
  /** Buffers allocated or reset. */
  allocations: number
  /** Adds and multiplies in the aggregate. */
  arithmetic: number
}

export const OPS_FIELDS: (keyof Ops)[] = [
  'virtualCalls',
  'nullChecks',
  'predicateEvals',
  'branches',
  'selectionWrites',
  'selectionLookups',
  'rowCopies',
  'allocations',
  'arithmetic',
]

export const OPS_LABEL: Record<keyof Ops, string> = {
  virtualCalls: 'virtual calls',
  nullChecks: 'null checks',
  predicateEvals: 'comparisons',
  branches: 'branches',
  selectionWrites: 'selection writes',
  selectionLookups: 'selection lookups',
  rowCopies: 'row copies',
  allocations: 'allocations',
  arithmetic: 'arithmetic',
}

const zeroOps = (): Ops => ({
  virtualCalls: 0,
  nullChecks: 0,
  predicateEvals: 0,
  branches: 0,
  selectionWrites: 0,
  selectionLookups: 0,
  rowCopies: 0,
  allocations: 0,
  arithmetic: 0,
})

export const totalOps = (ops: Ops): number =>
  OPS_FIELDS.reduce((acc, f) => acc + ops[f], 0)

/**
 * The pipeline: scan → filter → aggregate. Three operator boundaries, and the
 * number the batched modes divide by their batch size.
 */
export const PIPELINE_OPERATORS = 3

/**
 * Fixed cost of starting one batch, charged once per batch in the batched
 * modes: a `next()` per operator boundary, a loop-setup branch per operator,
 * one selection buffer reset, and one check of the batch's all-valid flag.
 */
export const PER_BATCH_OVERHEAD = PIPELINE_OPERATORS * 2 + 1 + 1

export interface ModeReport {
  mode: ModeId
  rowsProcessed: number
  /** Batches started. 1 per row in tuple mode is not a batch — see `unitLabel`. */
  batches: number
  /** Run fragments visited. Compressed mode only; 0 elsewhere. */
  fragments: number
  /** The unit of work this mode actually iterates over. */
  units: number
  unitLabel: string
  answer: Answer
  ops: Ops
  total: number
  /** Operations per row processed. The number that makes the modes comparable. */
  perRow: number
  /** How much of `total` was fixed per-batch cost. */
  batchOverhead: number
  /** batchOverhead ÷ total. The share a bigger batch can still remove. */
  overheadShare: number
}

const finish = (
  mode: ModeId,
  rowsProcessed: number,
  batches: number,
  fragments: number,
  units: number,
  unitLabel: string,
  answer: Answer,
  ops: Ops,
  batchOverhead: number,
): ModeReport => {
  const total = totalOps(ops)
  return {
    mode,
    rowsProcessed,
    batches,
    fragments,
    units,
    unitLabel,
    answer,
    ops,
    total,
    perRow: rowsProcessed > 0 ? total / rowsProcessed : 0,
    batchOverhead,
    overheadShare: total > 0 ? batchOverhead / total : 0,
  }
}

/* ------------------------- mode 1: tuple-at-a-time ----------------------- */

/**
 * The volcano model, priced honestly. Per row: a `next()` across each operator
 * boundary, a has-next branch, a null check, the first comparison and its
 * branch, then — only for rows that survived it — the second comparison and its
 * branch, and for survivors a materialised tuple handed to the aggregate.
 *
 * Note `rowCopies`: this mode copies the surviving row into the aggregate's
 * input because there is nothing else to hand it. That is the copy a selection
 * vector removes.
 */
export function runTuple(col: Column, cfg: Config, limitRows = col.rows): ModeReport {
  const end = Math.min(limitRows, col.rows)
  const ops = zeroOps()
  let matched = 0
  let sum = 0

  for (let i = 0; i < end; i++) {
    ops.virtualCalls += PIPELINE_OPERATORS
    ops.branches += 1
    ops.nullChecks += 1
    if (col.nulls[i] === 1) continue

    const v = col.values[i]
    ops.predicateEvals += 1
    ops.branches += 1
    if (v < PREDICATE.lo) continue

    ops.predicateEvals += 1
    ops.branches += 1
    if (v > PREDICATE.hi) continue

    /* The tuple has to exist for the aggregate to consume it. */
    ops.rowCopies += 1
    ops.allocations += 1
    ops.nullChecks += 1
    ops.arithmetic += 2 * cfg.downstream
    matched++
    sum += v
  }

  return finish('tuple', end, 0, 0, end, 'rows', { matched, sum }, ops, 0)
}

/* --------------- mode 2: batch-at-a-time with a selection vector --------- */

/**
 * Batch-at-a-time. Three things change and only three:
 *
 *   1. The per-operator overhead is charged once per BATCH, not once per row.
 *   2. The validity mask is consulted once per batch; a batch with no nulls
 *      costs one null check for the whole vector instead of one per row.
 *   3. The filter writes INDICES into a selection vector. The second predicate
 *      reads through that selection, so it is evaluated only over survivors,
 *      and nothing is copied — which is why `rowCopies` is 0 unless the reader
 *      turns compaction on.
 *
 * The loop over the vector is branchless: the comparison result is written, not
 * jumped on, so `branches` per row is 0. That is the shape a compiler
 * vectorises, and it is the honest reason batching helps beyond amortisation.
 */
export function runBatch(col: Column, cfg: Config, limitRows = col.rows): ModeReport {
  const end = Math.min(limitRows, col.rows)
  const batch = Math.max(1, Math.floor(cfg.batchSize))
  const ops = zeroOps()
  let overhead = 0
  let batches = 0
  let matched = 0
  let sum = 0

  for (let start = 0; start < end; start += batch) {
    const stop = Math.min(start + batch, end)
    const n = stop - start
    batches++

    /* per-batch fixed cost */
    ops.virtualCalls += PIPELINE_OPERATORS
    ops.branches += PIPELINE_OPERATORS
    ops.allocations += 1
    ops.nullChecks += 1
    overhead += PER_BATCH_OVERHEAD

    /* One question for the whole vector: does it contain any null at all? */
    const hasNulls = col.nullPrefix[stop] - col.nullPrefix[start] > 0
    if (hasNulls) ops.nullChecks += n

    /* predicate 1 over the dense vector: one comparison per row, no branches */
    ops.predicateEvals += n
    let kept = 0
    const sel: number[] = []
    for (let i = start; i < stop; i++) {
      if (col.nulls[i] === 1) continue
      if (col.values[i] >= PREDICATE.lo) {
        sel.push(i)
        kept++
      }
    }
    ops.selectionWrites += kept

    /* predicate 2 reads THROUGH the selection: evaluated only over survivors */
    ops.selectionLookups += kept
    ops.predicateEvals += kept
    let survivors = 0
    for (let k = 0; k < kept; k++) {
      const i = sel[k]
      if (col.values[i] <= PREDICATE.hi) {
        sel[survivors++] = i
      }
    }
    ops.selectionWrites += survivors

    if (cfg.compact) {
      /* Copy survivors into a dense batch. The copy itself must GATHER through
       * the selection vector — one lookup and one write per survivor — but it
       * is paid once, and every consumer that follows reads a dense array. */
      ops.selectionLookups += survivors
      ops.rowCopies += survivors
      ops.allocations += 1
    } else {
      ops.selectionLookups += survivors * cfg.downstream
    }

    ops.arithmetic += 2 * survivors * cfg.downstream
    for (let k = 0; k < survivors; k++) {
      matched++
      sum += col.values[sel[k]]
    }
  }

  return finish('batch', end, batches, 0, batches, 'batches', { matched, sum }, ops, overhead)
}

/* ---------------------- mode 3: execute-on-compressed -------------------- */

/**
 * The RLE fast path. The filter is evaluated once per run, and the aggregate
 * over a surviving run is arithmetic on the run header: `count += length`,
 * `sum += value × length`. Work is proportional to RUNS.
 *
 * The one honest complication, and it is the interesting part: a run is clipped
 * at the batch boundary, because a vector is the unit an engine materialises and
 * a run that straddles two vectors is two fragments. So the compressed path's
 * work is proportional to `runs + batches`, not to `runs` alone — and a reader
 * who sets the batch size to 1 destroys the fast path entirely, arriving back at
 * one operation per row. That interaction is the lesson, and it is why the
 * fragment count is reported next to the run count.
 */
export function runCompressed(col: Column, cfg: Config, limitRows = col.rows): ModeReport {
  const end = Math.min(limitRows, col.rows)
  const batch = Math.max(1, Math.floor(cfg.batchSize))
  const ops = zeroOps()
  let overhead = 0
  let batches = 0
  let fragments = 0
  let lastBatchIndex = -1
  let matched = 0
  let sum = 0

  for (const run of col.runs) {
    if (run.start >= end) break
    const runEnd = Math.min(run.start + run.length, end)
    let p = run.start

    while (p < runEnd) {
      const boundary = (Math.floor(p / batch) + 1) * batch
      const q = Math.min(runEnd, boundary)
      const length = q - p
      const batchIndex = Math.floor(p / batch)

      if (batchIndex !== lastBatchIndex) {
        batches++
        lastBatchIndex = batchIndex
        ops.virtualCalls += PIPELINE_OPERATORS
        ops.branches += PIPELINE_OPERATORS
        ops.allocations += 1
        ops.nullChecks += 1
        overhead += PER_BATCH_OVERHEAD
      }

      fragments++
      ops.nullChecks += 1
      if (run.value !== null) {
        ops.predicateEvals += 2
        ops.branches += 1
        if (run.value >= PREDICATE.lo && run.value <= PREDICATE.hi) {
          ops.selectionWrites += 1
          /* count += length; sum += value * length — three ops, per RUN. */
          ops.arithmetic += 3 * cfg.downstream
          matched += length
          sum += run.value * length
        }
      }

      p = q
    }
  }

  return finish(
    'compressed',
    end,
    batches,
    fragments,
    fragments,
    'run fragments',
    { matched, sum },
    ops,
    overhead,
  )
}

/* -------------------------------- driving ------------------------------- */

export function runMode(
  mode: ModeId,
  col: Column,
  cfg: Config,
  limitRows = col.rows,
): ModeReport {
  if (mode === 'tuple') return runTuple(col, cfg, limitRows)
  if (mode === 'batch') return runBatch(col, cfg, limitRows)
  return runCompressed(col, cfg, limitRows)
}

export interface RunSet {
  cfg: Config
  column: Column
  rowsProcessed: number
  reports: Record<ModeId, ModeReport>
  /** The reference, computed independently of all three modes. */
  reference: Answer
  /** Do all three modes agree with the reference and with each other? */
  agree: boolean
  /** Cheapest mode by total operations. */
  cheapest: ModeId
  /** Most expensive mode by total operations. */
  dearest: ModeId
}

export function runAll(cfg: Config, limitRows?: number): RunSet {
  const column = buildColumn(cfg.shape, cfg.seed)
  const rows = Math.min(limitRows ?? column.rows, column.rows)
  const reports = {
    tuple: runTuple(column, cfg, rows),
    batch: runBatch(column, cfg, rows),
    compressed: runCompressed(column, cfg, rows),
  }
  const reference = referenceAnswer(column, rows)
  const agree = MODE_IDS.every((m) => sameAnswer(reports[m].answer, reference))
  const ordered = [...MODE_IDS].sort((a, b) => reports[a].total - reports[b].total)
  return {
    cfg,
    column,
    rowsProcessed: rows,
    reports,
    reference,
    agree,
    cheapest: ordered[0],
    dearest: ordered[ordered.length - 1],
  }
}

/* ------------------------- the selection vector itself ------------------- */

export interface SelectionTrace {
  /** Indices surviving predicate 1, in row order, across all batches. */
  afterFirst: number[]
  /** Indices surviving both predicates. A subsequence of `afterFirst`. */
  afterSecond: number[]
  /** Values copied to achieve this. Zero — that is the whole claim. */
  copies: number
  /** Selection buffers used. One per batch, reused. */
  buffers: number
}

/**
 * The selection vector, exposed so a test can check the claim directly rather
 * than trusting a counter: chaining a second predicate narrows the SAME index
 * list, in place, and never materialises a row.
 */
export function selectionTrace(
  col: Column,
  batchSize: number,
  limitRows = col.rows,
): SelectionTrace {
  const end = Math.min(limitRows, col.rows)
  const batch = Math.max(1, Math.floor(batchSize))
  const afterFirst: number[] = []
  const afterSecond: number[] = []
  let buffers = 0

  for (let start = 0; start < end; start += batch) {
    const stop = Math.min(start + batch, end)
    buffers++
    const sel: number[] = []
    for (let i = start; i < stop; i++) {
      if (col.nulls[i] === 1) continue
      if (col.values[i] >= PREDICATE.lo) sel.push(i)
    }
    /* Appended one at a time on purpose: `push(...sel)` passes the whole
     * selection as arguments, and a batch the width of the column overflows the
     * call stack. A vector is data, not an argument list. */
    for (const i of sel) afterFirst.push(i)
    let n = 0
    for (let k = 0; k < sel.length; k++) {
      if (col.values[sel[k]] <= PREDICATE.hi) sel[n++] = sel[k]
    }
    sel.length = n
    for (const i of sel) afterSecond.push(i)
  }

  return { afterFirst, afterSecond, copies: 0, buffers }
}

/* ------------------------------- the answers ---------------------------- */

/** Fraction of `total` that a bigger batch could still remove, as a share. */
export const OVERHEAD_TARGET = 0.01

/** Below this, a doubling of the batch size has stopped buying anything. */
export const PLATEAU_EPS = 0.005

/** "Fewer than one operation per thousand rows" — the compressed-path target. */
export const COMPRESSED_TARGET = 0.001

const totalFor = (cfg: Config, batchSize: number, mode: ModeId = 'batch'): number =>
  runMode(mode, buildColumn(cfg.shape, cfg.seed), { ...cfg, batchSize }).total

/**
 * The smallest offered batch size beyond which every larger one changes the
 * batched count by less than `PLATEAU_EPS`. The graded answer to "where does a
 * bigger batch stop helping" — computed, so the answer key cannot drift from
 * the model.
 */
export function plateauBatchSize(cfg: Config): number {
  const asc = [...BATCH_CHOICES].sort((a, b) => a - b)
  for (const b of asc) {
    const here = totalFor(cfg, b)
    const flat = asc
      .filter((x) => x > b)
      .every((x) => Math.abs(totalFor(cfg, x) - here) / here < PLATEAU_EPS)
    if (flat) return b
  }
  return asc[asc.length - 1]
}

/**
 * The offered batch size that MINIMISES the batched count for this column — and
 * it is usually not the largest one, which is the surprise this lab is built
 * around. Two effects pull in opposite directions:
 *
 *   · a bigger batch amortises `PER_BATCH_OVERHEAD` over more rows (helps, with
 *     sharply diminishing returns — see `plateauBatchSize`)
 *   · a bigger batch is LESS LIKELY TO BE ALL-VALID, and a batch containing a
 *     single null loses the one-check-per-vector validity shortcut and pays a
 *     null check per row instead (hurts, and it can dominate)
 *
 * On a column with sparse, evenly spread nulls the second effect wins early, so
 * the minimum sits in the low hundreds of rows. On a column with no nulls at
 * all the count decreases monotonically. Both are computed, not asserted.
 */
export function bestBatchSize(cfg: Config): number {
  const asc = [...BATCH_CHOICES].sort((a, b) => a - b)
  let best = asc[0]
  let bestTotal = Infinity
  for (const b of asc) {
    const t = totalFor(cfg, b)
    if (t < bestTotal) {
      bestTotal = t
      best = b
    }
  }
  return best
}

/**
 * Selection vector against compaction, at the current batch size and consumer
 * count. Compaction gathers once (a lookup and a copy per survivor); a selection
 * vector pays a lookup per survivor PER CONSUMER. So the crossover sits at about
 * two consumers, and neither answer is universally right.
 */
export function compactionCompare(cfg: Config): {
  selection: number
  compaction: number
  winner: 'selection' | 'compaction' | 'tie'
} {
  const col = buildColumn(cfg.shape, cfg.seed)
  const selection = runBatch(col, { ...cfg, compact: false }).total
  const compaction = runBatch(col, { ...cfg, compact: true }).total
  const winner =
    selection === compaction ? 'tie' : selection < compaction ? 'selection' : 'compaction'
  return { selection, compaction, winner }
}

/**
 * The smallest batch size at which batching is strictly cheaper than
 * tuple-at-a-time — and the reason batch size 1 is on the dial. Below the
 * crossover, the bookkeeping costs more than the overhead it removes.
 */
export function crossoverBatchSize(cfg: Config, sizes = BATCH_CHOICES): number | null {
  const asc = [...sizes].sort((a, b) => a - b)
  const tuple = totalFor(cfg, asc[0], 'tuple')
  for (const b of asc) {
    if (totalFor(cfg, b) < tuple) return b
  }
  return null
}

/** Runs in the column, and fragments once the batch boundary has cut them. */
export function runShape(cfg: Config): { runs: number; fragments: number; rows: number } {
  const col = buildColumn(cfg.shape, cfg.seed)
  const r = runCompressed(col, cfg)
  return { runs: col.runs.length, fragments: r.fragments, rows: col.rows }
}

/* ------------------------------- grading -------------------------------- */

/**
 * What a given set of knobs demonstrates. The lab latches the union of these
 * across everything the reader has tried, so its task list is derived from
 * computed facts about configurations that were actually on screen — not from a
 * pile of booleans set by whichever effect fired last.
 */
export interface Achievements {
  /** All three modes agreed with the independent reference. */
  agreed: boolean
  /** Per-batch overhead fell below 1% of the batched count. */
  overheadAmortised: boolean
  /** Batching cost at least as much as tuple-at-a-time. Batch size 1 does it. */
  batchLost: boolean
  /** The compressed path did the whole query in under 1 op per 1,000 rows. */
  compressedTiny: boolean
  /** The selection vector beat compaction here. */
  selectionWon: boolean
  /** Compaction beat the selection vector here. */
  compactionWon: boolean
}

export const ACHIEVEMENT_KEYS: (keyof Achievements)[] = [
  'agreed',
  'overheadAmortised',
  'batchLost',
  'compressedTiny',
  'selectionWon',
  'compactionWon',
]

export function achievementsOf(cfg: Config): Achievements {
  const set = runAll(cfg)
  const cmp = compactionCompare(cfg)
  return {
    agreed: set.agree,
    overheadAmortised: set.reports.batch.overheadShare < OVERHEAD_TARGET,
    batchLost: set.reports.batch.total >= set.reports.tuple.total,
    compressedTiny: set.reports.compressed.perRow < COMPRESSED_TARGET,
    selectionWon: cmp.winner === 'selection',
    compactionWon: cmp.winner === 'compaction',
  }
}

export const mergeAchievements = (a: Achievements, b: Achievements): Achievements => {
  const out = { ...a }
  for (const k of ACHIEVEMENT_KEYS) out[k] = a[k] || b[k]
  return out
}
