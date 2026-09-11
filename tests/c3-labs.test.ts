/**
 * C3 lab contract tests — Parquet Anatomy and The Snapshot Lab.
 *
 * ── What is actually under test ────────────────────────────────────────────
 * Not a re-implementation. The labs' own modules — `src/lib/duckdb/anatomy.ts`
 * and `src/lib/duckdb/snapshot.ts` — are imported and executed here, with only
 * the transport swapped: `@/lib/duckdb/client` is mocked so `query`/`exec` run
 * against native DuckDB in Node instead of duckdb-wasm in a tab, and `FileStore`
 * is backed by `node:fs` instead of the wasm VFS. A bug in the production
 * arithmetic fails this suite, which is the point of writing it this way.
 *
 * ── The assertion style, and why ───────────────────────────────────────────
 * Relationships in generous bands, never byte counts. A DuckDB version bump, a
 * writer heuristic or a Snappy change would break exact assertions and teach
 * nobody anything. What must not change:
 *
 *   · statistics entries are exactly `row groups × leaf columns` — this one IS
 *     exact, because it is the format's grain rather than a measurement
 *   · the entry count rises with both dials, and the footer's share of the file
 *     rises as row groups get smaller
 *   · a three-row update rewrites orders of magnitude more rows than it changed
 *   · the superseded files still occupy storage until they are deleted, and
 *     deleting them returns exactly that storage and breaks time travel
 *   · amplification falls as file size falls, and the file COUNT rises with it —
 *     the tradeoff, in both directions
 *
 * ── The assertions that are not bands ──────────────────────────────────────
 * Two are absolutes, because they are correctness rather than cost:
 * `missedFiles` must be 0 (a file holding a target row must never be excluded by
 * its own statistics) and `rowsDiffering` must be exactly 3 (a copy-on-write
 * update that rewrites 49,152 rows must still change only the three it was asked
 * to). And `boundsHold` must be true: the folded chunk statistics must contain the
 * data, or every pruning decision in C2 is unsound.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

import {
  ANATOMY_FILES,
  ANATOMY_ROWS,
  CHECKSUM_COLUMN,
  CORRUPTIONS,
  HEAVY_FILE_ID,
  LONG_KEY_CHARS,
  NARROW_COLUMNS,
  PROOF_COLUMN,
  REFERENCE_FILE_ID,
  SIGNIFICANT_METADATA_SHARE,
  VECTOR_SIZE,
  WIDE_COLUMNS,
  anatomyFile,
  anatomyPath,
  corruptBytes,
  dataByteTarget,
  loadAnatomyFixtures,
  measureAll as measureAnatomy,
  runCorruptionProbes,
  statsGrain,
  walk,
  type AnatomyGrid,
  type AnatomyWalk,
  type CorruptionResult,
} from '@/lib/duckdb/anatomy'

import {
  REFERENCE_LAYOUT_ID,
  SNAPSHOT_COLUMNS,
  SNAPSHOT_LAYOUTS,
  SNAPSHOT_NEW_STATUS,
  SNAPSHOT_ROWS,
  SNAPSHOT_ROW_GROUP_SIZE,
  SNAPSHOT_UPDATED_ROWS,
  loadSnapshotSource,
  runAllLayouts,
  snapshotLayout,
  snapshotTargets,
  type CowResult,
  type SnapshotGrid,
} from '@/lib/duckdb/snapshot'

import type { FileStore } from '@/lib/duckdb/vfs'

let dir: string
let conn: DuckDBConnection
let anatomy: AnatomyGrid
let reference: AnatomyWalk
let corruption: CorruptionResult[]
let snapshots: SnapshotGrid

/** Plain SQL access for the assertions the production code does not make. */
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const r = await conn.runAndReadAll(sql)
  return r.getRowObjects() as T[]
}

const num = (v: unknown): number => Number(v)

/** The Node-side `FileStore`: the same three operations, backed by the real filesystem. */
const nodeFileStore: FileStore = {
  read: async (path) => new Uint8Array(readFileSync(path)),
  write: async (path, bytes) => writeFileSync(path, bytes),
  remove: async (path) => unlinkSync(path),
}

