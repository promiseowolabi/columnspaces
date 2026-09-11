/**
 * The batch machine — model tests.
 *
 * The lab makes one claim that must be true and five that must be *reachable*.
 *
 * THE CLAIM. All three execution modes return the identical answer — on every
 * column shape, every seed, every batch size, and at every row cursor, not just
 * at the end. This is the first and largest describe block below, and it is the
 * only reason the fast paths are allowed to exist: execute-on-compressed that
 * disagreed with the reference would be a correctness bug with better
 * benchmarks, which is precisely what forge lab 03 grades as `compressed_path`.
 *
 * THE REACHABLE CLAIMS, each one a graded task in the lab, so a model that
 * quietly stopped making them possible would ship a task nobody can finish:
 *
 *   1. batching is strictly cheaper than tuple-at-a-time above a small
 *      threshold batch size — and strictly WORSE below it, which is why the
 *      dial goes down to 1
 *   2. the compressed path's work scales with RUNS, not rows: a constant column
 *      at full vector width costs O(1), and a batch size of 1 destroys it
 *   3. selection vectors compose across chained predicates without
 *      materialising anything — the second predicate narrows the same index
 *      list, and `rowCopies` stays 0
 *   4. the selection-vector-versus-copy choice genuinely goes both ways
 *   5. no count is ever NaN, negative or infinite anywhere in the space
 *
 * Everything is deterministic: seeded xorshift columns, counts only, no
 * wall-clock anywhere.
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import BatchMachineLab from '@/components/browserlabs/BatchMachineLab'
import {
  ACHIEVEMENT_KEYS,
  BATCH_CHOICES,
  COMPRESSED_TARGET,
  DEFAULT_CONFIG,
  DOWNSTREAM_CHOICES,
  MODE_IDS,
  OPS_FIELDS,
  OVERHEAD_TARGET,
  PER_BATCH_OVERHEAD,
  PIPELINE_OPERATORS,
  PREDICATE,
  ROWS,
  SHAPE_IDS,
  achievementsOf,
  bestBatchSize,
  buildColumn,
  compactionCompare,
  crossoverBatchSize,
  mergeAchievements,
  plateauBatchSize,
  referenceAnswer,
  referenceIndices,
  runAll,
  runBatch,
  runCompressed,
  runMode,
  runTuple,
  sameAnswer,
  selectionTrace,
  totalOps,
  type Achievements,
  type ColumnShapeId,
  type Config,
} from '@/lib/vector/machine'

const cfg = (patch: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...patch })

/** Every number reachable from a value, flattened, for the NaN/negative sweep. */
function numbersOf(value: unknown, path = 'root', out: [string, number][] = []): [string, number][] {
  if (typeof value === 'number') out.push([path, value])
  else if (Array.isArray(value)) value.forEach((v, i) => numbersOf(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const [k, v] of Object.entries(value)) numbersOf(v, `${path}.${k}`, out)
  }
  return out
}

/* --------------------------------- columns -------------------------------- */

