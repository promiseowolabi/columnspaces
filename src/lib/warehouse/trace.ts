/**
 * trace.ts — the deterministic query trace.
 *
 * Four workloads, each one an adversary for a different layout decision. Every
 * query is generated from the seeded xorshift in `desks/kit`, so every reader
 * of every lesson sees the *same* trace and therefore the same counts: a
 * screenshot in a lesson and the reader's own screen agree, and a bug report
 * about the Warehouse is reproducible from the seed alone.
 *
 * A query is three facts and nothing else:
 *
 *   - the columns it PROJECTS  → sets how many bytes each row costs,
 *   - the predicates it FILTERS on → sets how many rows it can skip,
 *   - the key it SHUFFLES on (if any) → sets how uneven the exchange is.
 *
 * Predicate bounds are normalised to [0, 1) over the column's domain rather
 * than expressed in real values. That is deliberate: the engine then needs to
 * know only a *selectivity*, not a calendar or a tenant list, and the same
 * predicate model works for a timestamp, an integer id and a dictionary string
 * without eight special cases that could each be wrong.
 *
 * Write-shaped queries (append/update/delete) carry `rowsWritten` and project
 * nothing to read; the ingest mode is the only one that emits them.
 */

import { Rng } from '@/lib/desks/kit'
import { COLUMN_IDS, PARTITION_KEYS, type ColumnId } from './table'

export type TraceModeId = 'dashboard' | 'adhoc' | 'ingest' | 'skew'

export type QueryKind = 'scan' | 'append' | 'update' | 'delete'

/** A range predicate, normalised to a fraction of the column's domain. */
export interface Predicate {
  column: ColumnId
  /** Inclusive lower bound in [0, 1). */
  lo: number
  /** Exclusive upper bound in (lo, 1]. */
  hi: number
}

export interface Shuffle {
  key: ColumnId
  /**
   * Share of the shuffled rows that land on the single busiest key. A uniform
   * group-by over a few dozen groups sits near 0.04; a join against a
   * dominant tenant sits near 0.4. This is a property of the DATA the query
   * joins on, which is why it is recorded per query rather than inferred by
   * the engine from a column name.
   */
  hotShare: number
}

export interface Query {
  /** 1-based ordinal in the trace — the x-axis of the trace player. */
  id: number
  kind: QueryKind
  /** Human label, so the per-query table reads like a workload and not like a dump. */
  label: string
  /** Columns projected. Empty for write commits. */
  columns: ColumnId[]
  predicates: Predicate[]
  shuffle: Shuffle | null
  /** Rows added/updated/deleted. Zero for scans. */
  rowsWritten: number
}

export interface Trace {
  mode: TraceModeId
  seed: number
  name: string
  line: string
  queries: Query[]
}

export interface TraceModeSpec {
  id: TraceModeId
  name: string
  line: string
}

/**
 * The copy here is the contract the C0 lessons are written against — each mode
 * has to be an adversary for one specific decision, or it is decoration.
 */
export const TRACE_MODES: TraceModeSpec[] = [
  {
    id: 'dashboard',
    name: 'the dashboard',
    line: 'Narrow, repetitive, highly prunable. The workload a good layout makes nearly free — and the one that quietly triples when clustering breaks.',
  },
  {
    id: 'adhoc',
    name: 'the analyst',
    line: 'Wide, unpredictable projections with weak predicates. The pruning killer, and the reason quotas exist.',
  },
  {
    id: 'ingest',
    name: 'ingest & update',
    line: 'Continuous small commits with updates and deletes. The merge-on-read adversary: read amplification grows until compaction pays it down.',
  },
  {
    id: 'skew',
    name: 'the skewed join',
    line: 'One join key holding a disproportionate share of rows. Mean partition size stays flat while the job gets slower.',
  },
]

const MODE_BY_ID: Record<TraceModeId, TraceModeSpec> = TRACE_MODES.reduce(
  (acc, m) => {
    acc[m.id] = m
    return acc
  },
  {} as Record<TraceModeId, TraceModeSpec>,
)

export const traceMode = (id: TraceModeId): TraceModeSpec => MODE_BY_ID[id]

/**
 * The seed. One constant, exported, because a lesson that quotes a number from
 * the Warehouse is quoting *this* seed's trace — changing it invalidates
 * published numbers, so it should be a visible edit in a diff.
 */
