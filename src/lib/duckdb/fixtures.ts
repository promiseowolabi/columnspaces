/**
 * fixtures — the data every duck lab runs against.
 *
 * ── Why there are no .parquet files in this repository ──────────────────────
 * PLAN.md named "binary Parquet fixtures in git" as a risk. The resolution is
 * better than a generator script: the fixture is DDL. DuckDB builds the table
 * from `range()` and a seeded hash in the reader's tab, then writes real Parquet
 * into its own virtual filesystem at a row-group size we choose.
 *
 * That buys four things:
 *   · nothing binary in git, nothing to regenerate, nothing to keep in sync
 *   · the reader can read the generating SQL — the data has no secrets
 *   · deterministic: `hash(i)` is a pure function of the row number, so every
 *     reader sees byte-identical files and the same numbers
 *   · the files are REAL Parquet written by a real writer, so `parquet_metadata`
 *     returns genuine row groups, column chunks and statistics
 *
 * ── The scale caveat, stated up front ──────────────────────────────────────
 * The lessons work an example at 2 billion rows. This runs 2 million: three
 * orders of magnitude smaller, because it has to fit in a browser tab. The
 * RATIOS are what transfer — bytes per row, pruning percentage, compression
 * factor — and ratios are scale-free. Absolute byte counts here are 1/1000 of
 * the lesson's, and the labs say so rather than quietly hoping nobody checks.
 */

import { exec, query } from './client'

/** Rows in the generated fact table. Sized to load in a second or two. */
export const FIXTURE_ROWS = 2_000_000

/** The seed. Same xorshift lineage as every other seeded thing in the series. */
export const FIXTURE_SEED = 0x9e37_79b9

/** Days of history the generated timestamps span. */
export const FIXTURE_DAYS = 730

/**
 * The fact table: deliberately shaped like a real one — a few columns anyone
 * queries, and a long tail of columns nobody does. That tail is the entire
 * reason projection matters, so the fixture has to have it.
 *
 * Widths, so the arithmetic in the labs is checkable by hand:
 *   order_ts      TIMESTAMP  8 B
 *   region        VARCHAR    ~12 B  (8 distinct values)
 *   net_revenue   DOUBLE     8 B
 *   customer_id   INTEGER    4 B    (high cardinality — the pruning trap)
 *   status        VARCHAR    ~8 B   (4 distinct values)
 *   + pad_00..pad_39: 40 filler columns, 8 B each = 320 B
 *
 * ~360 B/row logical. The three columns the dashboard query wants are 28 B of
 * it, which is the 12-to-13x projection factor the lessons quote.
 */
const PAD_COLUMNS = 40

const padSelect = (): string =>
  Array.from(
    { length: PAD_COLUMNS },
    (_, i) => `  (hash(i * ${7 + i} + ${FIXTURE_SEED}) % 1000000)::BIGINT AS pad_${String(i).padStart(2, '0')}`,
  ).join(',\n')

/**
 * `orders_clustered` arrives in timestamp order — the layout a well-behaved
 * loader produces, and the one that prunes.
 *
 * `orders_shuffled` holds the SAME rows in an order that destroys clustering.
 * Two tables rather than one is the whole point: the difference between them is
 * not compression, not the query, and not the engine. It is only the order the
 * rows were written in, and it is worth a factor of ten in bytes read.
 */
export const FIXTURE_SQL = {
  base: `
CREATE OR REPLACE TABLE orders_clustered AS
SELECT
  TIMESTAMP '2024-01-01 00:00:00' + INTERVAL (i * ${FIXTURE_DAYS} * 86400 / ${FIXTURE_ROWS}) SECOND AS order_ts,
  ['EMEA','NA','APAC','LATAM','UK','DACH','NORDIC','ANZ'][((hash(i + ${FIXTURE_SEED}) % 8)::BIGINT) + 1] AS region,
  ((hash(i * 3 + ${FIXTURE_SEED}) % 90000) / 100.0)::DOUBLE AS net_revenue,
  (hash(i * 5 + ${FIXTURE_SEED}) % 250000)::INTEGER AS customer_id,
  ['new','paid','shipped','refunded'][((hash(i * 11 + ${FIXTURE_SEED}) % 4)::BIGINT) + 1] AS status,
${padSelect()}
FROM range(${FIXTURE_ROWS}) t(i);
`,
  shuffled: `
CREATE OR REPLACE TABLE orders_shuffled AS
SELECT * FROM orders_clustered ORDER BY hash(customer_id * 31 + ${FIXTURE_SEED});
`,
}

export interface ParquetFixture {
  /** Path inside duckdb's virtual filesystem. */
  path: string
  /** Human label for the UI. */
  label: string
  /** Rows per row group — the dial that decides how fine-grained pruning can be. */
  rowGroupSize: number
  /** One line on why this file exists. */
  why: string
}

export const PARQUET_FIXTURES: ParquetFixture[] = [
  {
    path: 'clustered.parquet',
    label: 'clustered · 100k row groups',
    rowGroupSize: 100_000,
    why: 'Written in timestamp order. Each row group covers a narrow time range, so a time predicate can skip most of them.',
  },
  {
    path: 'shuffled.parquet',
    label: 'shuffled · 100k row groups',
    rowGroupSize: 100_000,
    why: 'The same rows, written in an order unrelated to time. Every row group spans nearly the whole history, so nothing can be skipped.',
  },
  {
    path: 'clustered-small.parquet',
    label: 'clustered · 10k row groups',
    rowGroupSize: 10_000,
    why: 'Clustered, but ten times more row groups: finer pruning, more metadata. The lesson is that this dial has two edges.',
  },
]

let loaded = false

/**
 * Build the tables and write the Parquet files. Idempotent per tab.
 *
 * `onStep` exists because this takes a few seconds and silence reads as a hang.
 */
export async function loadFixtures(onStep?: (s: string) => void): Promise<void> {
  if (loaded) {
    onStep?.('fixtures already built')
    return
  }

  onStep?.(`generating ${FIXTURE_ROWS.toLocaleString('en-US')} rows`)
  await exec(FIXTURE_SQL.base)

  onStep?.('writing the same rows in a non-clustered order')
  await exec(FIXTURE_SQL.shuffled)

  for (const f of PARQUET_FIXTURES) {
    onStep?.(`writing ${f.path}`)
    const source = f.path.startsWith('shuffled') ? 'orders_shuffled' : 'orders_clustered'
    await exec(
      `COPY ${source} TO '${f.path}' (FORMAT parquet, ROW_GROUP_SIZE ${f.rowGroupSize}, COMPRESSION snappy);`,
    )
  }

  loaded = true
  onStep?.('ready')
}

export const fixturesLoaded = (): boolean => loaded

/* --------------------------- shape introspection --------------------------- */

export interface ColumnShape {
  name: string
  type: string
  /** Logical bytes per value for this type, for hand-checkable arithmetic. */
  logicalBytes: number
}

/** Nominal per-value widths. Deliberately simple — the reader must be able to redo it. */
const WIDTHS: Record<string, number> = {
  TIMESTAMP: 8,
  DOUBLE: 8,
  BIGINT: 8,
  INTEGER: 4,
  VARCHAR: 10,
}

export async function tableShape(table: string): Promise<ColumnShape[]> {
  const rows = await query<{ column_name: string; column_type: string }>(
    `DESCRIBE ${table};`,
  )
  return rows.map((r) => ({
    name: r.column_name,
    type: r.column_type,
    logicalBytes: WIDTHS[r.column_type] ?? 8,
  }))
}
