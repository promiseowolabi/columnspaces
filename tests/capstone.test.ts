/**
 * Capstone tests.
 *
 * The capstone is an aggregation, so there is exactly one thing here that could
 * be wrong in an interesting way: the artifact → dossier-field mapping. It is
 * DERIVED from the objection predicates rather than written down, and the whole
 * value of doing it that way is that it cannot drift from what the rooms
 * actually attack. These tests pin that property from both sides — every
 * objection's artifact is one of the four, every objection reads at least one
 * field, every field group lands on a known artifact or is provably read by
 * nobody — so that a hand-written table could not be substituted without
 * failing.
 *
 * Then the three claims the page makes to the learner:
 *   • the pass rule is "all five survived", INCLUDING the wounded case, which
 *     must pass and must still be reported as wounded;
 *   • an empty dossier is four incomplete artifacts and no POC plan;
 *   • a full dossier with a falsifier is a complete POC plan.
 *
 * All pure: no store, no DOM, no clock.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ROOMS, THE_VENDOR } from '@/data/rooms'
import type { Dossier, Objection } from '@/data/rooms'
import type { ArtifactId } from '@/data/lessons/types'
import { DOSSIER_FIELDS, DOSSIER_GROUPS } from '@/lib/rooms/dossier-fields'
import type { DossierKey } from '@/lib/rooms/dossier-fields'
import type { Verdict } from '@/lib/rooms/encounter'
import {
  ALL_OBJECTIONS,
  ARTIFACTS,
  ARTIFACT_IDS,
  ATTACKED_ARTIFACTS,
  CAPSTONE_SIM_ID,
  CAPSTONE_TASK_ID,
  POC_FIELDS,
  UNATTACKED_GROUPS,
  artifactMeta,
  artifactStanding,
  artifactStandings,
  artifactsForField,
  artifactsForGroup,
  capstoneVerdict,
  fieldsForArtifact,
  fieldsRead,
  objectionsForArtifact,
  pocStanding,
  roomStandings,
} from '@/lib/rooms/capstone'
import type { RoomRunLike } from '@/lib/rooms/capstone'

/* ------------------------------- fixtures ------------------------------- */

/** The four artifacts, as declared by the content model. */
const FOUR: ArtifactId[] = ['layout-design', 'scan-budget', 'platform-runbook', 'platform-memo']

/**
 * Every figure supplied and every gap closed — the desks' win condition. Same
 * shape as the FULL fixture in tests/room-encounter.test.ts; kept local so the
 * two suites cannot break each other.
 */
const FULL: Dossier = {
  logicalBytes: 40e12,
  dailyScanBytes: 1.2e12,
  worstQueryBytes: 0.4e12,
  pricingShape: 'consumption-bytes',
  growthModelled: true,
  growthRate: 1.5,
  compressionRatio: 6,
  compressionMeasured: true,
  partitionKey: 'event_date',
  sortKey: 'event_ts',
  partitionCardinality: 365,
  promisedPruningRatio: 0.9,
  pruningMeasured: true,
  targetFileSizeBytes: 128e6,
  fileCount: 120_000,
  worstQueryStated: true,
  ingestMode: 'micro-batch',
  batchIntervalSec: 300,
  stalenessP99Sec: 240,
  freshnessSlaSec: 300,
  compactionKeepsUp: true,
  writeAmplification: 3,
  readAmplification: 1.2,
  compactionAutomated: true,
  expiryWindowDays: 7,
  maintenanceCosted: true,
  tenants: 40,
  tenancyModel: 'shared-table-filter',
  costAttribution: true,
  noisyNeighbourControl: true,
  horizonMonths: 24,
  firstBottleneck: 'catalog',
  peakConcurrency: 60,
  headroomFactor: 1.3,
  choice: 'engine-on-object-store',
  threeYearTotal: 2_400_000,
  statedOngoingOps: true,
  opsEngineerMonths: 18,
  migrationCost: 300_000,
  exitCost: 450_000,
  openFormat: true,
  retentionPolicyDays: 400,
  erasurePath: true,
  lineageEvidence: true,
  regions: 3,
  residencyRequired: true,
  schemaContract: true,
  querySloDefined: true,
  querySloP95Sec: 4,
  qualityAlerting: true,
  runbookExists: true,
  onCallRotation: true,
  pocDefined: true,
  pocMetrics: ['bytes read per query', 'p95 at real concurrency', 'update path under our change rate'],
  pocFalsifier: true,
  benchmarkedOurselves: true,
  vendorNumbersQuoted: false,
}