export const TRACE_SEED = 0x5ca1_ab1e

/** 32 queries: long enough for ingest to accumulate small files, short enough to read. */
export const TRACE_LENGTH = 32

const DAYS = PARTITION_KEYS.find((p) => p.id === 'day')?.count ?? 90
const TENANTS = PARTITION_KEYS.find((p) => p.id === 'tenant')?.count ?? 64

/** A window of `width` of the domain, placed inside [floor, ceiling). */
function window_(rng: Rng, column: ColumnId, width: number, floor = 0, ceiling = 1): Predicate {
  const w = Math.min(width, ceiling - floor)
  const lo = rng.uniform(floor, ceiling - w)
  return { column, lo, hi: lo + w }
}

/** Exactly one slice of a discrete domain — a single day, a single tenant. */
function slice(rng: Rng, column: ColumnId, buckets: number, span = 1): Predicate {
  const k = rng.below(Math.max(1, buckets - span))
  return { column, lo: k / buckets, hi: (k + span) / buckets }
}

/* ------------------------------ dashboard ------------------------------ */

/**
 * Four tiles on one page, refreshed over and over. Repetition is the point:
 * the same four projections against a recent time window and one tenant, which
 * is precisely the shape that a day-partitioned, tenant-clustered layout makes
 * nearly free — and the shape whose bill triples the moment clustering rots.
 */
const DASHBOARD_TILES: { label: string; columns: ColumnId[] }[] = [
  { label: 'tile · revenue by hour', columns: ['ts', 'tenant_id', 'amount'] },
  { label: 'tile · event mix', columns: ['ts', 'tenant_id', 'event_type'] },
  { label: 'tile · regional split', columns: ['ts', 'tenant_id', 'region', 'amount'] },
  { label: 'tile · device breakdown', columns: ['ts', 'tenant_id', 'device'] },
]

function dashboardQuery(rng: Rng, id: number): Query {
  const tile = DASHBOARD_TILES[(id - 1) % DASHBOARD_TILES.length]
  /* A dashboard looks at the last few days, never at the whole history: the
   * window is placed in the newest 25% of the table. */
  const days = 1 + rng.below(3)
  const ts = window_(rng, 'ts', days / DAYS, 0.75, 1)
  const tenant = slice(rng, 'tenant_id', TENANTS)
  return {
    id,
    kind: 'scan',
    label: tile.label,
    columns: tile.columns,
    predicates: [ts, tenant],
    /* Group-bys over a few dozen buckets: an exchange, but a nearly even one. */
    shuffle: { key: 'event_type', hotShare: 0.04 },
    rowsWritten: 0,
  }
}

/* -------------------------------- adhoc -------------------------------- */

function adhocQuery(rng: Rng, id: number): Query {
  /* 4–7 columns, and payload lands in roughly a third of them — the analyst
   * writes SELECT * because they do not yet know which column matters. */
  const n = 4 + rng.below(4)
  const pool = COLUMN_IDS.filter((c) => c !== 'payload')
  const columns: ColumnId[] = []
  for (let i = 0; i < n; i++) {
    const c = pool[rng.below(pool.length)]
    if (!columns.includes(c)) columns.push(c)
  }
  if (rng.below(3) === 0) columns.push('payload')

  const predicates: Predicate[] = []
  const roll = rng.below(10)
  if (roll >= 3) {
    /* A predicate on whatever column the question is about, with a wide range:
     * this is why "just add a filter" does not rescue an ad-hoc workload. */
    const col = COLUMN_IDS[rng.below(COLUMN_IDS.length)]
    predicates.push(window_(rng, col, rng.uniform(0.2, 0.85)))
  }
  if (roll >= 8) {
    const col = COLUMN_IDS[rng.below(COLUMN_IDS.length)]
    predicates.push(window_(rng, col, rng.uniform(0.3, 0.9)))
  }

  return {
    id,
    kind: 'scan',
    label: predicates.length === 0 ? 'exploration · no predicate' : 'exploration · wide filter',
    columns,
    predicates,
    shuffle: rng.below(3) === 0 ? { key: 'user_id', hotShare: 0.06 } : null,
    rowsWritten: 0,
  }
}

/* -------------------------------- ingest ------------------------------- */