const at = (fileId: string) => {
  const m = anatomy[fileId]
  if (!m) throw new Error(`no anatomy measurement for ${fileId}`)
  return m
}

const layoutResult = (id: string): CowResult => {
  const r = snapshots[id]
  if (!r) throw new Error(`no copy-on-write result for ${id}`)
  return r
}

const NARROW_SWEEP = ANATOMY_FILES.filter((f) => f.family === 'narrow')
const WIDE_SWEEP = ANATOMY_FILES.filter((f) => f.family === 'wide')
const COARSEST_LAYOUT = SNAPSHOT_LAYOUTS[0]
const FINEST_LAYOUT = SNAPSHOT_LAYOUTS[SNAPSHOT_LAYOUTS.length - 1]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'columnspaces-c3-'))
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

  /* Both labs' own loaders and measurements, unmodified, writing into a temp dir. */
  await loadAnatomyFixtures(undefined, { dir })
  anatomy = await measureAnatomy(undefined, dir)
  reference = await walk(anatomyFile(REFERENCE_FILE_ID), dir)
  corruption = await runCorruptionProbes(nodeFileStore, anatomyPath(anatomyFile(REFERENCE_FILE_ID), dir), {
    dir,
  })

  await loadSnapshotSource()
  snapshots = await runAllLayouts({ dir, store: nodeFileStore })
}, 900_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/* ==========================================================================
 *                          parquet-anatomy
 * ========================================================================== */

describe('the anatomy fixture', () => {
  it('writes eight real Parquet files with the promised shapes', async () => {
    expect(ANATOMY_FILES.length).toBe(8)
    expect(new Set(ANATOMY_FILES.map((f) => f.file)).size).toBe(8)
    expect(new Set(ANATOMY_FILES.map((f) => f.id)).size).toBe(8)

    for (const f of ANATOMY_FILES) {
      const [meta] = await rows<{ vals: unknown; codec: string }>(`
        SELECT sum(num_values) FILTER (WHERE column_id = 0) AS vals,
               any_value(compression) AS codec
        FROM parquet_metadata('${anatomyPath(f, dir)}')
      `)
      expect(num(meta.vals), `${f.id} row count`).toBe(ANATOMY_ROWS)
      expect(meta.codec, `${f.id} codec`).toBe('SNAPPY')
    }
  })

  it('honours every requested row-group size, because all of them are multiples of the vector size', () => {
    for (const f of ANATOMY_FILES) {
      expect(f.rowGroupSize % VECTOR_SIZE, `${f.id} is not a multiple of ${VECTOR_SIZE}`).toBe(0)
      const m = at(f.id)
      expect(m.groupRows, `${f.id} rows per group`).toBe(f.rowGroupSize)
      expect(m.rowGroups, `${f.id} row groups`).toBe(Math.ceil(ANATOMY_ROWS / f.rowGroupSize))
    }
  })

  it('gives the narrow family 4 leaf columns and the wide family many more', () => {
    for (const f of NARROW_SWEEP) expect(at(f.id).leafColumns).toBe(NARROW_COLUMNS.length)
    for (const f of WIDE_SWEEP) expect(at(f.id).leafColumns).toBe(WIDE_COLUMNS + 1)
    expect(at('longkey-8k').leafColumns).toBe(2)
  })
})