const runs = (m: Record<string, Verdict>): Record<string, RoomRunLike> =>
  Object.fromEntries(Object.entries(m).map(([id, v]) => [id, { attempts: 1, bestVerdict: v }]))

const allRooms = (v: Verdict): Record<string, RoomRunLike> =>
  runs(Object.fromEntries(ROOMS.map((r) => [r.id, v])))

/* =================== the mapping is derived, not duplicated =================== */

describe('artifact → field mapping is derived', () => {
  it('every objection attacks one of the four artifacts', () => {
    expect(ALL_OBJECTIONS.length).toBeGreaterThan(0)
    for (const o of ALL_OBJECTIONS) {
      expect(FOUR, `${o.id} attacks unknown artifact ${o.artifact}`).toContain(o.artifact)
    }
    /* And the display list is exactly those four, in some order. */
    expect([...ARTIFACT_IDS].sort()).toEqual([...FOUR].sort())
    expect(ARTIFACTS.map((a) => a.id)).toEqual(ARTIFACT_IDS)
    for (const id of ARTIFACT_IDS) expect(artifactMeta(id)?.name, id).toBeTruthy()
  })

  it('all four artifacts are actually attacked by at least one objection', () => {
    expect([...ATTACKED_ARTIFACTS].sort()).toEqual([...FOUR].sort())
    for (const id of ARTIFACT_IDS) {
      expect(objectionsForArtifact(id).length, `${id} has no objections`).toBeGreaterThan(0)
    }
  })

  /**
   * The anti-hardcode assertion. Every objection is a pure predicate over the
   * dossier, so if it reads NO field the derivation is broken (or the objection
   * is a constant, which would be worse).
   */
  it('every objection reads at least one dossier field, found by counterfactual', () => {
    for (const o of ALL_OBJECTIONS) {
      expect(fieldsRead(o).length, `${o.id} reads no dossier field`).toBeGreaterThan(0)
    }
  })

  /**
   * The mapping is the union of what the artifact's objections read — computed
   * here independently of the implementation, from the objections themselves. If
   * anyone replaces the derivation with a table, this fails.
   */
  it('an artifact is exactly the union of the fields its objections read', () => {
    for (const id of ARTIFACT_IDS) {
      const expected = new Set(objectionsForArtifact(id).flatMap(fieldsRead))
      expect(new Set(fieldsForArtifact(id)), id).toEqual(expected)
      /* And it is returned in dossier order, so the page reads like the editor. */
      const order = DOSSIER_FIELDS.map((f) => f.key).filter((k) => expected.has(k))
      expect(fieldsForArtifact(id), `${id} field order`).toEqual(order)
    }
  })

  it('a field an objection only quotes back at you is not part of the artifact', () => {
    /*
     * THE_CFO names your partition key and THE_PRINCIPAL names your sort key in
     * `ask()`, but only one of them FIRES on the key. `partitionKey` decides
     * nothing anywhere, so it belongs to no artifact — while
     * `partitionCardinality`, which is the actual predicate, belongs to the
     * layout design.
     */
    expect(artifactsForField('partitionKey')).toEqual([])
    expect(artifactsForField('partitionCardinality')).toEqual(['layout-design'])
  })

  it('the fields a critical objection reads belong to that objection’s artifact', () => {
    for (const o of ALL_OBJECTIONS.filter((x) => x.severity === 3)) {
      for (const k of fieldsRead(o)) {
        expect(artifactsForField(k), `${o.id} reads ${k}`).toContain(o.artifact)
      }
    }
  })

  it('every field group maps to known artifacts, or is read by nobody', () => {
    const readByAnyone = new Set(ALL_OBJECTIONS.flatMap(fieldsRead))
    for (const g of DOSSIER_GROUPS) {
      const mapped = artifactsForGroup(g)
      for (const id of mapped) expect(FOUR, `${g.id} → ${id}`).toContain(id)

      const touched = g.fields.some((f) => readByAnyone.has(f.key))
      if (mapped.length === 0) {
        /* Unmapped is allowed — but only because nothing reads it. Never by omission. */
        expect(touched, `${g.id} is unmapped but its fields ARE read by an objection`).toBe(false)
        expect(UNATTACKED_GROUPS.map((x) => x.id), `${g.id} missing from UNATTACKED_GROUPS`).toContain(g.id)
      } else {
        expect(touched, `${g.id} maps to ${mapped.join(',')} but nothing reads its fields`).toBe(true)
        expect(UNATTACKED_GROUPS.map((x) => x.id)).not.toContain(g.id)
      }
    }
  })

  it('the unattacked groups are exactly the ones no objection reads', () => {
    const readByAnyone = new Set<DossierKey>(ALL_OBJECTIONS.flatMap(fieldsRead))
    const expected = DOSSIER_GROUPS.filter((g) => !g.fields.some((f) => readByAnyone.has(f.key))).map(
      (g) => g.id,
    )
    expect(UNATTACKED_GROUPS.map((g) => g.id)).toEqual(expected)
    /* Non-empty today: the tenancy desk's figures are not read by any room. */
    expect(UNATTACKED_GROUPS.length).toBeGreaterThan(0)
  })

  it('no field is invented — every mapped key is a real dossier field', () => {
    const known = new Set(DOSSIER_FIELDS.map((f) => f.key))
    for (const id of ARTIFACT_IDS) {
      for (const k of fieldsForArtifact(id)) expect(known, `${id} → ${k}`).toContain(k)
    }
  })

  it('the derivation is stable across calls (memoised, not recomputed differently)', () => {
    for (const o of ALL_OBJECTIONS) expect(fieldsRead(o)).toEqual(fieldsRead(o))
    for (const id of ARTIFACT_IDS) expect(fieldsForArtifact(id)).toEqual(fieldsForArtifact(id))
  })
})

