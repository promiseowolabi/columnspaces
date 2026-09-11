/**
 * Pruning lab contract tests.
 *
 * ── What is actually under test ────────────────────────────────────────────
 * Not a re-implementation of the lab. The lab's own modules — `pruningSourceSql`,
 * `copyPruningSql`, `shapeSql`, `auditSql`, `measure`, `measureAll`, and through
 * them `computeBill` from `src/lib/duckdb/bill.ts` — are imported and executed
 * here. Only the transport is swapped: `@/lib/duckdb/client` is mocked so that
 * `query`/`exec` run against native DuckDB in Node instead of duckdb-wasm in a
 * tab. So a bug in the production pruning arithmetic fails this suite, which is
 * the entire point of writing it this way rather than restating the logic.
 *
 * This runs at the browser's exact scale (512,000 rows, six files). That costs a
 * few seconds and buys something a scaled proxy cannot: the numbers asserted here
 * are the numbers the reader sees.
 *
 * ── The assertion style, and why ───────────────────────────────────────────
 * Relationships in generous bands, never byte counts. A DuckDB version bump, a
 * writer heuristic or a Snappy change would break exact assertions and teach
 * nobody anything. What must not change is that a matching-column predicate
 * prunes far more than a wrong-column one at the same selectivity, that a wider
 * window prunes less, and that finer row groups prune at least as well while
 * costing strictly more metadata. Those are claims about information and
 * arithmetic, so they hold across engine versions.
 *
 * ── The one assertion that is not a band ───────────────────────────────────
 * `falseNegativeRows` must be exactly 0 in every configuration. Pruning's two
 * failure modes are not comparable: over-reading is a bill, under-reading is a
 * silently wrong answer. It is checked twice and both checks are in SQL over the
 * data rather than over the metadata that made the decision:
 *
 *   1. Per row group, count the rows that satisfy the predicate under DuckDB's
 *      own typed evaluation, and assert none of them sit in a skipped group.
 *   2. Per row group, compute the true min and max of each predicate column from
 *      the DATA and assert the footer statistics bound them. That is the root
 *      property a zone map must have; if it ever failed, every pruning decision
 *      built on it would be unsound regardless of predicate.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The transport swap. `vi.hoisted` gives the mock factory something to reach
 * that is safe to reference before `beforeAll` has run — the factory is
 * evaluated during module resolution, so a plain `const` would be in its
 * temporal dead zone.
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

import {
  CUSTOMER_CLUSTERED,
  CUSTOMER_MAX,
  CUSTOMER_MIN,
  FIXTURE_COLUMNS,
  PROJECTION,
  PRUNING_FILES,
  PRUNING_ROWS,
  PRUNING_SPAN_SECONDS,
  PRUNING_START,
  REFERENCE_FILE_ID,
  REFERENCE_WINDOW_ID,
  ROW_GROUP_VARIANTS,
  VECTOR_SIZE,
  WINDOWS,
  cellKey,
  customerPredicate,
  fmtCount,
  fmtPercent,
  fmtSelectivity,
  loadPruningFixtures,
  measureAll,
  pruningConfigurations,
  pruningPath,
  shapeSql,
  tsPredicate,
  type PruningGrid,
  type PruningMeasurement,
} from '@/lib/duckdb/pruning'

let dir: string
let conn: DuckDBConnection
let grid: PruningGrid

/** Plain SQL access for the assertions the production code does not make. */
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const r = await conn.runAndReadAll(sql)
  return r.getRowObjects() as T[]
}

const num = (v: unknown): number => Number(v)

const path = (fileId: string): string => {
  const f = PRUNING_FILES.find((x) => x.id === fileId)!
  return pruningPath(f, dir)
}

const at = (fileId: string, windowId: string, column: 'order_ts' | 'customer_id') => {
  const m = grid[cellKey(fileId, windowId, column)]
  if (!m) throw new Error(`no measurement for ${fileId}/${windowId}/${column}`)
  return m
}

