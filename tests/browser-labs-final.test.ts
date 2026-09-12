/**
 * The last three browser labs — model tests.
 *
 * Each of these labs makes a claim in prose that its model has to keep true. A
 * lab that merely *said* the weakest factor dominates, or that a dictionary can
 * expand a column, or that the footer share rises as row groups shrink, would be
 * three paragraphs. These tests are what make them properties of the models, so
 * they cannot quietly stop being true.
 *
 * What is asserted, per lab:
 *
 *   scan-arithmetic  The total is EXACTLY the three factors multiplied, and the
 *                    factor identification is correct across the whole 48-point
 *                    sweep: the axis with the most headroom is always an axis
 *                    sitting at 1× whenever one exists. Plus the paired target —
 *                    under the freshness ceiling, no factor may be left at 1×.
 *
 *   codec-chooser    The byte formulas match forge lab 01's formulas exactly on
 *                    hand-computed cases, INCLUDING the all-distinct column where
 *                    the dictionary expands by half again and frame-of-reference
 *                    loses by exactly the 8 bytes its base costs. And the bound:
 *                    the optimal choice is never worse than plain, on the seven
 *                    lab columns and across 240 seeded random ones.
 *
 *   footer-walk      Metadata entries are exactly row groups × columns, in every
 *                    configuration, and the footer share rises strictly and
 *                    monotonically as row groups shrink. Statistics live at
 *                    exactly one level, computed rather than asserted.
 *
 * And for all three: determinism, and no NaN, no Infinity and no negative number
 * anywhere in the reachable output. One NaN on the page discredits every number
 * beside it.
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ScanArithmeticLab from '@/components/browserlabs/ScanArithmeticLab'
import CodecChooserLab from '@/components/browserlabs/CodecChooserLab'
import FooterWalkLab from '@/components/browserlabs/FooterWalkLab'
import { Rng } from '@/lib/desks/kit'
import {
  AXIS_OPTIONS,
  BASELINE_RUNS_PER_DAY,
  BLOCKS,
  CHOICE_GRID,
  COLUMN_COUNT,
  FACTOR_IDS,
  FACTOR_MAX,
  FREQUENCIES,
  NAMED_BYTES,
  OPENING_CHOICE,
  OTHER_BYTES,
  OTHER_COLUMNS,
  PROJECTIONS,
  PRUNINGS,
  ROWS,
  ROWS_PER_BLOCK,
  ROW_BYTES,
  SCHEMA,
  TARGETS,
  axisChanged,
  bestWithAxisAtOne,
  cheapestChoice,
  choiceKey,
  factorValue,
  sampleWorkload,
  scanBill,
  solvingChoices,
  stepGain,
  stepUp,
  weakestHistogram,
  type FactorId,
  type ScanChoice,
} from '@/lib/scan/arithmetic'
import {
  CODEC_IDS,
  COLUMNS as CODEC_COLUMNS,
  COLUMN_ROWS,
  HEADER,
  bitmapBytes,
  bitpackSize,
  bitpackWidth,
  bitsNeeded,
  columnProfile,
  columnValues,
  dictSize,
  distinctCount,
  expandingDictColumns,
  forFrame,
  forSize,
  hasNull,
  optimalCodec,
  orderingPair,
  packedWords,
  plainSize,
  plainWinsColumns,
  priceAll,
  priceOf,
  rleSize,
  runCount,
  totals,
  type Cell,
  type CodecId,
} from '@/lib/codec/chooser'
import {
  COLUMN_SETS,
  CONFIG_GRID,
  ENTRY_FIXED_BYTES,
  FOOTER_FIXED_BYTES,
  KEY_WIDTH_CHOICES,
  LEADING_MAGIC_BYTES,
  LEVEL_IDS,
  LEVEL_SPECS,
  OPENING_CONFIG,
  ROWS as FOOTER_ROWS,
  ROW_GROUP_CHOICES,
  ROW_GROUP_STRUCT_BYTES,
  SCHEMA_BYTES_PER_COLUMN,
  SHARE_TARGET,
  TRAILER_BYTES,
  columnSet,
  configKey,
  configsWhereFooterExceedsData,
  footerModel,
  footerShareSweep,
  rangeReads,
  schemaTree,
  statisticsLevel,
} from '@/lib/footer/walk'

/** Every number reachable from a value, flattened, for the NaN/negative sweep. */
function numbersOf(value: unknown, path = 'root', out: [string, number][] = []): [string, number][] {
  if (typeof value === 'number') out.push([path, value])
  else if (Array.isArray(value)) value.forEach((v, i) => numbersOf(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object' && typeof value !== 'bigint') {
    for (const [k, v] of Object.entries(value)) numbersOf(v, `${path}.${k}`, out)
  }
  return out
}

/** Finite, non-negative, and not NaN — asserted with the path so a failure names itself. */
function expectClean(value: unknown, label: string): void {
  for (const [path, n] of numbersOf(value)) {
    expect(Number.isFinite(n), `${label} ${path} = ${n}`).toBe(true)
    expect(n >= 0, `${label} ${path} = ${n}`).toBe(true)
  }
}

/* ══════════════════════════ scan-arithmetic ══════════════════════════ */

describe('scan-arithmetic · the space', () => {
  it('is the product of the three knobs, and nothing else', () => {
    expect(CHOICE_GRID).toHaveLength(PROJECTIONS.length * PRUNINGS.length * FREQUENCIES.length)
    expect(CHOICE_GRID).toHaveLength(48)
    expect(new Set(CHOICE_GRID.map(choiceKey)).size).toBe(CHOICE_GRID.length)
  })

  it('opens on a configuration inside the space', () => {
    expect(CHOICE_GRID.map(choiceKey)).toContain(choiceKey(OPENING_CHOICE))
  })

  it('has a schema whose widths add up to the row width the lesson quotes', () => {
    expect(NAMED_BYTES + OTHER_BYTES).toBe(ROW_BYTES)
    expect(SCHEMA.length + OTHER_COLUMNS).toBe(COLUMN_COUNT)
    expect(OTHER_COLUMNS).toBe(48)
    expect(OTHER_BYTES).toBe(284)
    for (const c of SCHEMA) expect(c.bytes).toBeGreaterThan(0)
  })

  it('divides the table into whole blocks', () => {
    expect(ROWS_PER_BLOCK).toBe(ROWS / BLOCKS)
    expect(Number.isInteger(ROWS_PER_BLOCK)).toBe(true)
    for (const p of PRUNINGS) expect(BLOCKS % p.blocksRead).toBe(0)
  })
})

describe('scan-arithmetic · determinism', () => {
  it('the same three choices produce identical counts, twice', () => {
    for (const c of [OPENING_CHOICE, ...CHOICE_GRID.slice(0, 12)]) {
      expect(scanBill({ ...c })).toEqual(scanBill({ ...c }))
    }
  })

  it('a choice rebuilt from its parts prices the same as the original object', () => {
    const rebuilt: ScanChoice = {
      projection: OPENING_CHOICE.projection,
      pruning: OPENING_CHOICE.pruning,
      frequency: OPENING_CHOICE.frequency,
    }
    expect(scanBill(rebuilt)).toEqual(scanBill(OPENING_CHOICE))
  })

  it('the sample workload is the same eight queries every time', () => {
    expect(sampleWorkload()).toHaveLength(8)
    expect(sampleWorkload()).toEqual(sampleWorkload())
    expect(sampleWorkload().map((q) => choiceKey(q.choice))).toEqual(
      sampleWorkload().map((q) => choiceKey(q.choice)),
    )
    const hist = weakestHistogram()
    expect(FACTOR_IDS.reduce((n, id) => n + hist[id], 0)).toBe(8)
  })
})

describe('scan-arithmetic · the product is exactly the three factors multiplied', () => {
  it('holds for all 48 configurations, to the bit', () => {
    for (const c of CHOICE_GRID) {
      const b = scanBill(c)
      expect(b.totalFactor).toBe(b.projectionFactor * b.pruningFactor * b.frequencyFactor)
      /* And the factors array is the same three numbers, not a second model. */
      expect(b.factors.map((f) => f.value)).toEqual([
        b.projectionFactor,
        b.pruningFactor,
        b.frequencyFactor,
      ])
      expect(b.factors.map((f) => f.id)).toEqual(FACTOR_IDS)
    }
  })

  it('agrees with the ratio of the two byte counts it also reports', () => {
    for (const c of CHOICE_GRID) {
      const b = scanBill(c)
      const fromCounts = b.baselineBytesPerDay / b.bytesPerDay
      expect(fromCounts).toBeCloseTo(b.totalFactor, 6)
      expect(b.bytesPerPass).toBe(b.rowsRead * b.bytesPerRowProjected)
      expect(b.bytesPerDay).toBe(b.bytesPerPass * b.runsPerDay)
      expect(b.baselineBytesPerPass).toBe(ROWS * ROW_BYTES)
      expect(b.baselineBytesPerDay).toBe(ROWS * ROW_BYTES * BASELINE_RUNS_PER_DAY)
      /* Every byte count is an exact integer: these are counts, and a count with
       * a fractional part is a modelling error wearing a decimal point. */
      expect(Number.isSafeInteger(b.bytesPerPass)).toBe(true)
      expect(Number.isSafeInteger(b.bytesPerDay)).toBe(true)
      expect(Number.isSafeInteger(b.baselineBytesPerDay)).toBe(true)
    }
  })

  it('writes each factor as a division the reader can redo', () => {
    for (const c of CHOICE_GRID) {
      const b = scanBill(c)
      for (const f of b.factors) expect(f.value).toBe(f.numerator / f.denominator)
      expect(b.factors[0].denominator).toBe(b.bytesPerRowProjected)
      expect(b.factors[1].denominator).toBe(b.blocksRead)
      expect(b.factors[2].denominator).toBe(b.runsPerDay)
    }
  })

  it('never reports a factor below 1×, so a "reduction" is never an increase', () => {
    for (const c of CHOICE_GRID) {
      for (const f of scanBill(c).factors) expect(f.value).toBeGreaterThanOrEqual(1)
      expect(scanBill(c).totalFactor).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('scan-arithmetic · the weakest factor is identified correctly', () => {
  /** The independent answer: argmin / argmax over the three values, ties by FACTOR_IDS order. */
  const argBy = (c: ScanChoice, better: (a: number, b: number) => boolean): FactorId => {
    let best = FACTOR_IDS[0]
    for (const id of FACTOR_IDS) if (better(factorValue(c, id), factorValue(c, best))) best = id
    return best
  }

  it('names the smallest factor, across the whole sweep', () => {
    for (const c of CHOICE_GRID) {
      expect(scanBill(c).weakest).toBe(argBy(c, (a, b) => a < b))
      expect(scanBill(c).strongest).toBe(argBy(c, (a, b) => a > b))
    }
  })

  it('lists exactly the factors that are at 1×', () => {
    for (const c of CHOICE_GRID) {
      const b = scanBill(c)
      expect(b.factorsAtOne).toEqual(FACTOR_IDS.filter((id) => factorValue(c, id) === 1))
    }
  })

  it('puts the most headroom on an axis at 1× whenever one exists — for all 48 configurations', () => {
    /* This is the lab's structural claim. `max ÷ current` per axis is the
     * headroom, and the smallest headroom available to an axis at 1× is larger
     * than the largest headroom available to any axis above 1× — so "fix the 1×
     * factor first" is a fact about the space, not advice. */
    let sawAtOne = 0
    for (const c of CHOICE_GRID) {
      const b = scanBill(c)
      const headroom = (id: FactorId) => FACTOR_MAX[id] / factorValue(c, id)
      const best = FACTOR_IDS.reduce((acc, id) => (headroom(id) > headroom(acc) ? id : acc), FACTOR_IDS[0])
      expect(b.mostHeadroom).toBe(best)
      if (b.factorsAtOne.length > 0) {
        sawAtOne += 1
        expect(b.factorsAtOne).toContain(b.mostHeadroom)
        expect(b.factorsAtOne).toContain(b.weakest)
      }
    }
    expect(sawAtOne).toBeGreaterThan(20)
  })

  it('opens with exactly one factor at 1×, and it is pruning', () => {
    const b = scanBill(OPENING_CHOICE)
    expect(b.factorsAtOne).toEqual(['pruning'])
    expect(b.mostHeadroom).toBe('pruning')
    expect(b.weakest).toBe('pruning')
  })

  it('orders each axis weakest-first, so a "step up" is always an improvement', () => {
    for (const axis of FACTOR_IDS) {
      const values = AXIS_OPTIONS[axis].map((opt) =>
        factorValue({ ...OPENING_CHOICE, [axis]: opt } as ScanChoice, axis),
      )
      for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1])
      expect(values[0]).toBe(1)
      expect(values[values.length - 1]).toBe(FACTOR_MAX[axis])
    }
  })

  it('reports a step gain of at least 1×, and exactly 1× at the top of an axis', () => {
    for (const c of CHOICE_GRID) {
      for (const axis of FACTOR_IDS) {
        const gain = stepGain(c, axis)
        expect(gain).toBeGreaterThanOrEqual(1)
        const next = stepUp(c, axis)
        if (next === null) expect(gain).toBe(1)
        else {
          expect(axisChanged(c, next)).toBe(axis)
          expect(factorValue(next, axis)).toBeGreaterThan(factorValue(c, axis))
        }
      }
    }
  })
})

describe('scan-arithmetic · the target is paired, so the frequency lever cannot answer it', () => {
  it('is satisfied by exactly two of the 48 configurations', () => {
    const solving = solvingChoices()
    expect(solving).toHaveLength(2)
    for (const c of solving) {
      const b = scanBill(c)
      expect(b.totalFactor).toBeGreaterThanOrEqual(TARGETS.totalFactor)
      expect(b.stalenessMinutes).toBeLessThanOrEqual(TARGETS.stalenessMinutes)
      /* And no solution leaves a factor untouched. */
      expect(b.factorsAtOne).toEqual([])
    }
  })

  it('is not satisfied by the configuration with the smallest bill', () => {
    const cheapest = scanBill(cheapestChoice())
    expect(cheapest.targetOk).toBe(true)
    expect(cheapest.freshOk).toBe(false)
    expect(cheapest.ok).toBe(false)
    expect(cheapest.stalenessMinutes / TARGETS.stalenessMinutes).toBeGreaterThanOrEqual(4)
  })

  it('cannot be reached with any factor left at 1×, once the freshness ceiling applies', () => {
    for (const axis of FACTOR_IDS) {
      expect(bestWithAxisAtOne(axis, true)).toBeLessThan(TARGETS.totalFactor)
    }
    /* Without the ceiling one axis CAN be left at 1× and the target still met —
     * which is exactly why the ceiling is part of the task. */
    expect(bestWithAxisAtOne('projection', false)).toBeGreaterThanOrEqual(TARGETS.totalFactor)
  })
})

describe('scan-arithmetic · no NaN, no Infinity, no negative', () => {
  it('holds across the whole 48-point sweep', () => {
    for (const c of CHOICE_GRID) expectClean(scanBill(c), `bill ${choiceKey(c)}`)
    expectClean(sampleWorkload(), 'sample workload')
  })
})

/* ═══════════════════════════ codec-chooser ══════════════════════════ */

const cells = (...vals: (number | bigint | null)[]): Cell[] =>
  vals.map((v) => (v === null ? null : BigInt(v)))

const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n

describe('codec-chooser · the formulas are forge lab 01’s formulas', () => {
  it('charges the same 8-byte header every codec pays', () => {
    expect(HEADER).toBe(8)
  })

  it('sizes the plain encoding by hand: 8 + 8n, plus one validity bit per value when a null exists', () => {
    expect(plainSize([])).toBe(8)
    expect(plainSize(cells(1))).toBe(8 + 8)
    expect(plainSize(cells(...Array.from({ length: 10 }, (_, i) => i)))).toBe(8 + 80)
    /* Ten values, one of them null: 8 + 80 + ⌈10/8⌉ = 90. */
    expect(plainSize(cells(1, 2, 3, 4, 5, 6, 7, 8, 9, null))).toBe(90)
    expect(bitmapBytes(cells(1, 2, 3))).toBe(0)
    expect(bitmapBytes(cells(1, null, 3))).toBe(1)
    expect(bitmapBytes(cells(...Array.from({ length: 9 }, () => null)))).toBe(2)
    expect(plainSize(cells(null))).toBe(8 + 8 + 1)
  })

  it('sizes the dictionary by hand: 8 + 8·distinct + 4·n, with NULL as one of the distinct values', () => {
    expect(distinctCount(cells(1, 1, 2, null))).toBe(3)
    expect(dictSize(cells(1, 1, 2, null))).toBe(8 + 8 * 3 + 4 * 4)
    expect(dictSize(cells(1, 1, 2, null))).toBe(48)
    expect(dictSize([])).toBe(8)
    expect(distinctCount(cells(null, null))).toBe(1)
  })

  it('sizes RLE by hand: 8 + 12·runs, over MAXIMAL runs', () => {
    /* The hand case from forge lab 01's rle_roundtrip check: a value that
     * reappears after a null run starts a NEW run, so this is six runs. */
    const hand = cells(1, 1, 2, 3, 3, 3, null, null, 3, 4)
    expect(runCount(hand)).toBe(6)
    expect(rleSize(hand)).toBe(8 + 12 * 6)
    expect(rleSize(hand)).toBe(80)
    expect(runCount([])).toBe(0)
    expect(rleSize([])).toBe(8)
    /* A constant column is exactly one run; an alternating column is n of them. */
    expect(runCount(cells(...Array.from({ length: 1000 }, () => 7)))).toBe(1)
    expect(runCount(cells(...Array.from({ length: 1000 }, (_, i) => i % 2)))).toBe(1000)
    /* Built without a spread: 300,000 arguments is a stack overflow, not a test. */
    const longRun: Cell[] = new Array<Cell>(300_000).fill(7n)
    expect(runCount(longRun)).toBe(1)
    expect(rleSize(longRun)).toBe(HEADER + 12)
  })

  it('counts significant bits the way bits_needed does, never returning zero', () => {
    expect(bitsNeeded(0n)).toBe(1)
    expect(bitsNeeded(1n)).toBe(1)
    expect(bitsNeeded(2n)).toBe(2)
    expect(bitsNeeded(255n)).toBe(8)
    expect(bitsNeeded(256n)).toBe(9)
    expect(bitsNeeded(0xffff_ffffn)).toBe(32)
    expect(bitsNeeded(2n ** 64n - 1n)).toBe(64)
  })

  it('counts packed words as a ceiling divide, because values straddle word boundaries', () => {
    expect(packedWords(0, 1)).toBe(0)
    expect(packedWords(97, 1)).toBe(2)
    expect(packedWords(97, 64)).toBe(97)
    expect(packedWords(101, 3)).toBe(5)
    expect(packedWords(4096, 3)).toBe(192)
    expect(packedWords(4096, 64)).toBe(4096)
  })

  it('sizes bit-packing by hand, and refuses what it cannot represent', () => {
    /* 4,096 flags at width 1: 8 + 8·⌈4096/64⌉ = 8 + 512 = 520. */
    expect(bitpackSize(cells(...Array.from({ length: 4096 }, (_, i) => i % 2)))).toBe(520)
    expect(bitpackSize([])).toBe(8)
    expect(bitpackWidth(cells(0, 1))).toBe(1)
    expect(bitpackWidth(cells(0, 0xffff_ffff))).toBe(32)
    /* Out of the declared unsigned-32-bit domain, or holding a null: refused. */
    expect(bitpackSize(cells(1, -1))).toBeNull()
    expect(bitpackSize(cells(0x1_0000_0000))).toBeNull()
    expect(bitpackSize([I64_MIN])).toBeNull()
    expect(bitpackSize(cells(0, null))).toBeNull()
    expect(bitpackWidth(cells(0, null))).toBeNull()
  })

  it('sizes frame-of-reference by hand, with the base pinned to the minimum', () => {
    expect(forSize([])).toBe(16)
    /* A column holding both i64::MIN and i64::MAX spans 2^64 − 1: width 64,
     * two words, 8 + 8 + 16 = 32. In i64 that subtraction would overflow. */
    const extremes = [I64_MIN, I64_MAX]
    expect(forFrame(extremes)?.base).toBe(I64_MIN)
    expect(forFrame(extremes)?.width).toBe(64)
    expect(forSize(extremes)).toBe(8 + 8 + 8 * 2)
    /* Descending and negative columns are fine: the base is the minimum, not the
     * first value, which is what keeps every delta non-negative. */
    const descending = Array.from({ length: 500 }, (_, i) => 1_000_000n - BigInt(i) * 7n)
    expect(forFrame(descending)?.base).toBe(1_000_000n - 499n * 7n)
    expect(forFrame(descending)?.width).toBe(bitsNeeded(499n * 7n))
    expect(forSize(cells(0, null))).toBeNull()
  })
})

describe('codec-chooser · the all-distinct column, where the dictionary expands', () => {
  const profile = columnProfile('order_id')

  it('is all-distinct over the full 64-bit range, with no nulls', () => {
    expect(profile.rows).toBe(COLUMN_ROWS)
    expect(profile.distinct).toBe(COLUMN_ROWS)
    expect(profile.runs).toBe(COLUMN_ROWS)
    expect(profile.nullCount).toBe(0)
    expect(profile.forWidth).toBe(64)
    /* Values leave bit-packing's unsigned-32-bit domain, so it refuses outright. */
    expect(profile.bitpackWidth).toBeNull()
  })

  it('prices plain at 8 + 8·4096 = 32,776, by hand', () => {
    expect(profile.plainBytes).toBe(8 + 8 * 4096)
    expect(profile.plainBytes).toBe(32_776)
  })

  it('EXPANDS under a dictionary: 8 + 8·4096 + 4·4096 = 49,160, half again as large', () => {
    const dict = priceOf(profile, 'dict').bytes as number
    expect(dict).toBe(8 + 8 * 4096 + 4 * 4096)
    expect(dict).toBe(49_160)
    expect(dict).toBeGreaterThan(profile.plainBytes)
    expect(dict / profile.plainBytes).toBeGreaterThan(1.49)
    expect(expandingDictColumns()).toContain('order_id')
  })

  it('loses under frame-of-reference by exactly the 8 bytes the base costs', () => {
    const forBytes = priceOf(profile, 'for').bytes as number
    expect(forBytes).toBe(8 + 8 + 8 * 4096)
    expect(forBytes).toBe(32_784)
    expect(forBytes - profile.plainBytes).toBe(8)
  })

  it('falls back to plain, and the fallback is the lesson', () => {
    expect(profile.optimal.codec).toBe('plain')
    expect(profile.optimal.bytes).toBe(profile.plainBytes)
    expect(profile.savedBytes).toBe(0)
    expect(plainWinsColumns()).toEqual(['order_id'])
  })
})

describe('codec-chooser · the bound: never worse than plain', () => {
  it('holds on all seven lab columns, and the chosen codec is the smallest candidate', () => {
    for (const c of CODEC_COLUMNS) {
      const p = columnProfile(c.id)
      const applicable = p.prices.filter((x) => x.bytes !== null).map((x) => x.bytes as number)
      expect(p.optimal.bytes).toBe(Math.min(...applicable))
      expect(p.optimal.bytes as number).toBeLessThanOrEqual(p.plainBytes)
      expect(p.savedBytes).toBeGreaterThanOrEqual(0)
      /* Plain is always a candidate — that is what makes the bound hold at all. */
      expect(priceOf(p, 'plain').bytes).toBe(p.plainBytes)
      expect(priceOf(p, 'plain').applicable).toBe(true)
    }
  })

  it('holds across 240 seeded columns of every shape that breaks a codec', () => {
    const rng = new Rng(0x5eed_c0de)
    for (let i = 0; i < 240; i++) {
      const n = i % 37 === 0 ? 0 : 1 + rng.below(400)
      const span = 1 + rng.below(4096)
      const nullIn = 1 + rng.below(20)
      const shape = i % 8
      const col: Cell[] = []
      for (let k = 0; k < n; k++) {
        if (shape === 0) col.push(null)
        else if (shape === 1) col.push(rng.next() >= 2n ** 63n ? rng.next() - 2n ** 64n : rng.next())
        else if (shape === 2) col.push(7n)
        else if (shape === 3) col.push(BigInt(rng.below(6)) * 104_729n - 50_000_000_000n)
        else if (shape === 4) col.push(1_700_000_000_000n + BigInt(k) * BigInt(rng.below(60)))
        else if (shape === 5) col.push(BigInt(rng.below(8)))
        else if (shape === 6) col.push(rng.below(nullIn) === 0 ? null : BigInt(rng.below(span)))
        else col.push(BigInt(rng.below(2)))
      }
      const plain = plainSize(col)
      const prices = priceAll(col)
      const best = optimalCodec(col)

      expect(best.bytes as number).toBeLessThanOrEqual(plain)
      expect(best.bytes as number).toBeGreaterThan(0)
      for (const p of prices) {
        if (p.bytes === null) {
          /* A codec only refuses for the two stated reasons. */
          expect(p.codec === 'bitpack' || p.codec === 'for').toBe(true)
          expect(hasNull(col) || p.codec === 'bitpack').toBe(true)
          continue
        }
        expect(Number.isSafeInteger(p.bytes)).toBe(true)
        expect(p.bytes).toBeGreaterThanOrEqual(HEADER)
      }
      /* And the tape measure agrees with itself, field by field. */
      expect(priceAll(col).map((p) => p.bytes)).toEqual([
        plain,
        dictSize(col),
        rleSize(col),
        bitpackSize(col),
        forSize(col),
      ])
      expect(distinctCount(col)).toBeLessThanOrEqual(Math.max(1, n))
      expect(runCount(col)).toBeLessThanOrEqual(n)
    }
  })
})

describe('codec-chooser · determinism', () => {
  it('builds the same seven columns every time', () => {
    for (const c of CODEC_COLUMNS) {
      expect(columnValues(c.id)).toEqual(columnValues(c.id))
      expect(columnProfile(c.id)).toEqual(columnProfile(c.id))
      expect(columnValues(c.id)).toHaveLength(COLUMN_ROWS)
    }
  })

  it('reproduces a column from its seed alone, with no shared state', () => {
    /* The generator is a pure function of the seed: two Rngs seeded alike draw
     * the identical stream, which is what makes every number on the page
     * replayable on any machine. */
    const a = new Rng(0x5eed_0006)
    const b = new Rng(0x5eed_0006)
    const drawA = Array.from({ length: 4096 }, () => BigInt(a.below(2)))
    const drawB = Array.from({ length: 4096 }, () => BigInt(b.below(2)))
    expect(drawA).toEqual(drawB)
    expect(drawA).toEqual(columnValues('is_refunded'))
  })

  it('prices identical columns identically, whichever object they arrive in', () => {
    const a = columnValues('region_clustered')
    const copy = [...a]
    expect(priceAll(copy).map((p) => p.bytes)).toEqual(priceAll(a).map((p) => p.bytes))
  })
})

describe('codec-chooser · the properties do not decide alone', () => {
  it('gives two columns the same cardinality and range, and a different winner', () => {
    const pair = orderingPair()
    expect(pair.sameCardinality).toBe(true)
    expect(pair.differentCodec).toBe(true)
    const a = columnProfile(pair.a)
    const b = columnProfile(pair.b)
    expect(a.distinct).toBe(b.distinct)
    expect(a.bitpackWidth).toBe(b.bitpackWidth)
    expect(a.runs).toBeLessThan(b.runs)
    expect(a.optimal.codec).toBe('rle')
    expect(b.optimal.codec).toBe('bitpack')
  })

  it('makes every one of the five codecs the right answer somewhere', () => {
    const winners = new Set<CodecId>(CODEC_COLUMNS.map((c) => columnProfile(c.id).optimal.codec))
    for (const id of CODEC_IDS) expect([...winners]).toContain(id)
  })

  it('bars the packed codecs exactly when a null is present or the domain is exceeded', () => {
    for (const c of CODEC_COLUMNS) {
      const values = columnValues(c.id)
      const p = columnProfile(c.id)
      if (hasNull(values)) {
        expect(p.bitpackWidth).toBeNull()
        expect(p.forWidth).toBeNull()
        expect(priceOf(p, 'bitpack').bytes).toBeNull()
        expect(priceOf(p, 'for').bytes).toBeNull()
      } else {
        expect(p.forWidth).not.toBeNull()
      }
    }
    expect(columnProfile('event_type').nullCount).toBeGreaterThan(0)
    expect(columnProfile('event_type').optimal.codec).toBe('dict')
  })

  it('reports a total that is the sum of the per-column optima', () => {
    const sums = totals()
    expect(sums.optimal).toBe(
      CODEC_COLUMNS.reduce((n, c) => n + (columnProfile(c.id).optimal.bytes as number), 0),
    )
    expect(sums.plain).toBe(CODEC_COLUMNS.reduce((n, c) => n + columnProfile(c.id).plainBytes, 0))
    expect(sums.optimal).toBeLessThan(sums.plain)
    expect(sums.ratio).toBe(sums.plain / sums.optimal)
  })
})

describe('codec-chooser · no NaN, no Infinity, no negative', () => {
  it('holds for every column profile', () => {
    for (const c of CODEC_COLUMNS) {
      const p = columnProfile(c.id)
      expectClean({ ...p, min: undefined, max: undefined, spread: undefined }, `profile ${c.id}`)
    }
    expectClean(totals(), 'totals')
  })
})

/* ════════════════════════════ footer-walk ═══════════════════════════ */

describe('footer-walk · the model', () => {
  it('divides the row count into whole row groups at every choice', () => {
    for (const rg of ROW_GROUP_CHOICES) {
      expect(FOOTER_ROWS % rg).toBe(0)
      expect(Number.isInteger(FOOTER_ROWS / rg)).toBe(true)
    }
  })

  it('is the product of the three knobs, and opens inside it', () => {
    expect(CONFIG_GRID).toHaveLength(
      ROW_GROUP_CHOICES.length * COLUMN_SETS.length * KEY_WIDTH_CHOICES.length,
    )
    expect(CONFIG_GRID).toHaveLength(54)
    expect(CONFIG_GRID.map(configKey)).toContain(configKey(OPENING_CONFIG))
  })

  it('produces identical counts for the same layout, twice', () => {
    for (const c of [OPENING_CONFIG, ...CONFIG_GRID.slice(0, 12)]) {
      expect(footerModel({ ...c })).toEqual(footerModel({ ...c }))
    }
    expect(schemaTree('wide')).toEqual(schemaTree('wide'))
    expect(schemaTree('reference')).toHaveLength(columnSet('reference').columns)
  })

  it('adds the footer up out of its four itemised parts', () => {
    for (const c of CONFIG_GRID) {
      const r = footerModel(c)
      expect(r.fileFieldBytes).toBe(FOOTER_FIXED_BYTES)
      expect(r.schemaBytes).toBe(SCHEMA_BYTES_PER_COLUMN * r.columns)
      expect(r.rowGroupStructBytes).toBe(ROW_GROUP_STRUCT_BYTES * r.rowGroups)
      expect(r.entryBytes).toBe(ENTRY_FIXED_BYTES + 2 * r.keyWidth)
      expect(r.entriesBytes).toBe(r.metadataEntries * r.entryBytes)
      expect(r.footerBytes).toBe(
        r.fileFieldBytes + r.schemaBytes + r.rowGroupStructBytes + r.entriesBytes,
      )
      expect(r.fileBytes).toBe(LEADING_MAGIC_BYTES + r.dataBytes + r.footerBytes + TRAILER_BYTES)
      expect(r.footerShare).toBe(r.footerBytes / r.fileBytes)
      expect(r.footerBytesPerRow).toBe(r.footerBytes / FOOTER_ROWS)
      expect(r.footerExceedsData).toBe(r.footerBytes > r.dataBytes)
    }
  })

  it('counts the opening sequence as two ranges, then one per projected chunk', () => {
    const r = footerModel(OPENING_CONFIG)
    expect(r.openingRangeReads).toBe(2)
    expect(rangeReads(r, 3, 4)).toBe(2 + 12)
    expect(rangeReads(r, 1, 1)).toBe(3)
    expect(rangeReads(r, 0, 0)).toBe(2)
  })
})

describe('footer-walk · metadata entries are row groups × columns, exactly', () => {
  it('holds in every configuration in the space', () => {
    for (const c of CONFIG_GRID) {
      const r = footerModel(c)
      expect(r.metadataEntries).toBe(r.rowGroups * r.columns)
      expect(r.rowGroups).toBe(c.rowGroups)
      expect(r.columns).toBe(columnSet(c.columnSet).columns)
      expect(Number.isInteger(r.metadataEntries)).toBe(true)
    }
  })

  it('reproduces the two figures C3.L1 quotes: 33 × 64 = 2,112 against 4 × 1 = 4', () => {
    expect(footerModel({ rowGroups: 64, columnSet: 'wide', keyWidth: 12 }).metadataEntries).toBe(2_112)
    expect(footerModel({ rowGroups: 1, columnSet: 'narrow', keyWidth: 12 }).metadataEntries).toBe(4)
  })

  it('counts one chunk entry per level entity, and three page offsets per entry', () => {
    for (const c of CONFIG_GRID.slice(0, 18)) {
      const r = footerModel(c)
      const byId = Object.fromEntries(r.levels.map((l) => [l.id, l]))
      expect(byId.file.entities).toBe(1)
      expect(byId['row-group'].entities).toBe(r.rowGroups)
      expect(byId['column-chunk'].entities).toBe(r.metadataEntries)
      expect(byId.page.entities).toBe(3 * r.metadataEntries)
    }
  })
})

describe('footer-walk · the footer share rises as row groups shrink', () => {
  it('rises strictly and monotonically along every column set and value width', () => {
    for (const set of COLUMN_SETS) {
      for (const w of KEY_WIDTH_CHOICES) {
        const sweep = footerShareSweep(set.id, w)
        expect(sweep).toHaveLength(ROW_GROUP_CHOICES.length)
        for (let i = 1; i < sweep.length; i++) {
          /* Coarsest first, so each step SHRINKS the row groups. */
          expect(sweep[i].rowGroups).toBeGreaterThan(sweep[i - 1].rowGroups)
          expect(sweep[i].rowsPerGroup).toBeLessThan(sweep[i - 1].rowsPerGroup)
          expect(sweep[i].footerBytes).toBeGreaterThan(sweep[i - 1].footerBytes)
          expect(sweep[i].footerShare).toBeGreaterThan(sweep[i - 1].footerShare)
          expect(sweep[i].metadataEntries).toBeGreaterThan(sweep[i - 1].metadataEntries)
        }
        for (const p of sweep) {
          expect(p.footerShare).toBeGreaterThan(0)
          expect(p.footerShare).toBeLessThan(1)
        }
      }
    }
  })

  it('also rises with the column count and with the width of the values each entry quotes', () => {
    const at = (setId: 'narrow' | 'reference' | 'wide', keyWidth: number) =>
      footerModel({ rowGroups: 64, columnSet: setId, keyWidth }).footerShare
    expect(at('reference', 12)).toBeGreaterThan(at('narrow', 12))
    expect(at('wide', 12)).toBeGreaterThan(at('reference', 12))
    expect(at('wide', 160)).toBeGreaterThan(at('wide', 40))
    expect(at('wide', 40)).toBeGreaterThan(at('wide', 12))
  })

  it('starts as a rounding error and reaches a tenth of the file', () => {
    expect(footerModel({ rowGroups: 1, columnSet: 'narrow', keyWidth: 12 }).footerShare).toBeLessThan(
      0.001,
    )
    expect(
      footerModel({ rowGroups: 64, columnSet: 'wide', keyWidth: 12 }).footerShare,
    ).toBeGreaterThan(SHARE_TARGET)
  })

  it('has exactly one layout whose footer is larger than the data it describes', () => {
    const found = configsWhereFooterExceedsData()
    expect(found).toHaveLength(1)
    expect(configKey(found[0])).toBe('128/wide/160')
    const r = footerModel(found[0])
    expect(r.footerBytes).toBeGreaterThan(r.dataBytes)
    expect(r.footerShare).toBeGreaterThan(0.5)
  })
})

describe('footer-walk · statistics live at exactly one level', () => {
  it('names the column chunk, computed rather than asserted', () => {
    expect(statisticsLevel()).toBe('column-chunk')
    expect(LEVEL_SPECS.filter((l) => l.hasStatistics)).toHaveLength(1)
    expect(LEVEL_IDS).toEqual(['file', 'row-group', 'column-chunk', 'page'])
    expect(LEVEL_SPECS.map((l) => l.index)).toEqual([0, 1, 2, 3])
  })

  it('gives the file level no statistics at all — Parquet defines none', () => {
    const file = LEVEL_SPECS.find((l) => l.id === 'file')
    expect(file?.hasStatistics).toBe(false)
    expect(file?.unknown.join(' ')).toContain('NO file-level statistics')
  })

  it('charges the page level nothing, because the footer sees it only as offsets', () => {
    for (const c of CONFIG_GRID.slice(0, 18)) {
      const r = footerModel(c)
      const page = r.levels[3]
      expect(page.id).toBe('page')
      expect(page.bytesHere).toBe(0)
      expect(page.hasStatistics).toBe(false)
      expect(page.bytesCumulative).toBe(r.footerBytes)
      /* Every level's bytes add up to the footer, and nothing is counted twice. */
      expect(r.levels.reduce((n, l) => n + l.bytesHere, 0)).toBe(r.footerBytes)
    }
  })

  it('gives every level something known, something unknown and a decision it enables', () => {
    for (const l of LEVEL_SPECS) {
      expect(l.known.length).toBeGreaterThan(0)
      expect(l.unknown.length).toBeGreaterThan(0)
      expect(l.decisions.length).toBeGreaterThan(0)
      expect(l.physically.length).toBeGreaterThan(10)
    }
  })
})

describe('footer-walk · no NaN, no Infinity, no negative', () => {
  it('holds across the whole 54-point sweep', () => {
    for (const c of CONFIG_GRID) expectClean(footerModel(c), `footer ${configKey(c)}`)
    for (const set of COLUMN_SETS) expectClean(footerShareSweep(set.id, 160), `sweep ${set.id}`)
  })
})

/* ═══════════════════════════ the rendered page ══════════════════════ */

describe('the three labs render honestly on arrival', () => {
  /* Rendered on the server, so effects never run: this asserts the state a
   * reader ARRIVES in, including that no panel is blank and no number is
   * undefined. An undefined field would ship as a broken lab. */
  const scan = renderToString(createElement(ScanArithmeticLab, { trackColor: '#A3E635' }))
  const codec = renderToString(createElement(CodecChooserLab, { trackColor: '#FBBF24' }))
  const footer = renderToString(createElement(FooterWalkLab, { trackColor: '#22D3EE' }))

  it('renders all three without crashing', () => {
    for (const html of [scan, codec, footer]) expect(html.length).toBeGreaterThan(10_000)
    expect(scan).toContain('Scan Arithmetic')
    expect(codec).toContain('The Codec Chooser')
    expect(footer).toContain('The Footer Walk')
  })

  it('puts no NaN, no Infinity and no undefined on any of the three pages', () => {
    for (const html of [scan, codec, footer]) {
      for (const bad of ['NaN', 'Infinity', 'undefined']) expect(html).not.toContain(bad)
    }
  })

  it('states what each lab is NOT, on the page rather than in a comment', () => {
    for (const html of [scan, codec, footer]) expect(html).toContain('what this lab is not')
    expect(scan).toContain('arithmetic, not a measurement')
    expect(codec).toContain('No codec runs here')
    expect(footer).toContain('does not parse one')
  })

  it('names the 1× factor on arrival — the scan panel is never blank', () => {
    const b = scanBill(OPENING_CHOICE)
    expect(scan).toContain('at 1×: pruning')
    expect(scan).toContain(b.factors[1].headroom.toFixed(0))
  })

  it('shows the expanding dictionary and the fallback in the codec lab', () => {
    /* The expansion is named in the bound panel on arrival — the per-candidate
     * "EXPANDS" badge appears once the reader opens the column it applies to. */
    expect(codec).toContain('every codec loses and the fallback is the answer')
    expect(codec).toContain('order_id')
    expect(codec).toContain('32,776')
    expect(codec).toContain('loses by exactly 8 bytes')
  })

  it('points the footer walk at the duck lab that reads a real file', () => {
    expect(footer).toContain('parquet-anatomy')
    expect(footer).toContain('models a footer')
    /* React splits interpolated text with comment markers, so assert the
     * uninterrupted tail of the sentence. */
    expect(footer).toContain('leaf columns — exactly, in every configuration')
    /* And the measured share is quoted at a precision that does not round it away. */
    expect(footer).toContain('0.024%')
  })
})
