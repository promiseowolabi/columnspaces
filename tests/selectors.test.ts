/**
 * Store-selector hygiene.
 *
 * ── The bug this exists to prevent ─────────────────────────────────────────
 * The capstone page shipped blank. Not wrong — blank, which is why it read as
 * "not built". One line did it:
 *
 *     const recorded = useProgress((s) => s.sims[CAPSTONE_SIM_ID]?.tasksDone ?? [])
 *
 * On a store where that sim has never been touched — every first visit — the
 * selector returns a NEW array each call. zustand compares selector output with
 * `Object.is`, so it looked changed on every render: render → fresh array →
 * render. React bailed out with error #185 and unmounted the tree.
 *
 * Nothing caught it. The unit suite has no DOM, so it cannot observe a render
 * loop. The browser e2e visited the route and passed, because it was measuring
 * the Suspense fallback and navigated away before the loop began. Both holes are
 * now fixed, but neither fix is cheap to rely on: the e2e needs a network, a
 * build and a browser.
 *
 * This test is the cheap one. It reads the source and fails on the SHAPE of the
 * mistake, in milliseconds, with no DOM at all. A selector must return a
 * primitive or a stable reference from the store — never a value the selector
 * itself constructs.
 *
 * ── Why not an eslint rule ─────────────────────────────────────────────────
 * A rule would be better placed and worse understood. The failure message here
 * can explain the whole mechanism, which is what someone hitting it at 2am needs.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (['.ts', '.tsx'].includes(extname(name))) out.push(full)
  }
  return out
}

const FILES = walk(SRC)

/**
 * Strip comments before matching.
 *
 * These tests search source text for a mistake, and this repository documents its
 * mistakes in comments — the fix for the capstone bug quotes the broken line
 * verbatim so the next reader understands why the code looks the way it does.
 * Without this, the explanation of a bug would fail the test guarding against it.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Every `useProgress((s) => …)` call, flattened to one line, with its location. */
interface Selector {
  file: string
  line: number
  body: string
}

function selectors(): Selector[] {
  const found: Selector[] = []
  for (const file of FILES) {
    const text = stripComments(readFileSync(file, 'utf8'))
    const lines = text.split('\n')
    for (const [i, raw] of lines.entries()) {
      /* Selectors in this codebase are single-line by convention; a multi-line one
       * is joined with the following two lines so a wrapped arrow is still seen. */
      const window = [raw, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ')
      const m = /useProgress\(\s*\((?:s|state)\)\s*=>\s*([^)]*)/.exec(window)
      if (!m) continue
      /* Skip the action-getters: `(s) => s.recordSimTask` is a stable reference. */
      found.push({ file: relative(ROOT, file), line: i + 1, body: m[1].trim() })
    }
  }
  return found
}

const ALL = selectors()

describe('zustand selectors', () => {
  it('finds the selectors to check (the scanner is not silently empty)', () => {
    expect(ALL.length, 'no useProgress selectors found — has the store been renamed?').toBeGreaterThan(
      10,
    )
  })

  /**
   * THE test. `?? []` and `?? {}` are the exact shape that blanked the capstone:
   * a fallback the selector allocates, returned on every call.
   */
  it('never fall back to a freshly allocated array or object', () => {
    const offenders = ALL.filter((s) => /\?\?\s*(\[\s*\]|\{\s*\})/.test(s.body)).map(
      (s) => `${s.file}:${s.line} → ${s.body}`,
    )
    expect(
      offenders,
      'A selector returning `?? []` or `?? {}` allocates a new value on every call. ' +
        'zustand compares with Object.is, so the component re-renders forever and React ' +
        'unmounts it (error #185) — the page goes BLANK, not wrong. ' +
        'Select a primitive instead: `?.tasksDone.includes(x) ?? false`, or `?.length ?? 0`. ' +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  /** The same hazard, built rather than defaulted. */
  it('never construct an array or object inline', () => {
    const offenders = ALL.filter((s) =>
      /(=>\s*\[|=>\s*\{\s*\w+\s*:|\.map\(|\.filter\(|\.slice\(|Object\.(keys|values|entries)\()/.test(
        s.body,
      ),
    ).map((s) => `${s.file}:${s.line} → ${s.body}`)
    expect(
      offenders,
      'A selector that maps, filters, slices or builds an object returns a new reference ' +
        'every call, with the same consequence as `?? []`. Do the derivation in a ' +
        'useMemo over a stable slice instead, or add a shallow comparator deliberately. ' +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  /**
   * The positive form: the page that broke must read this state as a boolean, so a
   * future "helpful" refactor back to the array shape fails here rather than in a
   * reader's browser.
   */
  it('the capstone reads its completion flag as a primitive', () => {
    const src = stripComments(readFileSync(join(SRC, 'pages/Capstone.tsx'), 'utf8'))
    /*
     * Assert the PROPERTY, not the layout: the completion flag must be read as a
     * boolean. An earlier version of this test pinned the exact line wrapping and
     * failed on a comment being added above it, which is a test asserting
     * formatting rather than behaviour.
     */
    const collapsed = src.replace(/\s+/g, ' ')
    expect(collapsed, 'Capstone.tsx no longer selects a boolean for completion').toMatch(
      /tasksDone\.includes\([^)]+\) \?\? false/,
    )
    expect(src, 'the array-returning selector is back').not.toMatch(/tasksDone\s*\?\?\s*\[\]/)
  })
})

describe('the route fallback stays detectable', () => {
  /**
   * The browser e2e waits for `[data-route-fallback]` to detach before it judges a
   * route. Remove the attribute and the e2e silently goes back to measuring the
   * loading state, which is how a blank route passed in the first place.
   */
  it('App.tsx marks the Suspense fallback with data-route-fallback', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8') /* the marker is in JSX, not a comment */
    expect(app, 'the e2e waits on this attribute; without it, blank routes pass').toContain(
      'data-route-fallback',
    )
  })

  it('the e2e waits for that marker rather than sniffing text', () => {
    const e2e = stripComments(readFileSync(join(ROOT, 'scripts/e2e.ts'), 'utf8'))
    expect(e2e).toContain('data-route-fallback')
    expect(e2e).toContain("state: 'detached'")
    /* The old, defeated check must not come back. */
    expect(e2e, 'the anchored loading… regex never matched, because the fallback renders beside the nav').not.toMatch(
      /\^\\s\*loading/,
    )
  })
})
