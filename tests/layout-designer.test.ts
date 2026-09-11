/**
 * The layout designer — model tests.
 *
 * The lab's whole claim is structural: EVERY layout has a query class it is bad
 * at, because a table has one physical order. A lab that merely *said* that
 * would be a paragraph; these tests are what make it a property of the model,
 * so it cannot quietly stop being true.
 *
 * The five claims, each one something a lesson asserts in prose:
 *
 *   1. DETERMINISM. Same three choices, same counts, twice — and the same
 *      queries whether the traces are priced in one order or another.
 *   2. A STRICTLY WORST CLASS EXISTS, for all 120 designs. The UI names the
 *      starved class unconditionally, so "there isn't one" must be impossible,
 *      and a tie would make the graded naming task unanswerable.
 *   3. THE STARVED CLASS MOVES. Several different classes are worst somewhere,
 *      which is what makes it a property of the design rather than of the
 *      workload.
 *   4. NO FREE WIN. The design that minimises the dashboard bill is not
 *      simultaneously the best for the ad-hoc or the needle class, and no
 *      design in the space is best for every class at once.
 *   5. NO METRIC IS EVER NaN OR NEGATIVE, across the whole design space. One
 *      NaN on the page discredits every number beside it.
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LayoutDesignerLab from '@/components/browserlabs/LayoutDesignerLab'
import {
  CLASS_IDS,
  DESIGN_GRID,
  GROUPS_PER_FILE,
  OPENING_DESIGN,
  PARTITION_CHOICES,
  ROW_GROUP_CHOICES,
  SORT_KEY_CHOICES,
  TARGETS,
  bestBytesFor,
  bestDesignFor,
  classCost,
  costMix,
  designKey,
  fileRowsFor,
  meetsTargets,
  queryClass,
  quotaClassId,
  solvingDesigns,
  toLayout,
  traceFor,
  worstServed,
  type Design,
  type QueryClassId,
} from '@/lib/layout/mix'
import { REFERENCE_LAYOUT } from '@/lib/warehouse/engine'
import { scansOf, writesOf } from '@/lib/warehouse/trace'

/** Every number reachable from a value, flattened, for the NaN/negative sweep. */
function numbersOf(value: unknown, path = 'root', out: [string, number][] = []): [string, number][] {
  if (typeof value === 'number') out.push([path, value])
  else if (Array.isArray(value)) value.forEach((v, i) => numbersOf(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) numbersOf(v, `${path}.${k}`, out)
  }
  return out
}

const bytesOf = (d: Design, id: QueryClassId): number => classCost(costMix(d), id).bytesScanned

describe('the design space', () => {
  it('is the product of the three knobs, and nothing else', () => {
    expect(DESIGN_GRID).toHaveLength(
      PARTITION_CHOICES.length * SORT_KEY_CHOICES.length * ROW_GROUP_CHOICES.length,
    )
    expect(new Set(DESIGN_GRID.map(designKey)).size).toBe(DESIGN_GRID.length)
  })

  it('opens on a design inside the space', () => {
    expect(DESIGN_GRID.map(designKey)).toContain(designKey(OPENING_DESIGN))
  })

  it('changes only the three knobs the reader is given', () => {
    /* Encodings, clustering and the compaction policy are deliberately pinned:
     * this lab is about physical order, and a reader who could also change
     * clustering could "fix" a starved class with a dial that in production
     * belongs to whoever writes the table. */
    for (const d of DESIGN_GRID.slice(0, 12)) {
      const l = toLayout(d)
      expect(l.clustering).toBe(REFERENCE_LAYOUT.clustering)
      expect(l.compactEvery).toBe(REFERENCE_LAYOUT.compactEvery)
      expect(l.encodings).toEqual(REFERENCE_LAYOUT.encodings)
      expect(l.fileRows).toBe(d.rowGroupRows * GROUPS_PER_FILE)
      expect(fileRowsFor(d.rowGroupRows)).toBe(l.fileRows)
    }
  })

  it('prices five classes, all of them reads', () => {
    expect(CLASS_IDS).toHaveLength(5)
    for (const id of CLASS_IDS) {
      const t = traceFor(id)
      expect(writesOf(t)).toHaveLength(0)
      expect(scansOf(t).length).toBeGreaterThan(0)
      for (const q of scansOf(t)) expect(q.columns.length).toBeGreaterThan(0)
    }
  })
})