const COARSEST = ROW_GROUP_VARIANTS[0]
const FINEST = ROW_GROUP_VARIANTS[ROW_GROUP_VARIANTS.length - 1]
const NEXT_FINEST = ROW_GROUP_VARIANTS[ROW_GROUP_VARIANTS.length - 2]
const WIDEST = WINDOWS[WINDOWS.length - 1]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'columnspaces-pruning-'))
  const instance = await DuckDBInstance.create(':memory:')
  conn = await instance.connect()

  /*
   * The client's contract includes BigInt normalisation — counts arrive from
   * duckdb as BigInt and would otherwise break arithmetic silently. Reproduce it
   * here so the modules under test see what they see in the browser.
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

  /* The lab's own loader and measurement, unmodified, writing into a temp dir. */
  await loadPruningFixtures(undefined, { dir })
  grid = await measureAll(undefined, dir)
}, 600_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/* -------------------------------- the fixture ------------------------------- */

describe('the pruning fixture', () => {
  it('writes six files, each with the fixture columns, the row count and the snappy codec', async () => {
    expect(PRUNING_FILES.length).toBe(6)
    expect(new Set(PRUNING_FILES.map((f) => f.file)).size).toBe(6)
    expect(new Set(PRUNING_FILES.map((f) => f.id)).size).toBe(6)

    for (const f of PRUNING_FILES) {
      const [meta] = await rows<{ cols: unknown; vals: unknown; codec: string }>(`
        SELECT count(DISTINCT path_in_schema) AS cols,
               sum(num_values) FILTER (WHERE path_in_schema = 'order_ts') AS vals,
               any_value(compression) AS codec
        FROM parquet_metadata('${pruningPath(f, dir)}')
      `)
      expect(num(meta.cols), `${f.id} column count`).toBe(FIXTURE_COLUMNS.length)
      expect(num(meta.vals), `${f.id} row count`).toBe(PRUNING_ROWS)
      expect(meta.codec, `${f.id} codec`).toBe('SNAPPY')
    }
  })

  /**
   * DuckDB rounds ROW_GROUP_SIZE to a multiple of its 2048-row vector, so
   * requesting 2500 silently gets you 4096. Every variant asks for a multiple,
   * and this pins that the label on the UI matches the file.
   */
  it('honours every requested row-group size exactly, because all of them are multiples of the vector size', () => {
    for (const f of ROW_GROUP_VARIANTS) {
      expect(f.rowGroupSize % VECTOR_SIZE, `${f.id} is not a multiple of ${VECTOR_SIZE}`).toBe(0)
      const m = at(f.id, REFERENCE_WINDOW_ID, 'order_ts')
      expect(m.groupRows, `${f.id} requested vs written rows per group`).toBe(f.rowGroupSize)
      expect(m.rowGroups).toBe(Math.ceil(PRUNING_ROWS / f.rowGroupSize))
    }
  })

  it('is genuinely clustered on the column each file claims', async () => {
    const inversions = async (file: string, col: string) => {
      const r = await rows<{ n: unknown }>(`
        SELECT count(*) AS n FROM (
          SELECT ${col} AS v, lag(${col}) OVER () AS prev
          FROM read_parquet('${file}')
        ) WHERE prev IS NOT NULL AND v < prev
      `)
      return num(r[0].n)
    }
    for (const f of ROW_GROUP_VARIANTS) {
      expect(await inversions(pruningPath(f, dir), 'order_ts'), `${f.id} must be time-ordered`).toBe(0)
    }
    const cust = pruningPath(CUSTOMER_CLUSTERED, dir)
    expect(await inversions(cust, 'customer_id'), 'the mirror file must be customer-ordered').toBe(0)
    /* And it must have LOST the time clustering, or the 2x2 proves nothing. */
    expect(
      await inversions(cust, 'order_ts'),
      'the mirror file must not still be time-ordered',
    ).toBeGreaterThan(PRUNING_ROWS / 10)
  })

  /**
   * The load-bearing fixture decision. `computeBill` compares statistics as the
   * VARCHAR that `parquet_metadata` returns; for integers that is only correct
   * when every value has the same number of digits. A six-digit domain makes
   * lexicographic order and numeric order the same order.
   */
  it('keeps customer_id to a fixed six-digit width, so string and numeric comparison agree', async () => {
    expect(String(CUSTOMER_MIN).length).toBe(6)
    expect(String(CUSTOMER_MAX).length).toBe(6)

    for (const f of PRUNING_FILES) {
      const [r] = await rows<{ bad: unknown; lo: unknown; hi: unknown }>(`
        SELECT
          count(*) FILTER (
            WHERE length(stats_min_value) <> 6 OR length(stats_max_value) <> 6
          ) AS bad,
          min(stats_min_value::BIGINT) AS lo,
          max(stats_max_value::BIGINT) AS hi
        FROM parquet_metadata('${pruningPath(f, dir)}')
        WHERE path_in_schema = 'customer_id'
      `)
      expect(num(r.bad), `${f.id} has non-six-digit customer statistics`).toBe(0)
      expect(num(r.lo)).toBeGreaterThanOrEqual(CUSTOMER_MIN)
      expect(num(r.hi)).toBeLessThanOrEqual(CUSTOMER_MAX)
    }
  })

  it('renders timestamp statistics in the fixed-width format string comparison needs', async () => {
    const [r] = await rows<{ bad: unknown }>(`
      SELECT count(*) FILTER (
        WHERE stats_min_value NOT SIMILAR TO '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}'
           OR stats_max_value NOT SIMILAR TO '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}'
      ) AS bad
      FROM parquet_metadata('${path(REFERENCE_FILE_ID)}')
      WHERE path_in_schema = 'order_ts'
    `)
    expect(num(r.bad), 'a fractional-second rendering would break the comparison').toBe(0)
  })

  it('is deterministic — the same seed and the same COPY give the same bytes', async () => {
    const again = join(dir, 'again.parquet')
    const f = ROW_GROUP_VARIANTS.find((v) => v.id === REFERENCE_FILE_ID)!
    await conn.run(
      `COPY ${f.table} TO '${again}' (FORMAT parquet, ROW_GROUP_SIZE ${f.rowGroupSize}, COMPRESSION snappy);`,
    )
    const total = async (file: string) => {
      const r = await rows<{ b: unknown }>(
        `SELECT sum(total_compressed_size)::BIGINT AS b FROM parquet_metadata('${file}')`,
      )
      return num(r[0].b)
    }
    expect(await total(again)).toBe(await total(path(REFERENCE_FILE_ID)))
  })
})

