/**
 * desks-500.test.ts — the L500 reference models: capacity, TCO, DR.
 *
 * What these tests defend, in order of how badly it breaks the course when it
 * regresses:
 *
 *   1. THE CONTRACT. `DESKS[].checks` is what the lessons are written against.
 *      If a model emits a check id the registry does not list, a learner loses
 *      a room for a reason the course never taught. Ids are asserted verbatim
 *      AND in order, per desk.
 *   2. DISCIPLINE ON OMISSION. Each desk has checks that must fail when a term
 *      is missing even though every number present is right, and the failure
 *      message has to say WHY — so the messages are asserted too.
 *   3. BANDS. In-band passes, out-of-band fails. A point-value grader would
 *      pass these tests trivially, so both sides are asserted.
 *   4. NO PRICES. Asserted against the source text, because this is the kind of
 *      thing that gets reintroduced by a well-meaning example.
 *   5. NUMERICAL HYGIENE across a sweep of hostile inputs: no NaN, no
 *      Infinity, no negative counts. Sizing models get fed zeros.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKS, getDesk } from '@/lib/desks'
import { GIB, MIB, TIB, allPassed } from '@/lib/desks/kit'
import type { DeskReport } from '@/lib/desks/kit'
import { COMPONENTS, computeCapacity, gradeCapacity } from '@/lib/desks/capacity'
import type { CapacityInput, CapacitySubmission, Component } from '@/lib/desks/capacity'
import { computeTco, gradeTco } from '@/lib/desks/tco'
import type { OptionCounts, TcoInput, TcoSubmission } from '@/lib/desks/tco'
import { computeDr, gradeDr } from '@/lib/desks/dr'
import type { DrInput, DrSubmission } from '@/lib/desks/dr'

const SRC = join(new URL('..', import.meta.url).pathname, 'src/lib/desks')

const ids = (r: DeskReport): string[] => r.checks.map((c) => c.id)
const check = (r: DeskReport, id: string) => {
  const c = r.checks.find((x) => x.id === id)
  if (!c) throw new Error(`no check ${id} in ${r.desk}: ${ids(r).join(', ')}`)
  return c
}
const failedIds = (r: DeskReport): string[] => r.checks.filter((c) => !c.pass).map((c) => c.id)
const numbers = (o: unknown): number[] => {
  const out: number[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'number') out.push(v)
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk)
  }
  walk(o)
  return out
}

/* ============================== capacity-desk ============================== */

/**
 * The catalog-binds-first case, which is the course's central claim. Byte growth
 * is comfortable (6%/month against a ceiling with room), but the commit interval
 * produces 12,000 files/day against a merge rate of 5,000 — a 7,000/day deficit,
 * which is C2/C5's arithmetic — and a deficit accumulates.
 */
const CATALOG_BOUND: CapacityInput = {
  horizonMonths: 24,
  liveBytes: 40 * TIB,
  dataGrowthPerMonth: 0.06,
  snapshotRetentionMultiplier: 1.4,
  storageCeilingBytes: 1000 * TIB,
  commitsPerDay: 96,
  partitionsPerCommit: 25,
  writers: 5,
  targetFileBytes: 256 * MIB,
  mergeFilesPerDay: 5_000,
  catalogEntryCeiling: 4_000_000,
  peakQueriesPerHour: 400,
  queryGrowthPerMonth: 0.02,
  instanceHoursPerQuery: 0.05,
  instanceHourCeilingPerHour: 120,
  bytesScannedPerQuery: 2 * GIB,
  networkBytesPerDayCeiling: 4000 * TIB,
  ingestBytesPerDay: 900 * GIB,
  ingestBytesPerDayCeiling: 40 * TIB,
}

const capacityRef = computeCapacity(CATALOG_BOUND)

const GOOD_CAPACITY: CapacitySubmission = {
  input: CATALOG_BOUND,
  claimedHorizonBytes: capacityRef.horizonBytes,
  claimedPeakInstanceHours: capacityRef.horizonInstanceHours,
  claimedEntryCount: capacityRef.horizonEntries,
  claimedFirstLimit: capacityRef.firstLimit,
  claimedHeadroomMonths: capacityRef.headroomMonths,
  statedGrowth: true,
}

