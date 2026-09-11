/**
 * skew — per-partition row and byte counts for a hash partitioning, measured
 * from real data by SQL, so the browser lab and the test suite run the identical
 * thing.
 *
 * ── The claim this exists to test ──────────────────────────────────────────
 * "Average partition size tells you nothing; the maximum is the runtime." The
 * mean is arithmetic: rows ÷ partitions. It cannot move when the distribution
 * changes, because nothing in it depends on the distribution. The maximum is the
 * only number in the pair that knows anything about the data, and it is the one
 * every worker waits on. A capacity model built on the mean is not conservative
 * or optimistic — it is silent about the thing it was asked.
 *
 * ── What is real here, and what is modelled ───────────────────────────────
 * REAL: the key distribution (generated as DDL from a seeded hash), the
 * partition assignment (`hash(key) % N`, evaluated by DuckDB), and every row and
 * byte count below (SQL aggregates over the actual values, not estimates).
 *
 * MODELLED: the shuffle itself. Nothing here moves bytes between processes. A
 * distributed exchange adds at least three things this cannot show — network
 * transfer of the partitioned bytes, spilling when one partition exceeds a
 * worker's memory, and work stealing or adaptive re-partitioning that a modern
 * planner may apply once it sees the skew at runtime. The lab says so on screen.
 * What transfers from here is the SHAPE: which partition is the biggest, by how
 * much, and what salting does to it.
 *
 * ── Fixture decisions that are load-bearing ───────────────────────────────
 * · Keys are FIXED WIDTH (`key_000001`, ten bytes always). Every level of skew
 *   therefore has the identical total byte count, so mean bytes per partition is
 *   flat by construction and the max is the only thing that moves. A variable
 *   width key would let a reader attribute the change to the strings.
 * · The payload width varies per ROW and is independent of the key, so byte skew
 *   is not simply row skew rescaled — it is measured separately and reported
 *   separately.
 * · The heavy hitter is one key, and the tail is a mild power law on top of it.
 *   Both dials are exposed as levels because a long tail alone is survivable at
 *   this cardinality and a single hot key is not, which is the more useful half
 *   of the lesson.
 * · The partition count is the model engine's `SHUFFLE_BUCKETS`, so the numbers
 *   here and the Warehouse's `shuffleSkew` mean the same thing: max ÷ mean.
 */

import { SHUFFLE_BUCKETS } from '@/lib/warehouse/engine'
import { exec, query } from './client'
import { FIXTURE_SEED } from './fixtures'

/** Rows in the skew fixture. A group-by over these is a second or two in wasm. */
export const SKEW_ROWS = 480_000

/** Same seed lineage as every other fixture in the course. */
export const SKEW_SEED = FIXTURE_SEED

/** Distinct join keys in the tail. */
export const SKEW_KEYS = 4_096

/**
 * Hash partitions — the parallelism the shuffle has to fill. Taken from the
 * model engine so `max ÷ mean` here is the same statistic the Warehouse reports
 * as `shuffleSkew`.
 */
export const SKEW_PARTITIONS = SHUFFLE_BUCKETS

/** Sub-partitions a heavy hitter is split across when salted. */
export const SALT_BUCKETS = 8

/**
 * A key is "heavy" when it holds more rows than one partition's fair share.
 * That threshold is not a taste: a key bigger than a fair partition cannot be
 * balanced by any assignment that keeps it whole, because every row of it must
 * land in the same place. Splitting it is the only move left.
 */
export const HEAVY_SHARE = 1 / SKEW_PARTITIONS

/** The key the heavy-hitter levels pile rows onto. Rank 1 of the tail. */
export const HOT_KEY = 'key_000001'

/** Bytes charged for the numeric measure column, so a row's cost is checkable by hand. */
export const AMOUNT_BYTES = 8

/** Payload width bounds. Varies per row, independent of the key. */
export const PAYLOAD_MIN_BYTES = 8
export const PAYLOAD_SPREAD_BYTES = 25

export interface SkewLevel {
  id: string
  label: string
  /** Fraction of rows forced onto `HOT_KEY`. */
  hotShare: number
  /**
   * Exponent applied to a uniform draw before it is turned into a key rank.
   * 1 is a uniform key distribution; above 1 concentrates mass on low ranks —
   * a Zipf-ish tail without a single key eating the table.
   */
  tailExponent: number
  why: string
}

