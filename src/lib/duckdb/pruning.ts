/**
 * pruning — the row-group survival experiment, expressed as SQL and arithmetic
 * so the browser lab and the test suite run the identical thing.
 *
 * ── What this module is for ────────────────────────────────────────────────
 * C2's whole subject is that a table has exactly one physical order, and that
 * pruning is available only to predicates that order happens to serve. Three
 * dials decide how much the planner can skip, and this module builds a fixture
 * that isolates each of them:
 *
 *   1. ROW GROUP SIZE — how coarse the min/max summary is. Finer groups prune
 *      more and cost more footer. Both edges are measured here: row groups,
 *      statistics entries and footer bytes, not just a pruning percentage.
 *   2. WHICH COLUMN the predicate names — the lesson. Against a file written in
 *      timestamp order, a same-selectivity predicate on `customer_id` prunes
 *      essentially nothing, and the same file's `order_ts` predicate prunes
 *      essentially everything. Nothing was configured differently.
 *   3. SELECTIVITY — a one-day window prunes almost every group; a two-year
 *      window over a two-year table prunes none, on any layout, ever.
 *
 * ── Why a dedicated fixture rather than PARQUET_FIXTURES ───────────────────
 * `src/lib/duckdb/fixtures.ts` writes three files from a 45-column table, sized
 * to make PROJECTION vivid. Sweeping five row-group sizes over that table would
 * put several gigabytes through a browser tab to demonstrate something four
 * columns show exactly as well. So this fixture is narrow — `order_ts`,
 * `customer_id`, `region`, `net_revenue` — and the sweep is affordable. The
 * pruning ARITHMETIC is not reimplemented: every byte count here comes from
 * `computeBill`, the same function the scan-bill lab uses.
 *
 * ── Two fixture decisions that are load-bearing ────────────────────────────
 * · `customer_id` is drawn from [100000, 999999] — a fixed six-digit range.
 *   That is not decoration. `parquet_metadata` hands statistics back as VARCHAR
 *   and `computeBill` compares them as strings, which is exact for DuckDB's
 *   timestamp rendering but would be wrong for variable-width integers
 *   ('9' > '10'). A fixed-width decimal domain makes lexicographic order and
 *   numeric order the same order, so the shared comparison stays correct. The
 *   test suite verifies both the width and the absence of false negatives
 *   rather than trusting the argument.
 * · Every requested row-group size is a multiple of 2048. DuckDB rounds
 *   ROW_GROUP_SIZE to a multiple of its 2048-row vector, so requesting 2500
 *   silently gets you 4096. Requesting multiples means the label matches the
 *   file, and the measurement reports the file's actual value regardless.
 *
 * ── What the numbers are, and are not ──────────────────────────────────────
 * These are Snappy-compressed Parquet files written by DuckDB's own writer at
 * reduced scale. Every count is read out of the files' own footers — the same
 * statistics the planner consults — so this is the planner's bill, not a syscall
 * trace. A real engine reads a little more (page headers, read-ahead) and
 * sometimes a little less (dictionary-only pages, late materialization).
 */

import { computeBill } from './bill'
import { exec, query } from './client'
import { FIXTURE_SEED } from './fixtures'

/** Rows in the pruning fixture. A multiple of 2048, so row groups divide evenly. */
export const PRUNING_ROWS = 512_000

/** Same seed lineage as every other fixture in the course. Determinism is the point. */
export const PRUNING_SEED = FIXTURE_SEED

/** Seconds between successive rows. Integer, so timestamp statistics carry no fractional part. */
export const PRUNING_STEP_SECONDS = 123

/** The history the fixture spans, in seconds. 512,000 × 123 s ≈ 729 days. */
export const PRUNING_SPAN_SECONDS = PRUNING_ROWS * PRUNING_STEP_SECONDS

/** First timestamp in the fixture. */
export const PRUNING_START = '2024-01-01 00:00:00'

/** DuckDB's vector size. ROW_GROUP_SIZE is rounded to a multiple of it. */
export const VECTOR_SIZE = 2_048

/** `customer_id` domain — fixed six-digit width, see the header note. */
export const CUSTOMER_MIN = 100_000
export const CUSTOMER_MAX = 999_999

/**
 * The columns the query reads. Both predicate columns are projected in every
 * configuration on purpose: if the customer_id row projected 4 bytes/row and the
 * order_ts row projected 8, the byte comparison between them would be measuring
 * type width instead of pruning.
 */
export const PROJECTION = ['order_ts', 'customer_id', 'net_revenue']