describe('the column', () => {
  it('is canonical RLE: adjacent runs never share a value, and the runs tile the column', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      expect(col.rows).toBe(ROWS)
      /* Accumulated and asserted once: `random` has 130,904 runs, and one
       * expect() per run turns a model test into a two-second one. */
      let at = 0
      let gaps = 0
      let empties = 0
      let adjacentEqual = 0
      col.runs.forEach((run, i) => {
        if (run.start !== at) gaps++
        if (run.length <= 0) empties++
        if (i > 0 && run.value === col.runs[i - 1].value) adjacentEqual++
        at += run.length
      })
      expect({ shape, gaps, empties, adjacentEqual, covered: at }).toEqual({
        shape,
        gaps: 0,
        empties: 0,
        adjacentEqual: 0,
        covered: ROWS,
      })
    }
  })

  it('gives each shape the run count its name promises', () => {
    expect(buildColumn('constant').runs).toHaveLength(1)
    /* random: a fresh value nearly every row, so RLE has nothing to hold. */
    expect(buildColumn('random').runs.length).toBeGreaterThan(ROWS * 0.9)
    /* clustered: long stretches — two orders of magnitude fewer runs than rows. */
    expect(buildColumn('clustered').runs.length).toBeLessThan(ROWS / 50)
    expect(buildColumn('clustered').runs.length).toBeGreaterThan(4)
  })

  it('is seeded, not random: same seed identical, different seed different', () => {
    const a = buildColumn('random', 4242)
    const b = buildColumn('random', 4242)
    const c = buildColumn('random', 99)
    expect(Array.from(a.values.slice(0, 64))).toEqual(Array.from(b.values.slice(0, 64)))
    expect(Array.from(a.values.slice(0, 64))).not.toEqual(Array.from(c.values.slice(0, 64)))
    expect(referenceAnswer(a)).toEqual(referenceAnswer(b))
    expect(referenceAnswer(a)).not.toEqual(referenceAnswer(c))
  })

  it('carries a null prefix that answers "is this batch all-valid" in O(1)', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      let nulls = 0
      let wrong = 0
      for (let i = 0; i < ROWS; i++) {
        if (col.nullPrefix[i] !== nulls) wrong++
        nulls += col.nulls[i]
      }
      expect({ shape, wrong, end: col.nullPrefix[ROWS], count: col.nullCount }).toEqual({
        shape,
        wrong: 0,
        end: nulls,
        count: nulls,
      })
    }
  })

  it('puts the constant column inside the predicate range, so the fast path is not free by accident', () => {
    const col = buildColumn('constant')
    const only = col.runs[0].value
    expect(only).not.toBeNull()
    expect(only as number).toBeGreaterThanOrEqual(PREDICATE.lo)
    expect(only as number).toBeLessThanOrEqual(PREDICATE.hi)
    expect(referenceAnswer(col).matched).toBe(ROWS)
  })
})

/* ------------------------------- equivalence ------------------------------ */

describe('equivalence — the claim that makes the fast path safe rather than clever', () => {
  it('returns the identical answer in all three modes, on every shape and every batch size', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      const reference = referenceAnswer(col)
      for (const batchSize of BATCH_CHOICES) {
        const set = runAll(cfg({ shape, batchSize }))
        expect(set.agree).toBe(true)
        for (const mode of MODE_IDS) {
          const answer = set.reports[mode].answer
          expect(sameAnswer(answer, reference)).toBe(true)
          expect(answer.matched).toBe(reference.matched)
          expect(answer.sum).toBe(reference.sum)
        }
      }
    }
  })

  it('agrees at every row cursor, not only at the end — which is what lets the lab step them together', () => {
    const cursors = [0, 1, 7, 63, 64, 65, 999, 2_048, 65_537, ROWS - 1, ROWS]
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      for (const batchSize of [1, 64, 2_048, ROWS]) {
        for (const rows of cursors) {
          const reference = referenceAnswer(col, rows)
          for (const mode of MODE_IDS) {
            const r = runMode(mode, col, cfg({ shape, batchSize }), rows)
            expect(r.rowsProcessed).toBe(Math.min(rows, ROWS))
            expect(r.answer).toEqual(reference)
          }
        }
      }
    }
  })

  it('agrees across seeds, so the equivalence is not a property of one column', () => {
    for (const seed of [1, 2, 3, 20260911, 987_654_321]) {
      for (const shape of SHAPE_IDS) {
        const set = runAll(cfg({ shape, seed, batchSize: 256 }))
        expect(set.agree).toBe(true)
        expect(set.reports.tuple.answer).toEqual(set.reference)
        expect(set.reports.compressed.answer).toEqual(set.reports.batch.answer)
      }
    }
  })

  it('is unaffected by the knobs that only change the bill', () => {
    for (const shape of SHAPE_IDS) {
      const reference = referenceAnswer(buildColumn(shape))
      for (const downstream of DOWNSTREAM_CHOICES) {
        for (const compact of [false, true]) {
          const set = runAll(cfg({ shape, downstream, compact, batchSize: 1_024 }))
          expect(set.agree).toBe(true)
          expect(set.reports.batch.answer).toEqual(reference)
        }
      }
    }
  })

  it('sums exactly — integer values, so no mode wins or loses a rounding error', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      const sum = referenceAnswer(col).sum
      expect(Number.isInteger(sum)).toBe(true)
      expect(runCompressed(col, cfg({ shape, batchSize: ROWS })).answer.sum).toBe(sum)
      expect(runTuple(col, cfg({ shape })).answer.sum).toBe(sum)
    }
  })
})