describe('determinism', () => {
  it('the same design produces identical costs, twice', () => {
    for (const d of [OPENING_DESIGN, ...DESIGN_GRID.slice(0, 8)]) {
      expect(costMix({ ...d })).toEqual(costMix({ ...d }))
    }
  })

  it('a design rebuilt from its parts prices the same as the original object', () => {
    const rebuilt: Design = {
      partitionKey: OPENING_DESIGN.partitionKey,
      sortKey: OPENING_DESIGN.sortKey,
      rowGroupRows: OPENING_DESIGN.rowGroupRows,
    }
    expect(costMix(rebuilt).classes).toEqual(costMix(OPENING_DESIGN).classes)
  })

  it('the traces are fixed: the experiment is controlled across every design', () => {
    /* Two designs must be priced against byte-identical queries, or the
     * comparison the lab is built on means nothing. */
    for (const id of CLASS_IDS) expect(traceFor(id)).toBe(traceFor(id))
    const a = DESIGN_GRID[0]
    const b = DESIGN_GRID[DESIGN_GRID.length - 1]
    expect(designKey(a)).not.toBe(designKey(b))
    for (const id of CLASS_IDS) expect(traceFor(id).queries).toEqual(traceFor(id).queries)
  })

  it('pricing order does not matter — no design leaks state into the next', () => {
    const forward = DESIGN_GRID.slice(0, 20).map((d) => costMix(d).totalBytes)
    const backward = DESIGN_GRID.slice(0, 20)
      .reverse()
      .map((d) => costMix(d).totalBytes)
      .reverse()
    expect(backward).toEqual(forward)
  })
})

describe('every design starves something, and strictly', () => {
  it('names a single worst-served class for all 120 designs', () => {
    for (const d of DESIGN_GRID) {
      const mix = costMix(d)
      expect(CLASS_IDS).toContain(mix.worst.id)
      expect(mix.worst.id).not.toBe(mix.runnerUp.id)
      /* Strictly worst: a tie would make the graded "name the class you starve"
       * task unanswerable, since two answers would both be right. */
      expect(
        mix.worst.starvation,
        `${designKey(d)}: ${mix.worst.id} vs ${mix.runnerUp.id}`,
      ).toBeGreaterThan(mix.runnerUp.starvation)
      expect(worstServed(d).id).toBe(mix.worst.id)
    }
  })

  it('the worst class is genuinely starved — never within 25% of its own best', () => {
    for (const d of DESIGN_GRID) {
      expect(costMix(d).worst.starvation, designKey(d)).toBeGreaterThan(1.25)
    }
  })

  it('starvation is a ratio against the best achievable, so no class can beat 1.0', () => {
    for (const d of DESIGN_GRID) {
      for (const c of costMix(d).classes) {
        expect(c.starvation, `${designKey(d)} ${c.id}`).toBeGreaterThanOrEqual(1)
        expect(c.bytesScanned).toBeGreaterThanOrEqual(c.bestBytes)
      }
    }
  })

  it('and every class attains 1.0 somewhere: the denominators are reachable', () => {
    for (const id of CLASS_IDS) {
      const d = bestDesignFor(id)
      expect(bytesOf(d, id)).toBe(bestBytesFor(id))
      expect(classCost(costMix(d), id).starvation).toBeCloseTo(1, 10)
    }
  })

  it('the starved class MOVES with the design — it is not a property of the workload', () => {
    const worstIds = new Set(DESIGN_GRID.map((d) => costMix(d).worst.id))
    expect(worstIds.size).toBeGreaterThanOrEqual(3)
    /* Including the class the reader came to protect: the dashboard can be
     * starved too, and one graded task requires the reader to do it. */
    expect(worstIds.has('dashboard')).toBe(true)
    expect(worstIds.has('tenant-audit')).toBe(true)
  })
})

