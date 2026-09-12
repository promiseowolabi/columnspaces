/**
 * desks.test.ts — contract tests for the five architecture-half desk models
 * (scan, layout, ingest, tenancy, compaction).
 *
 * ── What is actually under test ────────────────────────────────────────────
 * The production modules, imported and executed. Nothing is re-implemented
 * here: every reference figure comes from calling the model itself, and every
 * claimed figure in a "correct submission" is derived from that call. A test
 * that restated the arithmetic would pass while the model was wrong, which is
 * the failure mode these files exist to prevent.
 *
 * ── Six claims per desk, graded three different ways ───────────────────────
 *
 *   THE CONTRACT is an absolute. `DESKS[i].checks` in the registry is what the
 *   lessons are written against, so a report whose check ids drift — even in
 *   ORDER — silently breaks the promise a lesson made to a reader. Asserted as
 *   exact deep equality, never as a set.
 *
 *   DISCIPLINE CHECKS are absolutes too, and asserted on their MESSAGES. It is
 *   not enough that an omission fails; the failure must name the omitted term,
 *   because the message is the whole teaching surface. Every discipline test
 *   here keeps the point estimate perfect and removes only a term, which is the
 *   case the desks are built to catch.
 *
 *   NUMERIC CHECKS are bands, tested as a pair: a figure inside tolerance
 *   passes and a figure outside it fails, on the same submission. A single
 *   assertion in either direction would pass against a check that always
 *   returned the same verdict.
 *
 * Plus two invariants across all five: the models are pure and deterministic,
 * and no output is NaN, Infinity or spuriously negative anywhere in a parameter
 * sweep. And one project-wide rule, enforced by reading the sources: NO PRICES.
 * A desk emits counts; the caller multiplies by a rate this course never knows.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DESKS, allPassed } from '@/lib/desks'
import type { Check, DeskReport } from '@/lib/desks/kit'
import { GB, GIB, KIB, MB, MIB, TB } from '@/lib/desks/kit'

import * as scan from '@/lib/desks/scan'
import * as layout from '@/lib/desks/layout'
import * as ingest from '@/lib/desks/ingest'
import * as tenancy from '@/lib/desks/tenancy'
import * as compaction from '@/lib/desks/compaction'

/* ----------------------------- shared helpers ----------------------------- */

const contractFor = (id: string): string[] => {
  const meta = DESKS.find((d) => d.id === id)
  if (!meta) throw new Error(`no DeskMeta for ${id}`)
  return meta.checks
}

const ids = (r: DeskReport): string[] => r.checks.map((c) => c.id)

const check = (r: DeskReport, id: string): Check => {
  const c = r.checks.find((x) => x.id === id)
  if (!c) throw new Error(`report ${r.desk} has no check ${id}`)
  return c
}

const failures = (r: DeskReport): string[] => r.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.msg}`)

/**
 * Every numeric leaf must be finite. Fields listed in `signed` are allowed to
 * go negative because they are headroom figures — a negative headroom is the
 * information, not a bug.
 */
function expectFiniteAndSane(label: string, value: unknown, signed: string[] = [], path = ''): void {
  if (typeof value === 'number') {
    const where = `${label}${path}`
    expect(Number.isNaN(value), `${where} is NaN`).toBe(false)
    expect(Number.isFinite(value), `${where} is not finite (${value})`).toBe(true)
    if (!signed.some((s) => path.includes(s))) {
      expect(value, `${where} is negative (${value})`).toBeGreaterThanOrEqual(0)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, idx) => expectFiniteAndSane(label, v, signed, `${path}[${idx}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) expectFiniteAndSane(label, v, signed, `${path}.${k}`)
  }
}

/** Deterministic and non-mutating: same input twice, same output, input unchanged. */
function expectPure<I, O>(label: string, model: (i: I) => O, input: I): void {
  const before = JSON.stringify(input)
  const a = model(input)
  const b = model(input)
  expect(JSON.stringify(input), `${label} mutated its input`).toBe(before)
  expect(a, `${label} is not deterministic`).toEqual(b)
}

/* ================================== scan ================================== */