/** Every column in the fixture. `region` is here to be a column nobody projects. */
export const FIXTURE_COLUMNS = ['order_ts', 'customer_id', 'region', 'net_revenue']

/* -------------------------------- the fixture ------------------------------- */

/**
 * The source table, in timestamp order.
 *
 * `ORDER BY order_ts` is stated rather than inherited from the generator: the
 * clustering is the experimental condition, and an experimental condition should
 * be visible in the SQL rather than be a side effect of counting upwards.
 */
export const pruningSourceSql = (rows: number = PRUNING_ROWS): string => `
CREATE OR REPLACE TABLE pruning_source AS
SELECT
  TIMESTAMP '${PRUNING_START}' + INTERVAL (i * ${PRUNING_STEP_SECONDS}) SECOND AS order_ts,
  ((hash(i * 5 + ${PRUNING_SEED}) % ${CUSTOMER_MAX - CUSTOMER_MIN + 1}) + ${CUSTOMER_MIN})::INTEGER AS customer_id,
  ['EMEA','NA','APAC','LATAM','UK','DACH','NORDIC','ANZ'][((hash(i + ${PRUNING_SEED}) % 8)::BIGINT) + 1] AS region,
  ((hash(i * 3 + ${PRUNING_SEED}) % 90000) / 100.0)::DOUBLE AS net_revenue
FROM range(${rows}) t(i)
ORDER BY order_ts;
`

/**
 * The same rows in the other physical order. This is the file that makes the
 * "one physical order" point concrete: it prunes the customer predicate and
 * starves the timestamp one, which is exactly the trade the other file makes in
 * reverse.
 */
export const pruningByCustomerSql = (): string => `
CREATE OR REPLACE TABLE pruning_by_customer AS
SELECT * FROM pruning_source ORDER BY customer_id;
`

export type ClusterKey = 'order_ts' | 'customer_id'

export interface PruningFile {
  id: string
  /** Path inside duckdb's virtual filesystem (or a basename under a temp dir in tests). */
  file: string
  /** Which table the file is written from. */
  table: 'pruning_source' | 'pruning_by_customer'
  /** The physical order the rows were written in. */
  clusterBy: ClusterKey
  /** Rows per row group as requested. Always a multiple of VECTOR_SIZE. */
  rowGroupSize: number
  label: string
  why: string
}

/**
 * The row-group sweep: five files, identical rows, identical order, identical
 * codec. Only the size of the summarised block differs — a factor of 128 from
 * end to end, from 2 row groups to 250.
 */
export const ROW_GROUP_VARIANTS: PruningFile[] = [
  {
    id: 'rg-256k',
    file: 'pruning-rg-256k.parquet',
    table: 'pruning_source',
    clusterBy: 'order_ts',
    rowGroupSize: 262_144,
    label: '256k rows/group',
    why: 'Two row groups for the whole table. The best a predicate can do is skip one of them, so 50% is the ceiling however narrow the window gets.',
  },
  {
    id: 'rg-128k',
    file: 'pruning-rg-128k.parquet',
    table: 'pruning_source',
    clusterBy: 'order_ts',
    rowGroupSize: 131_072,
    label: '128k rows/group',
    why: 'Four groups. Halving the block doubles the resolution of the summary, and the pruning ceiling moves with it.',
  },
  {
    id: 'rg-32k',
    file: 'pruning-rg-32k.parquet',
    table: 'pruning_source',
    clusterBy: 'order_ts',
    rowGroupSize: 32_768,
    label: '32k rows/group',
    why: 'Sixteen groups. Around here the pruning percentage starts to look like the numbers vendors quote.',
  },
  {
    id: 'rg-8k',
    file: 'pruning-rg-8k.parquet',
    table: 'pruning_source',
    clusterBy: 'order_ts',
    rowGroupSize: 8_192,
    label: '8k rows/group',
    why: 'The reference file for the other two panels. Sixty-three groups: fine enough that a narrow window lands inside one or two of them.',
  },
  {
    id: 'rg-2k',
    file: 'pruning-rg-2k.parquet',
    table: 'pruning_source',
    clusterBy: 'order_ts',
    rowGroupSize: VECTOR_SIZE,
    label: '2k rows/group',
    why: 'The floor DuckDB allows, and far below anything sane in production. 250 groups buys a couple more points of pruning for four times the footer — this is the edge of the dial where refinement stops paying.',
  },
]

/** The reference row-group size, used by the column and selectivity panels. */
export const REFERENCE_FILE_ID = 'rg-8k'