/* ------------------------- the metadata the lab reads ----------------------- */

describe('parquet metadata is the shape src/lib/duckdb/pruning.ts depends on', () => {
  it('parquet_metadata exposes every field the bill, the shape and the audit read', async () => {
    const meta = await rows(`SELECT * FROM parquet_metadata('${path(REFERENCE_FILE_ID)}') LIMIT 1`)
    const keys = Object.keys(meta[0])
    for (const needed of [
      'row_group_id',
      'path_in_schema',
      'num_values',
      'total_compressed_size',
      'total_uncompressed_size',
      'compression',
      'stats_min_value',
      'stats_max_value',
    ]) {
      expect(keys, `parquet_metadata lacks ${needed}`).toContain(needed)
    }
  })

  it('shapeSql reports uniform row groups, so the audit can locate a row by division', async () => {
    for (const f of PRUNING_FILES) {
      const [s] = await rows<{
        stats_entries: unknown
        row_groups: unknown
        group_rows: unknown
        distinct_group_sizes: unknown
      }>(shapeSql(pruningPath(f, dir)))
      /* At most two sizes: the uniform body, and a short final group. */
      expect(num(s.distinct_group_sizes), `${f.id} row-group sizes`).toBeLessThanOrEqual(2)
      expect(num(s.stats_entries)).toBe(num(s.row_groups) * FIXTURE_COLUMNS.length)
      expect(num(s.group_rows)).toBe(f.rowGroupSize)
    }
  })

  it('read_parquet exposes file_row_number, so the false-negative audit can run at all', async () => {
    const [r] = await rows<{ n: unknown; mx: unknown }>(`
      SELECT count(*) AS n, max(file_row_number) AS mx
      FROM read_parquet('${path(REFERENCE_FILE_ID)}', file_row_number = true)
    `)
    expect(num(r.n)).toBe(PRUNING_ROWS)
    expect(num(r.mx)).toBe(PRUNING_ROWS - 1)
  })

  it('the footer byte count is available and grows with the number of row groups', () => {
    const sweep = ROW_GROUP_VARIANTS.map((f) => at(f.id, REFERENCE_WINDOW_ID, 'order_ts'))
    for (const m of sweep) {
      expect(m.footerBytes, `${m.fileId} footer bytes`).not.toBeNull()
      expect(m.fileBytes, `${m.fileId} file bytes`).not.toBeNull()
      expect(m.footerBytes!).toBeGreaterThan(0)
      expect(m.fileBytes!).toBeGreaterThan(m.footerBytes!)
    }
    for (let i = 0; i + 1 < sweep.length; i++) {
      expect(
        sweep[i + 1].footerBytes!,
        `${sweep[i + 1].fileId} (${sweep[i + 1].rowGroups} groups) vs ${sweep[i].fileId} (${sweep[i].rowGroups} groups)`,
      ).toBeGreaterThan(sweep[i].footerBytes!)
    }
    /* End to end: two orders of magnitude more footer for the finest file. */
    expect(sweep[sweep.length - 1].footerBytes! / sweep[0].footerBytes!).toBeGreaterThan(20)
  })
})

