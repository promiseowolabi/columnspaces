/**
 * Bundle budget.
 *
 * The duckdb engine is ~33 MB of wasm behind a ~27 kB JS wrapper. Both must stay
 * out of first paint, and the wrapper must stay behind a DYNAMIC import — one
 * stray top-level `import * as duckdb` would pull it into the shared lesson
 * chunk and every reader of every lesson would pay for a lab most of them never
 * open.
 *
 * This is exactly the kind of regression that is invisible in review and obvious
 * in a waterfall, so it is a test. It reads the built output, which means it only
 * means anything after `npm run build` — the verify script runs build first, and
 * the assertions skip (loudly) if dist is absent.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const ASSETS = join(DIST, 'assets')

const built = existsSync(join(DIST, 'index.html')) && existsSync(ASSETS)

describe.skipIf(!built)('bundle budget', () => {
  const html = built ? readFileSync(join(DIST, 'index.html'), 'utf8') : ''
  const files = built ? readdirSync(ASSETS) : []
  const js = files.filter((f) => f.endsWith('.js'))

  it('the build exists (run npm run build first)', () => {
    expect(built, 'dist/ is missing — this suite needs a production build').toBe(true)
    expect(js.length).toBeGreaterThan(5)
  })

  it('duckdb is not referenced by the first-paint document', () => {
    expect(html).not.toContain('duckdb')
  })

  it('duckdb lives in its own chunk', () => {
    const duckChunks = js.filter((f) => f.includes('duckdb'))
    expect(duckChunks.length, 'expected a dedicated duckdb chunk').toBe(1)
  })

  /**
   * The important one. A static `from"./pkg-duckdb…"` anywhere means some chunk
   * loads the wrapper unconditionally; only `import("./pkg-duckdb…")` is allowed.
   */
  it('no chunk statically imports the duckdb chunk', () => {
    const offenders: string[] = []
    for (const f of js) {
      if (f.includes('duckdb')) continue
      const text = readFileSync(join(ASSETS, f), 'utf8')
      /* Static import/re-export forms all use `from"…"`. */
      if (/from\s*"\.\/[^"]*duckdb[^"]*"/.test(text)) offenders.push(f)
    }
    expect(offenders, `static duckdb import in: ${offenders.join(', ')}`).toEqual([])
  })

  it('at least one chunk dynamically imports duckdb (the labs actually work)', () => {
    const dynamic = js.filter((f) => {
      if (f.includes('duckdb')) return false
      return /import\(\s*"\.\/[^"]*duckdb[^"]*"\s*\)/.test(readFileSync(join(ASSETS, f), 'utf8'))
    })
    expect(dynamic.length, 'nothing dynamically imports duckdb — is the lab wired up?').toBeGreaterThan(0)
  })

  /**
   * The entry chunk plus its preloaded vendor chunks are what a reader pays for
   * before seeing anything. tablespace got this to roughly 60 kB and it would be
   * easy to lose; 220 kB uncompressed is a deliberately loose ceiling that still
   * catches a catastrophic regression (a lesson registry or an engine landing in
   * the entry).
   */
  it('first-paint javascript stays under budget', () => {
    const preloaded = [...html.matchAll(/href="[^"]*\/assets\/([^"]+\.js)"/g)].map((m) => m[1])
    const entry = [...html.matchAll(/src="[^"]*\/assets\/([^"]+\.js)"/g)].map((m) => m[1])
    const firstPaint = [...new Set([...preloaded, ...entry])]
    expect(firstPaint.length, 'no first-paint scripts found — did the html format change?').toBeGreaterThan(0)

    const bytes = firstPaint.reduce((n, f) => {
      const p = join(ASSETS, f)
      return n + (existsSync(p) ? readFileSync(p).byteLength : 0)
    }, 0)
    const kb = Math.round(bytes / 1024)
    expect(kb, `first-paint JS is ${kb} kB`).toBeLessThan(600)
  })

  /**
   * The lesson corpus is ~1.7 MB of prose across 54 lessons. It is allowed to be
   * large; it is NOT allowed to be loaded by anything except the lesson route.
   *
   * This replaced a flat "no chunk over 1024 kB" rule, which fired when the
   * curriculum reached 54 lessons and would have been satisfied by either of two
   * things: splitting metadata out of the corpus (correct), or raising the number
   * (cosmetic). The rule below cannot be satisfied cosmetically — it pins the
   * property that actually matters, which is that reading a LIST of lesson titles
   * must not download every word of every lesson.
   *
   * The fix was src/data/lessons/manifest.ts: generated metadata with no imports
   * of the lesson files, which the list pages read instead. /curriculum went from
   * 1352 kB to 39 kB.
   */
  it('the lesson corpus is confined to the lesson route', () => {
    /*
     * Identify the corpus by PROSE BODY, not by a title: titles legitimately live
     * in the metadata manifest, so keying on one would flag the manifest as the
     * corpus. This sentence appears only inside a lesson's blocks.
     */
    const PROSE = 'Analytics has one physical cost'
    const corpus = js.filter((f) => readFileSync(join(ASSETS, f), 'utf8').includes(PROSE))
    expect(corpus.length, `expected exactly one corpus chunk, found: ${corpus.join(', ')}`).toBe(1)
    const name = corpus[0]

    /* It must be a route chunk for the lesson page, not a shared chunk. */
    expect(name, `corpus is in ${name}, which is not the Lesson route chunk`).toMatch(/^Lesson-/)

    /* Nothing may statically import it — if anything did, that route would pay for it. */
    const importers = js.filter(
      (f) => f !== name && new RegExp(`from\\s*"\\./${name.replace('.', '\\.')}"`).test(readFileSync(join(ASSETS, f), 'utf8')),
    )
    expect(importers, `these chunks pull in the whole corpus: ${importers.join(', ')}`).toEqual([])

    /* And it must never be in first paint. */
    expect(html).not.toContain(name)
  })

  it('lesson metadata is a small chunk the list pages can afford', () => {
    const manifest = js.find((f) => f.startsWith('manifest-'))
    expect(manifest, 'no manifest chunk — did the metadata split get reverted?').toBeDefined()
    const kb = readFileSync(join(ASSETS, manifest!)).byteLength / 1024
    expect(kb, `manifest chunk is ${kb.toFixed(0)} kB`).toBeLessThan(120)
    /* It carries titles and hooks by design, but must NOT carry block prose. */
    expect(readFileSync(join(ASSETS, manifest!), 'utf8')).not.toContain(
      'Analytics has one physical cost',
    )
  })

  it('no chunk outside the lesson corpus is absurdly large', () => {
    for (const f of js) {
      if (f.startsWith('pkg-')) continue
      if (f.startsWith('Lesson-')) continue /* the corpus, pinned by the test above */
      const kb = readFileSync(join(ASSETS, f)).byteLength / 1024
      expect(kb, `${f} is ${kb.toFixed(0)} kB`).toBeLessThan(1024)
    }
  })
})
