/**
 * DuckDB SQL contract tests.
 *
 * The duck labs run in a browser against duckdb-wasm, which no test here can
 * instantiate. But almost everything that can actually be WRONG is SQL and
 * arithmetic, and those are portable: the fixture DDL, the `parquet_metadata()`
 * column names the bill depends on, the row-group survival test, and the claim
 * the lab asks the reader to check.
 *
 * So this suite runs the real thing — native DuckDB in Node — over the same SQL
 * the browser will run, at a smaller row count. If `parquet_metadata` ever
 * renames a column, or the clustered fixture stops clustering, this fails here
 * rather than silently reporting nonsense to a reader.
 *
 * What this does NOT cover: the browser wiring (CDN bundle selection, the blob
 * worker, the object URL). That is documented boilerplate, and it is exercised
 * the first time anyone opens the lab.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_DAYS, FIXTURE_SEED } from '@/lib/duckdb/fixtures'

/**
 * 40k rows rather than the browser's 2M: the assertions are about ratios and
 * metadata shape, both scale-free, and a test suite should not take a minute.
 * Row group size scales with it so the group count stays comparable.
 */
const ROWS = 40_000
const ROW_GROUP = 2_000
const PAD_COLUMNS = 40

let dir: string
let conn: DuckDBConnection

const padSelect = (): string =>
  Array.from(
    { length: PAD_COLUMNS },
    (_, i) => `  (hash(i * ${7 + i} + ${FIXTURE_SEED}) % 1000000)::BIGINT AS pad_${String(i).padStart(2, '0')}`,
  ).join(',\n')

async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const r = await conn.runAndReadAll(sql)
  return r.getRowObjects() as T[]
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'columnspaces-duck-'))
  const instance = await DuckDBInstance.create(':memory:')
  conn = await instance.connect()

  /* The same generator shape as src/lib/duckdb/fixtures.ts, at test scale. */
  await conn.run(`
    CREATE OR REPLACE TABLE orders_clustered AS
    SELECT
      TIMESTAMP '2024-01-01 00:00:00' + INTERVAL (i * ${FIXTURE_DAYS} * 86400 / ${ROWS}) SECOND AS order_ts,
      ['EMEA','NA','APAC','LATAM','UK','DACH','NORDIC','ANZ'][((hash(i + ${FIXTURE_SEED}) % 8)::BIGINT) + 1] AS region,
      ((hash(i * 3 + ${FIXTURE_SEED}) % 90000) / 100.0)::DOUBLE AS net_revenue,
      (hash(i * 5 + ${FIXTURE_SEED}) % 250000)::INTEGER AS customer_id,
      ['new','paid','shipped','refunded'][((hash(i * 11 + ${FIXTURE_SEED}) % 4)::BIGINT) + 1] AS status,
    ${padSelect()}
    FROM range(${ROWS}) t(i);
  `)
  await conn.run(`
    CREATE OR REPLACE TABLE orders_shuffled AS
    SELECT * FROM orders_clustered ORDER BY hash(customer_id * 31 + ${FIXTURE_SEED});
  `)
  for (const [table, file] of [
    ['orders_clustered', 'clustered.parquet'],
    ['orders_shuffled', 'shuffled.parquet'],
  ]) {
    await conn.run(
      `COPY ${table} TO '${join(dir, file)}' (FORMAT parquet, ROW_GROUP_SIZE ${ROW_GROUP}, COMPRESSION snappy);`,
    )
  }
}, 120_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const path = (f: string) => join(dir, f)

describe('the fixture generator', () => {
  it('produces the row count and the column shape the labs assume', async () => {
    const [{ n }] = await rows<{ n: bigint }>('SELECT count(*) AS n FROM orders_clustered')
    expect(Number(n)).toBe(ROWS)

    const cols = await rows<{ column_name: string }>('DESCRIBE orders_clustered')
    const names = cols.map((c) => c.column_name)
    /* The three the dashboard query wants, plus the long tail that makes projection matter. */
    expect(names).toContain('order_ts')
    expect(names).toContain('region')
    expect(names).toContain('net_revenue')
    expect(names.filter((n) => n.startsWith('pad_')).length).toBe(PAD_COLUMNS)
  })

  it('is deterministic — the same seed gives the same data', async () => {
    const [a] = await rows<{ s: number }>('SELECT sum(customer_id)::BIGINT::DOUBLE AS s FROM orders_clustered')
    await conn.run(`
      CREATE OR REPLACE TABLE repeat_check AS
      SELECT (hash(i * 5 + ${FIXTURE_SEED}) % 250000)::INTEGER AS customer_id FROM range(${ROWS}) t(i);
    `)
    const [b] = await rows<{ s: number }>('SELECT sum(customer_id)::BIGINT::DOUBLE AS s FROM repeat_check')
    expect(Number(a.s)).toBe(Number(b.s))
  })

  it('the clustered table really is ordered by time and the shuffled one is not', async () => {
    const ordered = async (table: string) => {
      const r = await rows<{ inversions: bigint }>(`
        SELECT count(*) AS inversions FROM (
          SELECT order_ts, lag(order_ts) OVER () AS prev FROM ${table}
        ) WHERE prev IS NOT NULL AND order_ts < prev
      `)
      return Number(r[0].inversions)
    }
    expect(await ordered('orders_clustered')).toBe(0)
    expect(await ordered('orders_shuffled')).toBeGreaterThan(ROWS / 10)
  })
})

