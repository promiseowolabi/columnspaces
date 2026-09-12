/**
 * Version-tolerance contract tests.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * `src/lib/duckdb/anatomy.ts` carries candidate-list queries because DuckDB moves
 * catalogue columns between releases and the two engines this course runs are NOT
 * the same version:
 *
 *   tests (@duckdb/node-api)   native, currently 1.5.5
 *   readers (duckdb-wasm 1.32) embeds DuckDB 1.4.3
 *
 * That gap already shipped a bug. `parquet_schema()` grew `column_id` in 1.5, the
 * query was written against it, and every reader's browser answered
 *
 *     Binder Error: Column "column_id" referenced that exists in the SELECT
 *     clause - but this column cannot be referenced before it is defined
 *
 * while the whole suite stayed green, because the mocks run the native engine.
 * The browser e2e caught it. The e2e is the right place to catch an integration
 * failure and the wrong place to be the ONLY coverage, for a specific reason: the
 * fallback branch runs today only because the wasm engine happens to be 1.4.3. The
 * day duckdb-wasm ships a build with `column_id`, candidate zero starts winning,
 * the fallback stops executing anywhere, and it rots silently while everything
 * reports green.
 *
 * So this file tests every candidate INDIVIDUALLY against the native engine and
 * asserts they agree. It does not care which engine version is in play, which is
 * the entire point: the equivalence is what makes a fallback safe, and the
 * equivalence is what a version bump can break.
 *
 * ── What a failure here means ──────────────────────────────────────────────
 * Either a candidate no longer parses on this engine (fine, if another does — the
 * suite says which), or two candidates now disagree, which means readers on
 * different engine versions would see different metadata for the same file. The
 * second is the serious one and it is why the comparison is exact rather than
 * banded.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* The same transport swap the other duckdb suites use. */
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
  FILE_LEVEL_SQL_CANDIDATES,
  SCHEMA_SQL_CANDIDATES,
  fileLevel,
  schemaLevel,
} from '@/lib/duckdb/anatomy'

let dir: string
let conn: DuckDBConnection
let engineVersion = 'unknown'
let file: string

/** Normalise BigInt so two candidates' rows compare by value. */
function normalise(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'bigint' ? Number(v) : v
    return out
  })
}

async function runSql(sql: string): Promise<Record<string, unknown>[]> {
  const r = await conn.runAndReadAll(sql)
  return normalise(r.getRowObjects() as Record<string, unknown>[])
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'columnspaces-versions-'))
  const instance = await DuckDBInstance.create(':memory:')
  conn = await instance.connect()
  bridge.run = runSql

  engineVersion = String((await runSql('SELECT version() AS v'))[0].v)

  /*
   * A file with more than one column and more than one row group, so an ordering
   * bug in the fallback (which synthesises the position with row_number()) would
   * actually show up rather than being masked by a single row.
   */
  file = join(dir, 'versions.parquet')
  await runSql(`
    COPY (
      SELECT
        i::INTEGER                                   AS a,
        (i * 2)::BIGINT                              AS b,
        ('v' || (i % 4)::VARCHAR)                    AS c,
        (i / 3.0)::DOUBLE                            AS d
      FROM range(8192) t(i)
    ) TO '${file}' (FORMAT parquet, ROW_GROUP_SIZE 2048, COMPRESSION snappy);
  `)
}, 60_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('the engines are genuinely different versions', () => {
  it('says which native engine these tests ran against', () => {
    /* Not an assertion about the version — a record of it, so a failure elsewhere
     * in this file can be read against the engine that produced it. */
    expect(engineVersion).toMatch(/^v\d+\.\d+/)
    console.log(`      native engine under test: ${engineVersion}`)
  })

  it('the wasm engine readers get is pinned, and is not assumed to match', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8'),
    )
    /* Exact-pinned on purpose: `latest` on this package is a dev build. */
    expect(pkg.dependencies['@duckdb/duckdb-wasm']).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('parquet_schema candidates', () => {
  it('there is more than one, and the first is the preferred modern shape', () => {
    expect(SCHEMA_SQL_CANDIDATES.length).toBeGreaterThan(1)
    expect(SCHEMA_SQL_CANDIDATES[0]).toContain('column_id::BIGINT')
    /* The fallback must not reference the column that may not exist. */
    for (const c of SCHEMA_SQL_CANDIDATES.slice(1)) {
      expect(c, 'a fallback that still selects column_id is not a fallback').not.toMatch(
        /\bcolumn_id::BIGINT\s+AS\s+column_id/,
      )
    }
    /* Every candidate must be a template, or the substitution silently no-ops. */
    for (const c of SCHEMA_SQL_CANDIDATES) expect(c).toContain('%FILE%')
  })

  /**
   * THE test. Each candidate is executed on its own and the results compared. On
   * an engine that supports both, they must be identical — that equivalence is
   * the only thing that makes falling back safe.
   */
  it('every candidate that parses returns identical rows', async () => {
    const results: { index: number; rows: Record<string, unknown>[] }[] = []
    const rejected: { index: number; error: string }[] = []

    for (const [index, candidate] of SCHEMA_SQL_CANDIDATES.entries()) {
      try {
        results.push({ index, rows: await runSql(candidate.replace('%FILE%', file)) })
      } catch (e) {
        rejected.push({ index, error: e instanceof Error ? e.message : String(e) })
      }
    }

    expect(
      results.length,
      `no parquet_schema candidate parsed on ${engineVersion}: ${rejected
        .map((r) => `#${r.index} ${r.error}`)
        .join(' | ')}`,
    ).toBeGreaterThan(0)

    /* On this engine both shapes are expected to work. If one stops parsing, the
     * message names it rather than leaving a silent single-candidate pass. */
    if (rejected.length > 0) {
      console.log(
        `      note: ${rejected.length} parquet_schema candidate(s) do not parse on ${engineVersion}: ` +
          rejected.map((r) => `#${r.index}`).join(', '),
      )
    }

    const [first, ...rest] = results
    for (const other of rest) {
      expect(
        other.rows,
        `parquet_schema candidate #${other.index} disagrees with #${first.index} on ${engineVersion} — ` +
          'readers on different engine versions would see different metadata for the same file',
      ).toEqual(first.rows)
    }
  })

  it('the synthesised position matches the real column_id, row for row', async () => {
    /* The fallback derives column_id from row_number(). If parquet_schema ever
     * returned rows in another order, the fallback would mislabel every column —
     * so compare the two orderings directly rather than trusting the assumption. */
    const modern = await runSql(SCHEMA_SQL_CANDIDATES[0].replace('%FILE%', file))
    const fallback = await runSql(SCHEMA_SQL_CANDIDATES[1].replace('%FILE%', file))
    expect(fallback.map((r) => r.column_id)).toEqual(modern.map((r) => r.column_id))
    expect(fallback.map((r) => r.name)).toEqual(modern.map((r) => r.name))
  })

  it('schemaLevel returns the leaves regardless of which candidate wins', async () => {
    const entries = await schemaLevel(file)
    /* Row zero is the synthetic root; the leaves are the four columns written. */
    expect(entries.length).toBe(5)
    expect(entries[0].isLeaf).toBe(false)
    expect(entries.filter((e) => e.isLeaf).map((e) => e.name)).toEqual(['a', 'b', 'c', 'd'])
  })

  /**
   * The regression itself, stated as a test: the exact query that broke in the
   * browser must be one of the candidates rather than the only query, and the
   * loop must survive its failure.
   */
  it('a candidate that throws is skipped rather than fatal', async () => {
    const original = bridge.run!
    let calls = 0
    bridge.run = async (sql: string) => {
      calls += 1
      /* Fail exactly like DuckDB 1.4.3 does on the modern shape. */
      if (sql.includes('column_id::BIGINT')) {
        throw new Error(
          'Binder Error: Column "column_id" referenced that exists in the SELECT clause - ' +
            'but this column cannot be referenced before it is defined',
        )
      }
      return original(sql)
    }
    try {
      const entries = await schemaLevel(file)
      expect(calls, 'the fallback was never attempted').toBeGreaterThan(1)
      expect(entries.filter((e) => e.isLeaf).map((e) => e.name)).toEqual(['a', 'b', 'c', 'd'])
    } finally {
      bridge.run = original
    }
  })

  it('when no candidate parses, the engine’s own error is rethrown', async () => {
    const original = bridge.run!
    bridge.run = async () => {
      throw new Error('Binder Error: simulated total failure')
    }
    try {
      await expect(schemaLevel(file)).rejects.toThrow(/simulated total failure/)
    } finally {
      bridge.run = original
    }
  })
})