/* ------------------------------ amortisation ------------------------------ */

describe('batching amortises per-tuple overhead — above a threshold, and not below it', () => {
  it('charges per-operator overhead per row in tuple mode and per batch in batched mode', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      expect(runTuple(col, cfg({ shape })).ops.virtualCalls).toBe(PIPELINE_OPERATORS * ROWS)
      for (const batchSize of BATCH_CHOICES) {
        const r = runBatch(col, cfg({ shape, batchSize }))
        expect(r.batches).toBe(Math.ceil(ROWS / batchSize))
        expect(r.ops.virtualCalls).toBe(PIPELINE_OPERATORS * r.batches)
        expect(r.batchOverhead).toBe(PER_BATCH_OVERHEAD * r.batches)
      }
    }
  })

  it('is strictly cheaper than tuple-at-a-time above the crossover, and strictly worse at a batch of 1', () => {
    const fine = [1, 2, 4, 8, 16, 64, 256, 1_024, 2_048, 8_192, 32_768, ROWS]
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      const tuple = runTuple(col, cfg({ shape })).total
      const crossover = crossoverBatchSize(cfg({ shape }), fine)
      expect(crossover).not.toBeNull()
      expect(crossover as number).toBeLessThanOrEqual(8)

      /* A batch of one row is a volcano engine carrying paperwork. */
      expect(runBatch(col, cfg({ shape, batchSize: 1 })).total).toBeGreaterThan(tuple)

      for (const batchSize of fine.filter((b) => b >= (crossover as number))) {
        expect(runBatch(col, cfg({ shape, batchSize })).total).toBeLessThan(tuple)
      }
      /* And the offered dial: every choice from 8 upwards wins. */
      for (const batchSize of BATCH_CHOICES.filter((b) => b >= 8)) {
        expect(runBatch(col, cfg({ shape, batchSize })).total).toBeLessThan(tuple)
      }
    }
  })

  it('shrinks the per-batch overhead share monotonically, and reaches the lab target', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      const shares = BATCH_CHOICES.map((batchSize) =>
        runBatch(col, cfg({ shape, batchSize })).overheadShare,
      )
      for (let i = 1; i < shares.length; i++) expect(shares[i]).toBeLessThan(shares[i - 1])
      expect(shares[shares.length - 1]).toBeLessThan(OVERHEAD_TARGET)
      expect(plateauBatchSize(cfg({ shape }))).toBeLessThanOrEqual(ROWS)
    }
  })

  it('drops the branch per row: batched mode branches per batch, tuple mode per row', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      const t = runTuple(col, cfg({ shape }))
      const b = runBatch(col, cfg({ shape, batchSize: 2_048 }))
      expect(t.ops.branches).toBeGreaterThanOrEqual(ROWS)
      expect(b.ops.branches).toBe(PIPELINE_OPERATORS * b.batches)
      expect(b.ops.branches).toBeLessThan(t.ops.branches / 50)
    }
  })

  it('does not pretend a bigger batch is always better — the minimising size is not always the largest', () => {
    const bests = SHAPE_IDS.map((shape) => bestBatchSize(cfg({ shape })))
    /* The graded pick asks for this on two shapes with different answers, so at
     * least two distinct answers must exist in the space. */
    expect(new Set(bests).size).toBeGreaterThanOrEqual(2)
    /* On a column with nulls spread evenly, a wider vector loses the
     * one-check-per-vector validity shortcut, so the widest is NOT best. */
    expect(bestBatchSize(cfg({ shape: 'random' }))).toBeLessThan(ROWS)
    /* On a column with no nulls at all, nothing pulls the other way. */
    expect(buildColumn('constant').nullCount).toBe(0)
    expect(bestBatchSize(cfg({ shape: 'constant' }))).toBe(ROWS)
  })
})

/* -------------------------- execute-on-compressed ------------------------- */

