/**
 * diagram-text — fit a label inside a diagram box.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Diagram nodes live on a 100-unit-wide viewBox and the renderer used to draw
 * each label as a single centred `<text>` at a fixed size. Nothing measured the
 * label against the box, so 48% of the 541 node labels in this course overflowed
 * their own box, 417 subtitles overflowed, and long labels ran clean across their
 * neighbours. The geometry test passed throughout, because the BOXES never
 * overlapped — only the text did.
 *
 * So the fix belongs here rather than in 54 lesson files: wrap the text, and if
 * wrapping is not enough, step the font size down until it fits.
 *
 * ── The measurement ────────────────────────────────────────────────────────
 * Every diagram label is rendered in JetBrains Mono, and in a monospace face
 * every glyph advances the same width: almost exactly 0.6 × the font size for
 * this family. That makes width a multiplication rather than a DOM measurement,
 * which is what lets this be a pure function — testable in the unit suite, with
 * no browser and no canvas.
 *
 * `ADVANCE` is deliberately a touch generous (0.62). Underestimating advance is
 * how you get text that "fits" in the model and clips on screen.
 */

/** Width of one character as a fraction of font size, in JetBrains Mono. */
export const ADVANCE = 0.62

/** Padding inside a box, in viewBox units, so text never touches the border. */
export const PAD_X = 1.4

/** Line height as a multiple of font size. */
export const LINE_HEIGHT = 1.25

export interface FittedText {
  lines: string[]
  fontSize: number
  /** Total height of the wrapped block, in viewBox units. */
  height: number
  /** True when the text had to be cut — the renderer shows an ellipsis. */
  truncated: boolean
}

/** How many characters fit on one line of `width` at `size`. */
export const charsPerLine = (width: number, size: number): number =>
  Math.max(1, Math.floor((width - PAD_X * 2) / (size * ADVANCE)))

/**
 * Greedy word wrap. Words longer than a line are hard-split rather than allowed
 * to overflow — a 30-character identifier in a narrow box is a real case, and
 * breaking it is less bad than drawing over the neighbouring node.
 */
export function wrap(text: string, limit: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > limit) {
      if (line) {
        out.push(line)
        line = ''
      }
      for (let i = 0; i < word.length; i += limit) out.push(word.slice(i, i + limit))
      line = out.pop() ?? ''
      continue
    }
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length <= limit) line = candidate
    else {
      if (line) out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  return out.length > 0 ? out : ['']
}

/**
 * Fit `text` into `width` × `maxHeight`, trying each size in `sizes` from
 * largest to smallest and returning the first that fits within `maxLines`.
 *
 * If nothing fits, the smallest size is used and the last line is ellipsised.
 * That case is a content problem rather than a rendering one, so
 * `tests/diagrams.test.ts` fails on it instead of letting it ship quietly.
 */
export function fitText(
  text: string,
  width: number,
  opts: { sizes: number[]; maxLines: number; maxHeight?: number } = {
    sizes: [2.9, 2.6, 2.3, 2.05, 1.85],
    maxLines: 3,
  },
): FittedText {
  const { sizes, maxLines, maxHeight } = opts
  const clean = text.trim()

  for (const size of sizes) {
    const lines = wrap(clean, charsPerLine(width, size))
    const height = lines.length * size * LINE_HEIGHT
    if (lines.length <= maxLines && (maxHeight === undefined || height <= maxHeight)) {
      return { lines, fontSize: size, height, truncated: false }
    }
  }

  /* Nothing fitted. Use the smallest size, keep as many lines as allowed, and
   * mark the cut so the renderer can show it and the test can fail on it. */
  const size = sizes[sizes.length - 1]
  const all = wrap(clean, charsPerLine(width, size))
  const kept = all.slice(0, maxLines)
  const last = kept.length - 1
  if (all.length > kept.length && last >= 0) {
    kept[last] = `${kept[last].replace(/\s+\S*$/, '')}…`
  }
  const height = kept.length * size * LINE_HEIGHT

  /*
   * `truncated` means "I could not honour the constraints I was given", not
   * merely "I dropped a line". Height counts.
   *
   * This was a real hole rather than a wording nicety: the fallback could return
   * text that fitted within maxLines but was TALLER than maxHeight, with
   * truncated = false — and layoutNodeText trusts that flag to decide whether a
   * label fits its box. No node in the course hit it, and it would have overflowed
   * vertically the moment one did, which is exactly the class of bug this whole
   * module exists to end.
   */
  return {
    lines: kept,
    fontSize: size,
    height,
    truncated: all.length > kept.length || (maxHeight !== undefined && height > maxHeight + 1e-9),
  }
}

/** Font-size ladders. Separate constants so the test and the renderer agree. */
export const LABEL_SIZES = [2.9, 2.6, 2.3, 2.05, 1.85]
export const SUB_SIZES = [2.4, 2.15, 1.95, 1.75, 1.6]
export const EDGE_SIZES = [2.4, 2.15, 1.95]

/**
 * Lay out a node's label and optional subtitle inside its box, vertically
 * centred as one block.
 *
 * The label gets first call on the available height; the subtitle is dropped
 * entirely if there is no room left for it, because a clipped subtitle is worse
 * than no subtitle.
 */
export interface NodeTextLayout {
  label: FittedText
  sub: FittedText | null
  /** Baseline y for each label line, and for each sub line. */
  labelY: number[]
  subY: number[]
  /** True when either part had to be cut. */
  truncated: boolean
}

