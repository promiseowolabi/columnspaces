/**
 * Branding gate.
 *
 * `naigap` is not our domain. The fork inherited 59 references to it across 14
 * files, and "we removed them" is only true until someone copies a file forward
 * from tablespace. So it is a test, and it fails the build.
 *
 * The tablespace check is narrower on purpose: cross-links to the sibling
 * course are deliberate and valuable ("tablespace T7.L1 works the NSM/DSM
 * comparison from the row store's side"). What must not survive is tablespace
 * *identity* — the wordmark, the storage namespace, the domain.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('..', import.meta.url).pathname

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', '_solutions'])
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.html',
  '.css',
  '.yml',
  '.yaml',
  '.py',
  '.rs',
  '.txt',
  '.toml',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (TEXT_EXT.has(extname(name))) out.push(full)
  }
  return out
}

const FILES = walk(ROOT)
const rel = (f: string) => f.slice(ROOT.length)

describe('de-branding', () => {
  it('finds files to check (the walker is not silently empty)', () => {
    expect(FILES.length).toBeGreaterThan(50)
  })

  it('no file references naigap', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      /* PLAN.md documents the removal itself, so it is allowed to name it. */
      if (rel(f) === 'PLAN.md') continue
      if (rel(f).startsWith('tests/')) continue
      if (readFileSync(f, 'utf8').includes('naigap')) offenders.push(rel(f))
    }
    expect(offenders, `naigap survives in: ${offenders.join(', ')}`).toEqual([])
  })

  it('no file claims to BE tablespace', () => {
    /* Identity strings, not mentions. A cross-link is fine; a wordmark is not. */
    const identity = [
      'tablespace:v1',
      'tablespace-progress',
      '_tablespace',
      'name": "tablespace',
      "name: 'tablespace'",
      'the tablespace lesson',
    ]
    const offenders: string[] = []
    for (const f of FILES) {
      if (rel(f) === 'PLAN.md' || rel(f).startsWith('tests/')) continue
      const text = readFileSync(f, 'utf8')
      for (const needle of identity) {
        if (text.includes(needle)) offenders.push(`${rel(f)} (${needle})`)
      }
    }
    expect(offenders, `tablespace identity survives in: ${offenders.join(', ')}`).toEqual([])
  })

  it('the progress store uses the columnspaces namespace', () => {
    const progress = readFileSync(join(ROOT, 'src/lib/progress.ts'), 'utf8')
    expect(progress).toContain("name: 'columnspaces:v1'")
  })

  it('package name and html title are columnspaces', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('columnspaces')
    expect(readFileSync(join(ROOT, 'index.html'), 'utf8')).toContain('<title>columnspaces')
  })

  it('no CNAME is shipped (GitHub Pages project site, not a custom domain)', () => {
    const publicFiles = readdirSync(join(ROOT, 'public'))
    expect(publicFiles).not.toContain('CNAME')
  })

  it('exactly one public URL constant exists, and it points at the personal account', () => {
    const exporter = readFileSync(join(ROOT, 'scripts/export-lessons-md.ts'), 'utf8')
    expect(exporter).toContain('https://promiseowolabi.github.io/columnspaces')
    /* One definition only — every other link must derive from it. */
    const defs = exporter.match(/const SITE =/g) ?? []
    expect(defs).toHaveLength(1)
  })
})
