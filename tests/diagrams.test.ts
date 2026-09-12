/**
 * Diagram legibility.
 *
 * ── What was wrong, and why nothing caught it ──────────────────────────────
 * `tests/registry.test.ts` has always asserted that diagram BOXES do not
 * overlap and stay on the canvas. They never did. What overlapped was the TEXT:
 * the renderer drew each label as one centred line at a fixed size with no
 * measurement, so 260 of 541 node labels (48%) were wider than the box that
 * contained them, 417 subtitles overflowed, and long labels ran clean across
 * their neighbours. Every geometry assertion passed the whole time, because
 * geometry was not the problem.
 *
 * A reader had to send a screenshot. So the fitting is now a pure function —
 * `src/pages/lesson/diagram-text.ts` — and this file checks its output against
 * every node in the course.
 *
 * ── Why this can be a unit test at all ─────────────────────────────────────
 * The diagrams are rendered in a monospace face, so text width is
 * `chars × size × ADVANCE` rather than something only a browser knows. No DOM,
 * no canvas, no snapshot: just arithmetic against the same constants the
 * renderer uses.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALL_LESSONS } from '@/data/lessons'
import type { DiagramBlock } from '@/data/lessons/types'
import {
  ADVANCE,
  LINE_HEIGHT,
  PAD_X,
  charsPerLine,
  fitText,
  layoutNodeText,
  trimEdge,
  wrap,
} from '@/pages/lesson/diagram-text'

const ROOT = new URL('..', import.meta.url).pathname

interface NodeCase {
  lesson: string
  caption: string
  id: string
  label: string
  sub?: string
  box: { x: number; y: number; w: number; h: number }
}

const NODES: NodeCase[] = ALL_LESSONS.flatMap((l) =>
  l.blocks
    .filter((b): b is DiagramBlock => b.type === 'diagram')
    .flatMap((d) =>
      d.nodes.map((n) => ({
        lesson: l.id,
        caption: d.caption,
        id: n.id,
        label: n.label,
        sub: n.sub,
        box: { x: n.x, y: n.y, w: n.w ?? 18, h: n.h ?? 9 },
      })),
    ),
)

describe('the wrapper', () => {
  it('never emits a line longer than the limit', () => {
    for (const text of ['a b c', 'one twoooo three', 'x'.repeat(50), '', 'single']) {
      for (const limit of [4, 9, 17, 40]) {
        for (const line of wrap(text, limit)) {
          expect(line.length, `"${line}" exceeds ${limit}`).toBeLessThanOrEqual(limit)
        }
      }
    }
  })

  it('hard-splits a word too long for the line rather than overflowing', () => {
    const lines = wrap('no_false_negatives_is_an_absolute', 10)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(10)
    expect(lines.join('')).toContain('no_false_n')
  })

  it('loses no words', () => {
    const text = 'blocks are the unit of skipping and blocks are not all the same size'
    expect(wrap(text, 13).join(' ').split(/\s+/)).toEqual(text.split(' '))
  })

  it('charsPerLine accounts for padding and never returns zero', () => {
    expect(charsPerLine(46, 2.9)).toBe(Math.floor((46 - PAD_X * 2) / (2.9 * ADVANCE)))
    expect(charsPerLine(2, 2.9)).toBeGreaterThanOrEqual(1)
  })
})

describe('every node label in the course fits its box', () => {
  it('there are nodes to check', () => {
    expect(NODES.length).toBeGreaterThan(400)
  })

  /**
   * THE test. A truncated label is a label the reader cannot read, and it is what
   * the screenshot showed. Zero tolerance: shorten the label or widen the box.
   */
  it('no label is truncated', () => {
    const bad = NODES.filter((n) => layoutNodeText(n.label, n.sub, n.box).label.truncated).map(
      (n) => `${n.lesson} "${n.caption}" node ${n.id}: ${n.label.length} chars in w=${n.box.w} h=${n.box.h}`,
    )
    expect(
      bad,
      `These labels cannot be wrapped into their boxes at the smallest legible size. ` +
        `Shorten the label or widen the box.\n  ${bad.join('\n  ')}`,
    ).toEqual([])
  })

  /** Independently recomputed: every rendered line must fit the usable width. */
  it('no rendered line is wider than its box', () => {
    const bad: string[] = []
    for (const n of NODES) {
      const tl = layoutNodeText(n.label, n.sub, n.box)
      const usable = n.box.w - PAD_X * 2
      for (const line of tl.label.lines) {
        const width = line.length * tl.label.fontSize * ADVANCE
        if (width > usable + 1e-9) {
          bad.push(`${n.lesson}/${n.id} label line "${line}" is ${width.toFixed(1)} > ${usable.toFixed(1)}`)
        }
      }
      for (const line of tl.sub?.lines ?? []) {
        const width = line.length * tl.sub!.fontSize * ADVANCE
        if (width > usable + 1e-9) {
          bad.push(`${n.lesson}/${n.id} sub line "${line}" is ${width.toFixed(1)} > ${usable.toFixed(1)}`)
        }
      }
    }
    expect(bad, bad.join('\n  ')).toEqual([])
  })

  it('the text block fits the box height', () => {
    const bad: string[] = []
    for (const n of NODES) {
      const tl = layoutNodeText(n.label, n.sub, n.box)
      const total = tl.label.height + (tl.sub?.height ?? 0)
      if (total > n.box.h - 1.2 + 1e-9) {
        bad.push(`${n.lesson}/${n.id}: text ${total.toFixed(1)} > inner ${(n.box.h - 1.2).toFixed(1)}`)
      }
    }
    expect(bad, bad.join('\n  ')).toEqual([])
  })

  it('every baseline sits inside the box', () => {
    const bad: string[] = []
    for (const n of NODES) {
      const tl = layoutNodeText(n.label, n.sub, n.box)
      for (const y of [...tl.labelY, ...tl.subY]) {
        if (y < n.box.y || y > n.box.y + n.box.h) {
          bad.push(`${n.lesson}/${n.id}: baseline ${y.toFixed(1)} outside [${n.box.y}, ${n.box.y + n.box.h}]`)
        }
      }
    }
    expect(bad, bad.join('\n  ')).toEqual([])
  })

  it('font sizes stay legible', () => {
    for (const n of NODES) {
      const tl = layoutNodeText(n.label, n.sub, n.box)
      expect(tl.label.fontSize, `${n.lesson}/${n.id} label`).toBeGreaterThanOrEqual(1.8)
      if (tl.sub) expect(tl.sub.fontSize, `${n.lesson}/${n.id} sub`).toBeGreaterThanOrEqual(1.55)
    }
  })

  it('a label always wins the box over its subtitle', () => {
    /* When both cannot fit, the subtitle is dropped rather than clipped — and the
     * renderer keeps it in a <title>, so the information survives. */
    const dropped = NODES.filter((n) => n.sub && !layoutNodeText(n.label, n.sub, n.box).sub)
    for (const n of dropped) {
      expect(layoutNodeText(n.label, n.sub, n.box).label.truncated).toBe(false)
    }
    /* Recorded rather than asserted at zero: these are tall-text-in-short-box
     * cases, and the count is here so a regression that drops many more is
     * visible in the diff. */
    expect(dropped.length).toBeLessThan(60)
  })
})