describe('the compressed path does work proportional to runs, not rows', () => {
  it('costs O(1) on a constant column at full vector width', () => {
    const col = buildColumn('constant')
    const r = runCompressed(col, cfg({ shape: 'constant', batchSize: ROWS }))
    expect(col.runs).toHaveLength(1)
    expect(r.fragments).toBe(1)
    /* One run, one batch: a fixed handful of operations for 131,072 rows. */
    expect(r.total).toBeLessThan(32)
    expect(r.perRow).toBeLessThan(COMPRESSED_TARGET)
    expect(r.answer).toEqual(referenceAnswer(col))
  })

  it('scales with fragments across every shape and batch size, and never with rows', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      for (const batchSize of BATCH_CHOICES) {
        const r = runCompressed(col, cfg({ shape, batchSize }))
        const batches = Math.ceil(ROWS / batchSize)
        /* A fragment is a run clipped at a vector boundary, so the count sits
         * between the two partitions and below their sum. */
        expect(r.fragments).toBeGreaterThanOrEqual(Math.max(col.runs.length, batches))
        expect(r.fragments).toBeLessThanOrEqual(col.runs.length + batches - 1)
        /* Per fragment the charge is a small constant — that is the claim. */
        expect(r.total).toBeLessThanOrEqual(r.fragments * 16)
      }
    }
  })

  it('beats the batched path by orders of magnitude on a clustered column', () => {
    const c = cfg({ shape: 'clustered', batchSize: ROWS })
    const col = buildColumn('clustered')
    const compressed = runCompressed(col, c).total
    const batched = runBatch(col, c).total
    expect(compressed).toBeLessThan(batched / 100)
    expect(compressed).toBeLessThan(col.runs.length * 16)
  })

  it('has no win to offer on a random column, and the model does not invent one', () => {
    const c = cfg({ shape: 'random', batchSize: 2_048 })
    const col = buildColumn('random')
    const compressed = runCompressed(col, c).total
    const batched = runBatch(col, c).total
    /* runs ≈ rows, so the fast path degenerates to per-row work. Within a few
     * percent either way — a wash, which is what the lab says on screen. */
    expect(compressed).toBeGreaterThan(batched * 0.9)
    expect(compressed).toBeLessThan(batched * 1.1)
  })

  it('is destroyed by a batch size of 1, because a run cannot cross a vector boundary intact', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      const r = runCompressed(col, cfg({ shape, batchSize: 1 }))
      expect(r.fragments).toBe(ROWS)
      expect(r.total).toBeGreaterThan(runTuple(col, cfg({ shape })).total)
      expect(r.answer).toEqual(referenceAnswer(col))
    }
  })

  it('reaches the lab target only where runs are genuinely scarce', () => {
    expect(
      runCompressed(buildColumn('constant'), cfg({ shape: 'constant', batchSize: ROWS })).perRow,
    ).toBeLessThan(COMPRESSED_TARGET)
    expect(
      runCompressed(buildColumn('random'), cfg({ shape: 'random', batchSize: ROWS })).perRow,
    ).toBeGreaterThan(COMPRESSED_TARGET)
  })
})

/* ---------------------------- selection vectors --------------------------- */

