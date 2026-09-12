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

/**
 * Rows in the generated fact table.
 *
 * ── Why this is 500k and not 2M ────────────────────────────────────────────
 * It was 2,000,000, which nothing had ever executed in a browser: every unit
 * test builds this fixture natively (`@duckdb/node-api`, 40k rows, gigabytes of
 * host RAM), so the number was only ever checked against an engine that could
 * afford it. `npm run e2e` ran it in Chromium for the first time and it died
 * with `Out of Memory Error: Allocation failure` while writing the second
 * Parquet file.
 *
 * The budget it has to fit inside, measured rather than assumed:
 *   · duckdb-wasm reports `memory_limit` = 3.1 GiB, but that only accounts for
 *     the buffer manager. The Parquet files live in duckdb's in-memory virtual
 *     filesystem, in the SAME wasm32 heap, and are not counted.
 *   · At 2M rows one file holds 408 MiB of column chunks, and three of them plus
 *     the writer's own buffers do not fit.
 *
 * At 500k rows each file is ~102 MiB, all three fit with room to spare, and the
 * whole build takes ~100 s in a tab. The ratios — projection, pruning,
 * compression — are scale-free and unchanged; only the absolute byte counts
 * shrink, which the labs already say out loud.
 */
export const FIXTURE_ROWS = 500_000

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
 * Two relations rather than one is the whole point: the difference between them
 * is not compression, not the query, and not the engine. It is only the order the
 * rows were written in, and it is worth orders of magnitude in bytes read.
 *
 * ── Why these are VIEWS, and why the shuffle sorts an index ────────────────
 * They used to be `CREATE TABLE`s. Materialising them cost 930 MiB each — 1.8 GiB
 * of a wasm32 heap — before a single Parquet file had been written, and that is
 * what made this lab die in a real browser. Nothing needs the rows in memory:
 * every duck lab reads the Parquet FILES, so the tables were only ever an
 * expensive staging area on the way to `COPY`.
 *
 * As views, `COPY` streams: DuckDB generates a vector, encodes it, writes it,
 * and forgets it. Accounted memory stays at zero for the entire build.
 *
 * The shuffle needs more care, because `ORDER BY` over 360-byte rows is a
 * 930 MiB sort no matter how the rows are stored. So the sort is over the row
 * INDEX only — 8 bytes per row, a few MiB — and the wide row is generated after
 * the reordering, from the reordered index. Same rows, same shuffle key, same
 * resulting file; a hundredth of the sort buffer. Which is late materialization,
 * the subject of C4.L3, applied to the fixture that teaches it.
 */
export const FIXTURE_SQL = {
  base: `
CREATE OR REPLACE VIEW orders_clustered AS
SELECT
  TIMESTAMP '2024-01-01 00:00:00' + INTERVAL (i * ${FIXTURE_DAYS} * 86400 / ${FIXTURE_ROWS}) SECOND AS order_ts,
  ['EMEA','NA','APAC','LATAM','UK','DACH','NORDIC','ANZ'][((hash(i + ${FIXTURE_SEED}) % 8)::BIGINT) + 1] AS region,
  ((hash(i * 3 + ${FIXTURE_SEED}) % 90000) / 100.0)::DOUBLE AS net_revenue,
  (hash(i * 5 + ${FIXTURE_SEED}) % 250000)::INTEGER AS customer_id,
  ['new','paid','shipped','refunded'][((hash(i * 11 + ${FIXTURE_SEED}) % 4)::BIGINT) + 1] AS status,
${padSelect()}
FROM range(${FIXTURE_ROWS}) t(i);
`,
  /*
   * The same generator, reading a permuted index. The shuffle key is the same
   * one the clustered/shuffled pair has always used — a hash of customer_id —
   * so rows of one customer still land together and nothing about time survives.
   */
  shuffled: `
CREATE OR REPLACE VIEW orders_shuffled AS
SELECT
  TIMESTAMP '2024-01-01 00:00:00' + INTERVAL (i * ${FIXTURE_DAYS} * 86400 / ${FIXTURE_ROWS}) SECOND AS order_ts,
  ['EMEA','NA','APAC','LATAM','UK','DACH','NORDIC','ANZ'][((hash(i + ${FIXTURE_SEED}) % 8)::BIGINT) + 1] AS region,
  ((hash(i * 3 + ${FIXTURE_SEED}) % 90000) / 100.0)::DOUBLE AS net_revenue,
  (hash(i * 5 + ${FIXTURE_SEED}) % 250000)::INTEGER AS customer_id,
  ['new','paid','shipped','refunded'][((hash(i * 11 + ${FIXTURE_SEED}) % 4)::BIGINT) + 1] AS status,
${padSelect()}
FROM (
  SELECT i
  FROM range(${FIXTURE_ROWS}) t(i)
  ORDER BY hash(((hash(i * 5 + ${FIXTURE_SEED}) % 250000)::INTEGER) * 31 + ${FIXTURE_SEED})
) s(i);
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

/**
 * Row-group sizes are multiples of 2048, DuckDB's vector size, because the
 * writer rounds to vector multiples: ask for 2,500 and you get 4,096, which
 * would quietly make the "10× more row groups" file only 5× finer. 20,480 and
 * 2,048 are exactly a factor of ten apart and are exactly what gets written.
 *
 * At 500k rows that is 25 row groups and 245 row groups — enough that a
 * seven-day window out of two years can skip almost all of them.
 */
export const PARQUET_FIXTURES: ParquetFixture[] = [
  {
    path: 'clustered.parquet',
    label: 'clustered · 20k row groups',
    rowGroupSize: 20_480,
    why: 'Written in timestamp order. Each row group covers a narrow time range, so a time predicate can skip most of them.',
  },
  {
    path: 'shuffled.parquet',
    label: 'shuffled · 20k row groups',
    rowGroupSize: 20_480,
    why: 'The same rows, written in an order unrelated to time. Every row group spans nearly the whole history, so nothing can be skipped.',
  },
  {
    path: 'clustered-small.parquet',
    label: 'clustered · 2k row groups',
    rowGroupSize: 2_048,
    why: 'Clustered, but ten times more row groups: finer pruning, more metadata. The lesson is that this dial has two edges.',
  },
]

let loaded = false

/**
 * Declare the two relations and write the Parquet files. Idempotent per tab.
 *
 * `onStep` exists because this takes a minute or two and silence reads as a hang.
 * The finest-grained file is the slow one: ten times the row groups means ten
 * times the column chunks to encode and describe, and duckdb-wasm has one thread.
 */
export async function loadFixtures(onStep?: (s: string) => void): Promise<void> {
  if (loaded) {
    onStep?.('fixtures already built')
    return
  }

  onStep?.(`declaring the generator for ${FIXTURE_ROWS.toLocaleString('en-US')} rows`)
  await exec(FIXTURE_SQL.base)

  onStep?.('declaring the same rows in a non-clustered order')
  await exec(FIXTURE_SQL.shuffled)

  /*
   * Each COPY streams straight out of the view: no table is ever materialised,
   * so peak memory is one vector plus the file being written. That is the whole
   * difference between this running in a tab and failing in one.
   */
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
