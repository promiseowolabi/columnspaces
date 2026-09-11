/**
 * codecs — one column per Parquet file, so a compression ratio has exactly one
 * cause the reader can name.
 *
 * ── Why one column per file ────────────────────────────────────────────────
 * `parquet_metadata()` reports sizes per column chunk, so a single wide file
 * would do. But a wide file invites the reader to read a whole-file ratio and
 * attribute it to "Parquet" or "Snappy", which is exactly the habit C1 exists to
 * break. Six files, one column each, means every number on screen belongs to one
 * column's cardinality, ordering and range — and nothing else.
 *
 * ── What "ratio" means here, precisely ─────────────────────────────────────
 * This is the trap that makes most compression benchmarks worthless, so it is
 * spelled out. Parquet stores a column in two stages:
 *
 *     values ──encode──▶ encoded bytes ──codec──▶ stored bytes
 *              (dictionary,             (snappy, zstd, …)
 *               RLE, bit-packing)
 *
 * The footer's `total_uncompressed_size` is the size AFTER encoding and BEFORE
 * the codec. So `total_uncompressed_size / total_compressed_size` — the obvious
 * thing to compute, and what the scan-bill lab's `compressionRatio` computes —
 * measures the CODEC ALONE, with the encoding's gain already invisible in the
 * denominator. On a sorted low-cardinality column that number is about 0.95×,
 * because run-length encoding already took the column to a few hundred bytes and
 * Snappy then adds framing overhead. Reported as "the compression ratio" it says
 * Parquet made the data bigger, which is nonsense.
 *
 * So the denominator here is the PLAIN cost: what these values occupy with no
 * encoding at all, which is what the reader is implicitly comparing against when
 * they say "10× compression".
 *
 *     plainBytes    arithmetic over the values themselves — count × width for
 *                   fixed-width types, SUM(4 + byte length) for Parquet's
 *                   PLAIN byte-array layout. Redoable by hand.
 *     encodedBytes  total_uncompressed_size, from the file's own footer.
 *     storedBytes   total_compressed_size, from the file's own footer.
 *
 *     encoding gain = plain / encoded      codec gain = encoded / stored
 *     total ratio   = plain / stored
 *
 * The arithmetic denominator is not a fudge: `tests/codec-bench.test.ts` writes
 * each column a second time with `DICTIONARY_SIZE_LIMIT 0` (which forces genuine
 * PLAIN encoding) and asserts the arithmetic agrees with the writer's own byte
 * count to within half a percent. The residual is page headers.
 *
 * ── What this cannot tell you ──────────────────────────────────────────────
 * These are Snappy-compressed Parquet files written by DuckDB's writer on
 * synthetic data. Change any of those three and the numbers change. In
 * particular DuckDB's writer emits PLAIN for TIMESTAMP — it has no
 * DELTA_BINARY_PACKED to offer — and that single writer property, not anything
 * about timestamps, is why the monotone column here lands near 1.1×.
 */

import { exec, query } from './client'
import { FIXTURE_DAYS, FIXTURE_ROWS, FIXTURE_SEED } from './fixtures'

/** Same scale as the scan-bill fixture, so the two labs quote one row count. */
export const CODEC_ROWS = FIXTURE_ROWS

/** Rows per row group. Matched to the scan-bill fixture for the same reason. */
export const CODEC_ROW_GROUP = 100_000

/* ------------------------------- prediction -------------------------------- */

export type BucketId = 'flat' | 'modest' | 'strong' | 'extreme'

export interface Bucket {
  id: BucketId
  label: string
  /** Inclusive lower bound. */
  min: number
  /** Exclusive upper bound. */
  max: number
}

/**
 * Four buckets, not a number. A reader who can sort columns into these has the
 * skill the lesson is after; one who can name 6.35× has memorised this fixture.
 */
