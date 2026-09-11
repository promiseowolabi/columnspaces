/**
 * Skew lab contract tests.
 *
 * ── What is actually under test ────────────────────────────────────────────
 * Not a re-implementation. The lab's own module — `skewFixtureSql`,
 * `partitionProfileSql`, `saltCostSql`, `measureSkew`, `measureAllSkew` and the
 * reductions they feed — is imported and executed here. Only the transport is
 * swapped: `@/lib/duckdb/client` is mocked so `query`/`exec` run against native
 * DuckDB in Node instead of duckdb-wasm in a tab. A bug in the production skew
 * arithmetic fails this suite, which is the point of writing it this way rather
 * than restating the logic.
 *
 * This runs at the browser's exact scale (480,000 rows, five distributions, 32
 * partitions), so the numbers asserted here are the numbers the reader sees.
 *
 * ── The assertion style, and why ───────────────────────────────────────────
 * Two kinds of claim, graded two different ways, and the asymmetry is the course's
 * spine rather than a stylistic choice:
 *
 *   COST claims are bands. "max ÷ mean exceeds 8 at 45%" and "salting improves it
 *   by at least 3×" depend on the hash function, the partition count and the
 *   seed. A band survives a DuckDB version bump; an exact figure would break and
 *   teach nobody anything.
 *
 *   CORRECTNESS claims are absolutes. Row and byte conservation is asserted as
 *   exactly 0 drift, in every level, under both routings. A re-partitioning that
 *   loses a row has not made the job cheaper — it has made the answer wrong, and
 *   salting is precisely the kind of change that can do it.
 *
 * The mean being FLAT is asserted as an exact equality rather than a band, because
 * it is an identity: rows ÷ partitions, with both terms constants of the fixture.
 * If it ever moved, the levels would not be comparable and every other number
 * here would be measuring two things at once.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The transport swap. `vi.hoisted` gives the mock factory something safe to
 * reference before `beforeAll` has run — the factory is evaluated during module
 * resolution, so a plain `const` would be in its temporal dead zone.
 */
const bridge = vi.hoisted(() => ({
  run: null as null | ((sql: string) => Promise<Record<string, unknown>[]>),
}))

vi.mock('@/lib/duckdb/client', () => ({
  query: async (sql: string) => bridge.run!(sql),
  queryOne: async (sql: string) => (await bridge.run!(sql))[0],
  exec: async (sql: string) => {
    await bridge.run!(sql)
  },
  isDuckLoaded: () => true,
  getDuck: () => Promise.reject(new Error('duckdb-wasm is not instantiable under vitest')),
  getConnection: () => Promise.reject(new Error('duckdb-wasm is not instantiable under vitest')),
}))

import SkewLab from '@/components/ducklabs/SkewLab'
import {
  HEAVY_SHARE,
  HOT_KEY,
  SALT_BUCKETS,
  SKEW_KEYS,
  SKEW_LEVELS,
  SKEW_PARTITIONS,
  SKEW_ROWS,
  bytesConserved,
  hashPartitionExpr,
  keyColumn,
  loadSkewFixture,
  maxRises,
  meanIsFlat,
  measureAllSkew,
  measureSkew,
  partitionProfileSql,
  saltedPartitionExpr,
  skewFixtureSql,
  skewLevel,
  worstLevel,
  type SkewGrid,
} from '@/lib/duckdb/skew'
import { SHUFFLE_BUCKETS } from '@/lib/warehouse/engine'

let conn: DuckDBConnection
let grid: SkewGrid

/** Plain SQL access, for the assertions the production code does not make. */
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const r = await conn.runAndReadAll(sql)
  return r.getRowObjects() as T[]
}

const num = (v: unknown): number => Number(v)

const CONTROL = SKEW_LEVELS[0]
const WORST = SKEW_LEVELS[SKEW_LEVELS.length - 1]