/**
 * A streaming pipeline with corrections: two appends, one update, one delete,
 * and a freshness check reading the newest data. Merge-on-read means the
 * update and the delete do not rewrite anything — they add files that every
 * later read has to open. Read amplification climbs until compaction runs,
 * which is exactly the curve the ingest and compaction desks grade.
 */
function ingestQuery(rng: Rng, id: number): Query {
  const phase = (id - 1) % 5
  if (phase === 4) {
    return {
      id,
      kind: 'scan',
      label: 'freshness check',
      columns: ['ts', 'tenant_id', 'event_type'],
      /* The newest slice only: a monitor asking "did the last batch land?" */
      predicates: [window_(rng, 'ts', 1 / DAYS, 0.97, 1)],
      shuffle: null,
      rowsWritten: 0,
    }
  }
  if (phase === 2) {
    return {
      id,
      kind: 'update',
      label: 'late-arriving correction',
      columns: [],
      predicates: [],
      shuffle: null,
      rowsWritten: 20_000 + rng.below(60_000),
    }
  }
  if (phase === 3) {
    return {
      id,
      kind: 'delete',
      label: 'GDPR erasure',
      columns: [],
      predicates: [],
      shuffle: null,
      rowsWritten: 5_000 + rng.below(25_000),
    }
  }
  return {
    id,
    kind: 'append',
    label: 'micro-batch commit',
    columns: [],
    predicates: [],
    shuffle: null,
    rowsWritten: 120_000 + rng.below(480_000),
  }
}

/* --------------------------------- skew -------------------------------- */

const SKEW_SHAPES: { label: string; columns: ColumnId[] }[] = [
  { label: 'join · usage rollup', columns: ['ts', 'tenant_id', 'amount'] },
  { label: 'join · per-tenant users', columns: ['ts', 'tenant_id', 'user_id'] },
  { label: 'join · tenant × device', columns: ['ts', 'tenant_id', 'device', 'amount'] },
]

function skewQuery(rng: Rng, id: number): Query {
  const shape = SKEW_SHAPES[(id - 1) % SKEW_SHAPES.length]
  return {
    id,
    kind: 'scan',
    label: shape.label,
    columns: shape.columns,
    /* Weeks, not days: wide enough that partition pruning helps but does not
     * save the job. The join is what hurts here, not the scan. */
    predicates: [window_(rng, 'ts', rng.uniform(0.1, 0.25))],
    /**
     * 42% of rows on one tenant. Not a worst case — a routine one: the largest
     * account in a Zipf tenant distribution really does hold this share, and it
     * is why the mean partition size stays flat while the job slows down.
     */
    shuffle: { key: 'tenant_id', hotShare: 0.42 },
    rowsWritten: 0,
  }
}

/* ------------------------------- builder ------------------------------- */

/**
 * Build a trace. Same (mode, seed, length) → byte-identical query list, which
 * is the property the whole page rests on: the reader's counts are comparable
 * to the reference's counts only because the queries are identical.
 */
export function buildTrace(
  mode: TraceModeId,
  seed: number = TRACE_SEED,
  length: number = TRACE_LENGTH,
): Trace {
  /* The mode is mixed into the seed so the four traces are independent streams
   * rather than four views of one stream — otherwise `dashboard` and `skew`
   * would share their first draws and look suspiciously correlated. */
  const rng = new Rng(BigInt(seed) ^ (BigInt(mode.length) << 32n) ^ BigInt(mode.charCodeAt(0)))
  const spec = traceMode(mode)
  const queries: Query[] = []
  for (let i = 1; i <= length; i++) {
    if (mode === 'dashboard') queries.push(dashboardQuery(rng, i))
    else if (mode === 'adhoc') queries.push(adhocQuery(rng, i))
    else if (mode === 'ingest') queries.push(ingestQuery(rng, i))
    else queries.push(skewQuery(rng, i))
  }
  return { mode, seed, name: spec.name, line: spec.line, queries }
}

/** Scans only — the queries that produce read metrics. */
export const scansOf = (t: Trace): Query[] => t.queries.filter((q) => q.kind === 'scan')

/** Write commits only — the queries that produce files. */
export const writesOf = (t: Trace): Query[] => t.queries.filter((q) => q.kind !== 'scan')
