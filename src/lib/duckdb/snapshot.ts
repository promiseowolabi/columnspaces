/**
 * snapshot — copy-on-write amplification, executed rather than described.
 *
 * ── What this is, stated before anything else ─────────────────────────────
 * This is NOT Iceberg and it is NOT Delta Lake. Neither runs in duckdb-wasm, and
 * pretending otherwise would be the exact dishonesty this course is written
 * against. What runs here is the copy-on-write ALGORITHM, performed by hand over
 * real Parquet files that DuckDB writes and reads in the reader's tab:
 *
 *   1. lay a "table" out as N Parquet data files, each holding a contiguous
 *      `order_id` range — the layout a partitioned, clustered table produces
 *   2. take a three-row update and find which files hold those rows, using the
 *      files' own footer statistics
 *   3. rewrite every affected file IN FULL, because a Parquet file is immutable:
 *      there is no way to change three rows inside one
 *   4. leave the originals on disk. The old file list is still a valid, readable
 *      snapshot, which is what time travel is
 *   5. expire: delete the files the new snapshot no longer references, and watch
 *      the storage come back and the old snapshot become unreadable
 *
 * Every byte count below is `file_size_bytes` from a real file's footer, and the
 * update is verified by reading both snapshots back: exactly three rows differ,
 * the row count is unchanged, and the old snapshot still returns the old values.
 *
 * ── What a real table format adds, named so the gap is not hidden ─────────
 * · MANIFESTS. Step 2 here reads every file's footer to find three rows. Iceberg
 *   reads a manifest list and then manifest files, so file selection costs a
 *   couple of reads instead of N. This lab reports the footer-read count exactly
 *   so that cost is visible — it is the reason manifests exist.
 * · ATOMIC COMMIT. Here the "snapshot" is a list held in a variable. A real format
 *   swaps a single pointer (a catalog compare-and-set, or an atomic metadata
 *   write), so a reader never sees a half-committed file set. Nothing in this lab
 *   provides that.
 * · SNAPSHOT ISOLATION and CONFLICT DETECTION. Two writers touching the same file
 *   here would silently clobber each other. A real format detects the conflict at
 *   commit and fails the loser.
 * · SCHEMA AND PARTITION EVOLUTION, field ids, and hidden partitioning.
 * · MERGE-ON-READ as the alternative to all of this: position or equality delete
 *   files, which move the cost from the write to every subsequent read. This lab
 *   deliberately measures only the copy-on-write side, so it does not get to claim
 *   anything about the tradeoff between the two beyond naming it.
 * · SNAPSHOT EXPIRY and ORPHAN FILE CLEANUP as maintenance jobs with their own
 *   retention policy. Expiry is performed here, but by this module, not by a
 *   catalog that knows which snapshots are still referenced by a reader.
 *
 * ── The measurement that matters ──────────────────────────────────────────
 * Three rows change. The engine rewrites whole files. The amplification is
 * `rows rewritten ÷ rows changed` and `bytes written ÷ bytes logically changed`,
 * and at any sane file size both are enormous. Then the counter-argument, measured
 * rather than asserted: shrinking the files shrinks the amplification, and the
 * bill for that is a larger file COUNT — more footers to read, more entries in
 * whatever manifests the format keeps, more requests per scan, and more total
 * bytes on disk for the same rows. Both directions are reported, because a lab
 * that only showed amplification falling would be an argument for one-row files.
 */

import { exec, query } from './client'
import { FIXTURE_SEED } from './fixtures'
import type { FileStore } from './vfs'

/** Rows in the simulated table. 128 × 2048, so every layout divides evenly. */
export const SNAPSHOT_ROWS = 262_144

export const SNAPSHOT_SEED = FIXTURE_SEED

export const SNAPSHOT_START = '2024-01-01 00:00:00'

export const SNAPSHOT_STEP_SECONDS = 123

/**
 * Row groups inside every data file, held constant across layouts so that the only
 * variable between layouts is where the FILE boundaries fall. Files smaller than
 * this end up with a single, smaller row group, which is what a real writer does.
 */
export const SNAPSHOT_ROW_GROUP_SIZE = 16_384

/** The update. Three rows — the number in the claim under test. */
export const SNAPSHOT_UPDATED_ROWS = 3