describe('capacity-desk: contract', () => {
  it('emits exactly the registry check ids, verbatim and in order', () => {
    expect(ids(gradeCapacity(GOOD_CAPACITY))).toEqual(getDesk('capacity-desk')!.checks)
    expect(getDesk('capacity-desk')!.checks).toEqual([
      'storage_plan',
      'concurrency',
      'metadata_scale',
      'first_limit',
      'headroom',
    ])
  })

  it('reports its own desk id and a version', () => {
    const r = gradeCapacity(GOOD_CAPACITY)
    expect(r.desk).toBe('capacity-desk')
    expect(r.version).toBeGreaterThanOrEqual(1)
  })

  it('passes a submission that matches the reference', () => {
    const r = gradeCapacity(GOOD_CAPACITY)
    expect(failedIds(r)).toEqual([])
    expect(allPassed(r)).toBe(true)
  })

  it('is deterministic', () => {
    expect(gradeCapacity(GOOD_CAPACITY)).toEqual(gradeCapacity(GOOD_CAPACITY))
    expect(computeCapacity(CATALOG_BOUND)).toEqual(computeCapacity(CATALOG_BOUND))
  })
})

describe('capacity-desk: the catalog is usually the first limit — demonstrated, not assumed', () => {
  it('binds the catalog on a table whose byte growth is comfortable', () => {
    expect(capacityRef.firstLimit).toBe('catalog')
    /* Storage is genuinely not the problem here: well under its ceiling. */
    expect(capacityRef.curves.storage.utilisation).toBeLessThan(0.5)
    expect(capacityRef.curves.catalog.utilisation).toBeGreaterThan(1)
  })

  it('derives file creation from commits × partitions × writers (C5.L4)', () => {
    expect(capacityRef.filesCreatedPerDay).toBe(96 * 25 * 5)
    expect(capacityRef.mergeDeficitPerDay).toBe(12_000 - 5_000)
  })

  it('halving the commit interval doubles files at constant data', () => {
    const doubled = computeCapacity({ ...CATALOG_BOUND, commitsPerDay: 192 })
    expect(doubled.filesCreatedPerDay).toBe(2 * capacityRef.filesCreatedPerDay)
    /* Same bytes, same storage curve, worse catalog curve — the whole point. */
    expect(doubled.horizonBytes).toBe(capacityRef.horizonBytes)
    expect(doubled.horizonEntries).toBeGreaterThan(capacityRef.horizonEntries)
  })

  it('a merge rate that keeps up removes the accumulating term entirely', () => {
    const kept = computeCapacity({ ...CATALOG_BOUND, mergeFilesPerDay: 20_000 })
    expect(kept.mergeDeficitPerDay).toBe(0)
    expect(kept.firstLimit).not.toBe('catalog')
  })

  it('can name each of the five components for some input', () => {
    const named = new Set<Component>()
    named.add(capacityRef.firstLimit)
    named.add(computeCapacity({ ...CATALOG_BOUND, mergeFilesPerDay: 20_000, storageCeilingBytes: 50 * TIB }).firstLimit)
    named.add(
      computeCapacity({ ...CATALOG_BOUND, mergeFilesPerDay: 20_000, instanceHourCeilingPerHour: 21 }).firstLimit,
    )
    named.add(
      computeCapacity({ ...CATALOG_BOUND, mergeFilesPerDay: 20_000, networkBytesPerDayCeiling: 20 * TIB }).firstLimit,
    )
    named.add(
      computeCapacity({ ...CATALOG_BOUND, mergeFilesPerDay: 20_000, ingestBytesPerDayCeiling: 950 * GIB }).firstLimit,
    )
    expect([...named].sort()).toEqual([...COMPONENTS].sort())
  })

  it('grades first_limit against the model, naming the learner answer and the truth', () => {
    const wrong = gradeCapacity({ ...GOOD_CAPACITY, claimedFirstLimit: 'storage' })
    const c = check(wrong, 'first_limit')
    expect(c.pass).toBe(false)
    expect(c.msg).toContain('storage')
    expect(c.msg).toContain('catalog')
    expect(c.msg).toMatch(/FILE COUNT/)
  })
})