/** The same rows written in customer order. One file, at the reference size. */
export const CUSTOMER_CLUSTERED: PruningFile = {
  id: 'cust-8k',
  file: 'pruning-cust-8k.parquet',
  table: 'pruning_by_customer',
  clusterBy: 'customer_id',
  rowGroupSize: 8_192,
  label: 'clustered on customer_id',
  why: 'Byte-identical rows, written in customer order instead of timestamp order. Same writer, same codec, same row-group size. It prunes the other predicate.',
}

export const PRUNING_FILES: PruningFile[] = [...ROW_GROUP_VARIANTS, CUSTOMER_CLUSTERED]

/** Resolve a fixture's path. `dir` is empty in the browser and a temp dir in tests. */
export const pruningPath = (f: PruningFile, dir = ''): string =>
  dir ? `${dir}/${f.file}` : f.file

export const copyPruningSql = (f: PruningFile, into: string = f.file): string =>
  `COPY ${f.table} TO '${into}' (FORMAT parquet, ROW_GROUP_SIZE ${f.rowGroupSize}, COMPRESSION snappy);`

/* ------------------------------- the predicates ----------------------------- */

export interface PruningWindow {
  id: string
  label: string
  days: number
  /** Fraction of the table the window selects. Clamped at 1. */
  selectivity: number
}

const windowSelectivity = (days: number): number =>
  Math.min(1, (days * 86_400) / PRUNING_SPAN_SECONDS)

/**
 * Four windows, spanning three orders of magnitude of selectivity. The last one
 * covers the whole history and therefore cannot prune on any layout — which is
 * the honest end of the curve, not a broken measurement.
 */
export const WINDOWS: PruningWindow[] = [
  { id: '1d', label: '1 day', days: 1, selectivity: windowSelectivity(1) },
  { id: '7d', label: '7 days', days: 7, selectivity: windowSelectivity(7) },
  { id: '90d', label: '90 days', days: 90, selectivity: windowSelectivity(90) },
  { id: '2y', label: '2 years', days: 730, selectivity: windowSelectivity(730) },
]

export const REFERENCE_WINDOW_ID = '7d'

export interface PruningPredicate {
  column: ClusterKey
  /** Inclusive lower bound as the string the statistics are compared against. */
  min: string
  /** Inclusive upper bound, or undefined for an open-ended range. */
  max?: string
  /** The same predicate as SQL, for counting matching rows in the audit. */
  sql: string
  label: string
}

/** `YYYY-MM-DD HH:MM:SS`, the format DuckDB renders timestamp statistics in. */
const fmtTimestamp = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

const START_MS = Date.parse(`${PRUNING_START}Z`)

/**
 * The trailing-window predicate on the clustered column: the last N days of
 * history, which is what a dashboard actually asks for.
 */
export function tsPredicate(w: PruningWindow): PruningPredicate {
  const back = Math.max(0, PRUNING_SPAN_SECONDS - w.days * 86_400)
  const min = fmtTimestamp(START_MS + back * 1000)
  return {
    column: 'order_ts',
    min,
    sql: `order_ts >= TIMESTAMP '${min}'`,
    label: `order_ts >= '${min}'`,
  }
}

/** Six digits, so lexicographic order and numeric order agree. See the header. */
const customerBound = (n: number): string =>
  String(Math.min(CUSTOMER_MAX, Math.max(CUSTOMER_MIN, n))).padStart(6, '0')

/**
 * The wrong-column predicate: a `customer_id` range chosen to select the SAME
 * fraction of rows as the timestamp window it is paired with, so the only thing
 * that differs between the two is which column the predicate names.
 *
 * The window sits in the middle of the domain rather than at its edge. At the
 * edge, a small row group could occasionally contain no low ids and get pruned
 * by luck, which would put noise into the number the lesson rests on.
 */
export function customerPredicate(w: PruningWindow): PruningPredicate {
  const domain = CUSTOMER_MAX - CUSTOMER_MIN + 1
  const width = Math.max(1, Math.round(domain * w.selectivity))
  const mid = CUSTOMER_MIN + Math.round(domain / 2)
  const lo = Math.max(CUSTOMER_MIN, Math.min(CUSTOMER_MAX - width + 1, mid - Math.floor(width / 2)))
  const hi = Math.min(CUSTOMER_MAX, lo + width - 1)
  return {
    column: 'customer_id',
    min: customerBound(lo),
    max: customerBound(hi),
    sql: `customer_id BETWEEN ${lo} AND ${hi}`,
    label: `customer_id BETWEEN ${lo} AND ${hi}`,
  }
}