describe('selection vectors compose across chained predicates without materialising', () => {
  it('narrows the same index list: the second predicate keeps a subsequence of the first', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      const reference = referenceIndices(col)
      for (const batchSize of [1, 64, 2_048, ROWS]) {
        const t = selectionTrace(col, batchSize)
        expect(t.copies).toBe(0)
        expect(t.buffers).toBe(Math.ceil(ROWS / batchSize))

        /* A subsequence, in row order, with no duplicates — accumulated and
         * asserted once, because these lists hold tens of thousands of rows. */
        let k = 0
        let notASubsequence = 0
        let outOfOrder = 0
        let mismatched = 0
        t.afterSecond.forEach((i, n) => {
          while (k < t.afterFirst.length && t.afterFirst[k] !== i) k++
          if (k >= t.afterFirst.length) notASubsequence++
          k++
          if (n > 0 && i <= t.afterSecond[n - 1]) outOfOrder++
          /* and it is exactly the answer, not merely a plausible subset */
          if (i !== reference[n]) mismatched++
        })
        expect({ shape, batchSize, notASubsequence, outOfOrder, mismatched }).toEqual({
          shape,
          batchSize,
          notASubsequence: 0,
          outOfOrder: 0,
          mismatched: 0,
        })
        expect(t.afterSecond).toHaveLength(reference.length)
        expect(t.afterFirst.length).toBeGreaterThanOrEqual(t.afterSecond.length)
      }
    }
  })

  it('evaluates the second predicate only over survivors of the first', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      const t = selectionTrace(col, 2_048)
      const r = runBatch(col, cfg({ shape, batchSize: 2_048 }))
      /* one comparison per row for predicate 1, plus one per survivor for
       * predicate 2 — never two per row */
      expect(r.ops.predicateEvals).toBe(ROWS + t.afterFirst.length)
      expect(r.ops.selectionWrites).toBe(t.afterFirst.length + t.afterSecond.length)
    }
  })

  it('copies nothing while addressing, and copies exactly the survivors when told to compact', () => {
    for (const shape of SHAPE_IDS) {
      const col = buildColumn(shape)
      const matched = referenceAnswer(col).matched
      const addressed = runBatch(col, cfg({ shape, batchSize: 2_048, compact: false }))
      const copied = runBatch(col, cfg({ shape, batchSize: 2_048, compact: true }))
      expect(addressed.ops.rowCopies).toBe(0)
      expect(copied.ops.rowCopies).toBe(matched)
      expect(addressed.answer).toEqual(copied.answer)
      /* tuple mode has to materialise every surviving tuple — that is the copy
       * the selection vector removes */
      expect(runTuple(col, cfg({ shape })).ops.rowCopies).toBe(matched)
    }
  })

  it('makes the address-versus-copy choice a real tradeoff, decided by consumer count', () => {
    for (const shape of SHAPE_IDS) {
      /* one consumer: the indirection is paid once, so addressing wins */
      expect(compactionCompare(cfg({ shape, batchSize: 2_048, downstream: 1 })).winner).toBe(
        'selection',
      )
      /* four consumers: the indirection is paid four times, so the copy amortises */
      expect(compactionCompare(cfg({ shape, batchSize: 2_048, downstream: 4 })).winner).toBe(
        'compaction',
      )
    }
  })

  it('keeps one selection buffer per batch, not one per surviving row', () => {
    const col = buildColumn('random')
    const r = runBatch(col, cfg({ shape: 'random', batchSize: 2_048, compact: false }))
    expect(r.ops.allocations).toBe(r.batches)
    expect(r.ops.allocations).toBeLessThan(referenceAnswer(col).matched)
  })
})

/* --------------------------------- grading -------------------------------- */

describe('every graded task is reachable', () => {
  it('has a configuration in the offered space for each achievement', () => {
    const probes: Config[] = [
      cfg({ shape: 'random', batchSize: 1, downstream: 1 }),
      cfg({ shape: 'random', batchSize: 64, downstream: 1 }),
      cfg({ shape: 'clustered', batchSize: 2_048, downstream: 4 }),
      cfg({ shape: 'constant', batchSize: ROWS, downstream: 1 }),
    ]
    const reached = probes
      .map(achievementsOf)
      .reduce((a, b) => mergeAchievements(a, b), {
        agreed: false,
        overheadAmortised: false,
        batchLost: false,
        compressedTiny: false,
        selectionWon: false,
        compactionWon: false,
      } as Achievements)
    for (const key of ACHIEVEMENT_KEYS) expect(reached[key], key).toBe(true)
  })

  it('agrees on every configuration it grades — the equivalence is never conditional', () => {
    for (const shape of SHAPE_IDS) {
      for (const batchSize of BATCH_CHOICES) {
        expect(achievementsOf(cfg({ shape, batchSize })).agreed).toBe(true)
      }
    }
  })

  it('lets the graded batch-size pick have a different answer on two shapes', () => {
    const answers = SHAPE_IDS.map((shape) => bestBatchSize(cfg({ shape })))
    expect(new Set(answers).size).toBeGreaterThanOrEqual(2)
  })
})

/* ---------------------------- the honesty sweep --------------------------- */