describe('scan-desk', () => {
  const input = scan.SCAN_WORKED_EXAMPLE
  const out = scan.modelScanBudget(input)

  const correct = (): scan.ScanSubmission => ({
    input,
    claimedPerQueryBytes: Object.fromEntries(out.perClass.map((r) => [r.id, r.perQueryBytes])),
    claimedDailyTotalBytes: out.dailyTotalBytes,
    statedShape: 'per-byte-scanned',
    statedDataGrowth: true,
    statedAdoptionGrowth: true,
  })

  it('reports the registry check ids verbatim and in order', () => {
    expect(ids(scan.gradeScan(correct()))).toEqual(contractFor('scan-desk'))
    expect(contractFor('scan-desk')).toEqual(['per_query', 'daily_total', 'shape_stated', 'growth_modelled'])
  })

  it('passes every check for a correct submission', () => {
    const r = scan.gradeScan(correct())
    expect(failures(r)).toEqual([])
    expect(allPassed(r)).toBe(true)
  })

  it('splits recurring from ad-hoc, and reports ad-hoc as a bound not an estimate', () => {
    const adhoc = out.perClass.find((r) => r.id === 'analysts')!
    expect(adhoc.computed).toBe(false)
    /* The bound is the pool ceiling, NOT quota x queries, which would be 24 TB. */
    expect(adhoc.dailyBytes).toBe(1.5 * TB)
    expect(out.dailyTotalBytes).toBeCloseTo(out.recurringDailyBytes + out.adhocBoundBytes, 6)
  })

  it('fails shape_stated on omission, naming why the omission is the problem', () => {
    /* Point estimates left perfect — only the shape is removed. */
    const r = scan.gradeScan({ ...correct(), statedShape: null })
    expect(check(r, 'per_query').pass).toBe(true)
    expect(check(r, 'daily_total').pass).toBe(true)
    const c = check(r, 'shape_stated')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/pricing shape not stated/)
    expect(c.msg).toMatch(/per-byte-scanned/)
    expect(c.msg).toMatch(/provisioned-compute/)
    expect(c.msg).toMatch(/omission is the problem/)
  })

  it('fails growth_modelled when either growth term is omitted, naming the term', () => {
    const noAdoption = scan.gradeScan({ ...correct(), statedAdoptionGrowth: false })
    expect(check(noAdoption, 'growth_modelled').pass).toBe(false)
    expect(check(noAdoption, 'growth_modelled').msg).toMatch(/omitted: adoption growth/)
    expect(check(noAdoption, 'growth_modelled').msg).toMatch(/LARGER and less predictable/)

    const noData = scan.gradeScan({ ...correct(), statedDataGrowth: false })
    expect(check(noData, 'growth_modelled').msg).toMatch(/omitted: data growth/)

    const neither = scan.gradeScan({ ...correct(), statedDataGrowth: false, statedAdoptionGrowth: false })
    expect(check(neither, 'growth_modelled').msg).toMatch(/data growth and adoption growth/)
  })

  it('grades daily_total in a band: inside passes, outside fails', () => {
    const inside = scan.gradeScan({
      ...correct(),
      claimedDailyTotalBytes: out.dailyTotalBytes * (1 + (scan.SCAN_TOLERANCE_PCT - 3) / 100),
    })
    expect(check(inside, 'daily_total').pass).toBe(true)

    const outside = scan.gradeScan({
      ...correct(),
      claimedDailyTotalBytes: out.dailyTotalBytes * (1 + (scan.SCAN_TOLERANCE_PCT + 10) / 100),
    })
    const c = check(outside, 'daily_total')
    expect(c.pass).toBe(false)
    /* Diagnostic: the message itemises every class and both subtotals. */
    for (const r of out.perClass) expect(c.msg).toContain(r.id)
    expect(c.msg).toMatch(/Recurring subtotal/)
    expect(c.msg).toMatch(/ad-hoc ceiling/)
  })

  it('fails per_query when a class is missing entirely, not just mis-estimated', () => {
    const partial = correct()
    delete partial.claimedPerQueryBytes['pipelines']
    const c = check(scan.gradeScan(partial), 'per_query')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/no per-query figure for pipelines/)
    expect(c.msg).toMatch(/per query CLASS/)
  })

  it('is pure, deterministic and finite across a sweep', () => {
    expectPure('modelScanBudget', scan.modelScanBudget, input)
    for (const pruning of [0, 0.5, 0.95, 0.9999, 1]) {
      for (const horizonMonths of [0, 1, 24, 120]) {
        for (const growth of [-0.5, 0, 0.4, 3]) {
          const swept: scan.ScanInput = {
            ...input,
            horizonMonths,
            dataGrowthPerYear: growth,
            adoptionGrowthPerYear: growth,
            classes: input.classes.map((c) => ({ ...c, pruningRatio: pruning })),
          }
          expectFiniteAndSane(`scan(p=${pruning},h=${horizonMonths},g=${growth})`, scan.modelScanBudget(swept))
        }
      }
    }
  })
})

/* ================================= layout ================================= */