describe('capacity-desk: bands', () => {
  it('accepts a projection just inside the band and rejects one just outside', () => {
    const inside = gradeCapacity({ ...GOOD_CAPACITY, claimedHorizonBytes: capacityRef.horizonBytes * 1.14 })
    const outside = gradeCapacity({ ...GOOD_CAPACITY, claimedHorizonBytes: capacityRef.horizonBytes * 1.16 })
    expect(check(inside, 'storage_plan').pass).toBe(true)
    expect(check(outside, 'storage_plan').pass).toBe(false)
    expect(check(outside, 'storage_plan').msg).toContain('band')
  })

  it('bands concurrency and metadata scale on both sides', () => {
    for (const [key, id] of [
      ['claimedPeakInstanceHours', 'concurrency'],
      ['claimedEntryCount', 'metadata_scale'],
    ] as const) {
      const ref = id === 'concurrency' ? capacityRef.horizonInstanceHours : capacityRef.horizonEntries
      expect(check(gradeCapacity({ ...GOOD_CAPACITY, [key]: ref * 0.9 }), id).pass).toBe(true)
      expect(check(gradeCapacity({ ...GOOD_CAPACITY, [key]: ref * 0.7 }), id).pass).toBe(false)
      expect(check(gradeCapacity({ ...GOOD_CAPACITY, [key]: ref * 1.4 }), id).pass).toBe(false)
    }
  })

  it('bands headroom in whole months', () => {
    const ref = capacityRef.headroomMonths
    expect(check(gradeCapacity({ ...GOOD_CAPACITY, claimedHeadroomMonths: ref + 2 }), 'headroom').pass).toBe(true)
    expect(check(gradeCapacity({ ...GOOD_CAPACITY, claimedHeadroomMonths: ref + 6 }), 'headroom').pass).toBe(false)
  })

  it('metadata scale is not satisfied by the steady-state count alone', () => {
    /* The deficit term is most of the answer here; omitting it is out of band. */
    const steadyOnly = capacityRef.curves.catalog.demandAtHorizon - capacityRef.mergeDeficitPerDay * 30.437 * 24
    expect(check(gradeCapacity({ ...GOOD_CAPACITY, claimedEntryCount: steadyOnly }), 'metadata_scale').pass).toBe(false)
  })
})

describe('capacity-desk: headroom fails on omission', () => {
  it('fails when no growth term is stated, even with every number correct', () => {
    const r = gradeCapacity({ ...GOOD_CAPACITY, statedGrowth: false })
    expect(failedIds(r)).toEqual(['headroom'])
    const c = check(r, 'headroom')
    expect(c.msg).toContain('growth')
    expect(c.msg).toMatch(/snapshot/)
    expect(c.msg).toContain('headroom')
  })

  it('fails when growth is modelled but headroom is never stated', () => {
    const r = gradeCapacity({ ...GOOD_CAPACITY, claimedHeadroomMonths: null })
    expect(failedIds(r)).toEqual(['headroom'])
    expect(check(r, 'headroom').msg).toContain('headroom is not stated')
  })
})

/* ================================ tco-desk ================================ */

const counts = (o: Partial<OptionCounts>): OptionCounts => ({
  storageBytes: 100 * TIB,
  storageGrowthPerMonth: 0.03,
  computeUnitsPerMonth: 4_000,
  computeGrowthPerMonth: 0.02,
  oneOffEngineerMonths: 6,
  ongoingOpsFte: 0.25,
  migrationEngineerMonths: 4,
  migrationParallelMonths: 3,
  exitEngineerMonths: 5,
  exitEgressBytes: 100 * TIB,
  exitParallelMonths: 2,
  ...o,
})

/**
 * A 36-month horizon with the rate card the reader owns. The `engine` option is
 * the classic trap: cheaper platform counts, but 18 one-off engineer-months and
 * 1.5 FTE of ongoing operations — 54 more engineer-months — which is what makes
 * labour half of a self-operated total.
 */
const RATES = { perByteMonth: 2e-11, perComputeUnit: 2, perEngineerMonth: 9_000, perEgressByte: 1e-11 }

const TCO_BASE: TcoInput = {
  horizonMonths: 36,
  rates: RATES,
  options: {
    managed: counts({ computeUnitsPerMonth: 6_000, oneOffEngineerMonths: 3, ongoingOpsFte: 0.25 }),
    engine: counts({ computeUnitsPerMonth: 3_000, oneOffEngineerMonths: 18, ongoingOpsFte: 1.5, exitEngineerMonths: 9 }),
    appliance: counts({ computeUnitsPerMonth: 5_000, oneOffEngineerMonths: 8, ongoingOpsFte: 0.8 }),
  },
}

const tcoRef = computeTco(TCO_BASE)

const goodTco = (o: Partial<TcoSubmission> = {}): TcoSubmission => {
  const recommendation = o.recommendation ?? tcoRef.cheapest
  return {
    input: TCO_BASE,
    recommendation,
    claimedTotal: tcoRef.lines[recommendation].total,
    statedOngoingOps: true,
    statedMigration: true,
    statedExit: true,
    nonCostJustification: null,
    ...o,
  }
}