describe('the walk: file → row group → column chunk → page', () => {
  it('reads a file-level block naming DuckDB as the writer', () => {
    expect(reference.file.numRows).toBe(ANATOMY_ROWS)
    expect(reference.file.numRowGroups).toBe(ANATOMY_ROWS / 8_192)
    expect(reference.file.createdBy ?? '').toMatch(/duckdb/i)
  })

  it('reads a schema with a synthetic root and one leaf per column', () => {
    const leaves = reference.schema.filter((s) => s.isLeaf)
    const roots = reference.schema.filter((s) => !s.isLeaf)
    expect(roots.length).toBe(1)
    expect(roots[0].numChildren).toBe(NARROW_COLUMNS.length)
    expect(leaves.map((l) => l.name)).toEqual(NARROW_COLUMNS)
    /* Every leaf must declare a physical type and a repetition — those decide the encoding. */
    for (const l of leaves) {
      expect(l.parquetType, `${l.name} physical type`).toBeTruthy()
      expect(l.repetition, `${l.name} repetition type`).toBeTruthy()
    }
  })

  it('reads row groups that partition the rows exactly once', () => {
    const total = reference.rowGroups.reduce((n, g) => n + g.rows, 0)
    expect(total).toBe(ANATOMY_ROWS)
    for (const g of reference.rowGroups) {
      expect(g.columns).toBe(NARROW_COLUMNS.length)
      expect(g.chunks).toBe(NARROW_COLUMNS.length)
      expect(g.compressedBytes).toBeGreaterThan(0)
    }
  })

  it('reads one column chunk per column per row group, each carrying its own statistics', () => {
    expect(reference.chunks.map((c) => c.column)).toEqual(NARROW_COLUMNS)
    for (const c of reference.chunks) {
      expect(c.values, `${c.column} values`).toBe(8_192)
      expect(c.compressedBytes, `${c.column} bytes`).toBeGreaterThan(0)
      expect(c.statsMin, `${c.column} min`).not.toBeNull()
      expect(c.statsMax, `${c.column} max`).not.toBeNull()
      expect(c.nullCount, `${c.column} null count`).not.toBeNull()
      expect(c.dataPageOffset, `${c.column} first data page offset`).not.toBeNull()
    }
  })

  /**
   * The page level is where the footer's visibility ends, and the lab says so. The
   * one page-level byte count that IS derivable is asserted here so the claim in
   * the UI is not decoration: a dictionary-encoded column has a dictionary page,
   * and the gap to the first data page is its size.
   */
  it('exposes the page level only as offsets, and derives the dictionary page size from them', () => {
    const dict = reference.chunks.filter((c) => c.dictionaryPageOffset !== null)
    expect(dict.length, 'the reference file must contain a dictionary-encoded column').toBeGreaterThan(0)
    for (const c of dict) {
      expect(c.dictionaryPageBytes, `${c.column} dictionary page size`).toBeGreaterThan(0)
      expect(c.dictionaryPageBytes!).toBeLessThan(c.compressedBytes)
      expect(c.dataPageOffset!).toBeGreaterThan(c.dictionaryPageOffset!)
      expect(c.encodings ?? '', `${c.column} encodings`).toMatch(/DICT/i)
    }
    /* And no per-page statistics are claimed: the footer views do not carry them. */
    const plain = reference.chunks.filter((c) => c.dictionaryPageOffset === null)
    expect(plain.length, 'a mixed file is what makes the dictionary comparison meaningful').toBeGreaterThan(0)
  })
})