/**
 * The new value. Deliberately outside the generated status domain, so "exactly
 * three rows differ" is guaranteed rather than dependent on what the generator
 * happened to put in those rows.
 */
export const SNAPSHOT_NEW_STATUS = 'voided'

export const SNAPSHOT_STATUSES = ['new', 'paid', 'shipped', 'refunded']

/** Columns in the simulated table. */
export const SNAPSHOT_COLUMNS = [
  'order_id',
  'order_ts',
  'customer_id',
  'region',
  'status',
  'net_revenue',
]

/**
 * Where the three updated rows sit in the key space: near the front, the middle
 * and the back. Spread on purpose — three rows in one file is the lucky case, and
 * a lab that only measured the lucky case would understate the problem. The
 * layouts that hold everything in one file show the lucky case anyway.
 */
export const SNAPSHOT_TARGET_FRACTIONS = [0.1, 0.5, 0.9]

export const snapshotTargets = (rows: number = SNAPSHOT_ROWS): number[] =>
  SNAPSHOT_TARGET_FRACTIONS.map((f) => Math.floor(rows * f))

/* -------------------------------- the fixture ------------------------------- */

/**
 * The source table. `order_id` is dense and sorted so that a file holding a
 * contiguous id range is a realistic data file and its footer statistics locate
 * rows precisely — which is what lets step 2 be a real pruning decision rather
 * than a lookup in a list this module already has.
 */
export const snapshotSourceSql = (rows: number = SNAPSHOT_ROWS): string => `
CREATE OR REPLACE TABLE snapshot_source AS
SELECT
  i::INTEGER AS order_id,
  TIMESTAMP '${SNAPSHOT_START}' + INTERVAL (i * ${SNAPSHOT_STEP_SECONDS}) SECOND AS order_ts,
  ((hash(i * 5 + ${SNAPSHOT_SEED}) % 900000) + 100000)::INTEGER AS customer_id,
  ['EMEA','NA','APAC','LATAM','UK','DACH','NORDIC','ANZ'][((hash(i + ${SNAPSHOT_SEED}) % 8)::BIGINT) + 1] AS region,
  [${SNAPSHOT_STATUSES.map((s) => `'${s}'`).join(',')}][((hash(i * 11 + ${SNAPSHOT_SEED}) % ${SNAPSHOT_STATUSES.length})::BIGINT) + 1] AS status,
  ((hash(i * 3 + ${SNAPSHOT_SEED}) % 90000) / 100.0)::DOUBLE AS net_revenue
FROM range(${rows}) t(i)
ORDER BY order_id;
`

export interface SnapshotLayout {
  id: string
  label: string
  rowsPerFile: number
  /** Files the layout produces at `SNAPSHOT_ROWS`. */
  files: number
  why: string
}

const layout = (id: string, rowsPerFile: number, label: string, why: string): SnapshotLayout => ({
  id,
  label,
  rowsPerFile,
  files: Math.ceil(SNAPSHOT_ROWS / rowsPerFile),
  why,
})

/**
 * Four layouts of the same rows, spanning a factor of 64 in file size. This is the
 * dial a table format's target file size actually turns, and it is the dial that
 * decides what a three-row update costs.
 */
export const SNAPSHOT_LAYOUTS: SnapshotLayout[] = [
  layout(
    'f1',
    262_144,
    '1 file · 256k rows',
    'The whole table in one data file. A three-row update rewrites the table. This is the shape an unpartitioned bulk load produces, and it is why nobody runs a mutable table this way.',
  ),
  layout(
    'f4',
    65_536,
    '4 files · 64k rows',
    'Four files, and the three updated rows land in three of them. Three quarters of the table is rewritten to change three rows.',
  ),
  layout(
    'f16',
    16_384,
    '16 files · 16k rows',
    'The reference layout. The rewrite is now confined to three sixteenths of the table — still four orders of magnitude more rows than the update touched.',
  ),
  layout(
    'f64',
    4_096,
    '64 files · 4k rows',
    'Small files, and the amplification falls with them. This is where the tradeoff shows its other face: 64 footers to read on every plan, 64 manifest entries to keep, and more total bytes on disk for the same rows.',
  ),
]

export const REFERENCE_LAYOUT_ID = 'f16'

