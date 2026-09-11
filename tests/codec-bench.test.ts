/**
 * Codec bench contract tests.
 *
 * The codec-bench lab asks the reader to predict six compression ratios and then
 * shows them the measurement. That only teaches anything if the ORDERING of those
 * ratios is a property of the data rather than an accident of one duckdb build,
 * so this suite runs the lab's own SQL — `codecSourceSql`, `copySql`, `footerSql`,
 * and each column's `plainExpr`, imported, not retyped — against native DuckDB and
 * asserts the relationships the lesson stands on.
 *
 * ── The assertion style, and why ───────────────────────────────────────────
 * Never an exact byte count. A codec version bump, a writer heuristic change or a
 * different page-header size would break exact assertions and teach nobody
 * anything. What must not change is that a sorted low-cardinality column beats the
 * same values shuffled, that a narrow range beats a wide one, and that random
 * doubles sit on the floor at ~1×. Those are claims about information, so they are
 * asserted as orderings and as bands wide enough to survive an engine upgrade.
 *
 * ── The one thing this suite proves that the lab cannot ────────────────────
 * The lab's ratio denominator is `plainExpr`: arithmetic over the values. The
 * honest question is whether that arithmetic matches what a real PLAIN-encoded
 * Parquet file costs. Here it is checked directly — every column is written a
 * second time with `DICTIONARY_SIZE_LIMIT 0`, which forces genuine PLAIN, and the
 * arithmetic must agree with the writer's own footer to within half a percent.
 * The lab does not write those files (six more at browser scale is ~80 MB of
 * virtual filesystem to re-prove this); it relies on this test instead, and says so.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUCKETS,
  CODEC_COLUMNS,
  bucketOf,
  codecSourceSql,
  copyPlainSql,
  copySql,
  encodingsSql,
  fmtBytesPerValue,
  footerSql,
  parseEncodings,
  type CodecColumn,
} from '@/lib/duckdb/codecs'

/**
 * 40k rows rather than the lab's 2M. Ratios are the subject and most of them are
 * scale-free; the one that is NOT (the clustered string, whose run lengths grow
 * with rows-per-distinct-value) is asserted with a floor low enough to hold at
 * both scales — see the `not scale-free` test, which pins that behaviour down
 * rather than papering over it.
 */
const ROWS = 40_000
const ROW_GROUP = 2_000

let dir: string
let conn: DuckDBConnection

async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const r = await conn.runAndReadAll(sql)
  return r.getRowObjects() as T[]
}

const num = (v: unknown): number => Number(v)

const snappyPath = (c: CodecColumn) => join(dir, c.id + '.parquet')
const plainPath = (c: CodecColumn) => join(dir, c.id + '-plain.parquet')

interface Measured {
  id: string
  values: number
  rowGroups: number
  plainBytes: number
  plainFileBytes: number
  encodedBytes: number
  storedBytes: number
  encodings: string[]
  codec: string
  encodingGain: number
  codecGain: number
  totalRatio: number
}

const m: Record<string, Measured> = {}

async function measure(c: CodecColumn): Promise<Measured> {
  const [f] = await rows(footerSql(snappyPath(c)))
  const [e] = await rows<{ encodings: string | null }>(encodingsSql(snappyPath(c)))
  const [p] = await rows(footerSql(plainPath(c)))
  const [a] = await rows<{ b: unknown }>(`SELECT ${c.plainExpr} AS b FROM (${c.select})`)

  const plainBytes = num(a.b)
  const encodedBytes = num(f.encoded)
  const storedBytes = num(f.stored)
  return {
    id: c.id,
    values: num(f.n_values),
    rowGroups: num(f.row_groups),
    plainBytes,
    plainFileBytes: num(p.stored),
    encodedBytes,
    storedBytes,
    encodings: parseEncodings(e?.encodings ?? null),
    codec: String(f.codec),
    encodingGain: plainBytes / encodedBytes,
    codecGain: encodedBytes / storedBytes,
    totalRatio: plainBytes / storedBytes,
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'columnspaces-codec-'))
  const instance = await DuckDBInstance.create(':memory:')
  conn = await instance.connect()

  /* The lab's own DDL, at test scale. Not a copy of it — the exported string. */
  await conn.run(codecSourceSql(ROWS))

  for (const c of CODEC_COLUMNS) {
    await conn.run(copySql(c, snappyPath(c), ROW_GROUP))
    await conn.run(copyPlainSql(c, plainPath(c), ROW_GROUP))
  }
  for (const c of CODEC_COLUMNS) m[c.id] = await measure(c)
}, 180_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------- the fixture -------------------------------- */