export const BUCKETS: Bucket[] = [
  { id: 'flat', label: '< 1.5×', min: 0, max: 1.5 },
  { id: 'modest', label: '1.5–5×', min: 1.5, max: 5 },
  { id: 'strong', label: '5–20×', min: 5, max: 20 },
  { id: 'extreme', label: '> 20×', min: 20, max: Number.POSITIVE_INFINITY },
]

export function bucketOf(ratio: number): BucketId {
  for (const b of BUCKETS) if (ratio >= b.min && ratio < b.max) return b.id
  return 'extreme'
}

export const bucketLabel = (id: BucketId): string =>
  BUCKETS.find((b) => b.id === id)?.label ?? String(id)

/* --------------------------------- columns --------------------------------- */

export interface CodecColumn {
  id: string
  /** Path in duckdb's virtual filesystem. One column lives here and nothing else. */
  file: string
  /** The column's name inside that file. */
  column: string
  type: 'VARCHAR' | 'TIMESTAMP' | 'INTEGER' | 'DOUBLE'
  label: string
  /** The single-column SELECT that becomes the file. */
  select: string
  /**
   * Bytes these values would occupy PLAIN-encoded, as a SQL aggregate over
   * `select`. Fixed-width types are count × width; a Parquet PLAIN byte array is
   * a 4-byte little-endian length followed by the bytes.
   */
  plainExpr: string
  /** The three properties the reader predicts from. Shown BEFORE they run. */
  properties: { cardinality: string; ordering: string; range: string }
  /** What actually happened, and why. Shown AFTER they run. */
  why: string
}

const REGIONS = `['EMEA','NA','APAC','LATAM','UK','DACH','NORDIC','ANZ']`
const shuffleKey = `hash(i * 31 + ${FIXTURE_SEED})`

/** count × width, for the fixed-width physical types. */
const fixed = (w: number) => `(count(*) * ${w})::BIGINT`
/** Parquet PLAIN byte-array: 4-byte length prefix + payload, per value. */
const bytesPlain = `(sum(4 + octet_length(v::BLOB)))::BIGINT`

/**
 * The six columns, ordered so the table reads as an argument: the same values
 * twice in two orders, then a sorted column that still does badly, then range,
 * then two floors.
 */