describe('one physical order: there is no free win', () => {
  it('clustering on the dashboard predicate is not simultaneously optimal for adhoc', () => {
    const forDashboard = bestDesignFor('dashboard')
    expect(bytesOf(forDashboard, 'dashboard')).toBe(bestBytesFor('dashboard'))
    expect(bytesOf(forDashboard, 'adhoc')).toBeGreaterThan(bestBytesFor('adhoc'))
    /* And it does far worse than "slightly worse" on the needle, whose only
     * hope was a sort key the dashboard cannot spare. */
    expect(bytesOf(forDashboard, 'needle')).toBeGreaterThan(bestBytesFor('needle') * 5)
  })

  it('no design in the space is best for every class at once', () => {
    for (const d of DESIGN_GRID) {
      const optimalFor = CLASS_IDS.filter((id) => bytesOf(d, id) === bestBytesFor(id))
      expect(optimalFor.length, designKey(d)).toBeLessThan(CLASS_IDS.length)
    }
  })

  it('the sort key is the scarce resource: giving it to the needle costs the dashboard', () => {
    const forNeedle = bestDesignFor('needle')
    expect(forNeedle.sortKey).toBe('user_id')
    expect(bytesOf(forNeedle, 'dashboard')).toBeGreaterThan(bestBytesFor('dashboard'))
  })

  it('the partition key is scarce too: the audit and the dashboard want different ones', () => {
    expect(bestDesignFor('tenant-audit').partitionKey).toBe('tenant')
    expect(bestDesignFor('region-rollup').partitionKey).toBe('region')
    expect(bytesOf(bestDesignFor('region-rollup'), 'dashboard')).toBeGreaterThan(
      bestBytesFor('dashboard') * 10,
    )
  })

  it('the class needing a quota is computed, and it is the analyst', () => {
    /* Not an opinion: it is the class whose BEST case over the whole space is
     * still the largest bill in the mix, which is exactly C0.L5's argument for
     * bounding a workload rather than forecasting it. */
    const quota = quotaClassId()
    expect(quota).toBe('adhoc')
    for (const id of CLASS_IDS) {
      if (id !== quota) expect(bestBytesFor(id)).toBeLessThan(bestBytesFor(quota))
    }
    expect(queryClass(quota).wants).toMatch(/quota/)
  })
})

describe('the graded tradeoff is a tradeoff, not a free win', () => {
  const solutions = solvingDesigns()

  it('is satisfiable — but by few designs', () => {
    expect(solutions.length).toBeGreaterThan(0)
    expect(solutions.length).toBeLessThan(DESIGN_GRID.length / 10)
  })

  it('is not already satisfied by the opening design', () => {
    const opening = meetsTargets(OPENING_DESIGN)
    expect(opening.ok).toBe(false)
    /* Specifically: the dashboard target is already met, and the ceiling is
     * not. The reader has to protect the class they starved, not speed up the
     * one they like. */
    expect(opening.dashboardOk).toBe(true)
    expect(opening.starvedOk).toBe(false)
  })

  it('cannot be met by minimising the dashboard bill alone', () => {
    const greedy = meetsTargets(bestDesignFor('dashboard'))
    expect(greedy.dashboardOk).toBe(true)
    expect(greedy.starvedOk).toBe(false)
    expect(greedy.ok).toBe(false)
    /* By more than an order of magnitude, so this is not a near miss the reader
     * could argue their way out of. */
    expect(greedy.starvedBytes).toBeGreaterThan(TARGETS.starvedCeiling * 10)
  })

  it('cannot be met by minimising the worst class alone either', () => {
    const kindest = [...DESIGN_GRID].sort(
      (a, b) => costMix(a).worst.bytesScanned - costMix(b).worst.bytesScanned,
    )[0]
    const r = meetsTargets(kindest)
    expect(r.starvedOk).toBe(true)
    expect(r.dashboardOk).toBe(false)
    expect(r.ok).toBe(false)
  })

  it('every solution pays for the ceiling in dashboard bytes', () => {
    for (const d of solutions) {
      const r = meetsTargets(d)
      expect(r.ok).toBe(true)
      /* At least 3× off the dashboard's own optimum: the price of not
       * abandoning the starved class. */
      expect(bytesOf(d, 'dashboard')).toBeGreaterThan(bestBytesFor('dashboard') * 3)
    }
  })

  it('grades on counts alone, with no clock anywhere in the report', () => {
    const mix = costMix(OPENING_DESIGN)
    const keys = new Set(Object.keys(mix.classes[0]))
    for (const forbidden of ['ms', 'seconds', 'latency', 'elapsed', 'duration', 'time']) {
      expect(keys.has(forbidden)).toBe(false)
    }
  })
})