/* --------------------------- the claim under test --------------------------- */

describe('the claim the pruning lab asks the reader to check', () => {
  /**
   * The lesson, and the reason this lab exists. Same file, same statistics, same
   * number of matching rows — a different column named in the predicate.
   */
  it('a matching-column predicate prunes far more than a same-selectivity wrong-column one', () => {
    const right = at(REFERENCE_FILE_ID, REFERENCE_WINDOW_ID, 'order_ts')
    const wrong = at(REFERENCE_FILE_ID, REFERENCE_WINDOW_ID, 'customer_id')

    expect(right.fileId).toBe(wrong.fileId)
    expect(right.rowGroups).toBe(wrong.rowGroups)

    expect(
      right.pruningRatio,
      `matching column pruned ${fmtPercent(right.pruningRatio)}`,
    ).toBeGreaterThan(0.9)
    expect(
      wrong.pruningRatio,
      `wrong column pruned ${fmtPercent(wrong.pruningRatio)}`,
    ).toBeLessThan(0.05)
    expect(
      wrong.bytesRead / right.bytesRead,
      `${fmtCount(wrong.bytesRead)} B vs ${fmtCount(right.bytesRead)} B`,
    ).toBeGreaterThan(10)
  })

  it('the two predicates really do select the same needle, so the comparison is about the column', () => {
    for (const w of WINDOWS) {
      const right = at(REFERENCE_FILE_ID, w.id, 'order_ts')
      const wrong = at(REFERENCE_FILE_ID, w.id, 'customer_id')
      const drift =
        Math.abs(right.matchingRows - wrong.matchingRows) / Math.max(right.matchingRows, 1)
      expect(
        drift,
        `${w.label}: ${fmtCount(right.matchingRows)} rows on order_ts vs ${fmtCount(wrong.matchingRows)} on customer_id`,
      ).toBeLessThan(0.15)
      /* And both are close to the intended selectivity. */
      const expected = PRUNING_ROWS * w.selectivity
      expect(right.matchingRows / expected).toBeGreaterThan(0.8)
      expect(right.matchingRows / expected).toBeLessThan(1.25)
    }
  })

  /**
   * The mirror. Without it a reader could conclude that timestamps are special,
   * or that Parquet privileges them. It is the physical order that picks a winner.
   */
  it('the mirror file prunes the customer predicate and starves the timestamp one', () => {
    const cust = at(CUSTOMER_CLUSTERED.id, REFERENCE_WINDOW_ID, 'customer_id')
    const ts = at(CUSTOMER_CLUSTERED.id, REFERENCE_WINDOW_ID, 'order_ts')
    expect(cust.pruningRatio, `customer predicate: ${fmtPercent(cust.pruningRatio)}`).toBeGreaterThan(0.9)
    expect(ts.pruningRatio, `timestamp predicate: ${fmtPercent(ts.pruningRatio)}`).toBeLessThan(0.05)

    /* Same rows, same row-group size as the reference file: only the order differs. */
    expect(cust.rowGroups).toBe(at(REFERENCE_FILE_ID, REFERENCE_WINDOW_ID, 'order_ts').rowGroups)
    expect(ts.bytesRead / cust.bytesRead).toBeGreaterThan(10)
  })

  it('a wider window prunes less, monotonically, down to nothing at the whole history', () => {
    const sweep = WINDOWS.map((w) => at(REFERENCE_FILE_ID, w.id, 'order_ts'))
    for (let i = 0; i + 1 < sweep.length; i++) {
      expect(
        sweep[i + 1].pruningRatio,
        `${WINDOWS[i + 1].label} (${fmtPercent(sweep[i + 1].pruningRatio)}) must not prune more than ${WINDOWS[i].label} (${fmtPercent(sweep[i].pruningRatio)})`,
      ).toBeLessThanOrEqual(sweep[i].pruningRatio)
      expect(sweep[i + 1].bytesRead).toBeGreaterThanOrEqual(sweep[i].bytesRead)
    }
    expect(sweep[0].pruningRatio, 'a one-day window should prune nearly everything').toBeGreaterThan(0.95)
    expect(WIDEST.selectivity).toBe(1)
    expect(sweep[sweep.length - 1].pruningRatio, 'a window covering the history cannot prune').toBe(0)
    expect(sweep[sweep.length - 1].rowGroupsRead).toBe(sweep[sweep.length - 1].rowGroups)
  })

  /**
   * Dial 1, both edges. Finer groups never prune worse on the matching column,
   * and always cost strictly more metadata — which is the half of the trade a
   * pruning-percentage-only chart hides.
   */
  it('smaller row groups prune at least as well while producing strictly more row groups', () => {
    for (const w of WINDOWS) {
      const sweep = ROW_GROUP_VARIANTS.map((f) => at(f.id, w.id, 'order_ts'))
      for (let i = 0; i + 1 < sweep.length; i++) {
        const coarse = sweep[i]
        const fine = sweep[i + 1]
        expect(
          fine.rowGroups,
          `${w.label}: ${fine.fileId} must have more row groups than ${coarse.fileId}`,
        ).toBeGreaterThan(coarse.rowGroups)
        expect(
          fine.statsEntries,
          `${w.label}: ${fine.fileId} must carry more statistics entries`,
        ).toBeGreaterThan(coarse.statsEntries)
        expect(
          fine.pruningRatio,
          `${w.label}: ${fine.fileId} pruned ${fmtPercent(fine.pruningRatio)}, ${coarse.fileId} pruned ${fmtPercent(coarse.pruningRatio)}`,
        ).toBeGreaterThanOrEqual(coarse.pruningRatio)
      }
    }
  })

  it('the resolution ceiling is real: two row groups cannot beat 50%, however narrow the window', () => {
    for (const w of WINDOWS) {
      const m = at(COARSEST.id, w.id, 'order_ts')
      expect(m.rowGroups).toBe(2)
      expect(m.pruningRatio, `${w.label} on ${COARSEST.id}`).toBeLessThanOrEqual(0.5)
    }
    const finest = at(FINEST.id, REFERENCE_WINDOW_ID, 'order_ts')
    expect(finest.pruningRatio, `${FINEST.id} pruned ${fmtPercent(finest.pruningRatio)}`).toBeGreaterThan(0.98)
  })

  /** The lab's "where the dial stops paying" paragraph, as arithmetic. */
  it('the last refinement multiplies the metadata for a couple of points of pruning', () => {
    const fine = at(FINEST.id, REFERENCE_WINDOW_ID, 'order_ts')
    const next = at(NEXT_FINEST.id, REFERENCE_WINDOW_ID, 'order_ts')
    expect(fine.statsEntries / next.statsEntries).toBeGreaterThan(3)
    expect(fine.footerBytes! / next.footerBytes!).toBeGreaterThan(2)
    expect(
      fine.pruningRatio - next.pruningRatio,
      `${fmtPercent(next.pruningRatio)} → ${fmtPercent(fine.pruningRatio)}`,
    ).toBeLessThan(0.05)
  })

  /**
   * The losing edge, and the reason the lab refuses to say "smaller is better".
   * When nothing prunes, finer row groups are pure overhead.
   */
  it('at the widest window the finest file reads strictly more bytes than the coarsest', () => {
    const coarse = at(COARSEST.id, WIDEST.id, 'order_ts')
    const fine = at(FINEST.id, WIDEST.id, 'order_ts')
    expect(coarse.pruningRatio).toBe(0)
    expect(fine.pruningRatio).toBe(0)
    expect(
      fine.bytesRead,
      `${fmtCount(fine.bytesRead)} B at ${FINEST.label} vs ${fmtCount(coarse.bytesRead)} B at ${COARSEST.label}`,
    ).toBeGreaterThan(coarse.bytesRead)
    /* Small, and strictly a penalty. Both halves of that sentence are the point. */
    expect(fine.bytesRead / coarse.bytesRead).toBeLessThan(1.1)
    expect(fine.footerBytes!).toBeGreaterThan(coarse.footerBytes!)
  })
})