export const CODEC_COLUMNS: CodecColumn[] = [
  {
    id: 'region-clustered',
    file: 'codec-region-clustered.parquet',
    column: 'v',
    type: 'VARCHAR',
    label: 'region · clustered',
    select: `SELECT region AS v FROM codec_source ORDER BY region`,
    plainExpr: bytesPlain,
    properties: {
      cardinality: '8 distinct values',
      ordering: 'sorted — equal values are adjacent',
      range: 'strings, 2–6 bytes each',
    },
    why:
      'Eight distinct values sorted into eight runs. The dictionary holds 8 entries and the data page stores run lengths rather than values, so the whole column costs a few dozen bytes per ROW GROUP no matter how many rows that group holds — under two kilobytes for the entire file at this scale. Snappy then contributes nothing: it makes this column very slightly LARGER, because there is nothing left to find and framing a nearly empty page costs bytes. Note the consequence for the ratio itself — it is the one number in this table that grows with row count, because the numerator scales with rows and the denominator scales only with row groups.',
  },
  {
    id: 'region-shuffled',
    file: 'codec-region-shuffled.parquet',
    column: 'v',
    type: 'VARCHAR',
    label: 'region · shuffled',
    select: `SELECT region AS v FROM codec_source ORDER BY ${shuffleKey}`,
    plainExpr: bytesPlain,
    properties: {
      cardinality: '8 distinct values — identical multiset to the row above',
      ordering: 'shuffled — no two neighbours related',
      range: 'strings, 2–6 bytes each',
    },
    why:
      'The same 8 values, the same counts, the same writer, the same codec. Only the order changed. The dictionary still works — 8 entries need 3 bits per row instead of the 7.75 bytes PLAIN would spend — but there are no runs left, so the RLE/bit-packed hybrid falls back to bit-packing every row individually and its run headers push the realised cost to about half a byte per value. What was under two kilobytes is now megabytes. Cardinality bought the dictionary, and that part you keep; ordering bought the runs, and ordering is the part a shuffle, a merge or a careless insert can take away without changing a single value.',
  },
  {
    id: 'order-ts',
    file: 'codec-order-ts.parquet',
    column: 'v',
    type: 'TIMESTAMP',
    label: 'order_ts · monotone',
    select: `SELECT order_ts AS v FROM codec_source ORDER BY order_ts`,
    plainExpr: fixed(8),
    properties: {
      cardinality: 'all distinct',
      ordering: 'monotonically increasing',
      range: `${FIXTURE_DAYS} days — successive values differ by seconds`,
    },
    why:
      'The surprise, and the reason this lab exists. Every property says this should compress enormously: sorted, tiny deltas, a range that fits in far fewer than 64 bits. Delta encoding would take it to a couple of bits per row. But look at the encoding the footer reports — PLAIN. DuckDB’s Parquet writer does not emit DELTA_BINARY_PACKED, so no delta encoding happens, and all that is left is Snappy trying to find repeats in a stream of 8-byte little-endian integers whose low bytes all differ. A different writer would give a different answer for the identical data. "Timestamps compress well" is a claim about a writer, not about timestamps.',
  },
  {
    id: 'basket-size',
    file: 'codec-basket-size.parquet',
    column: 'v',
    type: 'INTEGER',
    label: 'basket_size · narrow range',
    select: `SELECT basket_size AS v FROM codec_source`,
    plainExpr: fixed(4),
    properties: {
      cardinality: '20 distinct values',
      ordering: 'unsorted',
      range: '1–20 — fits in 5 bits',
    },
    why:
      'Low cardinality with no clustering: the dictionary applies, run-length does not. 20 entries need 5 bits per row against a 32-bit stored integer, which predicts 32/5 ≈ 6.4× before you measure anything. That is the whole calculation, and it lands. Note what did NOT help: this column is an INTEGER, the type people expect to compress, and it does worse than the shuffled string — because the string was 7.75 bytes per value to begin with and had further to fall.',
  },
  {
    id: 'customer-id',
    file: 'codec-customer-id.parquet',
    column: 'v',
    type: 'INTEGER',
    label: 'customer_id · near-unique',
    select: `SELECT customer_id AS v FROM codec_source`,
    plainExpr: fixed(4),
    properties: {
      cardinality: 'essentially unique — drawn from a 2-billion space',
      ordering: 'unsorted',
      range: 'the full 32-bit space',
    },
    why:
      'A dictionary with one entry per row is larger than the data, so the writer declines it and emits PLAIN. Snappy then finds nothing, because there is nothing: the values are hash output, and hash output is incompressible by construction. This column stores 4 bytes per value — the width of the type, plus page headers, with no discount whatsoever — and that is what makes high-cardinality ids the columns that ruin a capacity plan. Every other column in this fixture gets some discount; this one converts row count straight into bytes.',
  },
  {
    id: 'noise',
    file: 'codec-noise.parquet',
    column: 'v',
    type: 'DOUBLE',
    label: 'noise · uniform random double',
    select: `SELECT noise AS v FROM codec_source`,
    plainExpr: fixed(8),
    properties: {
      cardinality: 'essentially unique',
      ordering: 'unsorted',
      range: '[0, 1), stored as a 64-bit double',
    },
    why:
      'The near-worst case, and the reason the scan-bill lab refuses to quote a compression ratio off its revenue column. It is also the most interesting failure here, because these values are NOT information-theoretically incompressible: the generator draws from a billion distinct values, about 30 bits, and stores each one in 64. A perfect coder would get roughly 2×. Parquet and Snappy get 1.00×, because the 30 bits of entropy are smeared across the mantissa by the division and neither a dictionary nor a byte-oriented codec can see arithmetic structure — they look for repeated values and repeated byte strings, and there are none. Redundancy a codec cannot address is not redundancy. Real measures are kinder than this — prices carry two decimals, quantities are small integers, sensor readings drift slowly — so treat 1.0× as the pessimistic bound rather than an estimate of your own data.',
  },
]

