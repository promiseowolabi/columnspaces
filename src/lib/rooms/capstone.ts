/**
 * capstone.ts — the course's ending, computed.
 *
 * The capstone adds NO grading of its own. Every judgement it displays already
 * exists somewhere else and is imported: the objection predicates from
 * `@/data/rooms`, the verdict rule from `./encounter`, the field presentation
 * contract from `./dossier-fields`, the attempt history from the progress store.
 * This module only aggregates — which is the honest shape for an ending, because
 * a capstone that introduced a new grader would be new content pretending to be
 * a conclusion.
 *
 * ── The one thing here that is not a lookup ────────────────────────────────
 * The artifact → dossier-field mapping is DERIVED, not written down. Each
 * objection declares which artifact it attacks (`Objection.artifact`) and is a
 * pure predicate over the dossier, so the fields an artifact is made of can be
 * computed: perturb one field at a time and see whether the predicate moves.
 * The alternative — a hand-written table of `'scan-budget': ['dailyScanBytes',
 * …]` — is a second copy of the truth, and second copies drift. Here the mapping
 * cannot drift, because there is nothing to drift from: it is a function of the
 * predicates themselves. Same technique, and same reason, as `sensitiveFields`
 * in `./encounter`.
 *
 * Consequences worth naming, because they are visible in the UI:
 *   • A field no objection reads belongs to no artifact. That is not a bug, it
 *     is a fact about the current objection trees, and the page says so.
 *   • An artifact is "complete" only in the weak sense that every field feeding
 *     it has been submitted. It does not mean the numbers are right. Nothing in
 *     this course can tell you that; only a measurement can.
 *
 * Pure and deterministic throughout: no RNG, no clock, no storage. Cost is a
 * count of fields, objections and rooms — never a duration, never a price.
 */

import { ROOMS, objectionsFor } from '@/data/rooms'
import type { Dossier, Objection, Room } from '@/data/rooms'
import type { ArtifactId, RoomId } from '@/data/lessons/types'
import { DOSSIER_FIELDS, DOSSIER_GROUPS } from './dossier-fields'
import type { DossierGroup, DossierKey, DossierValue } from './dossier-fields'
import { verdictSurvived } from './encounter'
import type { Verdict } from './encounter'

/* ------------------------------ the artifacts ------------------------------ */

export interface ArtifactMeta {
  id: ArtifactId
  name: string
  /** What the artifact is for, in one line. Presentation only — never a mapping. */
  question: string
}

/**
 * The four things a learner finishes the course holding. This list is display
 * order and prose; it deliberately contains NO field lists. Which fields feed
 * which artifact is computed below from the objections.
 */
export const ARTIFACTS: ArtifactMeta[] = [
  {
    id: 'scan-budget',
    name: 'Scan budget',
    question:
      'how many bytes this workload reads in a day, what the worst recurring query reads, and what both do as the table grows.',
  },
  {
    id: 'layout-design',
    name: 'Layout design',
    question:
      'the partition key, the sort key, the file size — and the query this layout is deliberately bad for.',
  },
  {
    id: 'platform-runbook',
    name: 'Platform runbook',
    question:
      'what consumers may expect, what maintenance costs, and the tested path by which one subject is erased.',
  },
  {
    id: 'platform-memo',
    name: 'Platform memo',
    question:
      'one recommendation, its three-year total, the computed cost of leaving, and what a proof-of-concept would have to measure.',
  },
]

export const ARTIFACT_IDS: ArtifactId[] = ARTIFACTS.map((a) => a.id)

export function artifactMeta(id: ArtifactId): ArtifactMeta | undefined {
  return ARTIFACTS.find((a) => a.id === id)
}

/** Every objection in the course, across all five rooms. */
export const ALL_OBJECTIONS: Objection[] = ROOMS.flatMap((r) => r.objections)

/** Artifacts that at least one objection actually attacks. Derived. */
export const ATTACKED_ARTIFACTS: ArtifactId[] = ARTIFACT_IDS.filter((id) =>
  ALL_OBJECTIONS.some((o) => o.artifact === id),
)

/* --------------------------- derived field mapping --------------------------- */

function withField(d: Dossier, key: DossierKey, value: DossierValue): Dossier {
  return { ...d, [key]: value } as Dossier
}

/**
 * Three baselines to probe from, because dependence can hide behind a guard.
 *
 * `residency_unaddressed` fires on `residencyRequired === true && regions < 2`.
 * From an empty dossier, moving `regions` alone changes nothing — the first
 * clause is false either way — so probing from one baseline would report that
 * the objection does not read `regions`, which is wrong. Probing from a baseline
 * where the guard is open finds it. `first` takes each field's first stated
 * probe, `last` its last (which for booleans is `false` and for the numeric
 * fields is the value on the far side of the threshold), so between the three
 * every predicate in the course has at least one baseline where each field it
 * reads can move the answer. `tests/capstone.test.ts` pins that: no objection is
 * allowed to read nothing.
 */