describe('layout-desk', () => {
  const classes = layout.LAYOUT_WORKED_CLASSES
  const design = layout.LAYOUT_WORKED_DESIGN
  const out = layout.modelLayout(classes, design)

  const correct = (): layout.LayoutSubmission => ({
    classes,
    design,
    promisedPruningRatio: Object.fromEntries(out.perClass.map((r) => [r.id, r.pruningRatio])),
    claimedFilesTouched: Object.fromEntries(out.perClass.map((r) => [r.id, r.filesTouched])),
    statedWorstClassId: out.worstClassId,
    statedWorstClassRatio: out.perClass.find((r) => r.id === out.worstClassId)!.pruningRatio,
    statedWorstClassResponse: 'a second table sorted for it, or nothing — deliberately, and the reason is in the doc',
    statisticsMaintainedWithData: true,
    filesTouchedCeiling: 128,
  })

  it('reports the registry check ids verbatim and in order', () => {
    expect(ids(layout.gradeLayout(correct()))).toEqual(contractFor('layout-desk'))
    expect(contractFor('layout-desk')).toEqual([
      'prunes_target',
      'file_count_sane',
      'worst_query_stated',
      'no_false_negatives',
    ])
  })

  it('passes every check for a correct submission', () => {
    const r = layout.gradeLayout(correct())
    expect(failures(r)).toEqual([])
  })

  it('reproduces C2 arithmetic including the +1 boundary row group', () => {
    /* 1 - d(fN + 1)/N at d = 1, f = 0.02, N = 24000 -> 1 - 481/24000. */
    expect(layout.pruningRatio(24_000, 0.02, 1)).toBeCloseTo(1 - 481 / 24_000, 12)
    /* Depth 4 multiplies the read side by 4, i.e. quadruples what is not pruned. */
    expect(1 - layout.pruningRatio(24_000, 0.02, 4)).toBeCloseTo(4 * (481 / 24_000), 12)
    /* Files are eight row groups, so the footer tax is per eight. */
    expect(layout.ROW_GROUPS_PER_FILE).toBe(8)
    /*
     * The starved class is ranked by BYTES READ, not by ratio — and this fixture
     * is exactly why. The needle class has the HIGHEST pruning ratio of the
     * three and still reads more bytes than the dashboard it was not designed
     * for, because its projection is wider. A design ranked by ratio would call
     * needle the best-served class and never notice rollup.
     */
    expect(out.worstClassId).toBe('rollup')
    expect(out.bestClassId).toBe('needle')
    const byRatio = [...out.perClass].sort((a, b) => b.pruningRatio - a.pruningRatio).map((r) => r.id)
    const byBytes = [...out.perClass].sort((a, b) => b.bytesRead - a.bytesRead).map((r) => r.id)
    expect(byRatio).toEqual(['needle', 'dashboard', 'rollup'])
    expect(byBytes).toEqual(['rollup', 'needle', 'dashboard'])
  })

  it('fails worst_query_stated on omission, naming the class the design starves', () => {
    const r = layout.gradeLayout({ ...correct(), statedWorstClassId: null })
    /* The ratio itself is still perfect — only the caveat was omitted. */
    expect(check(r, 'prunes_target').pass).toBe(true)
    const c = check(r, 'worst_query_stated')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/no starved class named/)
    expect(c.msg).toContain(out.worstClassId)
    expect(c.msg).toMatch(/one physical order/)
  })

  it('fails worst_query_stated when the named class is not the worst one', () => {
    const c = check(layout.gradeLayout({ ...correct(), statedWorstClassId: 'needle' }), 'worst_query_stated')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/named needle/)
    expect(c.msg).toMatch(/Rank by bytes read/)
  })

  it('fails worst_query_stated when the class is named with no response attached', () => {
    const c = check(layout.gradeLayout({ ...correct(), statedWorstClassResponse: null }), 'worst_query_stated')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/omitted your response to it/)
  })

  it('grades prunes_target in a band of ratio points: inside passes, outside fails', () => {
    const ref = out.perClass.find((r) => r.id === 'dashboard')!.pruningRatio
    const inside = layout.gradeLayout({
      ...correct(),
      promisedPruningRatio: {
        ...correct().promisedPruningRatio,
        dashboard: ref - layout.PRUNING_TOLERANCE_POINTS / 2,
      },
    })
    expect(check(inside, 'prunes_target').pass).toBe(true)

    const outside = layout.gradeLayout({
      ...correct(),
      promisedPruningRatio: { ...correct().promisedPruningRatio, dashboard: ref - 0.05 },
    })
    const c = check(outside, 'prunes_target')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/1 − d\(f·N \+ 1\)\/N/)
    expect(c.msg).toMatch(/boundary row group/)
  })

  it('fails no_false_negatives ABSOLUTELY for a ratio above the provable ceiling', () => {
    const needle = out.perClass.find((r) => r.id === 'needle')!
    const overPromise = needle.maxProvableRatio + 1e-6
    const r = layout.gradeLayout({
      ...correct(),
      promisedPruningRatio: { ...correct().promisedPruningRatio, needle: overPromise },
    })
    const c = check(r, 'no_false_negatives')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/provable ceiling/)
    expect(c.msg).toMatch(/could contain a match/)
    expect(c.msg).toMatch(/zero tolerance/)
    /* Absolute, not banded: a hair over the ceiling is still a wrong answer. */
    expect(overPromise - needle.maxProvableRatio).toBeLessThan(layout.PRUNING_TOLERANCE_POINTS)
  })

  it('fails no_false_negatives for a mechanism whose skips are not proofs', () => {
    const cached = layout.gradeLayout({ ...correct(), design: { ...design, mechanism: 'cached-statistics' } })
    expect(check(cached, 'no_false_negatives').pass).toBe(false)
    expect(check(cached, 'no_false_negatives').msg).toMatch(/correctness risk with a good pruning number/)

    const detached = layout.gradeLayout({ ...correct(), statisticsMaintainedWithData: false })
    expect(check(detached, 'no_false_negatives').pass).toBe(false)
    expect(check(detached, 'no_false_negatives').msg).toMatch(/same commit as the data/)
  })

  it('fails file_count_sane on both the partition ceiling and the files-per-query ceiling', () => {
    const tooManyPartitions = layout.gradeLayout({
      ...correct(),
      design: { ...design, partitionsWrittenPerDay: 5_000 },
    })
    const p = check(tooManyPartitions, 'file_count_sane')
    expect(p.pass).toBe(false)
    expect(p.msg).toMatch(/against a ceiling of/)
    expect(p.msg).toMatch(/permanently small files/)

    const tightCeiling = layout.gradeLayout({ ...correct(), filesTouchedCeiling: 8 })
    const f = check(tightCeiling, 'file_count_sane')
    expect(f.pass).toBe(false)
    expect(f.msg).toMatch(/invisible to a bytes-scanned dashboard/)
  })

  it('is pure, deterministic and finite across a sweep', () => {
    expectPure('modelLayout', (i: layout.LayoutDesign) => layout.modelLayout(classes, i), design)
    for (const depth of [1, 1.5, 8, 400]) {
      for (const rowGroups of [1, 8, 24_000, 2_000_000]) {
        for (const selectivity of [0, 1e-9, 0.02, 1]) {
          const swept = classes.map((c) => ({ ...c, candidateRowGroups: rowGroups, selectivity }))
          expectFiniteAndSane(
            `layout(d=${depth},N=${rowGroups},f=${selectivity})`,
            layout.modelLayout(swept, { ...design, clusteringDepth: depth }),
          )
        }
      }
    }
  })
})