describe('tco-desk: contract', () => {
  it('emits exactly the registry check ids, verbatim and in order', () => {
    expect(ids(gradeTco(goodTco()))).toEqual(getDesk('tco-desk')!.checks)
    expect(getDesk('tco-desk')!.checks).toEqual(['total', 'ongoing_ops', 'migration', 'exit_costed', 'honest_answer'])
  })

  it('passes a supported submission with every term costed', () => {
    const r = gradeTco(goodTco())
    expect(failedIds(r)).toEqual([])
    expect(r.desk).toBe('tco-desk')
  })

  it('is deterministic', () => {
    expect(gradeTco(goodTco())).toEqual(gradeTco(goodTco()))
    expect(computeTco(TCO_BASE)).toEqual(computeTco(TCO_BASE))
  })
})

describe('tco-desk: labour is the term that decides it', () => {
  it('counts labour in engineer-months, not in a clock or a rate', () => {
    const engine = tcoRef.lines.engine
    expect(engine.ongoingEngineerMonths).toBeCloseTo(1.5 * 36, 6)
    expect(engine.totalEngineerMonths).toBeCloseTo(18 + 54, 6)
  })

  it('puts labour at roughly half the self-operated total at 36 months', () => {
    /* The course claim, held as a range rather than a magic number. */
    expect(tcoRef.lines.engine.labourShare).toBeGreaterThan(0.4)
    expect(tcoRef.lines.engine.labourShare).toBeLessThan(0.75)
  })

  it('the cheaper platform counts do not save the self-operated option', () => {
    expect(tcoRef.lines.engine.platformWeight).toBeLessThan(tcoRef.lines.managed.platformWeight)
    expect(tcoRef.lines.engine.total).toBeGreaterThan(tcoRef.lines.managed.total)
    expect(tcoRef.cheapest).toBe('managed')
  })
})

describe('tco-desk: bands', () => {
  it('accepts a total just inside tolerance and rejects one just outside', () => {
    const ref = tcoRef.lines[tcoRef.cheapest].total
    expect(check(gradeTco(goodTco({ claimedTotal: ref * 1.09 })), 'total').pass).toBe(true)
    expect(check(gradeTco(goodTco({ claimedTotal: ref * 1.11 })), 'total').pass).toBe(false)
    expect(check(gradeTco(goodTco({ claimedTotal: ref * 0.5 })), 'total').msg).toContain('engineer-months')
  })
})

describe('tco-desk: omissions that flatter exactly one option', () => {
  it('fails ongoing_ops when the term is not stated, and says why', () => {
    const r = gradeTco(goodTco({ statedOngoingOps: false }))
    expect(failedIds(r)).toEqual(['ongoing_ops'])
    expect(check(r, 'ongoing_ops').msg).toContain('ongoing operations not counted')
    expect(check(r, 'ongoing_ops').msg).toMatch(/on-call rotation does not/)
  })

  it('fails ongoing_ops when the term is claimed but the FTE is zero', () => {
    const input: TcoInput = {
      ...TCO_BASE,
      options: { ...TCO_BASE.options, engine: counts({ ongoingOpsFte: 0, oneOffEngineerMonths: 18 }) },
    }
    const ref = computeTco(input)
    const r = gradeTco({
      ...goodTco(),
      input,
      recommendation: 'engine',
      claimedTotal: ref.lines.engine.total,
      nonCostJustification: 'data residency requires our own storage account',
    })
    expect(failedIds(r)).toEqual(['ongoing_ops'])
    expect(check(r, 'ongoing_ops').msg).toContain('ops FTE')
    expect(check(r, 'ongoing_ops').msg).toMatch(/omission dressed as a number/)
  })

  it('fails migration when it is not costed, and names the term', () => {
    const r = gradeTco(goodTco({ statedMigration: false }))
    expect(failedIds(r)).toEqual(['migration'])
    expect(check(r, 'migration').msg).toContain('migration not costed')
    expect(check(r, 'migration').msg).toContain('engineer-months')
  })

  it('fails migration when claimed but the engineer-months are zero', () => {
    const input: TcoInput = {
      ...TCO_BASE,
      options: {
        ...TCO_BASE.options,
        managed: counts({ computeUnitsPerMonth: 6_000, oneOffEngineerMonths: 3, migrationEngineerMonths: 0 }),
      },
    }
    const ref = computeTco(input)
    const r = gradeTco({ ...goodTco(), input, recommendation: 'managed', claimedTotal: ref.lines.managed.total })
    expect(failedIds(r)).toEqual(['migration'])
    expect(check(r, 'migration').msg).toContain('migration engineer-months')
  })

  it('fails exit_costed when the exit is not computed, and explains the leverage', () => {
    const r = gradeTco(goodTco({ statedExit: false }))
    expect(failedIds(r)).toEqual(['exit_costed'])
    expect(check(r, 'exit_costed').msg).toContain('exit not costed')
    expect(check(r, 'exit_costed').msg).toMatch(/CAP on any increase/)
  })

  it('fails exit_costed when claimed but both exit terms are zero', () => {
    const input: TcoInput = {
      ...TCO_BASE,
      options: {
        ...TCO_BASE.options,
        managed: counts({
          computeUnitsPerMonth: 6_000,
          oneOffEngineerMonths: 3,
          exitEngineerMonths: 0,
          exitEgressBytes: 0,
        }),
      },
    }
    const ref = computeTco(input)
    const r = gradeTco({ ...goodTco(), input, recommendation: 'managed', claimedTotal: ref.lines.managed.total })
    expect(failedIds(r)).toEqual(['exit_costed'])
    expect(check(r, 'exit_costed').msg).toContain('both exit terms')
  })
})