/* ------------------------------- the invariant ------------------------------- */

describe('the invariant: a false negative is a correctness bug, a false positive is a bill', () => {
  it('audits every configuration the lab reports', () => {
    expect(Object.keys(grid).length).toBe(pruningConfigurations().length)
    for (const m of Object.values(grid)) {
      expect(m.auditRan, `${m.key} was not audited`).toBe(true)
    }
  })

  it('reports zero false negatives in every configuration', () => {
    for (const m of Object.values(grid)) {
      expect(m.falseNegativeRows, `${m.key} skipped rows that matched`).toBe(0)
    }
  })

  it('surfaces no anomalies — the two survival implementations agree everywhere', () => {
    const anomalies = Object.values(grid).filter((m) => m.anomaly !== null)
    expect(anomalies.map((m) => `${m.key}: ${m.anomaly}`)).toEqual([])
  })

  /**
   * The independent check, in SQL over the data rather than over the metadata
   * that made the decision: every row group's true min and max must lie inside
   * the range its footer statistics advertise. This is the property that makes a
   * zone map sound at all — if it failed, every pruning decision built on it
   * would be unsound, for every predicate, whether or not this fixture happened
   * to notice.
   */
  it('the footer statistics bound the data they summarise, per row group, in both columns', async () => {
    for (const f of PRUNING_FILES) {
      const file = pruningPath(f, dir)
      const [r] = await rows<{ groups: unknown; unsound: unknown }>(`
        WITH g AS (
          SELECT max(num_values)::BIGINT AS n FROM parquet_metadata('${file}')
        ),
        actual AS (
          SELECT (file_row_number // (SELECT n FROM g))::BIGINT AS rg,
                 min(order_ts)    AS mn_ts,
                 max(order_ts)    AS mx_ts,
                 min(customer_id) AS mn_c,
                 max(customer_id) AS mx_c
          FROM read_parquet('${file}', file_row_number = true)
          GROUP BY 1
        ),
        stat AS (
          SELECT row_group_id::BIGINT AS rg,
                 (any_value(stats_min_value) FILTER (WHERE path_in_schema = 'order_ts'))::TIMESTAMP    AS mn_ts,
                 (any_value(stats_max_value) FILTER (WHERE path_in_schema = 'order_ts'))::TIMESTAMP    AS mx_ts,
                 (any_value(stats_min_value) FILTER (WHERE path_in_schema = 'customer_id'))::INTEGER   AS mn_c,
                 (any_value(stats_max_value) FILTER (WHERE path_in_schema = 'customer_id'))::INTEGER   AS mx_c
          FROM parquet_metadata('${file}')
          GROUP BY 1
        )
        SELECT count(*)::BIGINT AS groups,
               count(*) FILTER (
                 WHERE s.mn_ts > a.mn_ts OR s.mx_ts < a.mx_ts
                    OR s.mn_c  > a.mn_c  OR s.mx_c  < a.mx_c
               )::BIGINT AS unsound
        FROM actual a JOIN stat s USING (rg)
      `)
      expect(num(r.groups), `${f.id} produced no comparable row groups`).toBeGreaterThan(1)
      expect(num(r.unsound), `${f.id} has row groups whose statistics do not bound their data`).toBe(0)
    }
  })

  /**
   * The other direction, stated so it cannot be mistaken for a defect. The
   * planner may read a group it did not need; it may never skip one it did.
   *
   * Note what the wrong-column row actually shows, because it is sharper than
   * "the statistics were useless": every single row group contains at least one
   * matching customer, so there is genuinely nothing for a min/max pair to
   * exclude. The statistics are correct AND complete AND the pruning decision is
   * optimal — the needle is simply smeared across every block. The waste is
   * therefore not visible per group at all. It is visible per ROW: bytes read
   * divided by rows returned.
   */
  it('never skips a group holding a match, and pays the wrong column per row rather than per group', () => {
    for (const m of Object.values(grid)) {
      expect(
        m.rowGroupsRead,
        `${m.key} read fewer groups than contain matches`,
      ).toBeGreaterThanOrEqual(m.groupsWithMatches)
    }

    const wrong = at(REFERENCE_FILE_ID, REFERENCE_WINDOW_ID, 'customer_id')
    const right = at(REFERENCE_FILE_ID, REFERENCE_WINDOW_ID, 'order_ts')

    /* Every block holds a needle, so nothing is skippable and nothing is over-read. */
    expect(wrong.groupsWithMatches).toBe(wrong.rowGroups)
    expect(wrong.rowGroupsRead).toBe(wrong.rowGroups)
    expect(wrong.falseNegativeRows).toBe(0)

    /* The clustered predicate concentrates its needles into a handful of blocks. */
    expect(right.groupsWithMatches).toBeLessThan(wrong.groupsWithMatches / 10)

    const perRow = (m: PruningMeasurement) => m.bytesRead / m.matchingRows
    expect(
      perRow(wrong) / perRow(right),
      `${perRow(wrong).toFixed(0)} B per matching row on customer_id vs ${perRow(right).toFixed(0)} B on order_ts`,
    ).toBeGreaterThan(10)
  })
})