describe('parquet_file_metadata candidates', () => {
  it('there are several, each a template, degrading to nulls rather than failing', () => {
    expect(FILE_LEVEL_SQL_CANDIDATES.length).toBeGreaterThan(1)
    for (const c of FILE_LEVEL_SQL_CANDIDATES) expect(c).toContain('%FILE%')
    /* The last shape must ask for nothing optional, or there is no floor. */
    const last = FILE_LEVEL_SQL_CANDIDATES[FILE_LEVEL_SQL_CANDIDATES.length - 1]
    expect(last).toContain('NULL::BIGINT               AS footer_bytes')
  })

  it('every candidate that parses agrees on the fields it reports', async () => {
    const parsed: { index: number; rows: Record<string, unknown>[] }[] = []
    for (const [index, candidate] of FILE_LEVEL_SQL_CANDIDATES.entries()) {
      try {
        parsed.push({ index, rows: await runSql(candidate.replace('%FILE%', file)) })
      } catch {
        /* Expected on engines that spell these columns differently. */
      }
    }
    expect(parsed.length).toBeGreaterThan(0)

    /* Compare only the fields both sides actually report: later candidates
     * deliberately return NULL where earlier ones return a value, so the
     * equivalence is over the non-null intersection. */
    const [first, ...rest] = parsed
    for (const other of rest) {
      expect(other.rows.length).toBe(first.rows.length)
      for (const [i, row] of other.rows.entries()) {
        for (const [k, v] of Object.entries(row)) {
          if (v === null || first.rows[i][k] === null) continue
          expect(
            v,
            `file-level candidate #${other.index} disagrees with #${first.index} on ${k}`,
          ).toEqual(first.rows[i][k])
        }
      }
    }
  })

  it('fileLevel reports the row and row-group counts the file really has', async () => {
    const level = await fileLevel(file)
    expect(level.numRows).toBe(8192)
    expect(level.numRowGroups).toBe(4)
    /* footerBytes may legitimately be null on an engine that does not report it —
     * the module's contract is that it degrades rather than throws. */
    expect(level.footerBytes === null || level.footerBytes > 0).toBe(true)
  })

  it('falls back to a nulls-only shape rather than throwing', async () => {
    const original = bridge.run!
    bridge.run = async (sql: string) => {
      if (sql.includes('footer_size::BIGINT') || sql.includes('file_size_bytes::BIGINT')) {
        throw new Error('Binder Error: Referenced column "footer_size" not found')
      }
      return original(sql)
    }
    try {
      const level = await fileLevel(file)
      expect(level.numRows).toBe(8192)
      expect(level.footerBytes).toBeNull()
      expect(level.fileBytes).toBeNull()
    } finally {
      bridge.run = original
    }
  })
})