describe('tco-desk: honest_answer grades the arithmetic, not the opinion', () => {
  it('fails a recommendation the learner own numbers contradict', () => {
    const r = gradeTco(goodTco({ recommendation: 'engine', claimedTotal: tcoRef.lines.engine.total }))
    const c = check(r, 'honest_answer')
    expect(c.pass).toBe(false)
    expect(failedIds(r)).toEqual(['honest_answer'])
    expect(c.msg).toContain('YOUR OWN numbers')
    expect(c.msg).toContain('engine')
    expect(c.msg).toContain('managed')
    expect(c.msg).toContain('engineer-months')
  })

  it('passes the SAME numbers with the recommendation the arithmetic supports', () => {
    const r = gradeTco(goodTco({ recommendation: 'managed', claimedTotal: tcoRef.lines.managed.total }))
    expect(check(r, 'honest_answer').pass).toBe(true)
    expect(failedIds(r)).toEqual([])
  })

  it('passes the contradicted recommendation once a non-cost reason is named', () => {
    const r = gradeTco(
      goodTco({
        recommendation: 'engine',
        claimedTotal: tcoRef.lines.engine.total,
        nonCostJustification: 'residency: the data cannot leave our own storage account',
      }),
    )
    expect(check(r, 'honest_answer').pass).toBe(true)
    expect(check(r, 'honest_answer').msg).toContain('residency')
  })

  it('has no opinion about which option is right — reverse the labour and the answer reverses', () => {
    const flipped: TcoInput = {
      ...TCO_BASE,
      options: {
        ...TCO_BASE.options,
        managed: counts({ computeUnitsPerMonth: 6_000, oneOffEngineerMonths: 3, ongoingOpsFte: 3.0 }),
        engine: counts({ computeUnitsPerMonth: 3_000, oneOffEngineerMonths: 18, ongoingOpsFte: 0.25 }),
      },
    }
    const ref = computeTco(flipped)
    expect(ref.cheapest).toBe('engine')
    const r = gradeTco({ ...goodTco(), input: flipped, recommendation: 'engine', claimedTotal: ref.lines.engine.total })
    expect(check(r, 'honest_answer').pass).toBe(true)
    const wrong = gradeTco({
      ...goodTco(),
      input: flipped,
      recommendation: 'managed',
      claimedTotal: ref.lines.managed.total,
    })
    expect(check(wrong, 'honest_answer').pass).toBe(false)
  })

  it('treats a total within the tie band as undecided by cost', () => {
    const tie: TcoInput = {
      ...TCO_BASE,
      options: { ...TCO_BASE.options, appliance: TCO_BASE.options.managed },
    }
    const ref = computeTco(tie)
    const r = gradeTco({ ...goodTco(), input: tie, recommendation: 'appliance', claimedTotal: ref.lines.appliance.total })
    expect(check(r, 'honest_answer').pass).toBe(true)
  })
})

/* ================================= dr-desk ================================= */

const DR_BASE: DrInput = {
  commitIntervalMinutes: 5,
  replicationIntervalMinutes: 15,
  ingestBytesPerDay: 900 * GIB,
  manifestEntries: 1_200_000,
  entriesRestoredPerMinute: 20_000,
  bytesCopiedPerMinute: 40 * GIB,
  bytesToRestore: 0,
  coordinationMinutes: 30,
  crossRegionCopies: 1,
  copiesHaveIndependentCatalog: true,
  reliesOnTimeTravel: false,
  metadataExportedIndependently: true,
  drillsCompleted: 2,
  drillCoveredMetadataLoss: true,
  drillEntriesRestored: 1_200_000,
}