/**
 * The source table. One row per `i`, six columns, all derived from `hash(i)` so
 * every reader gets byte-identical files and therefore the same ratios.
 *
 * `customer_id` is drawn from a 2-billion space rather than generated as `i`
 * because a monotone id is a different lesson (it would compress) and this
 * column's job is to be the floor.
 */
export const codecSourceSql = (rows: number = CODEC_ROWS): string => `
CREATE OR REPLACE TABLE codec_source AS
SELECT
  i,
  ${REGIONS}[((hash(i + ${FIXTURE_SEED}) % 8)::BIGINT) + 1] AS region,
  TIMESTAMP '2024-01-01 00:00:00' + INTERVAL (i * ${FIXTURE_DAYS} * 86400 / ${rows}) SECOND AS order_ts,
  ((hash(i * 13 + ${FIXTURE_SEED}) % 20) + 1)::INTEGER AS basket_size,
  (hash(i * 7 + ${FIXTURE_SEED}) % 2000000000)::INTEGER AS customer_id,
  ((hash(i * 3 + ${FIXTURE_SEED}) % 1000000000) / 1000000000.0)::DOUBLE AS noise
FROM range(${rows}) t(i);
`

/**
 * The COPY that turns one column into one file.
 *
 * `into` and `rowGroup` are parameters purely so the test suite can run this
 * exact statement at test scale against native DuckDB, writing to a temp
 * directory instead of the browser's virtual filesystem. The lab always uses the
 * defaults.
 */
export const copySql = (
  c: CodecColumn,
  into: string = c.file,
  rowGroup: number = CODEC_ROW_GROUP,
): string =>
  `COPY (${c.select}) TO '${into}' (FORMAT parquet, ROW_GROUP_SIZE ${rowGroup}, COMPRESSION snappy);`

/**
 * The same column written with dictionary encoding disabled and no codec — a real
 * PLAIN file, from the same writer. This is how `tests/codec-bench.test.ts`
 * checks that `plainExpr`'s arithmetic is not a convenient fiction. The lab does
 * not write these: six more files at browser scale is ~80 MB of virtual
 * filesystem to prove something a test already proves.
 */
export const copyPlainSql = (c: CodecColumn, into: string, rowGroup = CODEC_ROW_GROUP): string =>
  `COPY (${c.select}) TO '${into}' (FORMAT parquet, ROW_GROUP_SIZE ${rowGroup}, COMPRESSION uncompressed, DICTIONARY_SIZE_LIMIT 0);`

let loaded = false

/** Build the source table and write the six single-column files. Idempotent per tab. */
export async function loadCodecFixtures(onStep?: (s: string) => void): Promise<void> {
  if (loaded) {
    onStep?.('fixtures already built')
    return
  }
  onStep?.(`generating ${CODEC_ROWS.toLocaleString('en-US')} rows`)
  await exec(codecSourceSql())
  for (const c of CODEC_COLUMNS) {
    onStep?.(`writing ${c.file}`)
    await exec(copySql(c))
  }
  loaded = true
  onStep?.('ready')
}

export const codecFixturesLoaded = (): boolean => loaded

/* ------------------------------- measurement ------------------------------- */

export interface CodecMeasurement {
  id: string
  values: number
  rowGroups: number
  /** Arithmetic: what these values cost with no encoding. The denominator. */
  plainBytes: number
  /** Footer `total_uncompressed_size`: after Parquet encoding, before the codec. */
  encodedBytes: number
  /** Footer `total_compressed_size`: the bytes actually on disk. */
  storedBytes: number
  /** Encodings the footer reports for this column. Empty if the build omits them. */
  encodings: string[]
  /** The codec the footer reports. Should be SNAPPY. */
  codec: string
  /** plain / encoded — what the ENCODING bought. */
  encodingGain: number
  /** encoded / stored — what the CODEC bought. Often ~1.0, sometimes below it. */
  codecGain: number
  /** plain / stored — the ratio a reader means when they say "compression". */
  totalRatio: number
  /** Stored bytes per value. The number that goes on a capacity plan. */
  bytesPerValue: number
}

