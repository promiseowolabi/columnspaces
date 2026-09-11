/**
 * bill — what a query has to read, computed from the file's own metadata.
 *
 * ── What this measures, precisely ──────────────────────────────────────────
 * DuckDB does not expose an instrumented "bytes read from storage" counter, and
 * inventing one would be exactly the sin this course is about. So the bill is
 * computed the way a query planner computes it, from the same inputs:
 *
 *   bytes = SUM(total_compressed_size) over the column chunks belonging to
 *           (a) the columns the query projects, in
 *           (b) the row groups whose min/max statistics cannot be ruled out
 *               by the predicate
 *
 * Every term is real: `parquet_metadata()` reads the actual footer of an actual
 * Parquet file written by an actual writer. The compressed sizes are the bytes on
 * "disk"; the statistics are the ones the engine itself consults. What this is
 * NOT is a syscall trace — a real engine may read slightly more (page headers,
 * the footer itself, read-ahead) or slightly less (dictionary-only pages, late
 * materialization). It is the planner's bill, and the planner's bill is what you
 * are charged for on a consumption platform.
 *
 * We then corroborate the pruning term against the engine's own behaviour via
 * `EXPLAIN ANALYZE`, so the reader is not taking our arithmetic on trust either.
 */

import { query, queryOne } from './client'

export interface ChunkRow {
  row_group_id: number
  path_in_schema: string
  total_compressed_size: number
  total_uncompressed_size: number
  num_values: number
  compression: string
  stats_min_value: string | null
  stats_max_value: string | null
}

/** Every column chunk in a file, with its size and statistics. */
export async function chunks(path: string): Promise<ChunkRow[]> {
  return query<ChunkRow>(`
    SELECT
      row_group_id::BIGINT           AS row_group_id,
      path_in_schema,
      total_compressed_size::BIGINT  AS total_compressed_size,
      total_uncompressed_size::BIGINT AS total_uncompressed_size,
      num_values::BIGINT             AS num_values,
      compression,
      stats_min_value,
      stats_max_value
    FROM parquet_metadata('${path}')
  `)
}

export interface Bill {
  /** Bytes of every column chunk in the file. What SELECT * with no predicate costs. */
  wholeFileBytes: number
  /** Bytes of the projected columns, all row groups. Projection only, no pruning. */
  projectedBytes: number
  /** Bytes of the projected columns in surviving row groups. Projection AND pruning. */
  prunedBytes: number
  /** Row groups in the file. */
  rowGroups: number
  /** Row groups the predicate cannot rule out. */
  rowGroupsRead: number
  /** 1 - read/total. The number to put on a dashboard. */
  pruningRatio: number
  /** wholeFileBytes / projectedBytes. */
  projectionFactor: number
  /** projectedBytes / prunedBytes. */
  pruningFactor: number
  /** wholeFileBytes / prunedBytes — the two factors multiplied. */
  totalFactor: number
  /** Uncompressed ÷ compressed over the projected columns. */
  compressionRatio: number
}

export interface BillInput {
  path: string
  /** Columns the query projects. */
  columns: string[]
  /**
   * The predicate, expressed as a range on one column. `null` means no
   * predicate, which is the honest way to show that pruning then does nothing.
   */
  predicate: { column: string; min?: string; max?: string } | null
}

/**
 * A row group survives when its statistics cannot rule it out. Note the
 * direction of the test: we keep anything we cannot exclude. That asymmetry is
 * the invariant forge lab 02 grades — a false negative (skipping a group that
 * held a match) is a correctness bug; a false positive is only a bill.
 */
function survives(c: ChunkRow, min?: string, max?: string): boolean {
  /* No statistics means no basis for skipping. Read it. */
  if (c.stats_min_value === null || c.stats_max_value === null) return true
  if (min !== undefined && c.stats_max_value < min) return false
  if (max !== undefined && c.stats_min_value > max) return false
  return true
}

export async function computeBill(input: BillInput): Promise<Bill> {
  const all = await chunks(input.path)
  if (all.length === 0) throw new Error(`no parquet metadata for ${input.path}`)

  const rowGroupIds = [...new Set(all.map((c) => c.row_group_id))]
  const projected = new Set(input.columns)

  const wholeFileBytes = all.reduce((n, c) => n + c.total_compressed_size, 0)

  const projectedChunks = all.filter((c) => projected.has(c.path_in_schema))
  const projectedBytes = projectedChunks.reduce((n, c) => n + c.total_compressed_size, 0)
  const projectedUncompressed = projectedChunks.reduce((n, c) => n + c.total_uncompressed_size, 0)

  /*
   * Pruning is decided per ROW GROUP, using the statistics of the predicate's
   * column — not per chunk. Getting this wrong (testing each projected column's
   * own statistics) is a classic error that reports impossible pruning.
   */
  let survivingGroups: Set<number>
  if (input.predicate === null) {
    survivingGroups = new Set(rowGroupIds)
  } else {
    const { column, min, max } = input.predicate
    survivingGroups = new Set(
      all
        .filter((c) => c.path_in_schema === column && survives(c, min, max))
        .map((c) => c.row_group_id),
    )
  }

  const prunedBytes = projectedChunks
    .filter((c) => survivingGroups.has(c.row_group_id))
    .reduce((n, c) => n + c.total_compressed_size, 0)

  const safe = (a: number, b: number) => (b > 0 ? a / b : 0)

  return {
    wholeFileBytes,
    projectedBytes,
    prunedBytes,
    rowGroups: rowGroupIds.length,
    rowGroupsRead: survivingGroups.size,
    pruningRatio: rowGroupIds.length > 0 ? 1 - survivingGroups.size / rowGroupIds.length : 0,
    projectionFactor: safe(wholeFileBytes, projectedBytes),
    pruningFactor: safe(projectedBytes, prunedBytes),
    totalFactor: safe(wholeFileBytes, prunedBytes),
    compressionRatio: safe(projectedUncompressed, projectedBytes),
  }
}

/**
 * Corroboration: ask the engine how many rows it actually scanned.
 *
 * If our metadata arithmetic says 90% of row groups are skippable, the engine's
 * own scan should report roughly a tenth of the rows. Two independent routes to
 * the same claim is the difference between a measurement and an assertion.
 */
export async function rowsScanned(sql: string): Promise<number | null> {
  const plan = await queryOne<{ explain_value: string }>(
    `EXPLAIN ANALYZE ${sql.replace(/;\s*$/, '')}`,
  )
  if (!plan) return null
  /* The profile prints per-operator cardinalities; take the scan's. */
  const m = plan.explain_value.match(/TABLE_SCAN[\s\S]{0,400}?(\d[\d,]*)\s*Rows/i)
  if (!m) return null
  return Number(m[1].replace(/,/g, ''))
}

/** Bytes → a short human string. Binary units, because that is what you provision. */
export function fmtBytes(bytes: number): string {
  const KIB = 1024
  const MIB = 1024 * KIB
  const GIB = 1024 * MIB
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`
  if (bytes >= KIB) return `${(bytes / KIB).toFixed(0)} KiB`
  return `${bytes} B`
}

export const fmtFactor = (f: number): string => (f >= 10 ? `${f.toFixed(0)}×` : `${f.toFixed(1)}×`)