/* ============================ artifact standing ============================ */

describe('artifact standing', () => {
  it('an empty dossier leaves all four artifacts incomplete, with everything blank', () => {
    const standings = artifactStandings({})
    expect(standings).toHaveLength(4)
    for (const a of standings) {
      expect(a.complete, `${a.meta.id} should not be complete on an empty dossier`).toBe(false)
      expect(a.submitted, `${a.meta.id} submitted`).toEqual([])
      expect(a.blank.length, `${a.meta.id} blank`).toBe(a.fields.length)
      expect(a.fields.length, `${a.meta.id} has no fields`).toBeGreaterThan(0)
      expect(a.objections, `${a.meta.id} objections`).toBeGreaterThan(0)
      expect(a.groups.length, `${a.meta.id} provenance`).toBeGreaterThan(0)
    }
    /* Nothing complete anywhere is the point of an empty dossier. */
    expect(standings.filter((a) => a.complete)).toEqual([])
  })

  it('a full dossier completes all four and fires nothing', () => {
    const standings = artifactStandings(FULL)
    for (const a of standings) {
      expect(a.complete, `${a.meta.id} should be complete`).toBe(true)
      expect(a.blank, `${a.meta.id} blank`).toEqual([])
      expect(a.firing, `${a.meta.id} firing`).toEqual([])
      expect(a.critical, `${a.meta.id} critical`).toBe(0)
    }
  })

  it('completeness tracks submission field by field, and firing follows the predicates', () => {
    const partial: Dossier = { ...FULL }
    delete partial.pocDefined
    const memo = artifactStanding('platform-memo', partial)
    expect(memo.complete).toBe(false)
    expect(memo.blank).toEqual(['pocDefined'])
    expect(memo.firing.map((o) => o.id)).toContain('poc_undefined')
    expect(memo.critical).toBe(1)

    /* Other artifacts are untouched by that one blank. */
    expect(artifactStanding('layout-design', partial).complete).toBe(true)
  })

  it('firing objections are worst-severity first', () => {
    for (const a of artifactStandings({})) {
      const sev = a.firing.map((o: Objection) => o.severity)
      expect([...sev].sort((x, y) => y - x), `${a.meta.id} order`).toEqual(sev)
    }
  })

  it('a group only ever contributes the fields that feed that artifact', () => {
    for (const a of artifactStandings(FULL)) {
      const own = new Set(a.fields)
      for (const g of a.groups) {
        expect(g.fields.length).toBeGreaterThan(0)
        for (const k of g.fields) expect(own, `${a.meta.id} ← ${k}`).toContain(k)
      }
      /* The groups partition the artifact's fields exactly. */
      expect(a.groups.flatMap((g) => g.fields).sort()).toEqual([...a.fields].sort())
    }
  })
})