/**
 * Five distributions over the same 4,096 keys and the same 480,000 rows. Only
 * the shape changes, so every difference in the tables below is caused by the
 * distribution and by nothing else.
 */
export const SKEW_LEVELS: SkewLevel[] = [
  {
    id: 'uniform',
    label: 'uniform',
    hotShare: 0,
    tailExponent: 1,
    why: 'The control. Every key equally likely, so the only imbalance left is which keys the hash happened to put together — the irreducible floor of a hash partitioning.',
  },
  {
    id: 'tail',
    label: 'zipf-ish tail',
    hotShare: 0,
    tailExponent: 2,
    why: 'A long tail and no single hot key: the most popular key holds about 1.6% of the rows, half a partition’s fair share. A tail alone is survivable at this cardinality, and saying so is what stops "skew" from meaning "any non-uniformity".',
  },
  {
    id: 'hot-05',
    label: 'one key at 5%',
    hotShare: 0.05,
    tailExponent: 2,
    why: 'One key crosses the fair-share line. From here on the busiest partition is decided by a single key rather than by the hash.',
  },
  {
    id: 'hot-20',
    label: 'one key at 20%',
    hotShare: 0.2,
    tailExponent: 2,
    why: 'A plausible production shape: one tenant, one null-ish sentinel, one bot account. The mean has not moved a row.',
  },
  {
    id: 'hot-45',
    label: 'one key at 45%',
    hotShare: 0.45,
    tailExponent: 2,
    why: 'The shape that ends a shuffle. Nearly half the rows want one worker, and the other thirty-one wait for it while looking idle in every dashboard that plots the average.',
  },
]

export const skewLevel = (id: string): SkewLevel => {
  const l = SKEW_LEVELS.find((x) => x.id === id)
  if (!l) throw new Error(`no skew level ${id}`)
  return l
}

/** The key column for a level. One table, one column per distribution. */
export const keyColumn = (l: SkewLevel): string => `key_${l.id.replace(/-/g, '_')}`

/* -------------------------------- the fixture ------------------------------- */

/**
 * The key expression for one level.
 *
 * `u_hot` decides whether a row is forced onto the heavy hitter; `u_rank` picks
 * a rank in the tail. Both come from independent hashes of the row number, so
 * the whole table is a pure function of `SKEW_SEED` and reproduces byte for byte
 * on every machine.
 */
export const keyExpr = (l: SkewLevel): string => {
  const rank = `least(${SKEW_KEYS}, 1 + floor(${SKEW_KEYS} * pow(u_rank, ${l.tailExponent.toFixed(3)})))`
  const tail = `'key_' || lpad(${rank}::BIGINT::VARCHAR, 6, '0')`
  if (l.hotShare <= 0) return tail
  return `CASE WHEN u_hot < ${l.hotShare} THEN '${HOT_KEY}' ELSE ${tail} END`
}

/**
 * The fixture. One table, one key column per level, plus the per-row salt source
 * and a payload whose width varies independently of the key.
 *
 * `salt_src` is drawn per ROW rather than per key on purpose: a salt that
 * depended on the key would send every row of the hot key to the same
 * sub-partition and fix nothing.
 */
export const skewFixtureSql = (rows: number = SKEW_ROWS): string => `
CREATE OR REPLACE TABLE skew_keys AS
WITH src AS (
  SELECT
    i AS row_id,
    ((hash(i * 2 + ${SKEW_SEED}) % 1000000) / 1000000.0)   AS u_hot,
    ((hash(i * 3 + ${SKEW_SEED}) % 1000000) / 1000000.0)   AS u_rank,
    (hash(i * 5 + ${SKEW_SEED}) % ${SALT_BUCKETS})::BIGINT AS salt_src,
    (${PAYLOAD_MIN_BYTES} + (hash(i * 7 + ${SKEW_SEED}) % ${PAYLOAD_SPREAD_BYTES}))::INTEGER AS payload_bytes
  FROM range(${rows}) t(i)
)
SELECT
  row_id,
${SKEW_LEVELS.map((l) => `  ${keyExpr(l)} AS ${keyColumn(l)}`).join(',\n')},
  salt_src,
  repeat('x', payload_bytes) AS payload,
  ((hash(row_id * 11 + ${SKEW_SEED}) % 90000) / 100.0)::DOUBLE AS amount
FROM src;
`