export const snapshotLayout = (id: string): SnapshotLayout =>
  SNAPSHOT_LAYOUTS.find((l) => l.id === id) ?? SNAPSHOT_LAYOUTS[0]

/** Path of one data file. `v` is the generation: 1 is the original, 2 the rewrite. */
export const dataFilePath = (layoutId: string, index: number, v: 1 | 2, dir = ''): string => {
  const base = `snap-${layoutId}-${String(index).padStart(3, '0')}-v${v}.parquet`
  return dir ? `${dir}/${base}` : base
}

export const writeFileSql = (
  table: string,
  lo: number,
  hi: number,
  into: string,
): string => `
COPY (
  SELECT * FROM ${table}
  WHERE order_id >= ${lo} AND order_id < ${hi}
  ORDER BY order_id
) TO '${into}' (FORMAT parquet, ROW_GROUP_SIZE ${SNAPSHOT_ROW_GROUP_SIZE}, COMPRESSION snappy);
`

/**
 * The rewrite. Note what this reads FROM: the old Parquet file, not the source
 * table. A copy-on-write engine does not have the original rows in memory — it
 * must read every row of every affected file and write them all back out. Reading
 * from the file is what makes the read amplification in the results real.
 */
export const rewriteFileSql = (from: string, into: string, targets: number[]): string => `
COPY (
  SELECT
    order_id,
    order_ts,
    customer_id,
    region,
    CASE WHEN order_id IN (${targets.join(', ')}) THEN '${SNAPSHOT_NEW_STATUS}' ELSE status END AS status,
    net_revenue
  FROM read_parquet('${from}')
  ORDER BY order_id
) TO '${into}' (FORMAT parquet, ROW_GROUP_SIZE ${SNAPSHOT_ROW_GROUP_SIZE}, COMPRESSION snappy);
`

let loaded = false

export async function loadSnapshotSource(
  onStep?: (s: string) => void,
  opts: { rows?: number } = {},
): Promise<void> {
  if (loaded) {
    onStep?.('source table already built')
    return
  }
  const rows = opts.rows ?? SNAPSHOT_ROWS
  onStep?.(`generating ${rows.toLocaleString('en-US')} rows`)
  await exec(snapshotSourceSql(rows))
  loaded = true
}

export const snapshotSourceLoaded = (): boolean => loaded

/* ------------------------------- SQL helpers -------------------------------- */

export const sqlList = (paths: string[]): string => `[${paths.map((p) => `'${p}'`).join(', ')}]`

export const bytesOfSql = (paths: string[]): string =>
  `SELECT coalesce(sum(file_size_bytes), 0)::BIGINT AS bytes,
          coalesce(sum(footer_size), 0)::BIGINT     AS footer_bytes,
          coalesce(sum(num_rows), 0)::BIGINT        AS rows,
          count(*)::BIGINT                          AS files
   FROM parquet_file_metadata(${sqlList(paths)})`

/** Fallback for builds without `footer_size`: sizes still work, footer bytes go null. */
export const bytesOfSqlNoFooter = (paths: string[]): string =>
  `SELECT coalesce(sum(file_size_bytes), 0)::BIGINT AS bytes,
          NULL::BIGINT                              AS footer_bytes,
          coalesce(sum(num_rows), 0)::BIGINT        AS rows,
          count(*)::BIGINT                          AS files
   FROM parquet_file_metadata(${sqlList(paths)})`

export interface FileSetSize {
  bytes: number
  footerBytes: number | null
  rows: number
  files: number
}

export async function fileSetSize(paths: string[]): Promise<FileSetSize> {
  if (paths.length === 0) return { bytes: 0, footerBytes: 0, rows: 0, files: 0 }
  for (const sql of [bytesOfSql(paths), bytesOfSqlNoFooter(paths)]) {
    try {
      const r = (
        await query<{ bytes: number; footer_bytes: number | null; rows: number; files: number }>(sql)
      )[0]
      if (r) {
        return { bytes: r.bytes, footerBytes: r.footer_bytes, rows: r.rows, files: r.files }
      }
    } catch {
      /* This build does not expose footer_size. Fall through to the plain shape. */
    }
  }
  throw new Error('could not read file sizes from parquet_file_metadata')
}