describe('the codec fixture', () => {
  it('writes one column per file, all six of them, at the requested row count', async () => {
    expect(CODEC_COLUMNS.length).toBe(6)
    expect(new Set(CODEC_COLUMNS.map((c) => c.file)).size).toBe(6)
    expect(new Set(CODEC_COLUMNS.map((c) => c.id)).size).toBe(6)
    for (const c of CODEC_COLUMNS) {
      const meta = await rows<{ cols: unknown }>(
        `SELECT count(DISTINCT path_in_schema) AS cols FROM parquet_metadata('${snappyPath(c)}')`,
      )
      expect(num(meta[0].cols), `${c.id} is not single-column`).toBe(1)
      expect(m[c.id].values, `${c.id} row count`).toBe(ROWS)
      expect(m[c.id].rowGroups, `${c.id} row groups`).toBe(ROWS / ROW_GROUP)
      expect(m[c.id].codec, `${c.id} codec`).toBe('SNAPPY')
    }
  })

  it('is deterministic — the same seed gives the same bytes', async () => {
    const before = m['region-shuffled'].storedBytes
    await conn.run(codecSourceSql(ROWS))
    const again = join(dir, 'again.parquet')
    const col = CODEC_COLUMNS.find((c) => c.id === 'region-shuffled')!
    await conn.run(copySql(col, again, ROW_GROUP))
    const [f] = await rows(footerSql(again))
    expect(num(f.stored)).toBe(before)
  })

  /**
   * The clustered/shuffled pair is only an argument if it is the SAME data. If
   * the two files differed in their value multiset, the ratio difference would
   * prove nothing about ordering.
   */
  it('the clustered and shuffled string columns hold an identical multiset', async () => {
    const counts = async (c: CodecColumn) =>
      rows<{ v: string; n: unknown }>(
        `SELECT v, count(*) AS n FROM read_parquet('${snappyPath(c)}') GROUP BY v ORDER BY v`,
      )
    const a = await counts(CODEC_COLUMNS.find((c) => c.id === 'region-clustered')!)
    const b = await counts(CODEC_COLUMNS.find((c) => c.id === 'region-shuffled')!)
    expect(a.map((r) => [r.v, num(r.n)])).toEqual(b.map((r) => [r.v, num(r.n)]))
    expect(a.length, 'the low-cardinality column should have 8 distinct values').toBe(8)
  })

  it('the columns really have the cardinality and ordering the lab claims', async () => {
    const distinct = async (c: CodecColumn) => {
      const r = await rows<{ n: unknown }>(
        `SELECT count(DISTINCT v) AS n FROM read_parquet('${snappyPath(c)}')`,
      )
      return num(r[0].n)
    }
    const byId = (id: string) => CODEC_COLUMNS.find((c) => c.id === id)!

    expect(await distinct(byId('region-clustered'))).toBe(8)
    expect(await distinct(byId('basket-size'))).toBe(20)
    /* Hash draws collide, so "unique" is honestly "nearly unique". */
    expect(await distinct(byId('customer-id'))).toBeGreaterThan(ROWS * 0.99)
    expect(await distinct(byId('noise'))).toBeGreaterThan(ROWS * 0.99)
    expect(await distinct(byId('order-ts'))).toBe(ROWS)

    const inversions = async (c: CodecColumn) => {
      const r = await rows<{ n: unknown }>(`
        SELECT count(*) AS n FROM (
          SELECT v, lag(v) OVER () AS prev FROM read_parquet('${snappyPath(c)}')
        ) WHERE prev IS NOT NULL AND v < prev
      `)
      return num(r[0].n)
    }
    expect(await inversions(byId('region-clustered')), 'clustered must be sorted').toBe(0)
    expect(await inversions(byId('order-ts')), 'the timestamp must be monotone').toBe(0)
    expect(
      await inversions(byId('region-shuffled')),
      'shuffled must actually be shuffled',
    ).toBeGreaterThan(ROWS / 10)
  })
})