interface MetaRow {
  n_values: number
  row_groups: number
  encoded: number
  stored: number
  codec: string | null
  encodings: string | null
}

/**
 * The footer aggregate for a single-column file. Exported as SQL so the test
 * suite runs the identical statement against native DuckDB — if
 * `parquet_metadata` ever renames a column, the test fails instead of the reader.
 */
export const footerSql = (file: string): string => `
    SELECT
      sum(num_values)::BIGINT              AS n_values,
      count(DISTINCT row_group_id)::BIGINT AS row_groups,
      sum(total_uncompressed_size)::BIGINT AS encoded,
      sum(total_compressed_size)::BIGINT   AS stored,
      any_value(compression)               AS codec
    FROM parquet_metadata('${file}')
  `

/**
 * `encodings` is read separately from the sizes so that a duckdb build without
 * that column degrades to an empty encodings list instead of failing the whole
 * lab on a binder error. The sizes are the measurement; the encodings are
 * corroboration — worth showing, not worth breaking for.
 */
export const encodingsSql = (file: string): string =>
  `SELECT any_value(encodings::VARCHAR) AS encodings FROM parquet_metadata('${file}')`

async function footer(file: string): Promise<MetaRow> {
  const base = await query<Omit<MetaRow, 'encodings'>>(footerSql(file))
  if (base.length === 0) throw new Error(`no parquet metadata for ${file}`)

  let encodings: string | null = null
  try {
    const e = await query<{ encodings: string | null }>(encodingsSql(file))
    encodings = e[0]?.encodings ?? null
  } catch {
    /* Older builds do not expose `encodings`. The sizes still stand. */
  }
  return { ...base[0], encodings }
}

/** Split duckdb's list-as-string rendering into plain encoding names. */
export function parseEncodings(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .replace(/^[[]|[\]]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0)
}

export async function measureColumn(c: CodecColumn): Promise<CodecMeasurement> {
  const meta = await footer(c.file)
  const plain = await query<{ b: number }>(`SELECT ${c.plainExpr} AS b FROM (${c.select})`)
  const plainBytes = plain[0]?.b ?? 0

  const safe = (a: number, b: number) => (b > 0 ? a / b : 0)
  return {
    id: c.id,
    values: meta.n_values,
    rowGroups: meta.row_groups,
    plainBytes,
    encodedBytes: meta.encoded,
    storedBytes: meta.stored,
    encodings: parseEncodings(meta.encodings),
    codec: meta.codec ?? 'unknown',
    encodingGain: safe(plainBytes, meta.encoded),
    codecGain: safe(meta.encoded, meta.stored),
    totalRatio: safe(plainBytes, meta.stored),
    bytesPerValue: safe(meta.stored, meta.n_values),
  }
}

export async function measureAll(
  onStep?: (s: string) => void,
): Promise<Record<string, CodecMeasurement>> {
  const out: Record<string, CodecMeasurement> = {}
  for (const c of CODEC_COLUMNS) {
    onStep?.(`reading the footer of ${c.file}`)
    out[c.id] = await measureColumn(c)
  }
  return out
}

/**
 * Stored bytes per value. Sub-byte costs are the interesting ones here — a
 * bit-packed dictionary reference is a fraction of a byte and a run-length
 * encoded column is a small fraction of one — so a fixed two decimals would
 * print the headline result as `0.00`.
 */
export function fmtBytesPerValue(b: number): string {
  if (b >= 1) return `${b.toFixed(2)} B/value`
  if (b >= 0.01) return `${b.toFixed(3)} B/value`
  return `${(b * 8).toPrecision(2)} bits/value`
}