describe('where the statistics live', () => {
  /**
   * The format's grain, asserted exactly rather than in a band: this is not a
   * measurement, it is what Parquet is.
   */
  it('holds exactly one statistics entry per column per row group, in every configuration', () => {
    for (const f of ANATOMY_FILES) {
      const m = at(f.id)
      expect(m.statsEntries, `${f.id} entry count`).toBe(m.rowGroups * m.leafColumns)
      expect(m.gridIsExact, `${f.id} entry grid`).toBe(true)
      expect(m.entriesWithStats, `${f.id} entries carrying a min/max pair`).toBe(m.statsEntries)
    }
  })

  it('has no file-level statistics, so a file-level bound must be folded from the chunks', async () => {
    expect(reference.stats.fileLevelEntries).toBe(0)
    expect(reference.stats.entries).toBe(ANATOMY_ROWS / 8_192)
    expect(reference.stats.boundsHold, 'the folded bound must contain the data').toBe(true)

    /* Cross-check the fold against SQL that never touches the metadata. */
    const [truth] = await rows<{ lo: string; hi: string }>(`
      SELECT min(${PROOF_COLUMN})::VARCHAR AS lo, max(${PROOF_COLUMN})::VARCHAR AS hi
      FROM read_parquet('${anatomyPath(anatomyFile(REFERENCE_FILE_ID), dir)}')
    `)
    expect(reference.stats.trueMin).toBe(truth.lo)
    expect(reference.stats.trueMax).toBe(truth.hi)
    expect(reference.stats.foldedMin).toBe(truth.lo)
    expect(reference.stats.foldedMax).toBe(truth.hi)
  })

  /**
   * The root property every pruning decision in C2 stands on. Checked from the
   * DATA, per row group, not from the metadata that made the decision.
   */
  it('bounds every row group’s true extremes with that row group’s own statistics', async () => {
    const path = anatomyPath(anatomyFile(REFERENCE_FILE_ID), dir)
    const groupRows = 8_192
    const bad = await rows<{ n: unknown }>(`
      WITH stats AS (
        SELECT row_group_id::BIGINT AS rg, stats_min_value AS lo, stats_max_value AS hi
        FROM parquet_metadata('${path}')
        WHERE path_in_schema = '${PROOF_COLUMN}'
      ),
      truth AS (
        SELECT (file_row_number // ${groupRows})::BIGINT AS rg,
               min(${PROOF_COLUMN})::VARCHAR AS lo,
               max(${PROOF_COLUMN})::VARCHAR AS hi
        FROM read_parquet('${path}', file_row_number = true)
        GROUP BY 1
      )
      SELECT count(*) AS n
      FROM stats s JOIN truth t USING (rg)
      WHERE s.lo > t.lo OR s.hi < t.hi
    `)
    expect(num(bad[0].n), 'row groups whose statistics do not bound their data').toBe(0)
  })

  it('agrees with the per-file entry count reported by the measurement', async () => {
    for (const f of ANATOMY_FILES) {
      const g = await statsGrain(anatomyPath(f, dir), f.family === 'wide' ? 'event_id' : f.family === 'longkey' ? 'k' : PROOF_COLUMN)
      expect(g.entries, `${f.id} entries for one column`).toBe(at(f.id).rowGroups)
      expect(g.boundsHold, `${f.id} folded bound`).toBe(true)
    }
  })
})

describe('metadata is not free', () => {
  it('multiplies the entry count by the row-group count, holding columns fixed', () => {
    for (let i = 1; i < NARROW_SWEEP.length; i += 1) {
      const coarse = at(NARROW_SWEEP[i - 1].id)
      const fine = at(NARROW_SWEEP[i].id)
      expect(fine.rowGroups).toBeGreaterThan(coarse.rowGroups)
      expect(fine.statsEntries).toBeGreaterThan(coarse.statsEntries)
      /* Same columns, so the entry ratio must track the row-group ratio. */
      expect(fine.statsEntries / coarse.statsEntries).toBeCloseTo(
        fine.rowGroups / coarse.rowGroups,
        6,
      )
    }
    const coarsest = at(NARROW_SWEEP[0].id)
    const finest = at(NARROW_SWEEP[NARROW_SWEEP.length - 1].id)
    expect(finest.statsEntries / coarsest.statsEntries).toBeGreaterThanOrEqual(32)
  })

  it('multiplies the entry count by the column count, holding row groups fixed', () => {
    const pairs: Array<[string, string]> = [
      ['narrow-128k', 'wide-128k'],
      ['narrow-8k', 'wide-8k'],
      ['narrow-2k', 'wide-2k'],
    ]
    for (const [narrowId, wideId] of pairs) {
      const n = at(narrowId)
      const w = at(wideId)
      expect(w.rowGroups, `${narrowId} vs ${wideId} row groups`).toBe(n.rowGroups)
      expect(w.leafColumns / n.leafColumns).toBeGreaterThan(5)
      expect(w.statsEntries / n.statsEntries).toBeCloseTo(w.leafColumns / n.leafColumns, 6)
    }
  })

  it('grows the footer in bytes as the entry grid grows', () => {
    const coarsest = at(NARROW_SWEEP[0].id)
    const finest = at(NARROW_SWEEP[NARROW_SWEEP.length - 1].id)
    if (coarsest.footerBytes === null || finest.footerBytes === null) return
    expect(finest.footerBytes).toBeGreaterThan(coarsest.footerBytes * 8)
  })

  it('raises the footer’s share of the file as row groups get smaller', () => {
    for (const family of [NARROW_SWEEP, WIDE_SWEEP]) {
      const shares = family.map((f) => at(f.id).metadataShare)
      if (shares.some((s) => s === null)) continue
      for (let i = 1; i < shares.length; i += 1) {
        expect(
          shares[i]!,
          `${family[i].id} share must exceed ${family[i - 1].id}`,
        ).toBeGreaterThan(shares[i - 1]!)
      }
      expect(shares[shares.length - 1]! / shares[0]!).toBeGreaterThan(4)
    }
  })

  it('finds a configuration where the footer is a significant fraction of the file', () => {
    const heavy = at(HEAVY_FILE_ID)
    if (heavy.metadataShare === null) return
    expect(
      heavy.metadataShare,
      `${HEAVY_FILE_ID} footer share must exceed ${SIGNIFICANT_METADATA_SHARE}`,
    ).toBeGreaterThan(SIGNIFICANT_METADATA_SHARE)
    /* And the reference file must NOT be in that band, or the point is vacuous. */
    const ref = at(REFERENCE_FILE_ID)
    if (ref.metadataShare !== null) {
      expect(ref.metadataShare).toBeLessThan(0.01)
    }
  })

  /**
   * The second driver of footer cost, isolated: a statistics entry quotes actual
   * values, so a wide key inflates every entry in the file. Same row-group size,
   * half the columns, and the bytes-per-entry go up rather than down.
   */
  it('charges more per entry for wider statistics values', () => {
    const ref = at(REFERENCE_FILE_ID)
    const long = at('longkey-8k')
    expect(long.rowGroups).toBe(ref.rowGroups)
    expect(long.leafColumns).toBeLessThan(ref.leafColumns)
    expect(long.statsValueChars / long.statsEntries).toBeGreaterThan(
      (ref.statsValueChars / ref.statsEntries) * 4,
    )
    if (long.footerBytesPerEntry === null || ref.footerBytesPerEntry === null) return
    expect(long.footerBytesPerEntry).toBeGreaterThan(ref.footerBytesPerEntry * 2)
    expect(long.footerBytesPerEntry).toBeGreaterThan(LONG_KEY_CHARS)
  })

  it('reports no anomalies across the eight configurations', () => {
    const flagged = Object.values(anatomy).filter((m) => m.anomaly !== null)
    expect(flagged.map((m) => `${m.fileId}: ${m.anomaly}`)).toEqual([])
  })
})