/* ------------------------- the pure parts of the module ---------------------- */

describe('the predicates and the configuration list', () => {
  it('builds the trailing window from the fixture span, clamping the widest one to the start', () => {
    expect(tsPredicate(WINDOWS[WINDOWS.length - 1]).min).toBe(PRUNING_START)
    for (const w of WINDOWS) {
      const p = tsPredicate(w)
      expect(p.column).toBe('order_ts')
      expect(p.min).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(p.sql).toContain('order_ts >=')
    }
    /* The narrower window must start later. */
    expect(tsPredicate(WINDOWS[0]).min > tsPredicate(WINDOWS[1]).min).toBe(true)
  })

  it('sizes the customer window to the same selectivity as the timestamp window it pairs with', () => {
    const domain = CUSTOMER_MAX - CUSTOMER_MIN + 1
    for (const w of WINDOWS) {
      const p = customerPredicate(w)
      expect(p.column).toBe('customer_id')
      expect(p.min.length, `bound "${p.min}" must be six digits`).toBe(6)
      expect(p.max!.length, `bound "${p.max}" must be six digits`).toBe(6)
      const width = Number(p.max) - Number(p.min) + 1
      expect(width / (domain * w.selectivity)).toBeGreaterThan(0.98)
      expect(width / (domain * w.selectivity)).toBeLessThan(1.02)
    }
    /* The widest window is the whole domain, so it cannot prune either. */
    const widest = customerPredicate(WIDEST)
    expect(Number(widest.min)).toBe(CUSTOMER_MIN)
    expect(Number(widest.max)).toBe(CUSTOMER_MAX)
  })

  it('derives the selectivity ladder from the fixture span and clamps it at 100%', () => {
    expect(PRUNING_SPAN_SECONDS).toBe(PRUNING_ROWS * 123)
    for (let i = 0; i + 1 < WINDOWS.length; i++) {
      expect(WINDOWS[i + 1].selectivity).toBeGreaterThan(WINDOWS[i].selectivity)
    }
    expect(WINDOWS[WINDOWS.length - 1].selectivity).toBe(1)
    expect(WINDOWS[0].selectivity).toBeLessThan(0.01)
  })

  it('enumerates the configurations the lab renders, and nothing it does not', () => {
    const configs = pruningConfigurations()
    /* Five row-group variants × four windows on the matching column. */
    expect(
      configs.filter((c) => c.predicate.column === 'order_ts' && c.file.clusterBy === 'order_ts')
        .length,
    ).toBe(ROW_GROUP_VARIANTS.length * WINDOWS.length)
    /* The wrong-column case at every selectivity, on the reference file. */
    const wrong = configs.filter(
      (c) => c.predicate.column === 'customer_id' && c.file.id === REFERENCE_FILE_ID,
    )
    expect(wrong.length).toBe(WINDOWS.length)
    /* Both predicates against the mirror file. */
    const mirror = configs.filter((c) => c.file.id === CUSTOMER_CLUSTERED.id)
    expect(mirror.map((c) => c.predicate.column).sort()).toEqual(['customer_id', 'order_ts'])
    /* No duplicates: every configuration is a distinct cell. */
    const keys = configs.map((c) => cellKey(c.file.id, c.window.id, c.predicate.column))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('projects both predicate columns, so a byte comparison is not measuring type width', () => {
    expect(PROJECTION).toContain('order_ts')
    expect(PROJECTION).toContain('customer_id')
    expect(PROJECTION).not.toContain('region')
    /* A column nobody projects must exist, or projection has nothing to skip. */
    expect(FIXTURE_COLUMNS.filter((c) => !PROJECTION.includes(c))).toEqual(['region'])
  })

  it('formats counts and percentages without printing a misleading zero', () => {
    expect(fmtPercent(0)).toBe('0.00%')
    expect(fmtPercent(0.9683)).toBe('96.83%')
    expect(fmtSelectivity(0.00137)).toBe('0.14%')
    expect(fmtSelectivity(0.1235)).toBe('12%')
    expect(fmtSelectivity(1)).toBe('100%')
    expect(fmtCount(512_000)).toBe('512,000')
  })
})

/* ---------------------------- the reported numbers -------------------------- */

/**
 * Not an assertion so much as a record: the grid the lab shows, printed once so a
 * future reader of this suite can see what "far more" and "nearly nothing"
 * actually came out as on the day it was written.
 */
describe('the grid the lab renders', () => {
  it('is complete and internally consistent', () => {
    const summary = (m: PruningMeasurement) =>
      `${m.fileId} · ${m.windowId} · ${m.predicateColumn}: ${m.rowGroupsRead}/${m.rowGroups} groups, ${fmtPercent(m.pruningRatio)} pruned, ${fmtCount(m.bytesRead)} B`
    const lines = Object.values(grid).map(summary)
    expect(lines.length).toBe(pruningConfigurations().length)

    for (const m of Object.values(grid)) {
      expect(m.rowGroupsRead, summary(m)).toBeGreaterThanOrEqual(0)
      expect(m.rowGroupsRead).toBeLessThanOrEqual(m.rowGroups)
      expect(m.pruningRatio).toBeCloseTo(1 - m.rowGroupsRead / m.rowGroups, 10)
      expect(m.bytesRead).toBeLessThanOrEqual(m.projectedBytes)
      expect(m.statsEntries).toBe(m.rowGroups * FIXTURE_COLUMNS.length)
      expect(m.matchingRows).toBeGreaterThan(0)
      expect(m.matchingRows).toBeLessThanOrEqual(PRUNING_ROWS)
    }
  })
})