/* ================================= ingest ================================= */

describe('ingest-desk', () => {
  const input = ingest.INGEST_WORKED_EXAMPLE
  const out = ingest.modelIngest(input)

  const correct = (): ingest.IngestSubmission => ({
    input,
    claimedP99StalenessSeconds: out.p99StalenessSeconds,
    claimedAverageFileBytes: out.averageFileBytes,
    statedTradeoff: 'freshness',
    statedTradeoffMagnitude: 'five minutes rather than thirty seconds, i.e. 10x fewer commits',
    statedWriteAmpBudget: out.writeAmplification,
  })

  it('reports the registry check ids verbatim and in order', () => {
    expect(ids(ingest.gradeIngest(correct()))).toEqual(contractFor('ingest-desk'))
    expect(contractFor('ingest-desk')).toEqual([
      'freshness_sla',
      'file_size',
      'compaction_keeps_up',
      'tradeoff_stated',
    ])
  })

  it('passes every check for a correct submission', () => {
    expect(failures(ingest.gradeIngest(correct()))).toEqual([])
  })

  it('reproduces C5.L4: p99 is interval + commit, and the mean flatters it', () => {
    expect(out.p99StalenessSeconds).toBeCloseTo(0.99 * 300 + 4, 9)
    expect(out.meanStalenessSeconds).toBeCloseTo(300 / 2 + 4, 9)
    expect(out.p99StalenessSeconds).toBeGreaterThan(out.meanStalenessSeconds * 1.9)

    /* The published 30-second arithmetic: 2,880 commits x 6 partitions x 4 writers. */
    const thirty = ingest.modelIngest({ ...input, batchIntervalSeconds: 30 })
    expect(thirty.commitsPerDay).toBe(2_880)
    expect(thirty.filesPerDay).toBe(69_120)
    expect(thirty.averageFileBytes).toBeLessThan(0.5 * MB)
    /* Halving the interval doubles the file count at constant data. */
    expect(ingest.modelIngest({ ...input, batchIntervalSeconds: 150 }).filesPerDay).toBe(out.filesPerDay * 2)
  })

  it('applies conversion lag only when the write buffer is off the read path', () => {
    expect(out.conversionLagApplied).toBe(0)
    const offPath = ingest.modelIngest({ ...input, bufferOnReadPath: false })
    expect(offPath.conversionLagApplied).toBe(input.conversionLagSeconds)
    /* And then it dominates the interval that was tuned. */
    expect(offPath.p99StalenessSeconds).toBeGreaterThan(out.p99StalenessSeconds * 4)
  })

  it('fails tradeoff_stated on omission of the write-amp budget, naming the term', () => {
    const r = ingest.gradeIngest({ ...correct(), statedWriteAmpBudget: null })
    /* Every numeric claim is still perfect. */
    expect(check(r, 'freshness_sla').pass).toBe(true)
    expect(check(r, 'file_size').pass).toBe(true)
    const c = check(r, 'tradeoff_stated')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/omitted: the write-amplification budget it consumes/)
    expect(c.msg).toMatch(/unbounded background bill/)
  })

  it('fails tradeoff_stated when the side given up is not named', () => {
    const c = check(ingest.gradeIngest({ ...correct(), statedTradeoff: null }), 'tradeoff_stated')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/which side you gave up \(freshness or file count\)/)
    expect(c.msg).toMatch(/JOINTLY achievable/)
  })

  it('grades freshness_sla in a band, and names the mean-for-p99 error', () => {
    const inside = ingest.gradeIngest({
      ...correct(),
      claimedP99StalenessSeconds: out.p99StalenessSeconds * (1 + (ingest.STALENESS_TOLERANCE_PCT - 5) / 100),
    })
    expect(check(inside, 'freshness_sla').pass).toBe(true)

    const outside = ingest.gradeIngest({ ...correct(), claimedP99StalenessSeconds: out.p99StalenessSeconds * 3 })
    expect(check(outside, 'freshness_sla').pass).toBe(false)

    /* Quoting the mean is a specific, diagnosed error rather than "out of band". */
    const meanQuoted = ingest.gradeIngest({ ...correct(), claimedP99StalenessSeconds: out.meanStalenessSeconds })
    const c = check(meanQuoted, 'freshness_sla')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/Your figure is the MEAN/)
    expect(c.msg).toMatch(/unluckiest row/)
  })

  it('fails compaction_keeps_up as a rate against a rate, and says a deficit accumulates', () => {
    const starved = ingest.gradeIngest({ ...correct(), input: { ...input, mergeRateFilesPerHour: 100 } })
    const c = check(starved, 'compaction_keeps_up')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/UNBOUNDED/)
    expect(c.msg).toMatch(/accumulates/)
    expect(c.msg).toMatch(/created-per-hour against merged-per-hour/)

    /* Parity is not enough: it fails the headroom requirement without a deficit. */
    const parity = ingest.gradeIngest({
      ...correct(),
      input: { ...input, mergeRateFilesPerHour: out.creationRateFilesPerHour },
    })
    const p = check(parity, 'compaction_keeps_up')
    expect(p.pass).toBe(false)
    expect(p.msg).toMatch(/necessary and insufficient/)
    expect(ingest.REQUIRED_HEADROOM).toBeGreaterThan(1)
  })

  it('fails file_size when the configured target is unreachable by the partition scheme', () => {
    const wish = ingest.gradeIngest({
      ...correct(),
      input: { ...input, targetFileBytes: 100 * GB },
      claimedAverageFileBytes: ingest.modelIngest({ ...input, targetFileBytes: 100 * GB }).averageFileBytes,
    })
    const c = check(wish, 'file_size')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/wish rather than a setting/)
  })

  it('is pure, deterministic and finite across a sweep', () => {
    expectPure('modelIngest', ingest.modelIngest, input)
    for (const batchIntervalSeconds of [1, 30, 300, 3_600, 86_400]) {
      for (const writers of [1, 4, 64]) {
        for (const partitionsWrittenPerBatch of [1, 6, 512]) {
          for (const targetFileBytes of [1 * MIB, 512 * MB, 8 * GB]) {
            expectFiniteAndSane(
              `ingest(i=${batchIntervalSeconds},w=${writers},p=${partitionsWrittenPerBatch})`,
              ingest.modelIngest({
                ...input,
                batchIntervalSeconds,
                writers,
                partitionsWrittenPerBatch,
                targetFileBytes,
              }),
            )
          }
        }
      }
    }
  })
})

