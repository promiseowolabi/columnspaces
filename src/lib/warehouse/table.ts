/**
 * table.ts — the one table The Warehouse is built on.
 *
 * The trace names columns and the engine prices them, so the schema has to sit
 * where both can see it without either importing the other. That is the whole
 * reason this file exists: `trace.ts → table.ts ← engine.ts` is acyclic, and a
 * cycle here would be the kind of import loop that only shows up as an
 * undefined-at-module-init crash in the built bundle, never in a unit test.
 *
 * The table is a wide event fact table because that is the shape that makes
 * columnar layout decisions *matter*: one 96-byte payload column dwarfs the
 * seven narrow ones, so projection is worth more here than any encoding — and
 * the reader should be able to see that in the counts rather than be told it.
 *
 * Every number below is a COUNT (rows, bytes, distinct values). There is no
 * wall-clock anywhere in the Warehouse: a count means the same thing on every
 * machine, which is what makes a run replayable and diffable against the
 * reference.
 */

/* Imported directly from `desks/kit` rather than from `desks/index`, because
 * the index pulls in the whole desk registry (and the lesson types with it).
 * The Warehouse is a route chunk; it should carry the RNG, not the curriculum. */
import { Rng } from '@/lib/desks/kit'

export type ColumnId =
  | 'ts'
  | 'tenant_id'
  | 'region'
  | 'event_type'
  | 'user_id'
  | 'device'
  | 'amount'
  | 'payload'

export type ColumnKind = 'ts' | 'int' | 'float' | 'string'

export interface ColumnSpec {
  id: ColumnId
  kind: ColumnKind
  /** Uncompressed bytes per value. Strings are quoted at their mean length. */
  width: number
  /** Distinct values in the whole table — the number every encoding model needs. */
  cardinality: number
  /** What this column is for, in one clause, for the UI. */
  label: string
}

/**
 * Widths and cardinalities are the model's inputs, not measurements: they are
 * a plausible clickstream table, stated so the reader can argue with them. The
 * spread matters more than the absolute values — a 96-byte payload next to a
 * 4-byte tenant id is what makes projection the dominant lever.
 */
export const COLUMNS: ColumnSpec[] = [
  { id: 'ts', kind: 'ts', width: 8, cardinality: 2_592_000, label: 'event time, second resolution' },
  { id: 'tenant_id', kind: 'int', width: 4, cardinality: 64, label: 'customer account' },
  { id: 'region', kind: 'string', width: 12, cardinality: 6, label: 'deployment region' },
  { id: 'event_type', kind: 'string', width: 16, cardinality: 24, label: 'event name' },
  { id: 'user_id', kind: 'int', width: 8, cardinality: 4_000_000, label: 'end user' },
  { id: 'device', kind: 'string', width: 10, cardinality: 400, label: 'device class' },
  { id: 'amount', kind: 'float', width: 8, cardinality: 1_000_000, label: 'measured value' },
  { id: 'payload', kind: 'string', width: 96, cardinality: 120_000_000, label: 'raw event body' },
]

export const COLUMN_IDS: ColumnId[] = COLUMNS.map((c) => c.id)

const BY_ID: Record<ColumnId, ColumnSpec> = COLUMNS.reduce(
  (acc, c) => {
    acc[c.id] = c
    return acc
  },
  {} as Record<ColumnId, ColumnSpec>,
)

export const column = (id: ColumnId): ColumnSpec => BY_ID[id]

/** Uncompressed bytes for one whole row — the denominator of every projection win. */
export const ROW_WIDTH = COLUMNS.reduce((n, c) => n + c.width, 0)

/**
 * 180M rows ≈ 28 GB uncompressed. Big enough that pruning is the difference
 * between a cheap dashboard and an expensive one, small enough that every
 * count on the page fits in a reader's head.
 */
export const TABLE_ROWS = 180_000_000

export type PartitionKeyId = 'none' | 'day' | 'tenant' | 'region'

export interface PartitionKeySpec {
  id: PartitionKeyId
  /** The column the partition value is derived from — `null` for an unpartitioned table. */
  column: ColumnId | null
  /** How many partitions the key produces. */
  count: number
  label: string
  line: string
}

export const PARTITION_KEYS: PartitionKeySpec[] = [
  {
    id: 'day',
    column: 'ts',
    count: 90,
    label: 'day',
    line: 'One directory per day. Prunes any query with a time range — which is most of them.',
  },
  {
    id: 'tenant',
    column: 'tenant_id',
    count: 64,
    label: 'tenant',
    line: 'One directory per account. Prunes per-tenant queries; sizes are Zipf, so the partitions are wildly uneven.',
  },
  {
    id: 'region',
    column: 'region',
    count: 6,
    label: 'region',
    line: 'Six coarse partitions. Cheap metadata, almost no pruning — the key that looks tidy and buys nothing.',
  },
  {
    id: 'none',
    column: null,
    count: 1,
    label: 'none',
    line: 'One flat set of files. Every query is a full file list; only row-group statistics can save you.',
  },
]

const PK_BY_ID: Record<PartitionKeyId, PartitionKeySpec> = PARTITION_KEYS.reduce(
  (acc, p) => {
    acc[p.id] = p
    return acc
  },
  {} as Record<PartitionKeyId, PartitionKeySpec>,
)

export const partitionKey = (id: PartitionKeyId): PartitionKeySpec => PK_BY_ID[id]

/**
 * The table's own seed. Fixed, and deliberately separate from the trace seed:
 * the data layout must not change when the reader switches trace mode, or the
 * two runs would not be comparable and the divergence panel would be lying.
 */
export const TABLE_SEED = 0xc01d_5eed

/**
 * Rows per partition for a given key.
 *
 * Day partitions get a mild growth trend plus jitter; tenant and region
 * partitions are drawn Zipf, because real tenant sizes are brutally skewed and
 * a uniform assumption is exactly why capacity models and shuffle estimates
 * come in low. Totals are normalised back to TABLE_ROWS so the *same table*
 * is being described no matter how it is cut — otherwise a partition-key
 * change would silently change the bill.
 */
export function partitionRows(key: PartitionKeyId): number[] {
  const spec = partitionKey(key)
  if (spec.count <= 1) return [TABLE_ROWS]

  const rng = new Rng(TABLE_SEED)
  const weights: number[] = []
  for (let i = 0; i < spec.count; i++) {
    if (key === 'day') {
      /* +40% volume across the window, ±15% day-to-day noise. */
      const trend = 1 + 0.4 * (i / (spec.count - 1))
      weights.push(trend * rng.uniform(0.85, 1.15))
    } else {
      weights.push(rng.zipfSize(spec.count * 4, 1.1))
    }
  }

  const total = weights.reduce((a, b) => a + b, 0)
  const out = weights.map((w) => Math.max(1, Math.round((w / total) * TABLE_ROWS)))

  /* Rounding drift lands on the largest partition, so no partition can end up
   * with zero (or negative) rows — a zero-row partition would divide by zero
   * in the pruning model. */
  const drift = TABLE_ROWS - out.reduce((a, b) => a + b, 0)
  let biggest = 0
  for (let i = 1; i < out.length; i++) if (out[i] > out[biggest]) biggest = i
  out[biggest] = Math.max(1, out[biggest] + drift)
  return out
}