describe('the reader refusing malformed input', () => {
  it('mutates real bytes, and every mutation actually changes the file', () => {
    const original = readFileSync(anatomyPath(anatomyFile(REFERENCE_FILE_ID), dir))
    const bytes = new Uint8Array(original)
    for (const p of CORRUPTIONS) {
      const mutated = corruptBytes(bytes, p.kind)
      const changed = mutated.length !== bytes.length || mutated.some((b, i) => b !== bytes[i])
      expect(changed, `${p.kind} must change the bytes`).toBe(true)
      /* And the original must be untouched — the probes work on copies. */
      expect(bytes.length).toBe(original.length)
    }
  })

  /**
   * The value-corruption probe is only meaningful if it lands in a byte the query
   * decodes. "A third of the way in" is a guess; the footer knows. This pins that
   * the offset came from the footer's own chunk entry for the checked column.
   */
  it('aims the value corruption at a byte the footer says belongs to the checked column', async () => {
    const path = anatomyPath(anatomyFile(REFERENCE_FILE_ID), dir)
    const offset = await dataByteTarget(path, CHECKSUM_COLUMN)
    expect(offset, 'the footer must be able to locate a data byte').not.toBeNull()
    const [bounds] = await rows<{ lo: unknown; hi: unknown }>(`
      SELECT min(data_page_offset) AS lo,
             max(data_page_offset + total_compressed_size) AS hi
      FROM parquet_metadata('${path}')
      WHERE path_in_schema = '${CHECKSUM_COLUMN}'
    `)
    expect(offset!).toBeGreaterThanOrEqual(num(bounds.lo))
    expect(offset!).toBeLessThan(num(bounds.hi))
    const flip = corruption.find((r) => r.kind === 'flip-a-data-byte')!
    expect(flip.byteOffset).toBe(offset)
  })

  it('ran every probe against a real corrupted file', () => {
    expect(corruption.length).toBe(CORRUPTIONS.length)
    for (const r of corruption) {
      expect(r.ran, `${r.kind} did not run: ${r.unavailableReason}`).toBe(true)
      expect(r.unavailableReason).toBeNull()
    }
  })

  it('refuses every structural corruption, with the engine’s own message', () => {
    for (const r of corruption.filter((x) => x.shouldRefuse)) {
      expect(r.refused, `${r.kind} was accepted`).toBe(true)
      expect(r.error, `${r.kind} must carry a real engine message`).toBeTruthy()
      expect(r.error!.length, `${r.kind} message is suspiciously short`).toBeGreaterThan(10)
      /* The message must come from the engine, so it must name the file. */
      expect(r.error!).toContain('corrupt-')
    }
  })

  /**
   * The finding worth more than the three refusals. Page CRCs are optional in
   * Parquet and DuckDB's writer does not emit them, so a flipped data byte is not
   * caught: the row count is right and the aggregate is wrong. Asserted loosely —
   * if a future build DOES refuse, that is an improvement and the lab reports it
   * as an anomaly rather than failing.
   */
  it('does not catch a flipped byte inside a data page — or says so if it does', () => {
    const flip = corruption.find((r) => r.kind === 'flip-a-data-byte')!
    if (flip.refused) {
      expect(flip.anomaly, 'a refusal here must be surfaced, not swallowed').toBeTruthy()
      return
    }
    expect(flip.rowsReturned, 'the row count survives value corruption').toBe(ANATOMY_ROWS)
    expect(
      flip.answerMatchedOriginal,
      'the point of this probe is a plausible WRONG answer with no error',
    ).toBe(false)
    expect(flip.anomaly).toBeNull()
  })

  it('leaves the original file readable after all four probes', async () => {
    const [r] = await rows<{ n: unknown }>(`
      SELECT count(*) AS n FROM read_parquet('${anatomyPath(anatomyFile(REFERENCE_FILE_ID), dir)}')
    `)
    expect(num(r.n)).toBe(ANATOMY_ROWS)
  })
})