/**
 * Step 2, done properly: which files can possibly hold the target rows, decided
 * from the files' own footer statistics.
 *
 * `order_id` is an integer, so the VARCHAR statistics are cast to BIGINT and
 * compared numerically. Comparing them as text would be wrong for a
 * variable-width integer domain ('9' > '10'), which is the trap
 * `src/lib/duckdb/pruning.ts` avoids by padding its keys instead.
 */
export const locateSql = (paths: string[], targets: number[]): string => `
    WITH ranges AS (
      SELECT file_name,
             min(stats_min_value::BIGINT) AS lo,
             max(stats_max_value::BIGINT) AS hi
      FROM parquet_metadata(${sqlList(paths)})
      WHERE path_in_schema = 'order_id'
      GROUP BY 1
    ),
    truth AS (
      SELECT filename AS file_name, count(*)::BIGINT AS hits
      FROM read_parquet(${sqlList(paths)}, filename = true)
      WHERE order_id IN (${targets.join(', ')})
      GROUP BY 1
    )
    SELECT r.file_name,
           r.lo::BIGINT                       AS lo,
           r.hi::BIGINT                       AS hi,
           coalesce(t.hits, 0)::BIGINT        AS hits
    FROM ranges r
    LEFT JOIN truth t USING (file_name)
    ORDER BY r.lo
  `

export interface FileRange {
  file: string
  lo: number
  hi: number
  /** Target rows the file actually contains, counted from the data. */
  hits: number
  /** Would the footer statistics select this file? */
  selected: boolean
}

export async function locate(paths: string[], targets: number[]): Promise<FileRange[]> {
  const rows = await query<{ file_name: string; lo: number; hi: number; hits: number }>(
    locateSql(paths, targets),
  )
  return rows.map((r) => ({
    file: r.file_name,
    lo: r.lo,
    hi: r.hi,
    hits: r.hits,
    selected: targets.some((t) => r.lo <= t && t <= r.hi),
  }))
}

/* ------------------------------ the measurement ----------------------------- */

export interface CowResult {
  layoutId: string
  label: string
  rowsPerFile: number
  fileCount: number

  /* ── locating the rows ── */
  /** Footers this module had to read to find three rows. A manifest replaces these. */
  footersRead: number
  filesAffected: number
  /** A file the statistics excluded that actually held a target row. Must be 0. */
  missedFiles: number
  /** Files the statistics selected that held nothing. Cost, not incorrectness. */
  falsePositiveFiles: number

  /* ── the rewrite ── */
  rowsChanged: number
  rowsRewritten: number
  /** rowsRewritten ÷ rowsChanged. */
  rowAmplification: number
  /** Mean stored bytes per row in the original table. Used for the logical delta. */
  bytesPerRow: number
  /** rowsChanged × bytesPerRow — what the update logically alters. */
  logicalBytesChanged: number
  /** Bytes read to perform the rewrite: every affected file, in full. */
  bytesRead: number
  /** Bytes written: the replacement files, in full. */
  bytesWritten: number
  /** bytesWritten ÷ logicalBytesChanged. */
  byteAmplification: number

  /* ── storage after the commit ── */
  /** The old snapshot's file set. */
  snapshotOneBytes: number
  /** The new snapshot's file set — what a fresh reader sees. */
  snapshotTwoBytes: number
  /** Everything still on disk: both snapshots. */
  onDiskBytes: number
  /** Files the new snapshot no longer references. What time travel is holding. */
  supersededBytes: number
  supersededFiles: number
  /** onDiskBytes ÷ snapshotTwoBytes. The storage bill for one retained snapshot. */
  storageOverhead: number

  /* ── the cost of small files, which is the other half of the tradeoff ── */
  /** Live data files after the commit. What a manifest would have to list. */
  liveFileCount: number
  /** Footer bytes across the live file set: per-file overhead, paid per file. */
  liveFooterBytes: number | null

  /* ── correctness ── */
  rowsAfter: number
  rowsDiffering: number | null
  timeTravelRowsIntact: number | null

  /* ── expiry ── */
  expiryRan: boolean
  expiryReclaimedBytes: number
  onDiskAfterExpiry: number | null
  snapshotOneReadableAfterExpiry: boolean | null
  expiryUnavailableReason: string | null

  anomaly: string | null
}

/**
 * Perform one layout's copy-on-write update and measure it.
 *
 * `store` is optional. Without it everything up to and including "what expiry
 * would reclaim" is still measured from real files; only the deletion itself does
 * not happen, and the result says so rather than claiming reclaimed storage.
 */
