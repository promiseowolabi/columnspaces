/**
 * Room encounter tests.
 *
 * `tests/rooms.test.ts` protects the objection trees themselves. This file
 * protects the machinery that turns them into a graded encounter, which has
 * three claims worth failing a build over:
 *
 *   1. the dossier is durable — numbers submitted at a desk must survive a
 *      reload and ride the export snapshot, or nobody can be attacked next week
 *      for what they wrote today.
 *   2. the room is exactly the dossier — the encounter faces precisely the
 *      objections whose predicates fire, and ONE changed field changes the set.
 *      That is the architecture half's central claim; if it breaks, the rooms
 *      are a quiz in costume.
 *   3. the verdict rule is the stated rule — a fatal on a critical objection
 *      loses the room, and wounds are survivable once and fatal in aggregate.
 *
 * The attribution tests are the interesting ones: "why am I facing this?" is
 * computed from the predicates by counterfactual rather than declared in a table,
 * so these assert that the fields named really do retire the objection.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ROOMS, THE_CFO, THE_CONSUMER, THE_PRINCIPAL, THE_STEWARD, THE_VENDOR, objectionsFor } from '@/data/rooms'
import type { Dossier, Objection, Outcome } from '@/data/rooms'
import {
  WOUND_BUDGET,
  answerFor,
  attribution,
  criticalFatals,
  isSilentRoom,
  runState,
  sensitiveFields,
  standing,
  verdictFor,
  woundLoad,
} from '@/lib/rooms/encounter'
import type { Answer } from '@/lib/rooms/encounter'
import { DOSSIER_FIELDS, DOSSIER_GROUPS, blankKeys, dossierField, fieldLabel, filledKeys } from '@/lib/rooms/dossier-fields'

/* ------------------------------- fixtures ------------------------------- */

/**
 * A dossier with every figure supplied and every gap closed. It should fire
 * nothing anywhere — which is the desks' win condition, not a bug.
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
  pocMetrics: ['bytes read per query', 'p95 at real concurrency'],
  pocFalsifier: true,
  benchmarkedOurselves: true,
  vendorNumbersQuoted: false,
}

const answers = (...specs: [severity: 1 | 2 | 3, outcome: Outcome][]): Answer[] =>
  specs.map(([severity, outcome], i) => ({
    objectionId: `o${i}`,
    responseId: `r${i}`,
    outcome,
    severity,
  }))

/* --------------------------- the field registry --------------------------- */

