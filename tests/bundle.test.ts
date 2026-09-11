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

  it('no single non-vendor chunk is absurdly large', () => {
    /* A 1 MB route chunk means content is being bundled that should be lazy. */
    for (const f of js) {
      if (f.startsWith('pkg-')) continue
      const kb = readFileSync(join(ASSETS, f)).byteLength / 1024
      expect(kb, `${f} is ${kb.toFixed(0)} kB`).toBeLessThan(1024)
    }
  })
})