export async function runCopyOnWrite(
  l: SnapshotLayout,
  opts: {
    dir?: string
    rows?: number
    store?: FileStore | null
    onStep?: (s: string) => void
  } = {},
): Promise<CowResult> {
  const dir = opts.dir ?? ''
  const rows = opts.rows ?? SNAPSHOT_ROWS
  const targets = snapshotTargets(rows)
  const fileCount = Math.ceil(rows / l.rowsPerFile)
  const anomalies: string[] = []

  /* ── snapshot 1: write the table ────────────────────────────────────────── */
  const v1: string[] = []
  for (let k = 0; k < fileCount; k += 1) {
    const path = dataFilePath(l.id, k, 1, dir)
    opts.onStep?.(`${l.label}: writing data file ${k + 1}/${fileCount}`)
    await exec(
      writeFileSql('snapshot_source', k * l.rowsPerFile, (k + 1) * l.rowsPerFile, path),
    )
    v1.push(path)
  }

  const one = await fileSetSize(v1)
  if (one.rows !== rows) {
    anomalies.push(
      `snapshot 1 holds ${one.rows.toLocaleString('en-US')} rows but the source has ${rows.toLocaleString('en-US')} — the file layout does not cover the table`,
    )
  }

  /* ── locate the three rows from the footers ─────────────────────────────── */
  opts.onStep?.(`${l.label}: reading ${fileCount} footer${fileCount === 1 ? '' : 's'} to locate 3 rows`)
  const ranges = await locate(v1, targets)
  const affected = ranges.filter((r) => r.selected).map((r) => r.file)
  const missedFiles = ranges.filter((r) => !r.selected && r.hits > 0).length
  const falsePositiveFiles = ranges.filter((r) => r.selected && r.hits === 0).length
  if (missedFiles > 0) {
    anomalies.push(
      `${missedFiles} file(s) holding a target row were excluded by their own statistics — a false negative, which is a correctness bug rather than a bill`,
    )
  }

  /* ── rewrite every affected file in full ────────────────────────────────── */
  const affectedSize = await fileSetSize(affected)
  /* Index by position rather than by parsing the path back apart. */
  const indexOf = new Map(v1.map((p, k) => [p, k]))
  const rewritten: string[] = []
  let i = 0
  for (const from of affected) {
    i += 1
    const index = indexOf.get(from)
    if (index === undefined) {
      anomalies.push(
        `the engine reported an affected file this module did not write: ${from} — the file-name round trip cannot be trusted, so the rewrite was skipped`,
      )
      continue
    }
    const into = dataFilePath(l.id, index, 2, dir)
    opts.onStep?.(`${l.label}: rewriting file ${i}/${affected.length} in full`)
    await exec(rewriteFileSql(from, into, targets))
    rewritten.push(into)
  }
  const rewrittenSize = await fileSetSize(rewritten)

  /* ── snapshot 2 = untouched originals + replacements ────────────────────── */
  const v2 = [...v1.filter((p) => !affected.includes(p)), ...rewritten]
  const two = await fileSetSize(v2)
  const onDisk = await fileSetSize([...new Set([...v1, ...v2])])

  /* ── correctness: exactly three rows differ, and time travel still works ── */
  let rowsDiffering: number | null = null
  let timeTravelRowsIntact: number | null = null
  try {
    const d = (
      await query<{ differing: number; intact: number }>(`
        SELECT
          (SELECT count(*)::BIGINT
             FROM read_parquet(${sqlList(v1)}) a
             JOIN read_parquet(${sqlList(v2)}) b USING (order_id)
            WHERE a.status <> b.status)                                        AS differing,
          (SELECT count(*)::BIGINT
             FROM read_parquet(${sqlList(v1)})
            WHERE order_id IN (${targets.join(', ')})
              AND status <> '${SNAPSHOT_NEW_STATUS}')                          AS intact
      `)
    )[0]
    if (d) {
      rowsDiffering = d.differing
      timeTravelRowsIntact = d.intact
    }
  } catch (e) {
    anomalies.push(
      `the correctness check could not run: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (rowsDiffering !== null && rowsDiffering !== targets.length) {
    anomalies.push(
      `the update was supposed to change exactly ${targets.length} rows and ${rowsDiffering} differ between the snapshots`,
    )
  }
  if (two.rows !== one.rows) {
    anomalies.push(
      `snapshot 2 holds ${two.rows.toLocaleString('en-US')} rows against snapshot 1's ${one.rows.toLocaleString('en-US')} — a copy-on-write update must not change the row count`,
    )
  }

  /* ── expiry: actually delete the superseded files ───────────────────────── */
  const superseded = v1.filter((p) => affected.includes(p))
  const supersededBytes = affectedSize.bytes
  let expiryRan = false
  let onDiskAfterExpiry: number | null = null
  let snapshotOneReadableAfterExpiry: boolean | null = null
  let expiryUnavailableReason: string | null = null

  if (opts.store) {
    try {
      opts.onStep?.(`${l.label}: expiring ${superseded.length} superseded file(s)`)
      for (const p of superseded) await opts.store.remove(p)
      expiryRan = true
      onDiskAfterExpiry = (await fileSetSize(v2)).bytes
      try {
        await query(`SELECT count(*) AS n FROM read_parquet(${sqlList(v1)})`)
        snapshotOneReadableAfterExpiry = true
        anomalies.push(
          'snapshot 1 was still readable after its files were deleted, which means expiry did not actually free anything in this environment',
        )
      } catch {
        snapshotOneReadableAfterExpiry = false
      }
    } catch (e) {
      expiryUnavailableReason = e instanceof Error ? e.message : String(e)
    }
  } else {
    expiryUnavailableReason =
      'no byte-level filesystem access in this build, so expiry was measured as reclaimable bytes but not performed'
  }

  const rowsChanged = targets.length
  const bytesPerRow = one.rows > 0 ? one.bytes / one.rows : 0

  return {
    layoutId: l.id,
    label: l.label,
    rowsPerFile: l.rowsPerFile,
    fileCount,

    footersRead: fileCount,
    filesAffected: affected.length,
    missedFiles,
    falsePositiveFiles,

    rowsChanged,
    rowsRewritten: rewrittenSize.rows,
    rowAmplification: rowsChanged > 0 ? rewrittenSize.rows / rowsChanged : 0,
    bytesPerRow,
    logicalBytesChanged: bytesPerRow * rowsChanged,
    bytesRead: affectedSize.bytes,
    bytesWritten: rewrittenSize.bytes,
    byteAmplification:
      bytesPerRow * rowsChanged > 0 ? rewrittenSize.bytes / (bytesPerRow * rowsChanged) : 0,

    snapshotOneBytes: one.bytes,
    snapshotTwoBytes: two.bytes,
    onDiskBytes: onDisk.bytes,
    supersededBytes,
    supersededFiles: superseded.length,
    storageOverhead: two.bytes > 0 ? onDisk.bytes / two.bytes : 0,

    liveFileCount: v2.length,
    liveFooterBytes: two.footerBytes,

    rowsAfter: two.rows,
    rowsDiffering,
    timeTravelRowsIntact,

    expiryRan,
    expiryReclaimedBytes: supersededBytes,
    onDiskAfterExpiry,
    snapshotOneReadableAfterExpiry,
    expiryUnavailableReason,

    anomaly: anomalies.length > 0 ? anomalies.join('; ') : null,
  }
}

export type SnapshotGrid = Record<string, CowResult>

/**
 * Every layout, in order, largest files first. Enumerated so the test suite
 * measures exactly what the reader sees.
 */
export async function runAllLayouts(
  opts: {
    dir?: string
    rows?: number
    store?: FileStore | null
    onStep?: (s: string) => void
  } = {},
): Promise<SnapshotGrid> {
  const grid: SnapshotGrid = {}
  for (const l of SNAPSHOT_LAYOUTS) {
    grid[l.id] = await runCopyOnWrite(l, opts)
  }
  return grid
}

/* --------------------------------- formatting ------------------------------- */

export const fmtCount = (n: number): string => n.toLocaleString('en-US')

export const fmtAmplification = (n: number): string =>
  n >= 1000 ? `${Math.round(n).toLocaleString('en-US')}×` : n >= 10 ? `${n.toFixed(0)}×` : `${n.toFixed(2)}×`

export const fmtOverhead = (n: number): string => `${n.toFixed(2)}×`