/* ------------------------ the measurement is the real thing ----------------- */

describe('the footer is the shape src/lib/duckdb/codecs.ts depends on', () => {
  it('parquet_metadata exposes every field the measurement reads', async () => {
    const meta = await rows(
      `SELECT * FROM parquet_metadata('${snappyPath(CODEC_COLUMNS[0])}') LIMIT 1`,
    )
    const keys = Object.keys(meta[0])
    for (const needed of [
      'row_group_id',
      'path_in_schema',
      'num_values',
      'total_compressed_size',
      'total_uncompressed_size',
      'compression',
      'encodings',
    ]) {
      expect(keys, `parquet_metadata lacks ${needed}`).toContain(needed)
    }
  })

  /**
   * The load-bearing check. If `plainExpr` and a real PLAIN file disagreed, every
   * ratio in the lab would be wrong by that factor.
   */
  it('the plain-byte arithmetic matches a real PLAIN-encoded file to within 0.5%', () => {
    for (const c of CODEC_COLUMNS) {
      const r = m[c.id]
      const drift = Math.abs(r.plainFileBytes - r.plainBytes) / r.plainFileBytes
      expect(
        drift,
        `${c.id}: arithmetic ${r.plainBytes} B vs writer ${r.plainFileBytes} B`,
      ).toBeLessThan(0.005)
    }
  })

  it('the forced-plain baseline really is PLAIN-encoded', async () => {
    for (const c of CODEC_COLUMNS) {
      const [e] = await rows<{ encodings: string | null }>(encodingsSql(plainPath(c)))
      expect(parseEncodings(e.encodings), `${c.id} baseline encodings`).toContain('PLAIN')
    }
  })

  it('parseEncodings survives duckdb rendering a list as a string', () => {
    expect(parseEncodings('[PLAIN_DICTIONARY, RLE]')).toEqual(['PLAIN_DICTIONARY', 'RLE'])
    expect(parseEncodings('[PLAIN]')).toEqual(['PLAIN'])
    expect(parseEncodings(null)).toEqual([])
    expect(parseEncodings('')).toEqual([])
  })
})

/* --------------------- the claim the lab asks to be checked ----------------- */