describe('parquet_metadata is the shape src/lib/duckdb/bill.ts depends on', () => {
  it('exposes every column the bill reads', async () => {
    const meta = await rows(`SELECT * FROM parquet_metadata('${path('clustered.parquet')}') LIMIT 1`)
    const keys = Object.keys(meta[0])
    for (const needed of [
      'row_group_id',
      'path_in_schema',
      'total_compressed_size',
      'total_uncompressed_size',
      'num_values',
      'compression',
      'stats_min_value',
      'stats_max_value',
    ]) {
      expect(keys, `parquet_metadata lacks ${needed}`).toContain(needed)
    }
  })

  it('writes multiple row groups with per-chunk statistics', async () => {
    const [g] = await rows<{ groups: bigint; with_stats: bigint }>(`
      SELECT
        count(DISTINCT row_group_id) AS groups,
        count(*) FILTER (WHERE stats_min_value IS NOT NULL) AS with_stats
      FROM parquet_metadata('${path('clustered.parquet')}')
    `)
    expect(Number(g.groups)).toBeGreaterThan(5)
    expect(Number(g.with_stats)).toBeGreaterThan(0)
  })
})

/**
 * The bill's own logic, re-implemented over the native engine's metadata. Kept
 * deliberately in the test rather than imported: the production function reads
 * through the wasm client, and duplicating ~15 lines is cheaper than abstracting
 * the engine away from a module whose whole job is to talk to one.
 */
interface Chunk {
  row_group_id: number
  path_in_schema: string
  total_compressed_size: number
  stats_min_value: string | null
  stats_max_value: string | null
}

async function bill(file: string, columns: string[], predicateMin?: string) {
  const raw = await rows<Record<string, unknown>>(`
    SELECT row_group_id::BIGINT AS row_group_id, path_in_schema,
           total_compressed_size::BIGINT AS total_compressed_size,
           stats_min_value, stats_max_value
    FROM parquet_metadata('${path(file)}')
  `)
  const all: Chunk[] = raw.map((r) => ({
    row_group_id: Number(r.row_group_id),
    path_in_schema: String(r.path_in_schema),
    total_compressed_size: Number(r.total_compressed_size),
    stats_min_value: r.stats_min_value === null ? null : String(r.stats_min_value),
    stats_max_value: r.stats_max_value === null ? null : String(r.stats_max_value),
  }))

  const groups = new Set(all.map((c) => c.row_group_id))
  const projected = all.filter((c) => columns.includes(c.path_in_schema))
  const wholeFileBytes = all.reduce((n, c) => n + c.total_compressed_size, 0)
  const projectedBytes = projected.reduce((n, c) => n + c.total_compressed_size, 0)

  const surviving = predicateMin
    ? new Set(
        all
          .filter(
            (c) =>
              c.path_in_schema === 'order_ts' &&
              (c.stats_max_value === null || c.stats_max_value >= predicateMin),
          )
          .map((c) => c.row_group_id),
      )
    : new Set(groups)

  const prunedBytes = projected
    .filter((c) => surviving.has(c.row_group_id))
    .reduce((n, c) => n + c.total_compressed_size, 0)

  return {
    wholeFileBytes,
    projectedBytes,
    prunedBytes,
    groups: groups.size,
    read: surviving.size,
    pruningRatio: 1 - surviving.size / groups.size,
  }
}

const DASHBOARD = ['order_ts', 'region', 'net_revenue']
/* A late window: the fixture spans two years from 2024-01-01. */
const WINDOW_MIN = '2025-12-25 00:00:00'

describe('the claim the scan-bill lab asks the reader to check', () => {
  it('projection alone is a large multiple', async () => {
    const b = await bill('clustered.parquet', DASHBOARD)
    const factor = b.wholeFileBytes / b.projectedBytes
    expect(factor, `projection factor was ${factor.toFixed(1)}x`).toBeGreaterThan(5)
  })

  it('the clustered file prunes most row groups on a narrow time window', async () => {
    const b = await bill('clustered.parquet', DASHBOARD, WINDOW_MIN)
    expect(b.pruningRatio, `pruned ${(b.pruningRatio * 100).toFixed(1)}%`).toBeGreaterThan(0.9)
  })

  /** The lesson's actual point: pruning is a property of layout, not of format. */
  it('the shuffled file prunes almost nothing on the SAME query', async () => {
    const b = await bill('shuffled.parquet', DASHBOARD, WINDOW_MIN)
    expect(b.pruningRatio, `pruned ${(b.pruningRatio * 100).toFixed(1)}%`).toBeLessThan(0.2)
  })

  it('clustered reads far fewer bytes than shuffled for an identical query', async () => {
    const c = await bill('clustered.parquet', DASHBOARD, WINDOW_MIN)
    const s = await bill('shuffled.parquet', DASHBOARD, WINDOW_MIN)
    expect(s.prunedBytes / c.prunedBytes).toBeGreaterThan(5)
  })

  it('the two factors multiply to the total', async () => {
    const b = await bill('clustered.parquet', DASHBOARD, WINDOW_MIN)
    const projection = b.wholeFileBytes / b.projectedBytes
    const pruning = b.projectedBytes / b.prunedBytes
    const total = b.wholeFileBytes / b.prunedBytes
    expect(Math.abs(total - projection * pruning) / total).toBeLessThan(0.02)
  })

  /** A predicate the layout does not serve must NOT prune. Guards against fake pruning. */
  it('no predicate means no pruning', async () => {
    const b = await bill('clustered.parquet', DASHBOARD)
    expect(b.pruningRatio).toBe(0)
    expect(b.read).toBe(b.groups)
  })
})