function probeBaselines(): Dossier[] {
  const first: Dossier = {}
  const last: Dossier = {}
  for (const f of DOSSIER_FIELDS) {
    const stated = f.probes.filter((p) => p !== undefined)
    if (stated.length === 0) continue
    Object.assign(first, { [f.key]: stated[0] })
    Object.assign(last, { [f.key]: stated[stated.length - 1] })
  }
  return [{}, first, last]
}

const BASELINES: Dossier[] = probeBaselines()

/** Memoised per objection — the predicates are pure, so the answer is stable. */
const READS = new WeakMap<Objection, DossierKey[]>()

/**
 * Which dossier fields this objection actually reads, found by counterfactual.
 *
 * A field is read if, from at least one baseline, replacing it with one of its
 * declared probe values flips the predicate. Note what this excludes: fields an
 * objection merely quotes back at you in `ask()` (the CFO names your partition
 * key, but does not fire on it) are not part of the artifact, because they do not
 * decide anything.
 */
export function fieldsRead(objection: Objection): DossierKey[] {
  const memo = READS.get(objection)
  if (memo) return memo
  const out: DossierKey[] = []
  for (const f of DOSSIER_FIELDS) {
    const reads = BASELINES.some((base) => {
      const now = objection.fires(base)
      return f.probes.some(
        (p) => p !== base[f.key] && objection.fires(withField(base, f.key, p)) !== now,
      )
    })
    if (reads) out.push(f.key)
  }
  READS.set(objection, out)
  return out
}

/** Objections attacking one artifact, across every room. */
export function objectionsForArtifact(id: ArtifactId): Objection[] {
  return ALL_OBJECTIONS.filter((o) => o.artifact === id)
}

/**
 * The fields that make up an artifact: the union of what its objections read,
 * in dossier order so the page reads like the editor.
 */
export function fieldsForArtifact(id: ArtifactId): DossierKey[] {
  const keys = new Set(objectionsForArtifact(id).flatMap(fieldsRead))
  return DOSSIER_FIELDS.map((f) => f.key).filter((k) => keys.has(k))
}

/** Artifacts one field feeds. Usually one; `exitCost` feeds the memo twice over. */
export function artifactsForField(key: DossierKey): ArtifactId[] {
  return ARTIFACT_IDS.filter((id) => fieldsForArtifact(id).includes(key))
}

/** Artifacts a desk's group of numbers feeds. Empty means no objection reads it. */
export function artifactsForGroup(group: DossierGroup): ArtifactId[] {
  const keys = new Set(group.fields.map((f) => f.key))
  return ARTIFACT_IDS.filter((id) => fieldsForArtifact(id).some((k) => keys.has(k)))
}

/**
 * Groups no artifact is made of — i.e. numbers no adversary currently attacks.
 * Derived, not declared, and shown to the learner rather than hidden: the
 * tenancy desk produces real figures that the five present rooms happen not to
 * read, and claiming otherwise would be the exact overclaim this course is about.
 */
export const UNATTACKED_GROUPS: DossierGroup[] = DOSSIER_GROUPS.filter(
  (g) => artifactsForGroup(g).length === 0,
)

/* ---------------------------- artifact standing ---------------------------- */

export interface ArtifactGroupStanding {
  group: DossierGroup
  /** Only the group's fields that feed THIS artifact. */
  fields: DossierKey[]
  submitted: number
}

export interface ArtifactStanding {
  meta: ArtifactMeta
  fields: DossierKey[]
  submitted: DossierKey[]
  blank: DossierKey[]
  /** Where the numbers come from, so the page can name the desk. */
  groups: ArtifactGroupStanding[]
  /** Objections attacking this artifact at all. */
  objections: number
  /** Objections firing against this dossier, worst-severity first. */
  firing: Objection[]
  critical: number
  /**
   * Every feeding field submitted. Complete means STATED, not correct — no part
   * of this course can tell you a number is right.
   */
  complete: boolean
}

export function artifactStanding(id: ArtifactId, d: Dossier): ArtifactStanding {
  const fields = fieldsForArtifact(id)
  const firing = ROOMS.flatMap((r) => objectionsFor(r, d))
    .filter((o) => o.artifact === id)
    .sort((a, b) => b.severity - a.severity)
  const groups: ArtifactGroupStanding[] = DOSSIER_GROUPS.map((group) => {
    const own = group.fields.map((f) => f.key).filter((k) => fields.includes(k))
    return { group, fields: own, submitted: own.filter((k) => d[k] !== undefined).length }
  }).filter((g) => g.fields.length > 0)

  return {
    meta: artifactMeta(id) ?? { id, name: id, question: '' },
    fields,
    submitted: fields.filter((k) => d[k] !== undefined),
    blank: fields.filter((k) => d[k] === undefined),
    groups,
    objections: objectionsForArtifact(id).length,
    firing,
    critical: firing.filter((o) => o.severity === 3).length,
    complete: fields.length > 0 && fields.every((k) => d[k] !== undefined),
  }
}