export const predicateFor = (column: ClusterKey, w: PruningWindow): PruningPredicate =>
  column === 'order_ts' ? tsPredicate(w) : customerPredicate(w)

/* ------------------------------- the footer shape --------------------------- */

/**
 * Row groups, statistics entries and the per-group row count, from the footer.
 *
 * A "statistics entry" is one column chunk's metadata — its offsets, its
 * encoding, and its min/max/null-count triple. There is one per column per row
 * group, so this count is the metadata the planner must parse BEFORE it can skip
 * anything, and it grows with exactly the dial that improves pruning.
 */
export const shapeSql = (file: string): string => `
    SELECT
      count(*)::BIGINT                      AS stats_entries,
      count(DISTINCT row_group_id)::BIGINT  AS row_groups,
      max(num_values)::BIGINT               AS group_rows,
      count(DISTINCT num_values)::BIGINT    AS distinct_group_sizes
    FROM parquet_metadata('${file}')
  `

/**
 * Footer bytes, straight from the file header block that records them.
 *
 * DuckDB has renamed this column across releases, so both spellings are tried
 * and the measurement degrades to `null` rather than failing the lab. The lab's
 * primary metadata metric is a COUNT (row groups, statistics entries), which is
 * available everywhere; footer bytes are the sharper version of the same claim
 * when the build offers them.
 */
export const FOOTER_SQL_CANDIDATES: string[] = ['footer_size', 'footer_size_bytes'].map(
  (col) => `
    SELECT ${col}::BIGINT AS footer_bytes, file_size_bytes::BIGINT AS file_bytes
    FROM parquet_file_metadata('%FILE%')
  `,
)

export const footerSqlFor = (file: string, candidate: string): string =>
  candidate.replace('%FILE%', file)

/* --------------------------------- the audit -------------------------------- */

/**
 * The correctness audit, and the reason this lab is not just a cost demo.
 *
 * Pruning has two ways to be wrong and they are not comparable. A false positive
 * — reading a group that held no match — costs money. A false NEGATIVE — skipping
 * a group that held a match — returns a wrong answer with no error. So every
 * configuration this lab reports is checked: count the matching rows per row
 * group with the engine's own typed evaluation of the predicate, then confirm
 * that no group containing a match was skipped.
 *
 * Two details make this an audit rather than a restatement:
 *
 *   · The surviving set is re-derived here in SQL from the same statistics, and
 *     its SIZE is cross-checked against `computeBill`'s independent TypeScript
 *     answer. Disagreement is surfaced, not smoothed.
 *   · The matching-row side is evaluated by DuckDB on typed values, not by
 *     string comparison. So if the statistics comparison were wrong — the
 *     lexicographic-integer trap this fixture is built to avoid — the rows would
 *     still be counted correctly and the false negative would appear.
 *
 * Row groups are located by `file_row_number // groupRows`, which is exact when
 * every group but the last holds `groupRows` rows. `shapeSql` reports
 * `distinct_group_sizes` so that assumption is checked rather than assumed.
 */
export const auditSql = (file: string, p: PruningPredicate, groupRows: number): string => {
  const belowWindow = `stats_max_value < '${p.min}'`
  const aboveWindow = p.max === undefined ? 'false' : `stats_min_value > '${p.max}'`
  return `
    WITH surviving AS (
      SELECT DISTINCT row_group_id::BIGINT AS rg
      FROM parquet_metadata('${file}')
      WHERE path_in_schema = '${p.column}'
        AND (
          stats_min_value IS NULL
          OR stats_max_value IS NULL
          OR NOT (${belowWindow} OR ${aboveWindow})
        )
    ),
    hits AS (
      SELECT (file_row_number // ${groupRows})::BIGINT AS rg, count(*)::BIGINT AS n
      FROM read_parquet('${file}', file_row_number = true)
      WHERE ${p.sql}
      GROUP BY 1
    )
    SELECT
      (SELECT count(*) FROM surviving)::BIGINT                                   AS surviving_groups,
      coalesce(sum(n), 0)::BIGINT                                                AS matching_rows,
      count(*)::BIGINT                                                           AS groups_with_matches,
      coalesce(sum(n) FILTER (WHERE rg NOT IN (SELECT rg FROM surviving)), 0)::BIGINT
                                                                                 AS false_negative_rows
    FROM hits
  `
}