describe('fitText', () => {
  it('prefers the largest size that fits', () => {
    const wide = fitText('short', 60, { sizes: [3, 2, 1], maxLines: 1 })
    expect(wide.fontSize).toBe(3)
    expect(wide.lines).toEqual(['short'])
  })

  it('steps down rather than overflowing', () => {
    const tight = fitText('a fairly long label indeed', 20, { sizes: [2.9, 1.85], maxLines: 2 })
    expect(tight.fontSize).toBe(1.85)
    expect(tight.lines.length).toBeLessThanOrEqual(2)
  })

  it('marks truncation instead of silently clipping', () => {
    const t = fitText('x '.repeat(200), 12, { sizes: [1.85], maxLines: 1 })
    expect(t.truncated).toBe(true)
    expect(t.lines[0].endsWith('…')).toBe(true)
  })

  it('respects maxHeight whenever it succeeds', () => {
    /* Two branches, and the contract differs between them. If a size fits, the
     * block must be inside maxHeight. If none does, the fallback keeps up to
     * maxLines at the smallest size and MARKS ITSELF TRUNCATED — it may then
     * exceed maxHeight, because showing text and flagging it beats returning
     * nothing. The caller (layoutNodeText) is what decides to drop a subtitle. */
    const fits = fitText('one two', 40, { sizes: [2.9, 1.85], maxLines: 2, maxHeight: 10 })
    expect(fits.truncated).toBe(false)
    expect(fits.height).toBeLessThanOrEqual(10 + 1e-9)

    const cannot = fitText('one two three four five six', 20, {
      sizes: [2.9, 1.85],
      maxLines: 4,
      maxHeight: 2.9 * LINE_HEIGHT,
    })
    expect(cannot.truncated).toBe(true)
  })
})

describe('edges', () => {
  it('are trimmed to the box borders, not drawn centre to centre', () => {
    const from = { x: 0, y: 0, w: 20, h: 10 }
    const to = { x: 60, y: 0, w: 20, h: 10 }
    const seg = trimEdge(from, to)
    /* Starts at the right border of `from`, ends at the left border of `to`. */
    expect(seg.x1).toBeGreaterThanOrEqual(from.x + from.w - 1)
    expect(seg.x2).toBeLessThanOrEqual(to.x + 1)
    /* And never inside either box. */
    expect(seg.x1).toBeLessThan(seg.x2)
  })

  it('handle vertically stacked boxes', () => {
    const seg = trimEdge({ x: 0, y: 0, w: 20, h: 10 }, { x: 0, y: 40, w: 20, h: 10 })
    expect(seg.y1).toBeGreaterThanOrEqual(9)
    expect(seg.y2).toBeLessThanOrEqual(41)
  })

  it('do not blow up on coincident boxes', () => {
    const b = { x: 10, y: 10, w: 10, h: 10 }
    const seg = trimEdge(b, b)
    for (const v of [seg.x1, seg.y1, seg.x2, seg.y2]) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('the renderer keeps the fixes', () => {
  const blocks = readFileSync(`${ROOT}src/pages/lesson/blocks.tsx`, 'utf8')

  it('uses the fitting helpers rather than raw centred text', () => {
    expect(blocks).toContain('layoutNodeText')
    expect(blocks).toContain('trimEdge')
  })

  it('does not draw edge labels on the canvas', () => {
    /* They collided with the boxes they ran between; they are listed under the
     * figure instead. A <text> for e.label inside the SVG means the regression is
     * back. */
    expect(blocks).not.toMatch(/<text[\s\S]{0,200}\{e\.label\}/)
  })

  it('gives every node a full-text title', () => {
    expect(blocks).toMatch(/<title>\{n\.sub \?/)
  })
})
