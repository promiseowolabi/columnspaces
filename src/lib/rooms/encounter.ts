/**
 * encounter.ts — turning a dossier into a graded room.
 *
 * The grading model itself lives in `@/data/rooms` (the predicates, the
 * responses, the three-valued outcomes) and is NOT duplicated here or in the
 * page. This module adds only the three things a page needs on top of it:
 *
 *   1. the queue     — which objections fire, worst-severity first, one at a
 *                      time. That is `objectionsFor`, re-exported unchanged.
 *   2. the verdict   — how a sequence of outcomes adds up to winning or losing
 *                      the room. See WOUND_BUDGET below for the exact rule.
 *   3. attribution   — "why am I facing this?", computed by counterfactual
 *                      rather than declared, so it cannot drift.
 *
 * Everything here is pure and deterministic: no RNG, no clock, no storage. The
 * same dossier always faces the same room and always earns the same verdict,
 * which is what makes an attempt reviewable by someone who was not there.
 */

import { objectionsFor } from '@/data/rooms'
import type { Dossier, Objection, Outcome, Room } from '@/data/rooms'
import { DOSSIER_FIELDS, dossierField } from './dossier-fields'
import type { DossierKey, DossierValue } from './dossier-fields'

export { objectionsFor }

/* -------------------------------- the run -------------------------------- */

/** One answered objection. Enough to replay and audit a run. */
export interface Answer {
  objectionId: string
  responseId: string
  outcome: Outcome
  severity: 1 | 2 | 3
}

export type Verdict = 'survived' | 'survived-wounded' | 'lost'

/**
 * ── THE AGGREGATION RULE ──────────────────────────────────────────────────
 * Stated explicitly because a grading rule that lives only in code is a rule
 * nobody agreed to.
 *
 *   • A `fatal` on a severity-3 objection loses the room outright. One is
 *     enough: a critical objection is critical precisely because there is no
 *     credit for the rest of the meeting once you have exposed a cost you never
 *     modelled.
 *   • Every other bad outcome contributes WOUNDS:
 *         wounded                    → 1 wound
 *         fatal on severity 1 or 2   → 2 wounds
 *     A non-critical fatal is worth two because it is strictly worse than
 *     conceding ground — you were wrong, not merely vague.
 *   • WOUND_BUDGET = 1. Carry one wound and you leave the room standing, marked
 *     `survived-wounded`. Accumulate two or more and the room is lost. This is
 *     the literal reading of the model in `@/data/rooms`: "wounded — survivable
 *     once; fatal in aggregate."
 *
 * Two consequences worth naming: two `wounded` answers lose the room even though
 * neither was fatal, and one non-critical `fatal` loses it on its own (2 wounds).
 * Both are intended. `tests/room-encounter.test.ts` pins all of it.
 */
export const WOUND_BUDGET = 1

const WOUNDS: Record<Outcome, number> = { survive: 0, wounded: 1, fatal: 2 }

export function woundsFor(a: Answer): number {
  return WOUNDS[a.outcome]
}

/** Total wound load carried by a run. Critical fatals are handled separately. */
export function woundLoad(answers: readonly Answer[]): number {
  return answers.reduce((n, a) => n + woundsFor(a), 0)
}

/** Fatal outcomes on severity-3 objections — each one loses the room by itself. */
export function criticalFatals(answers: readonly Answer[]): Answer[] {
  return answers.filter((a) => a.outcome === 'fatal' && a.severity === 3)
}

export function verdictFor(answers: readonly Answer[]): Verdict {
  if (criticalFatals(answers).length > 0) return 'lost'
  const load = woundLoad(answers)
  if (load > WOUND_BUDGET) return 'lost'
  return load === 0 ? 'survived' : 'survived-wounded'
}

export const verdictSurvived = (v: Verdict): boolean => v !== 'lost'

/** Build an Answer from an objection and the id of the response chosen. */
export function answerFor(objection: Objection, responseId: string): Answer | undefined {
  const response = objection.responses.find((r) => r.id === responseId)
  if (!response) return undefined
  return {
    objectionId: objection.id,
    responseId: response.id,
    outcome: response.outcome,
    severity: objection.severity,
  }
}