const drRef = computeDr(DR_BASE)

const goodDr = (o: Partial<DrSubmission> = {}): DrSubmission => {
  const input = o.input ?? DR_BASE
  const ref = computeDr(input)
  return {
    input,
    claimedRpoMinutes: ref.rpoMinutes,
    claimedRtoMinutes: ref.rtoMinutes,
    metadataRecoveryPath: 'hourly manifest export to a separate account, replayed into the standby catalog',
    ...o,
  }
}

describe('dr-desk: contract', () => {
  it('emits exactly the registry check ids, verbatim and in order', () => {
    expect(ids(gradeDr(goodDr()))).toEqual(getDesk('dr-desk')!.checks)
    expect(getDesk('dr-desk')!.checks).toEqual(['rpo', 'rto', 'metadata_path', 'tested', 'cross_region'])
  })

  it('passes a plan with two domains, a stated metadata path and drills that cover it', () => {
    const r = gradeDr(goodDr())
    expect(failedIds(r)).toEqual([])
    expect(r.desk).toBe('dr-desk')
  })

  it('is deterministic', () => {
    expect(gradeDr(goodDr())).toEqual(gradeDr(goodDr()))
    expect(computeDr(DR_BASE)).toEqual(computeDr(DR_BASE))
  })
})

describe('dr-desk: the objectives are counts divided by measured rates', () => {
  it('an RPO is the replication window plus the commit in flight', () => {
    expect(drRef.rpoMinutes).toBe(20)
    expect(drRef.rpoCommits).toBe(4)
    expect(drRef.bytesAtRisk).toBeCloseTo((900 * GIB * 20) / 1440, 3)
  })

  it('an RTO is dominated by the manifest entry count, not the byte count', () => {
    expect(drRef.dataRestoreMinutes).toBe(0)
    expect(drRef.metadataRestoreMinutes).toBe(1_200_000 / 20_000)
    expect(drRef.metadataShareOfRto).toBeGreaterThan(0.5)
    /* Double the files at constant bytes and the RTO grows; that is the claim. */
    expect(computeDr({ ...DR_BASE, manifestEntries: 2_400_000 }).rtoMinutes).toBeGreaterThan(drRef.rtoMinutes)
  })

  it('bands the RPO on both sides', () => {
    expect(check(gradeDr(goodDr({ claimedRpoMinutes: 20 * 1.15 })), 'rpo').pass).toBe(true)
    expect(check(gradeDr(goodDr({ claimedRpoMinutes: 15 })), 'rpo').pass).toBe(false)
    expect(check(gradeDr(goodDr({ claimedRpoMinutes: 15 })), 'rpo').msg).toContain('in flight')
  })

  it('bands the RTO on both sides, and a metadata-free RTO is out of band', () => {
    expect(check(gradeDr(goodDr({ claimedRtoMinutes: drRef.rtoMinutes * 1.2 })), 'rto').pass).toBe(true)
    const coordinationOnly = gradeDr(goodDr({ claimedRtoMinutes: DR_BASE.coordinationMinutes }))
    expect(check(coordinationOnly, 'rto').pass).toBe(false)
    expect(check(coordinationOnly, 'rto').msg).toContain('manifest entries')
  })
})

describe('dr-desk: time travel is not backup', () => {
  it('fails metadata_path when the RPO rests on the same tree it would recover from', () => {
    const input: DrInput = { ...DR_BASE, reliesOnTimeTravel: true, metadataExportedIndependently: false }
    const r = gradeDr(goodDr({ input }))
    expect(failedIds(r)).toEqual(['metadata_path'])
    const c = check(r, 'metadata_path')
    expect(c.msg).toContain('time travel')
    expect(c.msg).toMatch(/same manifest tree|same metadata tree/)
  })

  it('names the one-domain arithmetic when nothing exports the tree', () => {
    const input: DrInput = {
      ...DR_BASE,
      metadataExportedIndependently: false,
      copiesHaveIndependentCatalog: false,
      reliesOnTimeTravel: true,
    }
    const out = computeDr(input)
    expect(out.metadataDomains).toBe(1)
    expect(out.dataDomains).toBe(2)
    expect(out.singleMetadataDomain).toBe(true)
    const c = check(gradeDr(goodDr({ input })), 'metadata_path')
    expect(c.pass).toBe(false)
    expect(c.msg).toContain('2 domains and you have 1')
  })

  it('fails metadata_path when the section is simply absent', () => {
    const r = gradeDr(goodDr({ metadataRecoveryPath: null }))
    expect(failedIds(r)).toEqual(['metadata_path'])
    expect(check(r, 'metadata_path').msg).toContain('metadata recovery path not stated')
    expect(check(r, 'metadata_path').msg).toMatch(/bucket, not a table/)
  })
})