describe('the dossier field registry', () => {
  it('describes every field the room predicates and asks actually read', () => {
    /* Drift guard. A new `d.someField` in a predicate with no registry entry is a
       field the learner can never submit, which silently makes an objection
       unanswerable. Read the source rather than trusting a hand-kept list. */
    const src = readFileSync(new URL('../src/data/rooms.ts', import.meta.url), 'utf8')
    const used = new Set([...src.matchAll(/\bd\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    expect(used.size, 'the regex found no dossier reads — did rooms.ts change shape?').toBeGreaterThan(20)

    const known = new Set(DOSSIER_FIELDS.map((f) => f.key as string))
    const missing = [...used].filter((k) => !known.has(k))
    expect(missing, `fields read by rooms.ts but not editable: ${missing.join(', ')}`).toEqual([])
  })

  it('keys are unique, grouped once, and labelled in prose', () => {
    const keys = DOSSIER_FIELDS.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const f of DOSSIER_FIELDS) {
      expect(dossierField(f.key)?.key).toBe(f.key)
      expect(fieldLabel(f.key), `${f.key} label`).not.toBe(f.key)
      /* Silence is a submission, so every field must say what its blank costs. */
      expect(f.silence.length, `${f.key} silence`).toBeGreaterThan(20)
      expect(f.probes.length, `${f.key} probes`).toBeGreaterThanOrEqual(2)
      expect(f.probes, `${f.key} must probe omission`).toContain(undefined)
      if (f.kind === 'enum') expect(f.options?.length, `${f.key} options`).toBeGreaterThan(1)
    }
  })

  it('groups name where the numbers came from', () => {
    expect(DOSSIER_GROUPS.length).toBeGreaterThanOrEqual(8)
    for (const g of DOSSIER_GROUPS) {
      expect(g.fields.length, `${g.id} is empty`).toBeGreaterThan(0)
      expect(g.provenance.length, `${g.id} provenance`).toBeGreaterThan(20)
    }
  })

  it('filled and blank keys partition the registry', () => {
    expect(filledKeys({}).length).toBe(0)
    expect(blankKeys({}).length).toBe(DOSSIER_FIELDS.length)
    expect(filledKeys(FULL).length + blankKeys(FULL).length).toBe(DOSSIER_FIELDS.length)
    expect(blankKeys(FULL)).toEqual([])
  })
})

/* ------------------------------ the encounter ------------------------------ */

describe('the encounter faces exactly what fires', () => {
  it('the queue is the fired set, worst severity first', () => {
    const run = runState(THE_CFO, {}, [])
    expect(run.queue.map((o) => o.id)).toEqual(objectionsFor(THE_CFO, {}).map((o) => o.id))
    const sev = run.queue.map((o) => o.severity)
    expect(sev).toEqual([...sev].sort((a, b) => b - a))
    expect(run.cursor).toBe(0)
    expect(run.complete).toBe(false)
  })

  it('an objection that does not fire is never presented', () => {
    const d: Dossier = { dailyScanBytes: 1.2e12, growthModelled: true }
    const ids = runState(THE_CFO, d, []).queue.map((o) => o.id)
    expect(ids).not.toContain('daily_scan_unbudgeted')
    expect(ids).not.toContain('no_growth_term')
    for (const id of ids) {
      const o = THE_CFO.objections.find((x) => x.id === id)!
      expect(o.fires(d), `${id} is queued but does not fire`).toBe(true)
    }
  })

  it('the cursor advances one objection at a time and completes', () => {
    const queue = objectionsFor(THE_VENDOR, {})
    expect(queue.length).toBeGreaterThan(1)
    const given: Answer[] = []
    for (let i = 0; i < queue.length; i += 1) {
      const run = runState(THE_VENDOR, {}, given)
      expect(run.cursor).toBe(i)
      expect(run.complete).toBe(false)
      const survive = queue[i].responses.find((r) => r.outcome === 'survive') ?? queue[i].responses[0]
      given.push(answerFor(queue[i], survive.id)!)
    }
    const done = runState(THE_VENDOR, {}, given)
    expect(done.complete).toBe(true)
    expect(done.cursor).toBe(-1)
  })

  it('a full dossier faces fewer objections than an empty one, in every room', () => {
    for (const room of ROOMS) {
      const empty = objectionsFor(room, {}).length
      const full = objectionsFor(room, FULL).length
      expect(empty, `${room.id} fires nothing at an empty dossier`).toBeGreaterThan(0)
      expect(full, `${room.id}: full ${full} vs empty ${empty}`).toBeLessThan(empty)
    }
    expect(standing(ROOMS, {}).firing).toBeGreaterThan(standing(ROOMS, FULL).firing)
    expect(standing(ROOMS, FULL).critical).toBe(0)
  })

  it('a dossier that closes every gap makes the rooms silent', () => {
    for (const room of ROOMS) expect(isSilentRoom(room, FULL), `${room.id}`).toBe(true)
    expect(isSilentRoom(THE_CFO, {})).toBe(false)
  })

  /**
   * THE claim, on a different field and a different room from the one
   * rooms.test.ts pins — so the property is tested, not one lucky predicate.
   */
  it('changing ONE field changes the room you walk into', () => {
    const oneRegion: Dossier = { ...FULL, regions: 1 }
    const before = runState(THE_STEWARD, FULL, []).queue.map((o) => o.id)
    const after = runState(THE_STEWARD, oneRegion, []).queue.map((o) => o.id)
    expect(before).toEqual([])
    expect(after).toEqual(['residency_unaddressed'])
  })

  it('one changed field can also be the difference between a survivable room and a lost one', () => {
    /* Staleness above the SLA the business asked for is a critical objection. */
    const slow: Dossier = { ...FULL, stalenessP99Sec: 3600 }
    const ids = runState(THE_CONSUMER, slow, []).queue.map((o) => o.id)
    expect(ids).toEqual(['freshness_gap'])
    const o = THE_CONSUMER.objections.find((x) => x.id === 'freshness_gap')!
    expect(o.ask(slow)).toContain('3,600')
  })
})

/* ------------------------------- attribution ------------------------------- */

describe('why am I facing this?', () => {
  it('every firing objection names at least one dossier field that decided it', () => {
    for (const room of ROOMS) {
      for (const o of objectionsFor(room, {})) {
        const fields = sensitiveFields(o, {})
        expect(fields.length, `${room.id}/${o.id} has no attribution`).toBeGreaterThan(0)
      }
    }
  })

  it('the named fields really do retire the objection — attribution is computed, not asserted', () => {
    const o = THE_CFO.objections.find((x) => x.id === 'daily_scan_unbudgeted')!
    const keys = sensitiveFields(o, {})
    expect(keys).toContain('dailyScanBytes')
    for (const k of keys) {
      const field = dossierField(k)!
      const flips = field.probes.some((p) => o.fires({ [k]: p } as Dossier) !== o.fires({}))
      expect(flips, `${k} was named but changes nothing`).toBe(true)
    }
  })

  it('splits the reason into what you submitted and what you left blank', () => {
    const empty = attribution(THE_CFO.objections.find((x) => x.id === 'daily_scan_unbudgeted')!, {})
    expect(empty.omitted).toContain('dailyScanBytes')
    expect(empty.submitted).toEqual([])

    /* A high promised pruning ratio is an objection you talked yourself into. */
    const d: Dossier = { promisedPruningRatio: 0.95 }
    const bold = attribution(THE_CFO.objections.find((x) => x.id === 'pruning_promised_not_measured')!, d)
    expect(bold.submitted).toContain('promisedPruningRatio')
    expect(bold.omitted).toContain('pruningMeasured')
  })

  it('a field the predicate never reads is never blamed', () => {
    const o = THE_PRINCIPAL.objections.find((x) => x.id === 'partition_cardinality_bomb')!
    const keys = sensitiveFields(o, { partitionCardinality: 50_000 })
    expect(keys).toContain('partitionCardinality')
    expect(keys).not.toContain('threeYearTotal')
    expect(keys).not.toContain('onCallRotation')
  })
})

/* -------------------------------- verdicts -------------------------------- */

describe('the verdict rule', () => {
  it('all survive is a clean win', () => {
    expect(verdictFor(answers([3, 'survive'], [2, 'survive'], [1, 'survive']))).toBe('survived')
    expect(woundLoad(answers([3, 'survive']))).toBe(0)
  })

  it('a fatal on a severity-3 objection loses the room outright', () => {
    expect(verdictFor(answers([3, 'fatal']))).toBe('lost')
    /* Even surrounded by wins. There is no credit for the rest of the meeting. */
    expect(verdictFor(answers([3, 'survive'], [3, 'fatal'], [2, 'survive'], [1, 'survive']))).toBe('lost')
    expect(criticalFatals(answers([3, 'fatal'], [2, 'fatal']))).toHaveLength(1)
  })

  it('one wound is survivable', () => {
    expect(WOUND_BUDGET).toBe(1)
    expect(verdictFor(answers([3, 'survive'], [2, 'wounded']))).toBe('survived-wounded')
    expect(woundLoad(answers([2, 'wounded']))).toBe(1)
  })

  it('wounds are fatal in aggregate — two concessions lose the room', () => {
    expect(verdictFor(answers([2, 'wounded'], [1, 'wounded']))).toBe('lost')
    expect(woundLoad(answers([2, 'wounded'], [1, 'wounded']))).toBe(2)
  })

  it('a non-critical fatal counts as two wounds, so it loses on its own', () => {
    expect(verdictFor(answers([2, 'fatal']))).toBe('lost')
    expect(verdictFor(answers([1, 'fatal']))).toBe('lost')
    expect(woundLoad(answers([1, 'fatal']))).toBe(2)
  })

  it('an unanswered run is provisionally clean, and the provisional verdict can already be lost', () => {
    const empty = runState(THE_VENDOR, {}, [])
    expect(empty.verdict).toBe('survived')
    expect(empty.complete).toBe(false)

    const critical = objectionsFor(THE_VENDOR, {}).find((o) => o.severity === 3)!
    const fatal = critical.responses.find((r) => r.outcome === 'fatal')!
    const mid = runState(THE_VENDOR, {}, [answerFor(critical, fatal.id)!])
    expect(mid.verdict).toBe('lost')
    expect(mid.complete).toBe(false)
  })

  it('answerFor reads the outcome from the room, never from the page', () => {
    const o: Objection = THE_CFO.objections[0]
    const a = answerFor(o, o.responses[0].id)!
    expect(a.outcome).toBe(o.responses[0].outcome)
    expect(a.severity).toBe(o.severity)
    expect(answerFor(o, 'no-such-response')).toBeUndefined()
  })

  it('a real run through an empty dossier can be won, and every critical objection is winnable', () => {
    /* If a room cannot be survived from a blank dossier by answering well, the
       encounter is a trap rather than an adversary. */
    for (const room of ROOMS) {
      const queue = objectionsFor(room, {})
      const given = queue.map((o) => answerFor(o, o.responses.find((r) => r.outcome === 'survive')!.id)!)
      expect(verdictFor(given), `${room.id} is unwinnable`).toBe('survived')
    }
  })
})

/* ------------------------- persistence in the store ------------------------- */

/**
 * A localStorage stand-in. The store persists through `window.localStorage`, so
 * the shim has to be reachable there — and it has to be installed BEFORE the
 * store module is imported, because zustand resolves its storage once at
 * creation. Hence the dynamic import below rather than a static one.
 */
const memStorage = () => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

const storage = memStorage()
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { localStorage: storage })
const { useProgress, exportProgress, XP } = await import('@/lib/progress')

describe('the dossier persists like everything else in the store', () => {
  it('starts empty and takes one field at a time', () => {
    expect(useProgress.getState().dossier).toEqual({})
    useProgress.getState().setDossierField('dailyScanBytes', 1.2e12)
    useProgress.getState().setDossierField('partitionKey', 'event_date')
    expect(useProgress.getState().dossier.dailyScanBytes).toBe(1.2e12)
    expect(useProgress.getState().dossier.partitionKey).toBe('event_date')
  })

  it('a blank UNSETS rather than storing undefined — omission must be indistinguishable', () => {
    useProgress.getState().setDossierField('partitionKey', '')
    const d = useProgress.getState().dossier
    expect('partitionKey' in d).toBe(false)
    useProgress.getState().setDossierField('dailyScanBytes', undefined)
    expect('dailyScanBytes' in useProgress.getState().dossier).toBe(false)
  })

  it('setDossier merges a patch and unsets undefined keys', () => {
    useProgress.getState().setDossier({ regions: 3, residencyRequired: true })
    expect(useProgress.getState().dossier.regions).toBe(3)
    useProgress.getState().setDossier({ regions: undefined })
    expect('regions' in useProgress.getState().dossier).toBe(false)
    expect(useProgress.getState().dossier.residencyRequired).toBe(true)
  })

  it('a dossier round-trips through a reload — the persisted namespace carries it', async () => {
    useProgress.getState().setDossier({ promisedPruningRatio: 0.95, pruningMeasured: false, sortKey: 'event_ts' })
    const raw = storage.getItem('columnspaces:v1')
    expect(raw, 'nothing was persisted').toBeTruthy()
    const parsed = JSON.parse(raw!) as { state: { dossier: Dossier } }
    expect(parsed.state.dossier.promisedPruningRatio).toBe(0.95)
    expect(parsed.state.dossier.sortKey).toBe('event_ts')

    /* Reload: drop the module and let a fresh store hydrate from the same bytes. */
    vi.resetModules()
    const reloaded = await import('@/lib/progress')
    const after = reloaded.useProgress.getState().dossier
    expect(after.promisedPruningRatio).toBe(0.95)
    expect(after.pruningMeasured).toBe(false)
    expect(after.sortKey).toBe('event_ts')
  })

  it('the dossier rides the export snapshot and comes back through import', () => {
    useProgress.getState().setDossier({ erasurePath: true, exitCost: 450_000 })
    const snapshot = exportProgress()
    const parsed = JSON.parse(snapshot) as { dossier: Dossier; rooms: Record<string, unknown> }
    expect(parsed.dossier.erasurePath).toBe(true)
    expect(parsed.dossier.exitCost).toBe(450_000)
    expect(parsed.rooms).toBeDefined()

    useProgress.getState().clearDossier()
    expect(useProgress.getState().dossier).toEqual({})
    expect(useProgress.getState().importProgress(snapshot)).toBe(true)
    expect(useProgress.getState().dossier.erasurePath).toBe(true)
    expect(useProgress.getState().dossier.exitCost).toBe(450_000)
  })

  it('an older snapshot with no dossier still imports, and lands on an empty one', () => {
    const legacy = JSON.stringify({
      version: 1,
      lessons: {},
      sims: {},
      labs: {},
      fleetWeek: { actsDone: [], scores: {} },
      capstone: { step: 0, stepsDone: [] },
      xp: 300,
      streakDays: [],
      achievements: [],
      settings: {},
    })
    expect(useProgress.getState().importProgress(legacy)).toBe(true)
    expect(useProgress.getState().dossier).toEqual({})
    expect(useProgress.getState().xp).toBe(300)
  })

  it('room runs record outcomes, keep the best verdict, and pay XP once', () => {
    const outcomes: Record<string, Outcome> = { daily_scan_unbudgeted: 'fatal' }
    useProgress.getState().recordRoomRun('the-cfo', 'lost', outcomes)
    expect(useProgress.getState().rooms['the-cfo'].attempts).toBe(1)
    expect(useProgress.getState().rooms['the-cfo'].bestVerdict).toBe('lost')
    expect(useProgress.getState().rooms['the-cfo'].lastOutcomes).toEqual(outcomes)

    const before = useProgress.getState().xp
    useProgress.getState().recordRoomRun('the-cfo', 'survived-wounded', { daily_scan_unbudgeted: 'wounded' })
    expect(useProgress.getState().xp).toBe(before + XP.room)
    expect(useProgress.getState().rooms['the-cfo'].bestVerdict).toBe('survived-wounded')
    expect(useProgress.getState().rooms['the-cfo'].survivedAt).toBeDefined()

    /* A second survival is a replay, not a second reward. */
    useProgress.getState().recordRoomRun('the-cfo', 'survived', { daily_scan_unbudgeted: 'survive' })
    expect(useProgress.getState().xp).toBe(before + XP.room)
    expect(useProgress.getState().rooms['the-cfo'].bestVerdict).toBe('survived')
    expect(useProgress.getState().rooms['the-cfo'].attempts).toBe(3)

    /* Losing a room you had already survived does not erase that you survived it. */
    useProgress.getState().recordRoomRun('the-cfo', 'lost', {})
    expect(useProgress.getState().rooms['the-cfo'].bestVerdict).toBe('survived')
  })

  it('resetProgress clears the dossier and the room runs with everything else', () => {
    useProgress.getState().setDossierField('exitCost', 1)
    useProgress.getState().resetProgress()
    expect(useProgress.getState().dossier).toEqual({})
    expect(useProgress.getState().rooms).toEqual({})
  })
})