/**
 * Bytes charged to a row: the key, the payload and the measure column. Measured
 * from the values with `octet_length` rather than assumed from the schema, so
 * the byte totals are a property of the data. The BLOB cast is required —
 * DuckDB's `octet_length` is defined on bytes, and asking it for the byte length
 * of a VARCHAR rather than its character count is exactly the point.
 */
const rowBytesExpr = (key: string): string =>
  `(octet_length(${key}::BLOB) + octet_length(payload::BLOB) + ${AMOUNT_BYTES})`

/* ------------------------------- the routings ------------------------------- */

export type Routing = 'hash' | 'salted'

/** Plain hash partitioning: the partition is a property of the key alone. */
export const hashPartitionExpr = (key: string): string =>
  `(hash(${key}) % ${SKEW_PARTITIONS})::BIGINT`

/**
 * Salted partitioning: heavy hitters are spread across `SALT_BUCKETS` adjacent
 * partitions, everything else is left where the hash put it.
 *
 * The salt is added to the BUCKET rather than concatenated to the key before
 * hashing. Hashing `key || '#' || salt` is the textbook phrasing and it collides:
 * two salt values can hash into the same partition, so the split is uneven for
 * no reason. Adding to the bucket makes the S sub-partitions distinct by
 * construction, which is what production skew-join hints actually arrange.
 */
export const saltedPartitionExpr = (key: string): string => `
  CASE WHEN ${key} IN (SELECT heavy_key FROM heavy)
       THEN (((hash(${key}) % ${SKEW_PARTITIONS}) + (salt_src % ${SALT_BUCKETS})) % ${SKEW_PARTITIONS})::BIGINT
       ELSE ${hashPartitionExpr(key)}
  END`

/** Keys above the fair-share line, found in the data rather than declared. */
const heavyCte = (key: string, rows: number): string => `
  heavy AS (
    SELECT ${key} AS heavy_key
    FROM skew_keys
    GROUP BY 1
    HAVING count(*) > ${Math.floor(rows * HEAVY_SHARE)}
  )`

export const partitionExpr = (routing: Routing, key: string): string =>
  routing === 'hash' ? hashPartitionExpr(key) : saltedPartitionExpr(key)

/**
 * The measurement: row and byte counts for EVERY partition, including the ones
 * that received nothing.
 *
 * The empty partitions are the reason this is a `LEFT JOIN` over `range()`
 * rather than a bare `GROUP BY`. A group-by reports only the partitions that got
 * work, so a mean taken over its rows would quietly improve as skew got worse —
 * the idle workers would drop out of the denominator. Idle workers are exactly
 * what skew produces, so they have to be in the frame. Every reduction below is
 * computed in TypeScript from this profile, so the mean is always total ÷
 * `SKEW_PARTITIONS` and never an average over survivors.
 */
export const partitionProfileSql = (
  routing: Routing,
  key: string,
  rows: number = SKEW_ROWS,
): string => `
WITH ${routing === 'salted' ? `${heavyCte(key, rows)},` : ''}
  routed AS (
    SELECT ${partitionExpr(routing, key)} AS pid, ${rowBytesExpr(key)} AS row_bytes
    FROM skew_keys
  ),
  parts AS (
    SELECT pid, count(*)::BIGINT AS nrows, sum(row_bytes)::BIGINT AS nbytes
    FROM routed GROUP BY 1
  )
SELECT
  b.pid::BIGINT                  AS pid,
  coalesce(parts.nrows, 0)::BIGINT  AS nrows,
  coalesce(parts.nbytes, 0)::BIGINT AS nbytes
FROM range(${SKEW_PARTITIONS}) b(pid)
LEFT JOIN parts ON parts.pid = b.pid
ORDER BY b.pid;
`