/** Fallback when `file_row_number` is unavailable: the row count, without the per-group split. */
export const matchingRowsSql = (file: string, p: PruningPredicate): string =>
  `SELECT count(*)::BIGINT AS matching_rows FROM read_parquet('${file}') WHERE ${p.sql}`

/* ------------------------------- the measurement ---------------------------- */

export interface PruningMeasurement {
  key: string
  fileId: string
  windowId: string
  predicateColumn: ClusterKey
  /** The physical order the file was written in. */
  clusterBy: ClusterKey
  /** Rows per row group as requested in the COPY. */
  rowGroupSize: number
  /** Rows per row group as the writer actually produced them. */
  groupRows: number
  rowGroups: number
  rowGroupsRead: number
  pruningRatio: number
  /** Column chunks in the footer: one min/max/null-count triple each. */
  statsEntries: number
  footerBytes: number | null
  fileBytes: number | null
  /** Projected columns, every row group. What the query costs with no pruning. */
  projectedBytes: number
  /** Projected columns, surviving row groups only. The bill. */
  bytesRead: number
  /** Rows in the file that actually satisfy the predicate. */
  matchingRows: number
  /** Row groups that contain at least one matching row. */
  groupsWithMatches: number
  /** Matching rows sitting in a row group the planner skipped. Must be 0. */
  falseNegativeRows: number
  /** False when the build could not run the audit query. */
  auditRan: boolean
  /** Non-null when a check came out against the expected story. Surfaced, never hidden. */
  anomaly: string | null
}

export const cellKey = (fileId: string, windowId: string, column: ClusterKey): string =>
  `${fileId}|${windowId}|${column}`

/** All measurements, keyed by `cellKey`. */
export type PruningGrid = Record<string, PruningMeasurement>

let loaded = false

/** Build the two tables and write the six Parquet files. Idempotent per tab. */
export async function loadPruningFixtures(
  onStep?: (s: string) => void,
  opts: { rows?: number; dir?: string } = {},
): Promise<void> {
  if (loaded) {
    onStep?.('fixtures already built')
    return
  }
  const rows = opts.rows ?? PRUNING_ROWS
  onStep?.(`generating ${rows.toLocaleString('en-US')} rows in timestamp order`)
  await exec(pruningSourceSql(rows))

  onStep?.('writing the same rows in customer order')
  await exec(pruningByCustomerSql())

  for (const f of PRUNING_FILES) {
    onStep?.(`writing ${f.file}`)
    await exec(copyPruningSql(f, pruningPath(f, opts.dir)))
  }
  loaded = true
  onStep?.('ready')
}

export const pruningFixturesLoaded = (): boolean => loaded

interface ShapeRow {
  stats_entries: number
  row_groups: number
  group_rows: number
  distinct_group_sizes: number
}

async function footerBytes(file: string): Promise<{ footer: number | null; total: number | null }> {
  for (const candidate of FOOTER_SQL_CANDIDATES) {
    try {
      const r = await query<{ footer_bytes: number; file_bytes: number }>(
        footerSqlFor(file, candidate),
      )
      if (r[0]) return { footer: r[0].footer_bytes, total: r[0].file_bytes }
    } catch {
      /* This build spells the column differently, or does not expose it. Try the next. */
    }
  }
  return { footer: null, total: null }
}

/**
 * One configuration: one file, one predicate. Byte counts come from
 * `computeBill` — the scan-bill lab's function, unchanged — so the two labs
 * cannot drift apart on what a scan costs.
 */