describe('dr-desk: a plan never tested is not a plan', () => {
  it('fails tested at zero drills and says what makes it pass', () => {
    const r = gradeDr(goodDr({ input: { ...DR_BASE, drillsCompleted: 0 } }))
    expect(failedIds(r)).toEqual(['tested'])
    expect(check(r, 'tested').msg).toContain('0 restore drills')
    expect(check(r, 'tested').msg).toMatch(/not a plan, it is a document/)
  })

  it('fails tested when the drills never exercised metadata loss', () => {
    const r = gradeDr(goodDr({ input: { ...DR_BASE, drillCoveredMetadataLoss: false } }))
    expect(failedIds(r)).toEqual(['tested'])
    expect(check(r, 'tested').msg).toContain('METADATA loss')
  })

  it('fails tested when the drill ran on a toy table', () => {
    const r = gradeDr(goodDr({ input: { ...DR_BASE, drillEntriesRestored: 1_000 } }))
    expect(failedIds(r)).toEqual(['tested'])
    expect(check(r, 'tested').msg).toContain('manifest entries')
  })
})

describe('dr-desk: a copy is only a copy in another failure domain', () => {
  it('fails cross_region with no copy at all', () => {
    const input: DrInput = { ...DR_BASE, crossRegionCopies: 0 }
    const r = gradeDr(goodDr({ input }))
    expect(check(r, 'cross_region').pass).toBe(false)
    expect(check(r, 'cross_region').msg).toMatch(/durability is not availability/)
  })

  it('fails cross_region when the copies share one catalog', () => {
    const input: DrInput = { ...DR_BASE, copiesHaveIndependentCatalog: false }
    const r = gradeDr(goodDr({ input }))
    expect(failedIds(r)).toEqual(['cross_region'])
    expect(check(r, 'cross_region').msg).toMatch(/unnamed pile of Parquet/)
  })
})

/* ============================== house rules ============================== */

const SOURCES = ['capacity.ts', 'tco.ts', 'dr.ts'] as const

describe('house rules: no prices, ever', () => {
  it.each(SOURCES)('%s carries no currency symbol or currency word', (file) => {
    const src = readFileSync(join(SRC, file), 'utf8')
    /* Symbols. `$` alone is excluded: it is template-literal syntax in every line here. */
    expect(src).not.toMatch(/[£€¥₹¢]/)
    /* A symbol immediately in front of a figure is a price however it is spelled. */
    expect(src).not.toMatch(/\$\s*[\d.]/)
    expect(src).not.toMatch(/\b(USD|EUR|GBP|JPY)\b/)
    expect(src).not.toMatch(/\bdollars?\b/i)
    expect(src).not.toMatch(/\bper (?:GB|TB|month)-?(?:price|rate)\b/i)
  })

  it.each(SOURCES)('%s costs in counts and says so', (file) => {
    const src = readFileSync(join(SRC, file), 'utf8')
    expect(src.toLowerCase()).toContain('count')
  })

  it('the TCO model takes its rates from the caller rather than owning any', () => {
    const src = readFileSync(join(SRC, 'tco.ts'), 'utf8')
    expect(src).toContain('RateCard')
    expect(src).toMatch(/NOT prices/)
  })

  it('all three desks are registered at L500 with the ids the models report', () => {
    const l500 = DESKS.filter((d) => d.level === 500).map((d) => d.id)
    expect(l500).toEqual(['capacity-desk', 'tco-desk', 'dr-desk'])
  })
})

/* ============================ numerical hygiene ============================ */