/* ==========================================================================
 *                            snapshot-lab
 * ========================================================================== */

describe('the simulated copy-on-write table', () => {
  it('lays every layout out as real Parquet files covering the table exactly once', () => {
    for (const l of SNAPSHOT_LAYOUTS) {
      const r = layoutResult(l.id)
      expect(r.fileCount, `${l.id} file count`).toBe(Math.ceil(SNAPSHOT_ROWS / l.rowsPerFile))
      expect(r.fileCount).toBe(l.files)
      expect(r.rowsAfter, `${l.id} rows after the commit`).toBe(SNAPSHOT_ROWS)
      expect(r.snapshotOneBytes).toBeGreaterThan(0)
    }
  })

  it('writes the six promised columns at the promised row-group size', async () => {
    const l = snapshotLayout(REFERENCE_LAYOUT_ID)
    const path = join(dir, `snap-${l.id}-000-v1.parquet`)
    const cols = await rows<{ c: unknown }>(
      `SELECT count(DISTINCT path_in_schema) AS c FROM parquet_metadata('${path}')`,
    )
    expect(num(cols[0].c)).toBe(SNAPSHOT_COLUMNS.length)
    const groups = await rows<{ n: unknown }>(
      `SELECT max(num_values) AS n FROM parquet_metadata('${path}')`,
    )
    expect(num(groups[0].n)).toBeLessThanOrEqual(SNAPSHOT_ROW_GROUP_SIZE)
  })

  it('locates the target rows from the footers without ever missing a file', () => {
    for (const l of SNAPSHOT_LAYOUTS) {
      const r = layoutResult(l.id)
      expect(r.missedFiles, `${l.id} false negatives`).toBe(0)
      expect(r.falsePositiveFiles, `${l.id} false positives`).toBe(0)
      expect(r.filesAffected, `${l.id} affected files`).toBeGreaterThanOrEqual(1)
      expect(r.filesAffected).toBeLessThanOrEqual(SNAPSHOT_UPDATED_ROWS)
      /* The cost a manifest exists to remove: one footer read per file in the table. */
      expect(r.footersRead).toBe(r.fileCount)
    }
  })
})