/* ================================ tenancy ================================= */

describe('tenancy-desk', () => {
  const input = tenancy.TENANCY_WORKED_EXAMPLE
  const out = tenancy.modelTenancy(input)

  const correct = (): tenancy.TenancySubmission => ({
    input,
    statedBoundary: 'partition',
    attributionMethod: 'storage-bytes-by-partition',
    claimedWorstTenantBytes: out.largestTenantBytes,
    claimedCatalogObjects: out.catalogObjects,
  })

  it('reports the registry check ids verbatim and in order', () => {
    expect(ids(tenancy.gradeTenancy(correct()))).toEqual(contractFor('tenancy-desk'))
    expect(contractFor('tenancy-desk')).toEqual([
      'isolation',
      'attribution',
      'worst_tenant',
      'catalog_ceiling',
      'noisy_neighbour',
    ])
  })

  it('passes every check for a correct submission', () => {
    expect(failures(tenancy.gradeTenancy(correct()))).toEqual([])
  })

  it('models both ends of a Zipf population, so the mean is visibly a fiction', () => {
    expect(out.tenantBytes).toHaveLength(input.tenants)
    /* Sorted descending, and conserving the total. */
    for (let i = 1; i < out.tenantBytes.length; i++) {
      expect(out.tenantBytes[i]).toBeLessThanOrEqual(out.tenantBytes[i - 1])
    }
    /* Conserves the total. Relative tolerance: 180 TiB has no absolute epsilon. */
    const summed = out.tenantBytes.reduce((a, b) => a + b, 0)
    expect(Math.abs(summed - input.totalBytes) / input.totalBytes).toBeLessThan(1e-9)
    /* The head is well above the mean and the median is well below it. */
    expect(out.skewRatio).toBeGreaterThan(3)
    expect(out.medianTenantBytes).toBeLessThan(out.meanTenantBytes)
    expect(out.largestTenantBytes).toBeGreaterThan(out.smallestTenantBytes)
    /* Catalog objects: metadata grows with file count, and files dominate. */
    expect(out.files).toBeGreaterThan(out.partitions)
    expect(out.catalogObjects).toBe(out.tables + out.partitions + out.files)
  })

  it('fails attribution on omission, naming the mean it collapses to', () => {
    const r = tenancy.gradeTenancy({ ...correct(), attributionMethod: null })
    /* The worst-tenant figure is still exact — only attribution was omitted. */
    expect(check(r, 'worst_tenant').pass).toBe(true)
    const c = check(r, 'attribution')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/no attribution method stated/)
    expect(c.msg).toMatch(/the mean is a fiction/)
    expect(c.msg).toMatch(/omission is the problem/)
  })

  it('fails attribution when the method cannot separate tenants under the model', () => {
    const clustered = tenancy.gradeTenancy({
      ...correct(),
      input: { ...input, model: 'shared-table-clustered' },
      statedBoundary: 'row-filter',
    })
    const c = check(clustered, 'attribution')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/no per-tenant partition to sum/)
    expect(tenancy.attributionWorks('shared-table-clustered', 'storage-bytes-by-partition')).toBe(false)
    expect(tenancy.attributionWorks('shared-table-clustered', 'per-tenant-query-tags')).toBe(true)
  })

  it('fails isolation for a boundary the chosen model cannot enforce', () => {
    const c = check(tenancy.gradeTenancy({ ...correct(), statedBoundary: 'account' }), 'isolation')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/can enforce at most partition/)

    const none = check(tenancy.gradeTenancy({ ...correct(), statedBoundary: 'none' }), 'isolation')
    expect(none.pass).toBe(false)
    expect(none.msg).toMatch(/no isolation boundary stated/)

    /* A clustered shared table tops out at a row filter, and the message says why. */
    const clustered = check(
      tenancy.gradeTenancy({
        ...correct(),
        input: { ...input, model: 'shared-table-clustered' },
        attributionMethod: 'per-tenant-query-tags',
        statedBoundary: 'partition',
      }),
      'isolation',
    )
    expect(clustered.pass).toBe(false)
    expect(clustered.msg).toMatch(/SORT KEY, not a boundary/)
  })

  it('grades worst_tenant in a band and diagnoses a mean or median substitution', () => {
    const inside = tenancy.gradeTenancy({
      ...correct(),
      claimedWorstTenantBytes: out.largestTenantBytes * (1 - (tenancy.TENANT_TOLERANCE_PCT - 5) / 100),
    })
    expect(check(inside, 'worst_tenant').pass).toBe(true)

    const meanQuoted = tenancy.gradeTenancy({ ...correct(), claimedWorstTenantBytes: out.meanTenantBytes })
    const c = check(meanQuoted, 'worst_tenant')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/Your figure is the MEAN/)
    expect(c.msg).toMatch(/Model both ends, never the average/)
  })

  it('fails catalog_ceiling both over the ceiling and out of band', () => {
    const over = tenancy.gradeTenancy({
      ...correct(),
      input: { ...input, catalogObjectCeiling: Math.floor(out.catalogObjects / 2) },
    })
    const o = check(over, 'catalog_ceiling')
    expect(o.pass).toBe(false)
    expect(o.msg).toMatch(/metadata grows with FILE COUNT/)

    const offBand = tenancy.gradeTenancy({ ...correct(), claimedCatalogObjects: out.catalogObjects * 3 })
    const b = check(offBand, 'catalog_ceiling')
    expect(b.pass).toBe(false)
    expect(b.msg).toMatch(/term most often dropped is files/)

    const inBandClaim = tenancy.gradeTenancy({
      ...correct(),
      claimedCatalogObjects: out.catalogObjects * (1 + (tenancy.CATALOG_TOLERANCE_PCT - 5) / 100),
    })
    expect(check(inBandClaim, 'catalog_ceiling').pass).toBe(true)
  })

  it('fails noisy_neighbour with no cap, and with a cap that is not one', () => {
    const uncapped = tenancy.gradeTenancy({ ...correct(), input: { ...input, perTenantSlotCap: null } })
    const u = check(uncapped, 'noisy_neighbour')
    expect(u.pass).toBe(false)
    expect(u.msg).toMatch(/no per-tenant concurrency cap/)
    expect(u.msg).toMatch(/COUNT of slots/)

    const wholePool = tenancy.gradeTenancy({
      ...correct(),
      input: { ...input, perTenantSlotCap: input.poolSlots },
    })
    const w = check(wholePool, 'noisy_neighbour')
    expect(w.pass).toBe(false)
    expect(w.msg).toMatch(/A cap equal to the pool is not a cap/)
  })

  /*
   * 180 model runs, the largest of them drawing 5,000 Zipf tenants through the
   * shared bigint xorshift — a second and a half of real work. The explicit
   * timeout is here because the default 5s is measured against a machine that is
   * also transforming and running every other suite in parallel, and this test
   * was close enough to the line to fail on a cold cache rather than on a bug.
   */
  it('is pure, deterministic, seed-stable and finite across a sweep', () => {
    expectPure('modelTenancy', tenancy.modelTenancy, input)
    /* Same seed, same tenants — every learner sees the same population. */
    expect(tenancy.drawTenantBytes(50, 100 * GIB, 1.1, 7)).toEqual(tenancy.drawTenantBytes(50, 100 * GIB, 1.1, 7))
    expect(tenancy.drawTenantBytes(50, 100 * GIB, 1.1, 7)).not.toEqual(tenancy.drawTenantBytes(50, 100 * GIB, 1.1, 8))

    const signed = ['catalogHeadroom']
    for (const model of Object.keys(tenancy.MODEL_MAX_BOUNDARY) as tenancy.TenancyModel[]) {
      for (const tenants of [1, 2, 400, 5_000]) {
        for (const zipfExponent of [0.6, 1.1, 2.5]) {
          expectFiniteAndSane(
            `tenancy(${model},n=${tenants},s=${zipfExponent})`,
            tenancy.modelTenancy({ ...input, model, tenants, zipfExponent }),
            signed,
          )
        }
      }
    }
  }, 30_000)
})