/** The whole table's totals, computed without any partitioning at all. */
export const tableTotalsSql = (key: string): string => `
SELECT
  count(*)::BIGINT                        AS total_rows,
  sum(${rowBytesExpr(key)})::BIGINT       AS total_bytes,
  count(DISTINCT ${key})::BIGINT          AS distinct_keys,
  max(octet_length(${key}::BLOB))::BIGINT AS max_key_bytes,
  min(octet_length(${key}::BLOB))::BIGINT AS min_key_bytes
FROM skew_keys;
`

/** The most popular keys, for the panel that names the culprit. */
export const topKeysSql = (key: string, limit = 3): string => `
SELECT ${key} AS k, count(*)::BIGINT AS n
FROM skew_keys GROUP BY 1 ORDER BY n DESC, k LIMIT ${limit};
`

/**
 * What salting costs. The other side of the join has one row per key; every
 * salted key needs a copy per sub-partition, or the rows that were routed by
 * salt would find no match. The expansion is MATERIALISED and counted rather
 * than multiplied out in prose, because the point is that the fix is a trade and
 * not a free lunch.
 */
export const saltCostSql = (key: string, rows: number = SKEW_ROWS): string => `
WITH ${heavyCte(key, rows)},
  dim AS (SELECT DISTINCT ${key} AS k FROM skew_keys),
  dim_salted AS (
    SELECT k, 0 AS s FROM dim WHERE k NOT IN (SELECT heavy_key FROM heavy)
    UNION ALL
    SELECT k, s FROM dim, range(${SALT_BUCKETS}) r(s) WHERE k IN (SELECT heavy_key FROM heavy)
  )
SELECT
  (SELECT count(*) FROM dim)::BIGINT        AS dim_rows,
  (SELECT count(*) FROM heavy)::BIGINT      AS heavy_keys,
  (SELECT count(*) FROM dim_salted)::BIGINT AS dim_rows_salted;
`

/* ------------------------------ the measurement ----------------------------- */

export interface PartitionCell {
  pid: number
  rows: number
  bytes: number
}

export interface PartitionStats {
  routing: Routing
  /** Every partition, in id order, including the ones that got nothing. */
  profile: PartitionCell[]
  /** Partitions that received at least one row. */
  partitionsUsed: number
  /** Partitions that received nothing — idle workers, and part of the mean. */
  partitionsEmpty: number
  totalRows: number
  totalBytes: number
  /** totalRows ÷ SKEW_PARTITIONS. Arithmetic; cannot move with the distribution. */
  meanRows: number
  meanBytes: number
  maxRows: number
  minRows: number
  maxBytes: number
  minBytes: number
  /** max ÷ mean — the same statistic the model engine reports as `shuffleSkew`. */
  rowSkew: number
  byteSkew: number
  busiestPartition: number
}

export interface SkewMeasurement {
  levelId: string
  keyColumn: string
  distinctKeys: number
  /** Every key is the same width, so byte totals cannot drift between levels. */
  keyBytesFixed: boolean
  /** Rows and bytes counted with no partitioning, for the conservation check. */
  tableRows: number
  tableBytes: number
  hash: PartitionStats
  salted: PartitionStats
  topKeys: Array<{ key: string; rows: number; share: number }>
  heavyKeys: number
  dimRows: number
  dimRowsSalted: number
  /** dimRowsSalted ÷ dimRows. The price of the fix, on the other side of the join. */
  dimReplication: number
  /** Rows invented or lost by the hash routing. Must be 0. */
  hashRowDrift: number
  /** Bytes invented or lost by the hash routing. Must be 0. */
  hashByteDrift: number
  saltedRowDrift: number
  saltedByteDrift: number
  /** Non-null when something came out against the expected story. Surfaced, never hidden. */
  anomaly: string | null
}

interface ProfileRow {
  pid: number
  nrows: number
  nbytes: number
}

let loaded = false

/** Build the fixture table. Idempotent per tab. */
export async function loadSkewFixture(
  onStep?: (s: string) => void,
  opts: { rows?: number } = {},
): Promise<void> {
  if (loaded) {
    onStep?.('fixture already built')
    return
  }
  const rows = opts.rows ?? SKEW_ROWS
  onStep?.(`generating ${rows.toLocaleString('en-US')} rows across ${SKEW_LEVELS.length} distributions`)
  await exec(skewFixtureSql(rows))
  loaded = true
  onStep?.('ready')
}