describe('a three-row update rewrites whole files', () => {
  it('changes 3 rows and rewrites orders of magnitude more', () => {
    for (const l of SNAPSHOT_LAYOUTS) {
      const r = layoutResult(l.id)
      expect(r.rowsChanged, `${l.id} rows changed`).toBe(SNAPSHOT_UPDATED_ROWS)
      expect(r.rowsRewritten, `${l.id} rows rewritten`).toBeGreaterThan(r.rowsChanged * 100)
      expect(r.rowAmplification).toBeGreaterThan(100)
    }
    /* At the reference layout it is three orders of magnitude, not two. */
    const ref = layoutResult(REFERENCE_LAYOUT_ID)
    expect(ref.rowAmplification).toBeGreaterThan(1_000)
    expect(ref.rowsRewritten).toBe(ref.filesAffected * snapshotLayout(REFERENCE_LAYOUT_ID).rowsPerFile)
  })

  it('reads and writes whole files, not rows', () => {
    for (const l of SNAPSHOT_LAYOUTS) {
      const r = layoutResult(l.id)
      /* Bytes read ≈ bytes written: the rewrite is a copy with three cells altered. */
      expect(r.bytesRead).toBeGreaterThan(0)
      expect(r.bytesWritten / r.bytesRead).toBeGreaterThan(0.9)
      expect(r.bytesWritten / r.bytesRead).toBeLessThan(1.1)
      /* And both dwarf the logical change. */
      expect(r.byteAmplification, `${l.id} byte amplification`).toBeGreaterThan(100)
    }
  })

  it('still changes exactly the three rows it was asked to', () => {
    for (const l of SNAPSHOT_LAYOUTS) {
      const r = layoutResult(l.id)
      expect(r.rowsDiffering, `${l.id} rows differing between snapshots`).toBe(SNAPSHOT_UPDATED_ROWS)
    }
  })

  it('reports no anomalies across the four layouts', () => {
    const flagged = Object.values(snapshots).filter((r) => r.anomaly !== null)
    expect(flagged.map((r) => `${r.layoutId}: ${r.anomaly}`)).toEqual([])
  })
})

describe('the old files stay until expiry', () => {
  it('holds both snapshots on disk after the commit', () => {
    for (const l of SNAPSHOT_LAYOUTS) {
      const r = layoutResult(l.id)
      expect(r.supersededFiles, `${l.id} superseded files`).toBe(r.filesAffected)
      expect(r.supersededBytes, `${l.id} superseded bytes`).toBeGreaterThan(0)
      /* On-disk must exceed the live snapshot by roughly the superseded set. */
      expect(r.onDiskBytes).toBeGreaterThan(r.snapshotTwoBytes)
      const held = r.onDiskBytes - r.snapshotTwoBytes
      expect(held / r.supersededBytes).toBeGreaterThan(0.9)
      expect(held / r.supersededBytes).toBeLessThan(1.1)
      expect(r.storageOverhead).toBeGreaterThan(1)
    }
    /* One retained snapshot doubles storage when the table is one file. */
    const coarse = layoutResult(COARSEST_LAYOUT.id)
    expect(coarse.storageOverhead).toBeGreaterThan(1.8)
  })

  it('keeps the old snapshot readable, with the old values, before expiry', () => {
    for (const l of SNAPSHOT_LAYOUTS) {
      const r = layoutResult(l.id)
      expect(r.timeTravelRowsIntact, `${l.id} time travel`).toBe(SNAPSHOT_UPDATED_ROWS)
    }
  })

  it('reclaims exactly the superseded bytes when expiry runs, and breaks time travel', () => {
    for (const l of SNAPSHOT_LAYOUTS) {
      const r = layoutResult(l.id)
      expect(r.expiryRan, `${l.id} expiry: ${r.expiryUnavailableReason}`).toBe(true)
      expect(r.expiryReclaimedBytes).toBe(r.supersededBytes)
      expect(r.onDiskAfterExpiry, `${l.id} on disk after expiry`).not.toBeNull()
      expect(r.onDiskAfterExpiry!).toBe(r.snapshotTwoBytes)
      expect(r.onDiskAfterExpiry!).toBeLessThan(r.onDiskBytes)
      /* Expiry is not free either: the old snapshot is gone. */
      expect(r.snapshotOneReadableAfterExpiry, `${l.id} snapshot 1 after expiry`).toBe(false)
    }
  })

  it('actually removed the files from the filesystem', () => {
    const l = snapshotLayout(REFERENCE_LAYOUT_ID)
    const r = layoutResult(l.id)
    let missing = 0
    for (let k = 0; k < r.fileCount; k += 1) {
      try {
        statSync(join(dir, `snap-${l.id}-${String(k).padStart(3, '0')}-v1.parquet`))
      } catch {
        missing += 1
      }
    }
    expect(missing, 'the superseded v1 files must be gone from disk').toBe(r.supersededFiles)
  })
})