describe('the claim the codec-bench lab asks the reader to check', () => {
  /** The lesson. Identical values, identical writer, identical codec, different order. */
  it('the SAME low-cardinality values compress far better clustered than shuffled', () => {
    const clustered = m['region-clustered']
    const shuffled = m['region-shuffled']
    expect(clustered.totalRatio).toBeGreaterThan(shuffled.totalRatio)
    expect(
      clustered.totalRatio / shuffled.totalRatio,
      `clustered ${clustered.totalRatio.toFixed(1)}× vs shuffled ${shuffled.totalRatio.toFixed(1)}×`,
    ).toBeGreaterThan(5)
    expect(clustered.storedBytes).toBeLessThan(shuffled.storedBytes / 5)
  })

  it('the clustered column clears 20× and the shuffled one lands in single or low double digits', () => {
    expect(m['region-clustered'].totalRatio).toBeGreaterThan(20)
    expect(m['region-shuffled'].totalRatio).toBeGreaterThan(4)
    expect(m['region-shuffled'].totalRatio).toBeLessThan(60)
  })

  /**
   * The finding that contradicts the folklore, and the one the lab surfaces
   * loudest: DuckDB's Parquet writer emits PLAIN for TIMESTAMP. There is no delta
   * encoding, so a perfectly sorted timestamp gets whatever Snappy can find in a
   * stream of 8-byte little-endian integers, and that is almost nothing.
   *
   * If a future DuckDB starts emitting DELTA_BINARY_PACKED this test fails — and
   * it should, because the lab's copy would then be wrong.
   */
  it('the monotone timestamp is written PLAIN and therefore barely compresses', () => {
    const ts = m['order-ts']
    expect(ts.encodings, 'timestamp encodings').toContain('PLAIN')
    expect(ts.encodings, 'no delta encoding is emitted for TIMESTAMP').not.toContain(
      'DELTA_BINARY_PACKED',
    )
    expect(ts.encodingGain, 'PLAIN means the encoding bought nothing').toBeLessThan(1.05)
    expect(ts.totalRatio, `monotone timestamp measured ${ts.totalRatio.toFixed(2)}×`).toBeLessThan(2)
    /* It is above 1× — Snappy does find the shared high-order bytes — but only just. */
    expect(ts.totalRatio).toBeGreaterThan(1)
  })

  it('the narrow-range integer lands where bit-packing predicts', () => {
    /* 20 distinct values need 5 bits against a stored 32-bit int: 32/5 ≈ 6.4×. */
    const b = m['basket-size']
    expect(b.totalRatio, `basket_size measured ${b.totalRatio.toFixed(2)}×`).toBeGreaterThan(3)
    expect(b.totalRatio).toBeLessThan(15)
  })

  it('the near-unique integer and the uniform-random double both sit on the 1× floor', () => {
    for (const id of ['customer-id', 'noise']) {
      const r = m[id]
      expect(r.totalRatio, `${id} measured ${r.totalRatio.toFixed(3)}×`).toBeGreaterThan(0.85)
      expect(r.totalRatio, `${id} measured ${r.totalRatio.toFixed(3)}×`).toBeLessThan(1.15)
    }
    /* And the double is genuinely the near-worst case: no encoding, no codec gain. */
    expect(m['noise'].encodingGain).toBeLessThan(1.05)
    expect(m['noise'].codecGain).toBeLessThan(1.05)
  })

  /** The ordering is the lesson. Cardinality, then ordering, then range, then nothing. */
  it('the ratios come out in the order the lesson claims', () => {
    const chain = ['region-clustered', 'region-shuffled', 'basket-size', 'order-ts']
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = m[chain[i]]
      const b = m[chain[i + 1]]
      expect(
        a.totalRatio,
        `${chain[i]} (${a.totalRatio.toFixed(2)}×) should beat ${chain[i + 1]} (${b.totalRatio.toFixed(2)}×)`,
      ).toBeGreaterThan(b.totalRatio)
    }
    /* And every one of them beats the incompressible floor. */
    for (const id of chain) expect(m[id].totalRatio).toBeGreaterThan(m['noise'].totalRatio)
  })

  /**
   * The claim in duck-labs.ts is that ratio follows the data, not the codec's
   * reputation. This is that claim as arithmetic: on the column with the biggest
   * ratio in the fixture, Snappy's contribution is nil — it is very slightly
   * negative, because framing overhead costs bytes when there is nothing to find.
   */
  it('the codec contributes essentially nothing to the biggest ratio — the encoding does it all', () => {
    const c = m['region-clustered']
    expect(c.codecGain, `snappy gain ${c.codecGain.toFixed(2)}×`).toBeLessThan(1.1)
    expect(c.encodingGain).toBeGreaterThan(c.codecGain * 20)
    expect(c.encodings, 'a dictionary is what did the work').toEqual(
      expect.arrayContaining([expect.stringContaining('DICTIONARY')]),
    )
  })

  /**
   * Stated as a test so it cannot quietly stop being true: the clustered string
   * ratio is the one number in this fixture that is NOT scale-free, because a run
   * gets longer as rows-per-distinct-value grows. The lab says so in the UI; this
   * pins it.
   */
  it('the clustered ratio grows with scale — it is not scale-free, and the lab says so', async () => {
    const col = CODEC_COLUMNS.find((c) => c.id === 'region-clustered')!
    const small = m['region-clustered'].totalRatio

    await conn.run(codecSourceSql(ROWS * 5))
    const bigFile = join(dir, 'region-clustered-big.parquet')
    await conn.run(copySql(col, bigFile, ROW_GROUP * 5))
    const [f] = await rows(footerSql(bigFile))
    const [a] = await rows<{ b: unknown }>(`SELECT ${col.plainExpr} AS b FROM (${col.select})`)
    const big = num(a.b) / num(f.stored)

    expect(big, `${small.toFixed(0)}× at ${ROWS} rows, ${big.toFixed(0)}× at ${ROWS * 5}`).toBeGreaterThan(small)

    /* Restore the fixture for any test that runs after this one. */
    await conn.run(codecSourceSql(ROWS))
  })
})

/* ------------------------------ the prediction UI --------------------------- */