describe('no count is ever NaN, negative or infinite', () => {
  it('holds across shapes, batch sizes, consumer counts and both survivor strategies', () => {
    const shapes: ColumnShapeId[] = SHAPE_IDS
    let checked = 0
    shapes.forEach((shape, si) => {
      BATCH_CHOICES.forEach((batchSize, bi) => {
        /* Cycle the two secondary knobs rather than crossing them: the full
         * product would be 108 passes over 131,072 rows for no extra coverage. */
        const downstream = DOWNSTREAM_CHOICES[(si + bi) % DOWNSTREAM_CHOICES.length]
        const compact = (si + bi) % 2 === 0
        const set = runAll(cfg({ shape, batchSize, downstream, compact }))
        for (const mode of MODE_IDS) {
          const r = set.reports[mode]
          for (const [path, n] of numbersOf({
            total: r.total,
            perRow: r.perRow,
            batches: r.batches,
            fragments: r.fragments,
            units: r.units,
            batchOverhead: r.batchOverhead,
            overheadShare: r.overheadShare,
            answer: r.answer,
            ops: r.ops,
          })) {
            expect(Number.isFinite(n), `${mode} ${path}`).toBe(true)
            expect(n, `${mode} ${path}`).toBeGreaterThanOrEqual(0)
            checked++
          }
          expect(totalOps(r.ops)).toBe(r.total)
          expect(OPS_FIELDS.every((f) => Number.isInteger(r.ops[f]))).toBe(true)
        }
      })
    })
    expect(checked).toBeGreaterThan(1_000)
  })

  it('degrades gracefully at the empty prefix instead of dividing by zero', () => {
    for (const shape of SHAPE_IDS) {
      const set = runAll(cfg({ shape }), 0)
      expect(set.agree).toBe(true)
      for (const mode of MODE_IDS) {
        const r = set.reports[mode]
        expect(r.total).toBe(0)
        expect(r.perRow).toBe(0)
        expect(r.overheadShare).toBe(0)
        expect(r.answer).toEqual({ matched: 0, sum: 0 })
      }
    }
  })
})

/* -------------------------------- the page -------------------------------- */

describe('the lab page', () => {
  /* A render, not a snapshot, following the pattern the other browser-lab tests
   * use: `tsc` cannot catch a formatter that divides by an undefined field, and
   * that would ship as a blank lab. Rendered on the server, so effects never
   * run — this asserts the state a reader ARRIVES in. */
  const html = renderToString(createElement(BatchMachineLab, { trackColor: '#22D3EE' }))

  it('renders the opening configuration without crashing', () => {
    expect(html.length).toBeGreaterThan(8_000)
    expect(html).toContain('The Batch Machine')
  })

  it('puts no NaN, no Infinity and no undefined on the page', () => {
    for (const bad of ['NaN', 'Infinity', 'undefined']) expect(html).not.toContain(bad)
  })

  it('shows all three modes and their counts on arrival', () => {
    for (const mode of MODE_IDS) {
      const set = runAll(DEFAULT_CONFIG)
      expect(html).toContain(set.reports[mode].total.toLocaleString('en-US'))
    }
    expect(html).toContain('tuple-at-a-time')
    expect(html).toContain('batch + selection vector')
    expect(html).toContain('execute-on-compressed')
  })

  it('states the equivalence, and the reference answer it is checked against', () => {
    const set = runAll(DEFAULT_CONFIG)
    expect(html).toContain('three modes, one answer')
    expect(html).toContain(set.reference.matched.toLocaleString('en-US'))
    expect(html).toContain(set.reference.sum.toLocaleString('en-US'))
  })

  it('says plainly what a count cannot tell you — no clock, and no overclaim', () => {
    expect(html).toContain('what this lab is not')
    expect(html).toContain('modelled counts, not measurements')
    expect(html.toLowerCase()).toContain('simulates')
    expect(html).toContain('SIMD')
    /* Nothing on the page may quote a time. Cost is a count, never a clock. */
    expect(html).not.toMatch(/\d+\s?(ms|µs|us|ns|sec|s\/row)\b/i)
    for (const clock of ['millisecond', 'microsecond', 'nanosecond', 'throughput', 'latency']) {
      expect(html.toLowerCase()).not.toContain(clock)
    }
  })
})