export function artifactStandings(d: Dossier): ArtifactStanding[] {
  return ARTIFACT_IDS.map((id) => artifactStanding(id, d))
}

/* ------------------------------ room standing ------------------------------ */

/** The shape the capstone needs out of `ProgressState.rooms`, and no more. */
export interface RoomRunLike {
  attempts?: number
  bestVerdict?: Verdict
}

export interface RoomStanding {
  room: Room
  /** Objections firing against the dossier as it stands right now. */
  firing: number
  critical: number
  attempts: number
  bestVerdict?: Verdict
  /** Best verdict is anything other than a loss. Never attempted is not survived. */
  survived: boolean
  wounded: boolean
}

export function roomStandings(d: Dossier, runs: Record<string, RoomRunLike>): RoomStanding[] {
  return ROOMS.map((room) => {
    const firing = objectionsFor(room, d)
    const run = runs[room.id]
    const best = run?.bestVerdict
    return {
      room,
      firing: firing.length,
      critical: firing.filter((o) => o.severity === 3).length,
      attempts: run?.attempts ?? 0,
      bestVerdict: best,
      survived: best !== undefined && verdictSurvived(best),
      wounded: best === 'survived-wounded',
    }
  })
}

/* -------------------------------- the verdict -------------------------------- */

export interface CapstoneVerdict {
  rooms: number
  survived: number
  /** Rooms survived carrying a wound. Passing with these is still passing. */
  wounded: number
  /** Attempted and lost. */
  lost: RoomId[]
  /** Never entered. A room you have not walked into is not a room you survived. */
  unattempted: RoomId[]
  /** THE PASS RULE: every room survived, on any verdict that is not `lost`. */
  passed: boolean
  /** Passed, but not cleanly. Said out loud rather than rounded up. */
  withWounds: boolean
}

export function capstoneVerdict(standings: readonly RoomStanding[]): CapstoneVerdict {
  const survived = standings.filter((s) => s.survived)
  const passed = standings.length > 0 && survived.length === standings.length
  const wounded = survived.filter((s) => s.wounded).length
  return {
    rooms: standings.length,
    survived: survived.length,
    wounded,
    lost: standings.filter((s) => s.bestVerdict === 'lost').map((s) => s.room.id),
    unattempted: standings.filter((s) => s.bestVerdict === undefined).map((s) => s.room.id),
    passed,
    withWounds: passed && wounded > 0,
  }
}

/* ------------------------------ the honest ending ------------------------------ */

/**
 * The three fields the ending turns on. `pocDefined` is what THE_VENDOR's
 * severity-3 `poc_undefined` reads; the other two are what a defined POC has to
 * contain to be worth anything. `pocFalsifier` is the load-bearing one: a plan
 * with no result that would change the recommendation is not an evaluation.
 */
export const POC_FIELDS: DossierKey[] = ['pocDefined', 'pocMetrics', 'pocFalsifier']

export type PocStatus = 'missing' | 'partial' | 'complete'

export interface PocStanding {
  status: PocStatus
  defined: boolean
  metrics: string[]
  hasMetrics: boolean
  /** A stated result that would make the team decline. Falsifiability. */
  falsifier: boolean
  /** Did the team measure the platform themselves? Almost always false here. */
  benchmarkedOurselves: boolean
  /** Are vendor-published figures being carried as if they were ours? */
  vendorNumbersQuoted: boolean
  /** Fields of the three still blank. */
  blank: DossierKey[]
}

export function pocStanding(d: Dossier): PocStanding {
  const metrics = d.pocMetrics ?? []
  const defined = d.pocDefined === true
  const hasMetrics = metrics.length > 0
  const falsifier = d.pocFalsifier === true
  const stated = [defined, hasMetrics, falsifier].filter(Boolean).length
  const status: PocStatus = stated === 3 ? 'complete' : stated === 0 ? 'missing' : 'partial'
  return {
    status,
    defined,
    metrics,
    hasMetrics,
    falsifier,
    benchmarkedOurselves: d.benchmarkedOurselves === true,
    vendorNumbersQuoted: d.vendorNumbersQuoted === true,
    blank: POC_FIELDS.filter((k) => d[k] === undefined),
  }
}

/* -------------------------------- completion -------------------------------- */

/**
 * Completion is recorded through the ordinary sim-task channel rather than a new
 * store field: the rooms already award the XP, so the capstone records the fact
 * and nothing else.
 */
export const CAPSTONE_SIM_ID = 'capstone'
export const CAPSTONE_TASK_ID = 'platform-decision'