describe('the per-value cost the lab prints', () => {
  it('is 4 bytes for the near-unique integer and 8 for the double — the type width, no discount', () => {
    const per = (id: string) => m[id].storedBytes / m[id].values
    expect(per('customer-id')).toBeGreaterThan(3.95)
    expect(per('customer-id')).toBeLessThan(4.1)
    expect(per('noise')).toBeGreaterThan(7.95)
    expect(per('noise')).toBeLessThan(8.1)
  })

  /**
   * Which unit the formatter picks depends on scale — 20 row groups at test scale
   * puts this at hundredths of a byte, 2M rows in the browser puts it in bits. The
   * contract is that neither prints as zero.
   */
  it('is a small fraction of a byte for the clustered column, and never prints as zero', () => {
    const per = m['region-clustered'].storedBytes / m['region-clustered'].values
    expect(per).toBeLessThan(0.05)
    expect(per).toBeGreaterThan(0)
    const s = fmtBytesPerValue(per)
    expect(s).toMatch(/^[0-9.]+ (B|bits)\/value$/)
    expect(parseFloat(s), `formatted as "${s}"`).toBeGreaterThan(0)
  })

  it('formats sub-byte, fractional and whole-byte costs without printing 0.00', () => {
    expect(fmtBytesPerValue(8)).toBe('8.00 B/value')
    expect(fmtBytesPerValue(0.51)).toBe('0.510 B/value')
    expect(fmtBytesPerValue(0.000609)).toMatch(/bits\/value$/)
    expect(fmtBytesPerValue(0.000609)).not.toContain('0.00 B')
  })
})

/**
 * The lab tells the reader the random double is not information-theoretically
 * incompressible — the generator draws from a billion values and stores each in
 * 64 bits, so a perfect coder would get roughly 2×, and Parquet gets 1.00×
 * because the entropy is not in a form a byte-oriented codec can see. That is a
 * claim about the generator, so it is checked against the generator.
 */
describe('the double really is low-entropy data that still will not compress', () => {
  it('every value is a multiple of 1e-9, so the column carries ~30 bits, not 52', async () => {
    const r = await rows<{ off: unknown; n: unknown }>(`
      SELECT max(abs(v * 1000000000 - round(v * 1000000000))) AS off,
             count(DISTINCT v) AS n
      FROM read_parquet('${snappyPath(CODEC_COLUMNS.find((c) => c.id === 'noise')!)}')
    `)
    expect(num(r[0].off), 'values are k/1e9 for integer k').toBeLessThan(1e-3)
    expect(num(r[0].n)).toBeLessThanOrEqual(1_000_000_000)
    /* And despite that headroom, nothing recovers it. */
    expect(m['noise'].totalRatio).toBeLessThan(1.15)
  })
})

describe('the prediction buckets', () => {
  it('tile the whole positive range with no gap and no overlap', () => {
    expect(BUCKETS[0].min).toBe(0)
    expect(BUCKETS[BUCKETS.length - 1].max).toBe(Number.POSITIVE_INFINITY)
    for (let i = 0; i + 1 < BUCKETS.length; i++) {
      expect(BUCKETS[i].max, `bucket ${i} must abut ${i + 1}`).toBe(BUCKETS[i + 1].min)
    }
  })

  it('classify a ratio into exactly one bucket', () => {
    expect(bucketOf(1)).toBe('flat')
    expect(bucketOf(1.49)).toBe('flat')
    expect(bucketOf(1.5)).toBe('modest')
    expect(bucketOf(4.99)).toBe('modest')
    expect(bucketOf(5)).toBe('strong')
    expect(bucketOf(19.9)).toBe('strong')
    expect(bucketOf(20)).toBe('extreme')
    expect(bucketOf(12_000)).toBe('extreme')
  })

  /**
   * The buckets only work as a prediction game if the six columns do not all
   * land in one. Four buckets, and the fixture must occupy at least three of them.
   */
  it('the fixture spreads across the buckets rather than piling into one', () => {
    const hit = new Set(CODEC_COLUMNS.map((c) => bucketOf(m[c.id].totalRatio)))
    expect(hit.size, `buckets occupied: ${[...hit].join(', ')}`).toBeGreaterThanOrEqual(3)
  })
})