export async function measure(
  f: PruningFile,
  w: PruningWindow,
  p: PruningPredicate,
  dir = '',
): Promise<PruningMeasurement> {
  const path = pruningPath(f, dir)

  const bill = await computeBill({
    path,
    columns: PROJECTION,
    predicate: { column: p.column, min: p.min, max: p.max },
  })

  const shape = (await query<ShapeRow>(shapeSql(path)))[0]
  if (!shape) throw new Error(`no parquet metadata for ${path}`)

  const { footer, total } = await footerBytes(path)

  const anomalies: string[] = []
  if (shape.distinct_group_sizes > 2) {
    anomalies.push(
      `row groups are not uniformly sized (${shape.distinct_group_sizes} distinct sizes), so the audit's row-group arithmetic cannot be trusted`,
    )
  }

  let matchingRows = 0
  let groupsWithMatches = 0
  let falseNegativeRows = 0
  let auditRan = false

  if (shape.distinct_group_sizes <= 2) {
    try {
      const a = (
        await query<{
          surviving_groups: number
          matching_rows: number
          groups_with_matches: number
          false_negative_rows: number
        }>(auditSql(path, p, shape.group_rows))
      )[0]
      if (a) {
        auditRan = true
        matchingRows = a.matching_rows
        groupsWithMatches = a.groups_with_matches
        falseNegativeRows = a.false_negative_rows
        if (a.surviving_groups !== bill.rowGroupsRead) {
          anomalies.push(
            `the two survival implementations disagree: computeBill kept ${bill.rowGroupsRead} row groups, the audit's SQL kept ${a.surviving_groups}`,
          )
        }
        if (a.false_negative_rows > 0) {
          anomalies.push(
            `${a.false_negative_rows.toLocaleString('en-US')} matching rows sit in row groups this configuration skipped — a false negative, which is a correctness bug rather than a bill`,
          )
        }
      }
    } catch {
      /* `file_row_number` is unavailable in this build. Fall back to a plain count. */
    }
  }

  if (!auditRan) {
    try {
      const c = (await query<{ matching_rows: number }>(matchingRowsSql(path, p)))[0]
      matchingRows = c?.matching_rows ?? 0
    } catch {
      /* Leave it at zero and let the UI say the audit did not run. */
    }
    anomalies.push(
      'the false-negative audit could not run in this build, so this row reports a cost without a correctness check',
    )
  }

  return {
    key: cellKey(f.id, w.id, p.column),
    fileId: f.id,
    windowId: w.id,
    predicateColumn: p.column,
    clusterBy: f.clusterBy,
    rowGroupSize: f.rowGroupSize,
    groupRows: shape.group_rows,
    rowGroups: bill.rowGroups,
    rowGroupsRead: bill.rowGroupsRead,
    pruningRatio: bill.pruningRatio,
    statsEntries: shape.stats_entries,
    footerBytes: footer,
    fileBytes: total,
    projectedBytes: bill.projectedBytes,
    bytesRead: bill.prunedBytes,
    matchingRows,
    groupsWithMatches,
    falseNegativeRows,
    auditRan,
    anomaly: anomalies.length > 0 ? anomalies.join('; ') : null,
  }
}

/**
 * The configurations the lab reports. Enumerated as data so the test suite
 * measures exactly what the reader sees, in the same order.
 *
 *   · every row-group variant × every window, on the MATCHING column — the dial
 *   · the reference file × every window, on the WRONG column — the lesson
 *   · the customer-clustered file at the reference window, both columns — the
 *     mirror, which is what "a table has one physical order" costs
 */
export function pruningConfigurations(): Array<{
  file: PruningFile
  window: PruningWindow
  predicate: PruningPredicate
}> {
  const out: Array<{ file: PruningFile; window: PruningWindow; predicate: PruningPredicate }> = []
  for (const f of ROW_GROUP_VARIANTS) {
    for (const w of WINDOWS) out.push({ file: f, window: w, predicate: tsPredicate(w) })
  }
  const reference = ROW_GROUP_VARIANTS.find((f) => f.id === REFERENCE_FILE_ID)!
  for (const w of WINDOWS) {
    out.push({ file: reference, window: w, predicate: customerPredicate(w) })
  }
  const w7 = WINDOWS.find((w) => w.id === REFERENCE_WINDOW_ID)!
  out.push({ file: CUSTOMER_CLUSTERED, window: w7, predicate: tsPredicate(w7) })
  out.push({ file: CUSTOMER_CLUSTERED, window: w7, predicate: customerPredicate(w7) })
  return out
}

export async function measureAll(
  onStep?: (s: string) => void,
  dir = '',
): Promise<PruningGrid> {
  const grid: PruningGrid = {}
  const configs = pruningConfigurations()
  let i = 0
  for (const c of configs) {
    i += 1
    onStep?.(`measuring ${i}/${configs.length}: ${c.file.label}, ${c.window.label}, ${c.predicate.column}`)
    const m = await measure(c.file, c.window, c.predicate, dir)
    grid[m.key] = m
  }
  return grid
}

/* --------------------------------- formatting ------------------------------- */

export const fmtPercent = (r: number): string => `${(r * 100).toFixed(2)}%`

/** Selectivity spans three orders of magnitude here, so a fixed precision lies. */
export const fmtSelectivity = (r: number): string =>
  r >= 0.1 ? `${(r * 100).toFixed(0)}%` : r >= 0.01 ? `${(r * 100).toFixed(1)}%` : `${(r * 100).toFixed(2)}%`

export const fmtCount = (n: number): string => n.toLocaleString('en-US')