/* =============================== compaction =============================== */

describe('compaction-desk', () => {
  const input = compaction.COMPACTION_WORKED_EXAMPLE
  const out = compaction.modelCompaction(input)

  const correctCost = (): compaction.CostStatement => ({
    bytesRewrittenPerDay: out.bytesRewrittenPerDay,
    rewriteShareOfTablePerDay: out.rewriteShareOfTablePerDay,
    filesCreatedPerDay: out.filesWrittenPerDay,
    filesMergedPerDay: out.filesWrittenPerDay,
    requestsAddedPerDay: out.requestsAddedPerDay,
    pricingShapeNamed: 'per-byte-written plus per-request, on object storage',
    quotedWallClock: false,
  })

  const correct = (): compaction.CompactionSubmission => ({
    input,
    claimedReadAmp: out.amplification.read,
    readAmpCeiling: 1.5,
    claimedWriteAmp: out.amplification.write,
    statedRecoveryAfterExpiry: true,
    claimedStorageMultiple: out.storageMultiple,
    statedStrandedRows: true,
    cost: correctCost(),
  })

  it('reports the registry check ids verbatim and in order', () => {
    expect(ids(compaction.gradeCompaction(correct()))).toEqual(contractFor('compaction-desk'))
    expect(contractFor('compaction-desk')).toEqual([
      'read_amp_bounded',
      'write_amp_budget',
      'expiry_stated',
      'storage_stable',
      'cost_counted',
    ])
  })

  it('passes every check for a correct submission', () => {
    expect(failures(compaction.gradeCompaction(correct()))).toEqual([])
  })

  it('reproduces C5: write amp is 1 + base x scope / delta, and the two amps oppose', () => {
    expect(compaction.writeAmplification(312 * MIB, 18 * MIB, 1)).toBeCloseTo(1 + 312 / 18, 9)
    expect(out.amplification.write).toBeCloseTo(1 + (40 * 1024 * 0.03) / 512, 9)
    /* Read amp is two separated terms and they sum to the whole. */
    expect(out.readDataTerm + out.readMetadataTerm).toBeCloseTo(out.amplification.read, 12)
    expect(out.amplification.metadata).toBe(out.readMetadataTerm)
    /* At this scale the METADATA term is the larger half: footers, not data. */
    expect(out.readMetadataTerm).toBeGreaterThan(out.readDataTerm - 1)

    /* Opposing: a tighter trigger lowers read amp and raises write amp. */
    const tighter = compaction.modelCompaction({ ...input, triggerDeltaBytes: 128 * MIB })
    expect(tighter.amplification.read).toBeLessThan(out.amplification.read)
    expect(tighter.amplification.write).toBeGreaterThan(out.amplification.write)
  })

  it('fails write_amp_budget outright when there is no budget at all', () => {
    const r = compaction.gradeCompaction({ ...correct(), claimedWriteAmp: null })
    expect(check(r, 'read_amp_bounded').pass).toBe(true)
    const c = check(r, 'write_amp_budget')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/no write-amplification budget stated/)
    expect(c.msg).toMatch(/unbounded background bill/)
    expect(c.msg).toMatch(/written .* times, forever/)
  })

  it('fails expiry_stated on omission, and says why the omission bounds nothing', () => {
    const noExpiry = { ...input, expiryWindowDays: null }
    const ref = compaction.modelCompaction(noExpiry)
    const r = compaction.gradeCompaction({
      ...correct(),
      input: noExpiry,
      claimedReadAmp: ref.amplification.read,
      claimedWriteAmp: ref.amplification.write,
      claimedStorageMultiple: ref.storageMultiple,
    })
    /* Read and write amp are exact; only the expiry term is missing. */
    expect(check(r, 'read_amp_bounded').pass).toBe(true)
    expect(check(r, 'write_amp_budget').pass).toBe(true)
    const c = check(r, 'expiry_stated')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/no expiry window/)
    expect(c.msg).toMatch(/bounded in ratio and unbounded in bytes/)
    /* And the same omission unbounds storage_stable, which says 2 of 3. */
    const s = check(r, 'storage_stable')
    expect(s.pass).toBe(false)
    expect(s.msg).toMatch(/2 of the 3 components/)
    expect(ref.storageBounded).toBe(false)
    /* Never Infinity: unbounded is projected against a horizon and flagged. */
    expect(Number.isFinite(ref.retainedSupersededBytes)).toBe(true)
  })

  it('fails expiry_stated when the window is stated with no recovery path', () => {
    const c = check(
      compaction.gradeCompaction({ ...correct(), statedRecoveryAfterExpiry: false }),
      'expiry_stated',
    )
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/not what recovery looks like/)
    expect(c.msg).toMatch(/one failure domain where you believed you had two/)
  })

  it('fails cost_counted for a clock, and for any omitted count', () => {
    const clock = compaction.gradeCompaction({
      ...correct(),
      cost: { ...correctCost(), quotedWallClock: true },
    })
    const w = check(clock, 'cost_counted')
    expect(w.pass).toBe(false)
    expect(w.msg).toMatch(/quoted in wall-clock/)
    expect(w.msg).toMatch(/engineer-months/)
    expect(w.msg).toMatch(/does not know your prices/)

    const noShape = compaction.gradeCompaction({
      ...correct(),
      cost: { ...correctCost(), pricingShapeNamed: null },
    })
    const s = check(noShape, 'cost_counted')
    expect(s.pass).toBe(false)
    expect(s.msg).toMatch(/omitted: the pricing shape it lands on/)

    const noRates = compaction.gradeCompaction({
      ...correct(),
      cost: { ...correctCost(), filesCreatedPerDay: null, filesMergedPerDay: null },
    })
    const r = check(noRates, 'cost_counted')
    expect(r.pass).toBe(false)
    expect(r.msg).toMatch(/file creation rate; file merge rate/)
    expect(r.msg).toMatch(/grades presence and not only accuracy/)
  })

  it('grades read_amp_bounded on the OVERHEAD band: inside passes, outside fails', () => {
    const overhead = out.amplification.read - 1
    const inside = compaction.gradeCompaction({
      ...correct(),
      claimedReadAmp: 1 + overhead * (1 + (compaction.READ_AMP_TOLERANCE_PCT - 5) / 100),
    })
    expect(check(inside, 'read_amp_bounded').pass).toBe(true)

    /* 1.0x looks close to 1.02x and is a 100% error in the overhead. */
    const outside = compaction.gradeCompaction({ ...correct(), claimedReadAmp: 1.0 })
    const c = check(outside, 'read_amp_bounded')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/METADATA term was omitted/)
    expect(c.msg).toMatch(/data term/)
    expect(c.msg).toMatch(/metadata term/)
  })

  it('fails read_amp_bounded absolutely when the reference exceeds the committed ceiling', () => {
    const loose = { ...input, triggerDeltaBytes: 200 * GIB }
    const ref = compaction.modelCompaction(loose)
    expect(ref.amplification.read).toBeGreaterThan(1.5)
    const c = check(
      compaction.gradeCompaction({ ...correct(), input: loose, claimedReadAmp: ref.amplification.read }),
      'read_amp_bounded',
    )
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/against a committed ceiling/)
    expect(c.msg).toMatch(/trigger is set too high/)
  })

  it('grades write_amp_budget and storage_stable in bands', () => {
    const insideWrite = compaction.gradeCompaction({
      ...correct(),
      claimedWriteAmp: out.amplification.write * (1 + (compaction.WRITE_AMP_TOLERANCE_PCT - 5) / 100),
    })
    expect(check(insideWrite, 'write_amp_budget').pass).toBe(true)

    const lowWrite = compaction.gradeCompaction({ ...correct(), claimedWriteAmp: 1.05 })
    expect(check(lowWrite, 'write_amp_budget').pass).toBe(false)
    expect(check(lowWrite, 'write_amp_budget').msg).toMatch(/never rewrites sealed files/)

    const insideStorage = compaction.gradeCompaction({
      ...correct(),
      claimedStorageMultiple: out.storageMultiple * (1 - (compaction.STORAGE_TOLERANCE_PCT - 5) / 100),
    })
    expect(check(insideStorage, 'storage_stable').pass).toBe(true)

    const liveOnly = compaction.gradeCompaction({ ...correct(), claimedStorageMultiple: 1.0 })
    const s = check(liveOnly, 'storage_stable')
    expect(s.pass).toBe(false)
    expect(s.msg).toMatch(/the one component that was never at risk/)
  })

  it('fails storage_stable when tombstoned rows exist and none were named', () => {
    const c = check(compaction.gradeCompaction({ ...correct(), statedStrandedRows: false }), 'storage_stable')
    expect(c.pass).toBe(false)
    expect(c.msg).toMatch(/still present/)
    expect(c.msg).toMatch(/still stored and still read/)
  })

  it('is pure, deterministic and finite across a sweep', () => {
    expectPure('modelCompaction', compaction.modelCompaction, input)
    for (const compactionScopeFraction of [0, 0.03, 0.5, 1]) {
      for (const triggerDeltaBytes of [1 * KIB, 512 * MIB, 64 * GIB]) {
        for (const expiryWindowDays of [null, 0, 7, 365]) {
          for (const tombstoneFraction of [0, 0.5, 1]) {
            expectFiniteAndSane(
              `compaction(scope=${compactionScopeFraction},trigger=${triggerDeltaBytes},expiry=${expiryWindowDays})`,
              compaction.modelCompaction({
                ...input,
                compactionScopeFraction,
                triggerDeltaBytes,
                expiryWindowDays,
                tombstoneFraction,
              }),
            )
          }
        }
      }
    }
  })
})

