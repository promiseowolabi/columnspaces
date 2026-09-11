/**
 * Agent-surface freshness.
 *
 * `public/lessons-md/*.md` and `public/llms.txt` are GENERATED (by
 * scripts/export-lessons-md.ts) and COMMITTED, which is a combination that
 * silently rots: add a lesson, forget the export, and the deploy serves a
 * manifest that omits it while every other gate stays green. That happened
 * exactly once — C1 shipped and its five markdown files 404'd in production —
 * so it is now a test.
 *
 * The check is deliberately structural rather than byte-for-byte. A full
 * regenerate-and-diff would fail on trivial prose edits and train people to
 * ignore it; what matters is that every lesson HAS an export, that the export
 * belongs to that lesson, and that the manifest lists all of them.
 *
 * Fix when this fails:  npx tsx scripts/export-lessons-md.ts
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_LESSONS } from '@/data/lessons'

const ROOT = new URL('..', import.meta.url).pathname
const MD_DIR = join(ROOT, 'public/lessons-md')
const LLMS = join(ROOT, 'public/llms.txt')

describe('agent surface', () => {
  it('every authored lesson has an exported markdown file', () => {
    const missing = ALL_LESSONS.filter((l) => !existsSync(join(MD_DIR, `${l.id}.md`))).map((l) => l.id)
    expect(
      missing,
      `missing exports: ${missing.join(', ')} — run: npx tsx scripts/export-lessons-md.ts`,
    ).toEqual([])
  })

  it('no orphaned exports linger for deleted or renamed lessons', () => {
    const ids = new Set(ALL_LESSONS.map((l) => l.id))
    const orphans = readdirSync(MD_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .filter((id) => !ids.has(id))
    expect(orphans, `stale exports: ${orphans.join(', ')}`).toEqual([])
  })

  it('each export is the lesson it claims to be', () => {
    for (const l of ALL_LESSONS) {
      const md = readFileSync(join(MD_DIR, `${l.id}.md`), 'utf8')
      /* The exporter writes `# <ID> — <Title>` as the first line. */
      expect(md.split('\n')[0], `${l.id} heading`).toContain(l.title)
      expect(md, `${l.id} hook`).toContain(l.hook.slice(0, 40))
    }
  })

  it('llms.txt lists every lesson', () => {
    const llms = readFileSync(LLMS, 'utf8')
    const absent = ALL_LESSONS.filter((l) => !llms.includes(`${l.id}.md`)).map((l) => l.id)
    expect(absent, `absent from llms.txt: ${absent.join(', ')}`).toEqual([])
  })

  it('llms.txt points agents at paths that return 200, not app routes', () => {
    const llms = readFileSync(LLMS, 'utf8')
    /*
     * GitHub Pages has no SPA rewrite, so /lesson/<id> answers 404 (with the
     * right page in the body). Agents using a strict HTTP client must be sent to
     * the markdown instead, and the manifest has to say so.
     */
    expect(llms).toContain('/lessons-md/')
    expect(llms.toLowerCase()).toContain('404')
  })

  it('carries no reference to a domain we do not own', () => {
    expect(readFileSync(LLMS, 'utf8')).not.toContain('naigap')
  })
})