export interface RunState {
  /** Objections that fired, worst-severity first. */
  queue: Objection[]
  answers: Answer[]
  /** Index of the objection currently on the table, or -1 when the run is over. */
  cursor: number
  complete: boolean
  /** Provisional until `complete` — a run can already be lost mid-meeting. */
  verdict: Verdict
  wounds: number
}

/** Fold a dossier plus the answers given so far into everything a page renders. */
export function runState(room: Room, d: Dossier, answers: readonly Answer[]): RunState {
  const queue = objectionsFor(room, d)
  const answered = new Set(answers.map((a) => a.objectionId))
  const next = queue.findIndex((o) => !answered.has(o.id))
  return {
    queue,
    answers: [...answers],
    cursor: next,
    complete: next === -1,
    verdict: verdictFor(answers),
    wounds: woundLoad(answers),
  }
}

/**
 * An empty room. It happens: a dossier complete enough to fire nothing is the
 * intended win condition of the desks, and the page must say so rather than
 * render a blank meeting.
 */
export const isSilentRoom = (room: Room, d: Dossier): boolean => objectionsFor(room, d).length === 0

/* ------------------------------ attribution ------------------------------ */

function withField(d: Dossier, key: DossierKey, value: DossierValue): Dossier {
  return { ...d, [key]: value } as Dossier
}

/**
 * "Why am I facing this?" — answered by counterfactual, not by a lookup table.
 *
 * A field is *sensitive* for an objection if perturbing that one field to one of
 * its declared probe values flips the predicate. Because the predicates are pure
 * functions of the dossier, this is exact: the fields returned are, by
 * construction, the ones that decide whether this objection appears. Change one
 * of them and you face a different room — which is the whole pedagogical claim
 * of the architecture half, computed rather than asserted.
 */
export function sensitiveFields(objection: Objection, d: Dossier): DossierKey[] {
  const now = objection.fires(d)
  const out: DossierKey[] = []
  for (const f of DOSSIER_FIELDS) {
    for (const probe of f.probes) {
      if (probe === d[f.key]) continue
      if (objection.fires(withField(d, f.key, probe)) !== now) {
        out.push(f.key)
        break
      }
    }
  }
  return out
}

export interface Attribution {
  /** Fields that decide this objection, split by whether you submitted them. */
  submitted: DossierKey[]
  /** Fields you left blank. Omission is a submission, and this is it being read. */
  omitted: DossierKey[]
}

export function attribution(objection: Objection, d: Dossier): Attribution {
  const keys = sensitiveFields(objection, d)
  return {
    submitted: keys.filter((k) => d[k] !== undefined),
    omitted: keys.filter((k) => d[k] === undefined),
  }
}

/**
 * How much heat one blank (or one number) is generating across every room.
 * Drives the editor: a field is not "optional", it is a field with a count of
 * objections currently hanging off it.
 */
export function objectionsTurningOn(rooms: readonly Room[], d: Dossier, key: DossierKey): number {
  const field = dossierField(key)
  if (!field) return 0
  let n = 0
  for (const room of rooms) {
    for (const o of room.objections) {
      if (!o.fires(d)) continue
      for (const probe of field.probes) {
        if (probe === d[key]) continue
        if (!o.fires(withField(d, key, probe))) {
          n += 1
          break
        }
      }
    }
  }
  return n
}

/* -------------------------------- summary -------------------------------- */

export interface DossierStanding {
  filled: number
  total: number
  /** Objections firing right now, summed across all five rooms. */
  firing: number
  critical: number
}

export function standing(rooms: readonly Room[], d: Dossier): DossierStanding {
  let firing = 0
  let critical = 0
  for (const room of rooms) {
    for (const o of objectionsFor(room, d)) {
      firing += 1
      if (o.severity === 3) critical += 1
    }
  }
  return {
    filled: DOSSIER_FIELDS.filter((f) => d[f.key] !== undefined).length,
    total: DOSSIER_FIELDS.length,
    firing,
    critical,
  }
}