export const skewFixtureLoaded = (): boolean => loaded

/** Reset the memo. Tests build the fixture more than once per process. */
export const resetSkewFixture = (): void => {
  loaded = false
}

/**
 * Reduce a profile to the numbers the lab reports.
 *
 * `meanRows` is total ÷ partitions and nothing else. Writing it that way rather
 * than as an average over the profile rows is this lab's whole discipline in one
 * line: the denominator is the parallelism you paid for, not the parallelism you
 * happened to use.
 */
export function reduceProfile(
  routing: Routing,
  rows: ProfileRow[],
  anomalies: string[],
): PartitionStats {
  const profile: PartitionCell[] = rows.map((r) => ({ pid: r.pid, rows: r.nrows, bytes: r.nbytes }))
  if (profile.length !== SKEW_PARTITIONS) {
    anomalies.push(
      `${routing} routing reported ${profile.length} partitions, not ${SKEW_PARTITIONS} — the profile does not cover the whole exchange`,
    )
  }
  const totalRows = profile.reduce((n, p) => n + p.rows, 0)
  const totalBytes = profile.reduce((n, p) => n + p.bytes, 0)
  const meanRows = totalRows / SKEW_PARTITIONS
  const meanBytes = totalBytes / SKEW_PARTITIONS
  const maxRows = profile.reduce((n, p) => Math.max(n, p.rows), 0)
  const maxBytes = profile.reduce((n, p) => Math.max(n, p.bytes), 0)
  const busiest = profile.reduce(
    (a, b) => (b.rows > a.rows ? b : a),
    profile[0] ?? { pid: -1, rows: 0, bytes: 0 },
  )
  return {
    routing,
    profile,
    partitionsUsed: profile.filter((p) => p.rows > 0).length,
    partitionsEmpty: profile.filter((p) => p.rows === 0).length,
    totalRows,
    totalBytes,
    meanRows,
    meanBytes,
    maxRows,
    minRows: profile.reduce((n, p) => Math.min(n, p.rows), maxRows),
    maxBytes,
    minBytes: profile.reduce((n, p) => Math.min(n, p.bytes), maxBytes),
    rowSkew: meanRows > 0 ? maxRows / meanRows : 0,
    byteSkew: meanBytes > 0 ? maxBytes / meanBytes : 0,
    busiestPartition: busiest.pid,
  }
}