describe('no metric is ever NaN or negative', () => {
  it(`survives all ${DESIGN_GRID.length} designs with finite, non-negative counts`, () => {
    for (const d of DESIGN_GRID) {
      const mix = costMix(d)
      for (const [path, n] of numbersOf(mix)) {
        expect(Number.isFinite(n), `${designKey(d)} ${path} = ${n}`).toBe(true)
        expect(n, `${designKey(d)} ${path} = ${n}`).toBeGreaterThanOrEqual(0)
      }
      for (const c of mix.classes) {
        expect(c.pruningRatio).toBeGreaterThanOrEqual(0)
        expect(c.pruningRatio).toBeLessThanOrEqual(1)
        expect(c.bytesScanned).toBeGreaterThan(0)
        expect(c.metadataBytes).toBeGreaterThan(0)
        expect(c.filesTouched).toBeGreaterThan(0)
      }
      expect(mix.totalBytes).toBeCloseTo(
        mix.classes.reduce((n, c) => n + c.bytesScanned, 0),
        6,
      )
    }
  })

  it('the metadata tax is real: the smallest row group opens the most footers', () => {
    /* Not a NaN check but the same family of invariant — the row-group knob has
     * to cut both ways, or the lab would offer "smaller is always better". */
    const fine = { ...OPENING_DESIGN, rowGroupRows: ROW_GROUP_CHOICES[0] }
    const coarse = { ...OPENING_DESIGN, rowGroupRows: ROW_GROUP_CHOICES[ROW_GROUP_CHOICES.length - 1] }
    expect(classCost(costMix(fine), 'dashboard').filesTouched).toBeGreaterThan(
      classCost(costMix(coarse), 'dashboard').filesTouched,
    )
    expect(classCost(costMix(fine), 'dashboard').metadataBytes).toBeGreaterThan(
      classCost(costMix(coarse), 'dashboard').metadataBytes,
    )
  })
})

describe('first paint', () => {
  /**
   * A render, not a snapshot, following the pattern `tests/warehouse.test.ts`
   * uses for the Warehouse page. `tsc` cannot catch a formatter that divides by
   * an undefined field, and that would ship as a blank lab. Rendered on the
   * server, so effects never run: this asserts the state a reader ARRIVES in is
   * honest, including that the starved-class panel is already populated.
   */
  const html = renderToString(createElement(LayoutDesignerLab, { trackColor: '#A3E635' }))

  it('renders the opening design without crashing', () => {
    expect(html.length).toBeGreaterThan(10_000)
    expect(html).toContain('The Layout Designer')
  })

  it('puts no NaN, no Infinity and no undefined on the page', () => {
    for (const bad of ['NaN', 'Infinity', 'undefined']) expect(html).not.toContain(bad)
  })

  it('names the starved class on arrival — the panel is never blank', () => {
    const worst = costMix(OPENING_DESIGN).worst
    expect(html).toContain('this design starves')
    expect(html).toContain(worst.name)
    /* The ratio and its × land in separate text nodes, so assert the number. */
    expect(html).toContain(worst.starvation.toFixed(2))
    expect(html).toContain('starved')
  })

  it('prices all five classes and asks both graded questions', () => {
    for (const id of CLASS_IDS) expect(html).toContain(queryClass(id).name)
    expect(html).toContain('Which class does the design above starve?')
    expect(html).toContain('needs a quota')
    for (const label of ['bytes / pass', 'pruned', 'starvation', 'best possible']) {
      expect(html).toContain(label)
    }
  })

  it('states the tradeoff targets it grades, as counts', () => {
    expect(html).toContain('the scan-bill task')
    expect(html).toContain('128.0 MiB')
    expect(html).toContain('5.00 GiB')
  })
})