/* ============================ the no-prices rule ============================ */

describe('no prices anywhere in the desk models', () => {
  const files = ['scan.ts', 'layout.ts', 'ingest.ts', 'tenancy.ts', 'compaction.ts']
  const sources = files.map((f) => ({
    file: f,
    text: readFileSync(resolve(process.cwd(), 'src/lib/desks', f), 'utf8'),
  }))

  it('contains no currency symbols', () => {
    /* A bare $ that is not opening a template placeholder, plus the symbols. */
    const currency = /[£€¥₹¢]|\$(?!\{)/g
    for (const { file, text } of sources) {
      const hits = text.match(currency)
      expect(hits ?? [], `${file} contains a currency symbol: ${JSON.stringify(hits)}`).toEqual([])
    }
  })

  it('contains no currency codes or money words', () => {
    const money = /\b(USD|EUR|GBP|JPY|dollars?|cents?|euros?|pounds sterling)\b/gi
    for (const { file, text } of sources) {
      const hits = text.match(money)
      expect(hits ?? [], `${file} mentions money: ${JSON.stringify(hits)}`).toEqual([])
    }
  })

  it('hardcodes no rate constants — every rate is a caller-supplied parameter', () => {
    /* per-GB, per-TB, per-hour rate names are how a price sneaks in as a number. */
    const rateNames = /\b(costPer|pricePer|ratePer|perGiBMonth|perTBScanned|monthlyCost|hourlyRate)\w*/g
    for (const { file, text } of sources) {
      const hits = text.match(rateNames)
      expect(hits ?? [], `${file} hardcodes a rate: ${JSON.stringify(hits)}`).toEqual([])
    }
  })

  it('states cost as counts: bytes, files, objects, slots and engineer-months', () => {
    /* The positive form of the same rule: the vocabulary is countable. */
    const compactionSrc = sources.find((s) => s.file === 'compaction.ts')!.text
    expect(compactionSrc).toMatch(/engineerMonthsPerYear/)
    expect(compactionSrc).toMatch(/bytesRewrittenPerDay/)
    expect(sources.find((s) => s.file === 'tenancy.ts')!.text).toMatch(/catalogObjects/)
    expect(sources.find((s) => s.file === 'ingest.ts')!.text).toMatch(/filesPerDay/)
    /* And no desk reports a duration as a cost. */
    for (const { file, text } of sources) {
      expect(text, `${file} costs something in wall-clock`).not.toMatch(
        /\b(costSeconds|costMinutes|costHours|secondsOfCompute|cpuHours)\b/,
      )
    }
  })
})