/** Levels ordered the way the lab presents them: rising hot-key share. */
const ORDERED = [...SKEW_LEVELS].sort(
  (a, b) => a.hotShare - b.hotShare || a.tailExponent - b.tailExponent,
)

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:')
  conn = await instance.connect()

  /*
   * The client's contract includes BigInt normalisation — counts arrive from
   * duckdb as BigInt and would otherwise break arithmetic silently. Reproduce it
   * here so the module under test sees what it sees in the browser.
   */
  bridge.run = async (sql: string) => {
    const r = await conn.runAndReadAll(sql)
    return r.getRowObjects().map((row) => {
      const obj = row as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'bigint') obj[k] = Number(v)
      }
      return obj
    })
  }

  await loadSkewFixture()
  grid = await measureAllSkew()
}, 600_000)

/* -------------------------------- the fixture ------------------------------- */

describe('the skew fixture', () => {
  it('is DDL and nothing else — no binary fixture, no generator script', () => {
    const sql = skewFixtureSql()
    expect(sql).toContain('CREATE OR REPLACE TABLE skew_keys')
    expect(sql).toContain(`range(${SKEW_ROWS})`)
    /* Deterministic by construction: every column is a hash of the row number. */
    expect(sql).toContain('hash(i')
    expect(sql).not.toMatch(/random\s*\(/i)
  })

  it('generates the stated row count and one key column per level', async () => {
    const [r] = await rows<{ n: unknown; cols: unknown }>(`
      SELECT (SELECT count(*) FROM skew_keys) AS n,
             (SELECT count(*) FROM (DESCRIBE skew_keys)) AS cols
    `)
    expect(num(r.n)).toBe(SKEW_ROWS)
    /* row_id, one key column per level, salt_src, payload, amount. */
    expect(num(r.cols)).toBe(4 + SKEW_LEVELS.length)
  })

  it('draws every level from the same fixed-width key domain', () => {
    for (const l of SKEW_LEVELS) {
      const m = grid[l.id]
      expect(m.distinctKeys, `${l.id} distinct keys`).toBe(SKEW_KEYS)
      expect(m.keyBytesFixed, `${l.id} key width`).toBe(true)
    }
  })

  it('gives every level the identical row and byte total, so only the shape differs', () => {
    const totals = SKEW_LEVELS.map((l) => grid[l.id])
    for (const m of totals) {
      expect(m.tableRows).toBe(SKEW_ROWS)
      expect(m.tableBytes).toBe(totals[0].tableBytes)
    }
  })

  it('takes its partition count from the model engine, so max ÷ mean means one thing', () => {
    expect(SKEW_PARTITIONS).toBe(SHUFFLE_BUCKETS)
    expect(hashPartitionExpr('k')).toContain(`% ${SKEW_PARTITIONS}`)
    expect(saltedPartitionExpr('k')).toContain(`% ${SALT_BUCKETS}`)
  })

  it('reports no anomalies — nothing came out against the expected story', () => {
    for (const l of SKEW_LEVELS) {
      expect(grid[l.id].anomaly, `${l.id}`).toBeNull()
    }
  })
})

/* ------------------------- the mean against the maximum --------------------- */

describe('the mean tells you nothing', () => {
  /**
   * The identity at the centre of the lab. Asserted as exact equality across
   * five wildly different distributions, because the mean is rows ÷ partitions
   * and neither term can respond to the data.
   */
  it('is IDENTICAL under every distribution, to the row', () => {
    const means = SKEW_LEVELS.map((l) => grid[l.id].hash.meanRows)
    for (const m of means) expect(m).toBe(SKEW_ROWS / SKEW_PARTITIONS)
    expect(new Set(means).size).toBe(1)
    expect(meanIsFlat(grid)).toBe(true)
  })

  it('is identical on bytes too, because the keys are fixed width', () => {
    const means = SKEW_LEVELS.map((l) => grid[l.id].hash.meanBytes)
    expect(new Set(means).size).toBe(1)
  })

  it('holds under the salted routing as well — salting moves the max, never the mean', () => {
    for (const l of SKEW_LEVELS) {
      expect(grid[l.id].salted.meanRows).toBe(grid[l.id].hash.meanRows)
      expect(grid[l.id].salted.meanBytes).toBe(grid[l.id].hash.meanBytes)
    }
  })
})

describe('the maximum is the runtime', () => {
  it('rises monotonically with the hot key’s share', () => {
    const maxes = ORDERED.map((l) => grid[l.id].hash.maxRows)
    for (let i = 1; i < maxes.length; i++) {
      expect(maxes[i], `${ORDERED[i].id} vs ${ORDERED[i - 1].id}`).toBeGreaterThan(maxes[i - 1])
    }
    expect(maxRises(grid)).toBe(true)
  })

  /** A band: the exact figure depends on the hash, the seed and the bucket count. */
  it('exceeds 8× the mean on the skewed key', () => {
    const m = grid[WORST.id]
    expect(m.hash.rowSkew).toBeGreaterThan(8)
    expect(m.hash.byteSkew).toBeGreaterThan(8)
    /* The busiest partition is the hot key's partition, and the hot key's share
     * times the partition count is the floor of the ratio. */
    expect(m.hash.rowSkew).toBeGreaterThan(WORST.hotShare * SKEW_PARTITIONS * 0.9)
  })

  it('stays close to 1 on a uniform key — the floor a hash partitioning cannot beat', () => {
    const m = grid[CONTROL.id]
    expect(m.hash.rowSkew).toBeGreaterThan(1)
    expect(m.hash.rowSkew).toBeLessThan(1.5)
    /* Not exactly 1: 4,096 keys do not divide evenly into 32 buckets, and saying
     * "skew is 1.00 when uniform" would be the wrong lesson. */
    expect(m.hash.rowSkew).not.toBe(1)
  })

  it('is not moved by a long tail alone at this cardinality', () => {
    /* The tail level's most popular key holds well under a fair share, so the
     * busiest partition is barely worse than the uniform control. This is the
     * assertion that stops "skew" from meaning "any non-uniformity". */
    const tail = grid[skewLevel('tail').id]
    expect(tail.topKeys[0].share).toBeLessThan(HEAVY_SHARE)
    expect(tail.heavyKeys).toBe(0)
    expect(tail.hash.rowSkew).toBeLessThan(2)
  })

  it('names the heavy hitter the lab claims, once it crosses the fair-share line', () => {
    const m = grid[WORST.id]
    expect(m.topKeys[0].key).toBe(HOT_KEY)
    expect(m.topKeys[0].share).toBeGreaterThan(HEAVY_SHARE)
    expect(m.heavyKeys).toBe(1)
    expect(worstLevel(grid)?.levelId).toBe(WORST.id)
  })

  /**
   * Adding workers is the reflex, and it makes the ratio worse: the mean falls
   * with the partition count while the hot key's partition does not move at all.
   * Measured rather than argued, by re-running the profile at 4× the parallelism.
   */
  it('gets WORSE when you add workers, because the hot key does not split', async () => {
    const key = keyColumn(WORST)
    const wide = SKEW_PARTITIONS * 4
    const profile = await rows<{ nrows: unknown }>(`
      SELECT count(*)::BIGINT AS nrows
      FROM skew_keys GROUP BY (hash(${key}) % ${wide})::BIGINT
    `)
    const counts = profile.map((r) => num(r.nrows))
    const max = Math.max(...counts)
    const mean = SKEW_ROWS / wide
    expect(max / mean).toBeGreaterThan(grid[WORST.id].hash.rowSkew)
    /* The absolute size of the busiest partition barely improves, which is the
     * part that actually costs time. */
    expect(max).toBeGreaterThan(grid[WORST.id].hash.maxRows * 0.9)
  })
})

/* ---------------------------------- the fix --------------------------------- */

describe('salting the heavy hitter', () => {
  it('cuts max ÷ mean by at least 3× on the skewed key', () => {
    const m = grid[WORST.id]
    expect(m.hash.rowSkew / m.salted.rowSkew).toBeGreaterThan(3)
    expect(m.salted.rowSkew).toBeLessThan(4)
  })

  it('does not reach 1×, and the lab does not claim it does', () => {
    const m = grid[WORST.id]
    /* Splitting a key that holds share `s` across S sub-partitions bounds its
     * contribution at s/S, and those sub-partitions still carry ordinary
     * traffic. So the floor is above 1 by construction. */
    expect(m.salted.rowSkew).toBeGreaterThan(1)
    const bound = (m.topKeys[0].share / SALT_BUCKETS) * SKEW_PARTITIONS
    expect(m.salted.rowSkew).toBeGreaterThan(bound * 0.8)
  })

  it('leaves an unskewed distribution exactly where it was', () => {
    /* No key crosses the fair-share line, so the salted routing is the hash
     * routing. Byte-for-byte, not approximately. */
    for (const id of [CONTROL.id, 'tail']) {
      const m = grid[id]
      expect(m.heavyKeys).toBe(0)
      expect(m.salted.maxRows).toBe(m.hash.maxRows)
      expect(m.salted.maxBytes).toBe(m.hash.maxBytes)
      expect(m.dimRowsSalted).toBe(m.dimRows)
      expect(m.dimReplication).toBe(1)
    }
  })

  it('charges for itself on the build side, and the charge is measured', () => {
    const m = grid[WORST.id]
    expect(m.heavyKeys).toBeGreaterThan(0)
    /* One extra dimension row per salt bucket per heavy key, materialised and
     * counted rather than multiplied out in prose. */
    expect(m.dimRowsSalted).toBe(m.dimRows + m.heavyKeys * (SALT_BUCKETS - 1))
    expect(m.dimRowsSalted).toBeGreaterThan(m.dimRows)
    expect(m.dimReplication).toBeGreaterThan(1)
  })

  it('spreads the heavy key across exactly SALT_BUCKETS distinct partitions', async () => {
    /* The salt is added to the bucket rather than hashed into it, so the
     * sub-partitions are distinct by construction. Hashing `key || salt` would
     * collide and split unevenly for no reason. */
    const key = keyColumn(WORST)
    const [r] = await rows<{ n: unknown }>(`
      WITH heavy AS (
        SELECT ${key} AS heavy_key FROM skew_keys GROUP BY 1
        HAVING count(*) > ${Math.floor(SKEW_ROWS * HEAVY_SHARE)}
      )
      SELECT count(DISTINCT (((hash(${key}) % ${SKEW_PARTITIONS}) + (salt_src % ${SALT_BUCKETS})) % ${SKEW_PARTITIONS}))::BIGINT AS n
      FROM skew_keys WHERE ${key} IN (SELECT heavy_key FROM heavy)
    `)
    expect(num(r.n)).toBe(SALT_BUCKETS)
  })
})

/* ------------------------------- the invariant ------------------------------ */

describe('the invariant — conservation, as an absolute', () => {
  it('invents and loses exactly 0 rows and 0 bytes, in every level, under both routings', () => {
    for (const l of SKEW_LEVELS) {
      const m = grid[l.id]
      expect(m.hashRowDrift, `${l.id} hash rows`).toBe(0)
      expect(m.hashByteDrift, `${l.id} hash bytes`).toBe(0)
      expect(m.saltedRowDrift, `${l.id} salted rows`).toBe(0)
      expect(m.saltedByteDrift, `${l.id} salted bytes`).toBe(0)
      expect(m.hash.totalRows).toBe(m.tableRows)
      expect(m.salted.totalRows).toBe(m.tableRows)
      expect(m.hash.totalBytes).toBe(m.tableBytes)
      expect(m.salted.totalBytes).toBe(m.tableBytes)
    }
    expect(bytesConserved(grid)).toBe(true)
  })

  it('cross-checks the byte total against SQL that knows nothing about partitions', async () => {
    const key = keyColumn(WORST)
    const [r] = await rows<{ b: unknown; n: unknown }>(`
      SELECT sum(octet_length(${key}::BLOB) + octet_length(payload::BLOB) + 8)::BIGINT AS b,
             count(*)::BIGINT AS n
      FROM skew_keys
    `)
    expect(num(r.b)).toBe(grid[WORST.id].hash.totalBytes)
    expect(num(r.n)).toBe(grid[WORST.id].hash.totalRows)
  })

  it('routes every row into [0, SKEW_PARTITIONS) and leaves no partition unaccounted for', () => {
    for (const l of SKEW_LEVELS) {
      for (const stats of [grid[l.id].hash, grid[l.id].salted]) {
        expect(stats.profile).toHaveLength(SKEW_PARTITIONS)
        expect(stats.profile.map((p) => p.pid)).toEqual(
          Array.from({ length: SKEW_PARTITIONS }, (_, i) => i),
        )
        expect(stats.partitionsUsed + stats.partitionsEmpty).toBe(SKEW_PARTITIONS)
      }
    }
  })

  /**
   * The mean must be over the whole exchange, not over the partitions that got
   * work. Asserted directly against SQL that omits the empty ones, because the
   * difference between those two denominators is the exact mistake the lab is
   * about — and at high skew it flatters the number.
   */
  it('computes the mean over every partition, including the idle ones', async () => {
    const key = keyColumn(WORST)
    const [r] = await rows<{ used: unknown; avg_used: unknown }>(`
      WITH parts AS (
        SELECT (hash(${key}) % ${SKEW_PARTITIONS})::BIGINT AS pid, count(*)::BIGINT AS nrows
        FROM skew_keys GROUP BY 1
      )
      SELECT count(*)::BIGINT AS used, avg(nrows) AS avg_used FROM parts
    `)
    const m = grid[WORST.id]
    expect(m.hash.meanRows).toBe(m.tableRows / SKEW_PARTITIONS)
    if (num(r.used) < SKEW_PARTITIONS) {
      expect(num(r.avg_used)).toBeGreaterThan(m.hash.meanRows)
    } else {
      expect(num(r.avg_used)).toBeCloseTo(m.hash.meanRows, 6)
    }
  })
})

/* ------------------------------- determinism -------------------------------- */

describe('determinism', () => {
  it('measures the same numbers twice, on the same fixture', async () => {
    const again = await measureSkew(WORST)
    const first = grid[WORST.id]
    expect(again.hash.profile).toEqual(first.hash.profile)
    expect(again.salted.profile).toEqual(first.salted.profile)
    expect(again.hash.rowSkew).toBe(first.hash.rowSkew)
    expect(again.topKeys).toEqual(first.topKeys)
  })

  it('produces no NaN and no negative count anywhere in the grid', () => {
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'number') {
        expect(Number.isFinite(v), `${path} is ${v}`).toBe(true)
        expect(v, `${path} is negative`).toBeGreaterThanOrEqual(0)
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
      }
    }
    walk(grid, 'grid')
  })

  it('emits the profile query with a LEFT JOIN over the whole exchange', () => {
    const sql = partitionProfileSql('hash', 'key_uniform')
    expect(sql).toContain(`range(${SKEW_PARTITIONS})`)
    expect(sql).toContain('LEFT JOIN')
  })

  /**
   * The pre-run state has to be honest: before the reader presses run there are no
   * measurements, and the page must say so rather than showing a plausible number.
   * It must also state the modelling limit up front, because a lab that measures
   * partition sizes and calls it a shuffle is overclaiming.
   */
  it('renders its empty state without claiming a measurement it has not made', () => {
    const html = renderToString(createElement(SkewLab, { trackColor: '#F472B6' }))
    expect(html).toContain('no measurements yet')
    expect(html).toContain('the shuffle is modelled')
    expect(html).toContain('network transfer')
    expect(html).toContain('spilling')
    expect(html).toContain('work stealing')
    expect(html).not.toContain('NaN')
  })
})