export function layoutNodeText(
  label: string,
  sub: string | undefined,
  box: { x: number; y: number; w: number; h: number },
): NodeTextLayout {
  const inner = box.h - 1.2

  /*
   * Search the two ladders TOGETHER.
   *
   * Sizing the label first and giving the subtitle the remainder looks
   * reasonable and is wrong: it spends the box on the label and then reports the
   * subtitle as unfittable, which is how a six-character label ended up flagged
   * as truncated because its subtitle had nowhere to go. Both are text in one
   * box, so both sizes are one decision. Largest-label-first is still the
   * preference — the loop order encodes it — but a smaller label that lets the
   * subtitle fit beats a bigger one that clips it.
   */
  let fitted: FittedText | null = null
  let subFit: FittedText | null = null

  if (!sub) {
    fitted = fitText(label, box.w, { sizes: LABEL_SIZES, maxLines: 3, maxHeight: inner })
  } else {
    outer: for (const ls of LABEL_SIZES) {
      const lf = fitText(label, box.w, { sizes: [ls], maxLines: 3, maxHeight: inner })
      if (lf.truncated) continue
      for (const ss of SUB_SIZES) {
        /* Subtitles wrap as freely as labels; capping them at two lines was an
         * arbitrary limit that dropped 70 of them for want of a third line. */
        const sf = fitText(sub, box.w, { sizes: [ss], maxLines: 3 })
        if (sf.truncated) continue
        if (lf.height + sf.height <= inner) {
          fitted = lf
          subFit = sf
          break outer
        }
      }
    }
    /* No combination fitted: keep the label legible and drop the subtitle, which
     * is the lesser loss — a clipped subtitle reads as a rendering bug. */
    if (!fitted) {
      fitted = fitText(label, box.w, { sizes: LABEL_SIZES, maxLines: 3, maxHeight: inner })
      subFit = null
    }
  }

  const total = fitted.height + (subFit ? subFit.height : 0)
  const top = box.y + (box.h - total) / 2

  /* SVG baselines sit at the bottom of the glyph, so offset by ~0.8 of the size. */
  const labelY = fitted.lines.map(
    (_, i) => top + i * fitted.fontSize * LINE_HEIGHT + fitted.fontSize * 0.82,
  )
  const subY = subFit
    ? subFit.lines.map(
        (_, i) => top + fitted.height + i * subFit!.fontSize * LINE_HEIGHT + subFit!.fontSize * 0.78,
      )
    : []

  return {
    label: fitted,
    sub: subFit,
    labelY,
    subY,
    truncated: fitted.truncated || (subFit?.truncated ?? false),
  }
}

/**
 * Place an edge label so it does not sit on top of the boxes it runs between.
 *
 * Two changes from the original, which drew every label at the raw midpoint of
 * the line: the label is offset perpendicular to the edge, and its x is clamped
 * so a long label near an edge of the canvas cannot escape the viewBox. The
 * renderer additionally only draws labels for the highlighted edges, so a step
 * shows one or two rather than all of them at once.
 */
export function edgeLabelPlacement(
  a: { cx: number; cy: number },
  b: { cx: number; cy: number },
  text: string,
  viewWidth = 100,
): { x: number; y: number; fontSize: number; lines: string[]; width: number } {
  const mx = (a.cx + b.cx) / 2
  const my = (a.cy + b.cy) / 2

  const fitted = fitText(text, Math.min(46, viewWidth), { sizes: EDGE_SIZES, maxLines: 2 })
  const longest = Math.max(...fitted.lines.map((l) => l.length))
  const width = longest * fitted.fontSize * ADVANCE

  /* Perpendicular offset: push the label off the line rather than through it. */
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const len = Math.hypot(dx, dy) || 1
  const off = 1.9
  const x = mx + (-dy / len) * off * 0.35
  const y = my + (dx / len) * off * 0.35 - 0.4

  const half = width / 2 + 1
  return {
    x: Math.min(viewWidth - half, Math.max(half, x)),
    y,
    fontSize: fitted.fontSize,
    lines: fitted.lines,
    width,
  }
}

/**
 * Trim a centre-to-centre line back to the borders of the two boxes.
 *
 * Edges were drawn from centre to centre, so every arrow began inside its source
 * box, ended inside its target, and drew over the label it was pointing at. This
 * clips the segment to each rectangle's edge, which is what makes the arrowhead
 * land ON the box rather than in the middle of its text.
 *
 * It does not stop a line crossing a THIRD box that happens to sit between the
 * two — that is a layout property of the diagram, not something the renderer can
 * fix, and the step highlighting is what keeps it readable.
 */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Where the ray from the centre of `box` towards (tx,ty) leaves the box. */
function exitPoint(box: Box, tx: number, ty: number): { x: number; y: number } {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  /* Scale the direction until it touches the nearer of the two box planes. */
  const sx = dx === 0 ? Infinity : box.w / 2 / Math.abs(dx)
  const sy = dy === 0 ? Infinity : box.h / 2 / Math.abs(dy)
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

export function trimEdge(
  from: Box,
  to: Box,
  gap = 0.6,
): { x1: number; y1: number; x2: number; y2: number } {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
  const a = exitPoint(from, tc.x, tc.y)
  const b = exitPoint(to, fc.x, fc.y)
  /* Pull both ends back a hair so the stroke does not kiss the border. */
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ux = (dx / len) * gap
  const uy = (dy / len) * gap
  return { x1: a.x + ux, y1: a.y + uy, x2: b.x - ux, y2: b.y - uy }
}