/* ============================== the pass rule ============================== */

describe('the pass rule', () => {
  it('passes only when all five rooms have been survived', () => {
    const v = capstoneVerdict(roomStandings(FULL, allRooms('survived')))
    expect(v.rooms).toBe(5)
    expect(v.survived).toBe(5)
    expect(v.passed).toBe(true)
    expect(v.withWounds).toBe(false)
    expect(v.wounded).toBe(0)
    expect(v.lost).toEqual([])
    expect(v.unattempted).toEqual([])
  })

  it('four of five is not a pass', () => {
    const m = Object.fromEntries(ROOMS.map((r) => [r.id, 'survived' as Verdict]))
    delete m[THE_VENDOR.id]
    const v = capstoneVerdict(roomStandings(FULL, runs(m)))
    expect(v.survived).toBe(4)
    expect(v.passed).toBe(false)
    expect(v.unattempted).toEqual([THE_VENDOR.id])
  })

  it('a wounded survival still passes — and is still reported as wounded', () => {
    const m = Object.fromEntries(ROOMS.map((r) => [r.id, 'survived' as Verdict]))
    m[THE_VENDOR.id] = 'survived-wounded'
    const v = capstoneVerdict(roomStandings(FULL, runs(m)))
    expect(v.passed, 'wounded survival is survival').toBe(true)
    expect(v.withWounds, 'and it must not be rounded up').toBe(true)
    expect(v.wounded).toBe(1)
    expect(v.lost).toEqual([])
  })

  it('all five wounded passes, wounded in all five', () => {
    const v = capstoneVerdict(roomStandings(FULL, allRooms('survived-wounded')))
    expect(v.passed).toBe(true)
    expect(v.withWounds).toBe(true)
    expect(v.wounded).toBe(5)
  })

  it('a lost room blocks the pass and is named', () => {
    const m = Object.fromEntries(ROOMS.map((r) => [r.id, 'survived' as Verdict]))
    m['the-cfo'] = 'lost'
    const v = capstoneVerdict(roomStandings(FULL, runs(m)))
    expect(v.passed).toBe(false)
    expect(v.lost).toEqual(['the-cfo'])
    expect(v.survived).toBe(4)
  })

  it('an untouched store is five unattempted rooms and no pass', () => {
    const standings = roomStandings({}, {})
    const v = capstoneVerdict(standings)
    expect(v.passed).toBe(false)
    expect(v.survived).toBe(0)
    expect(v.unattempted).toHaveLength(5)
    expect(v.lost).toEqual([])
    for (const s of standings) {
      expect(s.attempts).toBe(0)
      expect(s.bestVerdict).toBeUndefined()
      expect(s.survived).toBe(false)
    }
  })

  it('room standing carries the live objection counts, not the stored ones', () => {
    const empty = roomStandings({}, {})
    const full = roomStandings(FULL, {})
    /* An empty dossier takes heat everywhere; a complete one takes none. */
    expect(empty.reduce((n, s) => n + s.firing, 0)).toBeGreaterThan(0)
    expect(full.reduce((n, s) => n + s.firing, 0)).toBe(0)
    for (const s of empty) expect(s.firing).toBeLessThanOrEqual(s.room.objections.length)
  })
})

/* ============================ the honest ending ============================ */