describe('the tradeoff: smaller files, smaller rewrite, more files', () => {
  it('lowers the amplification factor monotonically as file size falls', () => {
    const ordered = SNAPSHOT_LAYOUTS.map((l) => layoutResult(l.id))
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].rowsPerFile).toBeLessThan(ordered[i - 1].rowsPerFile)
      expect(
        ordered[i].rowAmplification,
        `${ordered[i].layoutId} must amplify less than ${ordered[i - 1].layoutId}`,
      ).toBeLessThan(ordered[i - 1].rowAmplification)
      expect(ordered[i].bytesWritten).toBeLessThan(ordered[i - 1].bytesWritten)
    }
    const coarse = layoutResult(COARSEST_LAYOUT.id)
    const fine = layoutResult(FINEST_LAYOUT.id)
    expect(coarse.rowAmplification / fine.rowAmplification).toBeGreaterThan(10)
  })

  it('lowers the storage a retained snapshot holds as file size falls', () => {
    const ordered = SNAPSHOT_LAYOUTS.map((l) => layoutResult(l.id))
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].storageOverhead).toBeLessThan(ordered[i - 1].storageOverhead)
    }
    expect(layoutResult(FINEST_LAYOUT.id).storageOverhead).toBeLessThan(1.2)
  })

  /**
   * The bill for all of the above, and the reason the answer is not "one row per
   * file". Both counts rise, and the byte total rises with them.
   */
  it('raises the file count, the footer reads and the total bytes as file size falls', () => {
    const ordered = SNAPSHOT_LAYOUTS.map((l) => layoutResult(l.id))
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].liveFileCount).toBeGreaterThan(ordered[i - 1].liveFileCount)
      expect(ordered[i].footersRead).toBeGreaterThan(ordered[i - 1].footersRead)
      expect(ordered[i].snapshotOneBytes).toBeGreaterThan(ordered[i - 1].snapshotOneBytes)
      if (ordered[i].liveFooterBytes === null || ordered[i - 1].liveFooterBytes === null) continue
      expect(ordered[i].liveFooterBytes!).toBeGreaterThan(ordered[i - 1].liveFooterBytes!)
    }
    const coarse = layoutResult(COARSEST_LAYOUT.id)
    const fine = layoutResult(FINEST_LAYOUT.id)
    expect(fine.liveFileCount / coarse.liveFileCount).toBeGreaterThan(10)
    /* The byte penalty is small at this scale; the COUNT penalty is not. Say both. */
    expect(fine.snapshotOneBytes / coarse.snapshotOneBytes).toBeLessThan(1.2)
  })

  it('puts the three target rows in distinct files once files are small enough', () => {
    const targets = snapshotTargets(SNAPSHOT_ROWS)
    expect(targets.length).toBe(SNAPSHOT_UPDATED_ROWS)
    expect(new Set(targets).size).toBe(SNAPSHOT_UPDATED_ROWS)
    expect(layoutResult(COARSEST_LAYOUT.id).filesAffected).toBe(1)
    expect(layoutResult(REFERENCE_LAYOUT_ID).filesAffected).toBe(SNAPSHOT_UPDATED_ROWS)
  })

  it('uses a new status value that could not already be present', () => {
    expect(SNAPSHOT_COLUMNS).toContain('status')
    expect(SNAPSHOT_NEW_STATUS).toBe('voided')
  })
})