describe('numerical hygiene: no NaN, no Infinity, no negative counts across a sweep', () => {
  const finiteAndSane = (o: unknown, label: string): void => {
    for (const n of numbers(o)) {
      expect(Number.isFinite(n), `${label}: ${n}`).toBe(true)
      expect(n, label).toBeGreaterThanOrEqual(0)
    }
  }

  it('capacity survives zeros, absurd growth and zero ceilings', () => {
    const hostile: Partial<CapacityInput>[] = [
      {},
      { liveBytes: 0 },
      { dataGrowthPerMonth: 0 },
      { dataGrowthPerMonth: 3 },
      { dataGrowthPerMonth: -0.5 },
      { targetFileBytes: 0 },
      { mergeFilesPerDay: 0 },
      { commitsPerDay: 0, writers: 0, partitionsPerCommit: 0 },
      { catalogEntryCeiling: 0 },
      { storageCeilingBytes: 0 },
      { instanceHourCeilingPerHour: 0 },
      { networkBytesPerDayCeiling: 0 },
      { ingestBytesPerDayCeiling: 0 },
      { horizonMonths: 0 },
      { horizonMonths: 120, snapshotRetentionMultiplier: 0 },
      { peakQueriesPerHour: 0, bytesScannedPerQuery: 0, instanceHoursPerQuery: 0 },
    ]
    for (const patch of hostile) {
      const input = { ...CATALOG_BOUND, ...patch }
      const out = computeCapacity(input)
      finiteAndSane(out, `capacity ${JSON.stringify(patch)}`)
      expect(COMPONENTS).toContain(out.firstLimit)
      const r = gradeCapacity({
        ...GOOD_CAPACITY,
        input,
        claimedHorizonBytes: out.horizonBytes,
        claimedPeakInstanceHours: out.horizonInstanceHours,
        claimedEntryCount: out.horizonEntries,
        claimedFirstLimit: out.firstLimit,
        claimedHeadroomMonths: out.headroomMonths,
      })
      expect(ids(r)).toEqual(getDesk('capacity-desk')!.checks)
      for (const c of r.checks) expect(c.msg).not.toContain('NaN')
    }
  })

  it('tco survives zero rates, zero counts and negative growth', () => {
    const hostile: Partial<OptionCounts>[] = [
      {},
      { storageBytes: 0, computeUnitsPerMonth: 0 },
      { storageGrowthPerMonth: 0 },
      { storageGrowthPerMonth: -0.9 },
      { computeGrowthPerMonth: 2 },
      { oneOffEngineerMonths: 0, ongoingOpsFte: 0 },
      { migrationEngineerMonths: 0, migrationParallelMonths: 0 },
      { exitEngineerMonths: 0, exitEgressBytes: 0, exitParallelMonths: 0 },
    ]
    const rateSweep = [RATES, { perByteMonth: 0, perComputeUnit: 0, perEngineerMonth: 0, perEgressByte: 0 }]
    for (const patch of hostile) {
      for (const rates of rateSweep) {
        for (const horizonMonths of [1, 12, 36, 60]) {
          const input: TcoInput = {
            horizonMonths,
            rates,
            options: {
              managed: counts(patch),
              engine: counts({ ...patch, ongoingOpsFte: 1.5 }),
              appliance: counts(patch),
            },
          }
          const out = computeTco(input)
          finiteAndSane(out, `tco ${JSON.stringify(patch)} h=${horizonMonths}`)
          const r = gradeTco({
            input,
            recommendation: out.cheapest,
            claimedTotal: out.lines[out.cheapest].total,
            statedOngoingOps: true,
            statedMigration: true,
            statedExit: true,
            nonCostJustification: null,
          })
          expect(ids(r)).toEqual(getDesk('tco-desk')!.checks)
          for (const c of r.checks) expect(c.msg).not.toContain('NaN')
        }
      }
    }
  })

  it('dr survives zero rates, zero entries and a zero commit interval', () => {
    const hostile: Partial<DrInput>[] = [
      {},
      { commitIntervalMinutes: 0 },
      { replicationIntervalMinutes: 0 },
      { manifestEntries: 0 },
      { entriesRestoredPerMinute: 0 },
      { bytesCopiedPerMinute: 0, bytesToRestore: 10 * TIB },
      { coordinationMinutes: 0 },
      { ingestBytesPerDay: 0 },
      { crossRegionCopies: 0, copiesHaveIndependentCatalog: false },
      { drillsCompleted: 0, drillEntriesRestored: 0 },
      { manifestEntries: 0, drillEntriesRestored: 0 },
    ]
    for (const patch of hostile) {
      const input = { ...DR_BASE, ...patch }
      const out = computeDr(input)
      finiteAndSane(out, `dr ${JSON.stringify(patch)}`)
      const r = gradeDr(goodDr({ input }))
      expect(ids(r)).toEqual(getDesk('dr-desk')!.checks)
      for (const c of r.checks) expect(c.msg).not.toContain('NaN')
    }
  })
})