describe('the honest ending', () => {
  it('the POC spine is three real dossier fields', () => {
    expect(POC_FIELDS).toEqual(['pocDefined', 'pocMetrics', 'pocFalsifier'])
    const known = new Set(DOSSIER_FIELDS.map((f) => f.key))
    for (const k of POC_FIELDS) expect(known).toContain(k)
  })

  it('an empty dossier shows the POC section as missing', () => {
    const p = pocStanding({})
    expect(p.status).toBe('missing')
    expect(p.defined).toBe(false)
    expect(p.hasMetrics).toBe(false)
    expect(p.falsifier).toBe(false)
    expect(p.metrics).toEqual([])
    expect(p.blank).toEqual(POC_FIELDS)
  })

  it('a full dossier with a falsifier shows the POC as complete', () => {
    const p = pocStanding(FULL)
    expect(p.status).toBe('complete')
    expect(p.defined).toBe(true)
    expect(p.hasMetrics).toBe(true)
    expect(p.falsifier).toBe(true)
    expect(p.metrics.length).toBeGreaterThan(0)
    expect(p.blank).toEqual([])
  })

  it('a plan with no falsifier is never complete, however much else is stated', () => {
    const d: Dossier = { ...FULL }
    delete d.pocFalsifier
    const p = pocStanding(d)
    expect(p.status).toBe('partial')
    expect(p.falsifier).toBe(false)
    expect(p.blank).toEqual(['pocFalsifier'])

    /* Explicitly answering "no" is not a falsifier either. */
    expect(pocStanding({ ...FULL, pocFalsifier: false }).status).toBe('partial')
    expect(pocStanding({ ...FULL, pocFalsifier: false }).blank).toEqual([])
  })

  it('an empty metric list is not a metric list', () => {
    expect(pocStanding({ ...FULL, pocMetrics: [] }).hasMetrics).toBe(false)
    expect(pocStanding({ ...FULL, pocMetrics: [] }).status).toBe('partial')
  })

  it('it mirrors THE_VENDOR’s severity-3 poc_undefined, on the same field', () => {
    const o = THE_VENDOR.objections.find((x) => x.id === 'poc_undefined')
    expect(o, 'poc_undefined has been renamed or removed').toBeDefined()
    expect(o!.severity).toBe(3)
    expect(o!.artifact).toBe('platform-memo')
    expect(fieldsRead(o!)).toEqual(['pocDefined'])
    /* Blank → the objection fires and the section reports no plan. */
    expect(o!.fires({})).toBe(true)
    expect(pocStanding({}).defined).toBe(false)
    /* Stated → it stops firing and the section agrees. */
    expect(o!.fires({ pocDefined: true })).toBe(false)
    expect(pocStanding({ pocDefined: true }).defined).toBe(true)
  })

  it('the falsifier is the one field the rooms do not check — so the capstone must', () => {
    /*
     * This is why the honest ending exists as a section rather than as another
     * objection: nothing in the five rooms fires on `pocFalsifier`, so a learner
     * can survive every room without ever naming a result that would change
     * their recommendation. The capstone says so instead of implying it.
     */
    expect(artifactsForField('pocFalsifier')).toEqual([])
    expect(artifactsForField('pocMetrics')).toEqual([])
    expect(artifactsForField('pocDefined')).toEqual(['platform-memo'])
  })
})

/* ============================== completion ============================== */

describe('completion recording', () => {
  it('records through the ordinary sim-task channel, with stable ids', () => {
    expect(CAPSTONE_SIM_ID).toBe('capstone')
    expect(CAPSTONE_TASK_ID).toBe('platform-decision')
  })

  it('the page records only when the pass rule is met', () => {
    /* The condition the page's effect guards on, asserted directly. */
    expect(capstoneVerdict(roomStandings({}, {})).passed).toBe(false)
    expect(capstoneVerdict(roomStandings(FULL, allRooms('survived-wounded'))).passed).toBe(true)
    expect(capstoneVerdict(roomStandings(FULL, allRooms('lost'))).passed).toBe(false)
  })
})

/* ============================== no overclaim ============================== */

describe('the capstone does not overclaim', () => {
  it('adds no grading of its own — every verdict it shows comes from the rooms', () => {
    /*
     * Structural: the module may aggregate and it may import the graders, but it
     * must not define an outcome or a wound rule. If a new predicate lands here,
     * the architecture half has two graders and they will disagree.
     */
    const src = new URL('../src/lib/rooms/capstone.ts', import.meta.url).pathname
    const text = readFileSync(src, 'utf8')
    expect(text).not.toMatch(/WOUND_BUDGET\s*=/)
    expect(text).not.toMatch(/outcome\s*===\s*'fatal'/)
    expect(text).toContain("from './encounter'")
  })

  it('states cost as counts, never as a clock or a price', () => {
    const a = artifactStanding('scan-budget', FULL)
    /* Everything the standing reports is a count of things, not a duration. */
    expect(Number.isInteger(a.objections)).toBe(true)
    expect(Number.isInteger(a.critical)).toBe(true)
    expect(Number.isInteger(a.submitted.length)).toBe(true)
  })
})