/** One level: the hash routing, the salted routing, and what the salt costs. */
export async function measureSkew(
  level: SkewLevel,
  opts: { rows?: number } = {},
): Promise<SkewMeasurement> {
  const rows = opts.rows ?? SKEW_ROWS
  const key = keyColumn(level)
  const anomalies: string[] = []

  const totals = (
    await query<{
      total_rows: number
      total_bytes: number
      distinct_keys: number
      max_key_bytes: number
      min_key_bytes: number
    }>(tableTotalsSql(key))
  )[0]
  if (!totals) throw new Error(`no totals for ${key}`)

  const hashRows = await query<ProfileRow>(partitionProfileSql('hash', key, rows))
  const saltedRows = await query<ProfileRow>(partitionProfileSql('salted', key, rows))

  const cost = (
    await query<{ dim_rows: number; heavy_keys: number; dim_rows_salted: number }>(
      saltCostSql(key, rows),
    )
  )[0]
  if (!cost) throw new Error(`no salt cost for ${key}`)

  const top = await query<{ k: string; n: number }>(topKeysSql(key))

  const hash = reduceProfile('hash', hashRows, anomalies)
  const salted = reduceProfile('salted', saltedRows, anomalies)

  const hashRowDrift = hash.totalRows - totals.total_rows
  const hashByteDrift = hash.totalBytes - totals.total_bytes
  const saltedRowDrift = salted.totalRows - totals.total_rows
  const saltedByteDrift = salted.totalBytes - totals.total_bytes

  if (hashRowDrift !== 0 || saltedRowDrift !== 0) {
    anomalies.push(
      `the partitioning did not conserve rows: hash is off by ${hashRowDrift}, salted by ${saltedRowDrift}`,
    )
  }
  if (hashByteDrift !== 0 || saltedByteDrift !== 0) {
    anomalies.push(
      `the partitioning did not conserve bytes: hash is off by ${hashByteDrift}, salted by ${saltedByteDrift}`,
    )
  }
  if (totals.max_key_bytes !== totals.min_key_bytes) {
    anomalies.push(
      `keys are not fixed width (${totals.min_key_bytes}..${totals.max_key_bytes} bytes), so byte totals are not comparable across levels`,
    )
  }
  if (level.hotShare > HEAVY_SHARE && cost.heavy_keys === 0) {
    anomalies.push(
      `no key crossed the fair-share line even though this level forces ${(level.hotShare * 100).toFixed(0)}% onto one key`,
    )
  }
  if (totals.distinct_keys !== SKEW_KEYS) {
    anomalies.push(
      `the key domain came out at ${totals.distinct_keys} distinct keys rather than ${SKEW_KEYS}, so the levels are not drawn from the same domain`,
    )
  }

  return {
    levelId: level.id,
    keyColumn: key,
    distinctKeys: totals.distinct_keys,
    keyBytesFixed: totals.max_key_bytes === totals.min_key_bytes,
    tableRows: totals.total_rows,
    tableBytes: totals.total_bytes,
    hash,
    salted,
    topKeys: top.map((t) => ({
      key: t.k,
      rows: t.n,
      share: totals.total_rows > 0 ? t.n / totals.total_rows : 0,
    })),
    heavyKeys: cost.heavy_keys,
    dimRows: cost.dim_rows,
    dimRowsSalted: cost.dim_rows_salted,
    dimReplication: cost.dim_rows > 0 ? cost.dim_rows_salted / cost.dim_rows : 1,
    hashRowDrift,
    hashByteDrift,
    saltedRowDrift,
    saltedByteDrift,
    anomaly: anomalies.length > 0 ? anomalies.join('; ') : null,
  }
}

export type SkewGrid = Record<string, SkewMeasurement>

export async function measureAllSkew(
  onStep?: (s: string) => void,
  opts: { rows?: number } = {},
): Promise<SkewGrid> {
  const grid: SkewGrid = {}
  let i = 0
  for (const l of SKEW_LEVELS) {
    i += 1
    onStep?.(`measuring ${i}/${SKEW_LEVELS.length}: ${l.label}`)
    grid[l.id] = await measureSkew(l, opts)
  }
  return grid
}

/* --------------------------------- reductions ------------------------------- */

/**
 * Is the mean flat across every level? An equality, not a band: the mean is
 * rows ÷ partitions and both are constants of the fixture, so anything other
 * than exact agreement means the levels are not comparable.
 */
export function meanIsFlat(grid: SkewGrid): boolean {
  const means = SKEW_LEVELS.map((l) => grid[l.id]?.hash.meanRows).filter((m) => m !== undefined)
  if (means.length !== SKEW_LEVELS.length) return false
  return means.every((m) => m === means[0])
}

/** Does the busiest partition grow monotonically as the hot key grows? */
export function maxRises(grid: SkewGrid): boolean {
  const ordered = [...SKEW_LEVELS].sort((a, b) => a.hotShare - b.hotShare || a.tailExponent - b.tailExponent)
  const maxes = ordered.map((l) => grid[l.id]?.hash.maxRows)
  if (maxes.some((m) => m === undefined)) return false
  return maxes.every((m, i) => i === 0 || m! >= maxes[i - 1]!)
}

/** Total bytes conserved by both routings, in every level. An absolute. */
export function bytesConserved(grid: SkewGrid): boolean {
  const ms = Object.values(grid)
  if (ms.length === 0) return false
  return ms.every(
    (m) => m.hashByteDrift === 0 && m.saltedByteDrift === 0 && m.hashRowDrift === 0 && m.saltedRowDrift === 0,
  )
}

/** The level with the worst hash skew, for the panels that need a headline. */
export const worstLevel = (grid: SkewGrid): SkewMeasurement | undefined =>
  Object.values(grid).sort((a, b) => b.hash.rowSkew - a.hash.rowSkew)[0]

export const fmtRatio = (r: number): string => `${r.toFixed(2)}×`

export const fmtShare = (r: number): string => `${(r * 100).toFixed(1)}%`
