/**
 * Room tests.
 *
 * These exist to protect the architecture half's central design bet. The rooms
 * claim to be adversaries rather than quizzes in costume, and there is exactly
 * one test for that claim:
 *
 *   change ONE number in a dossier, and a different objection must appear.
 *
 * If that ever stops holding, the objection trees have become a reading
 * exercise with extra steps and the course has lost its distinctive claim.
 */

import { describe, expect, it } from 'vitest'
import {
  ROOMS,
  THE_CFO,
  THE_VENDOR,
  criticalObjections,
  getRoom,
  objectionsFor,
} from '@/data/rooms'
import type { Dossier } from '@/data/rooms'
import { DESKS } from '@/lib/desks'

const ARTIFACTS = new Set(['layout-design', 'scan-budget', 'platform-runbook', 'platform-memo'])

describe('room structure', () => {
  it('five rooms, unique ids, resolvable by id', () => {
    expect(ROOMS).toHaveLength(5)
    const ids = ROOMS.map((r) => r.id)
    expect(new Set(ids).size).toBe(5)
    for (const id of ids) expect(getRoom(id)?.id).toBe(id)
  })

  it('each room has an adversary, a role, an opening and a closing', () => {
    for (const r of ROOMS) {
      expect(r.adversary.length).toBeGreaterThan(3)
      expect(r.role.length).toBeGreaterThanOrEqual(3) /* 'CFO' */
      expect(r.opening.length, `${r.id} opening sets the register`).toBeGreaterThan(80)
      expect(r.closing.length, `${r.id} closing`).toBeGreaterThan(60)
    }
  })

  it('objection ids are unique within a room and attack a real artifact', () => {
    for (const r of ROOMS) {
      const ids = r.objections.map((o) => o.id)
      expect(new Set(ids).size, `${r.id} duplicate objection ids`).toBe(ids.length)
      for (const o of r.objections) expect(ARTIFACTS, `${r.id}/${o.id}`).toContain(o.artifact)
    }
  })

  it('every room has at least one critical objection', () => {
    for (const r of ROOMS) {
      expect(r.objections.filter((o) => o.severity === 3).length, `${r.id}`).toBeGreaterThan(0)
    }
  })

  /**
   * A severity-3 objection with no surviving answer is an unwinnable room, which
   * is not adversarial teaching, it is a trap.
   */
  it('every severity-3 objection offers at least one surviving response', () => {
    for (const r of ROOMS) {
      for (const o of r.objections.filter((x) => x.severity === 3)) {
        const survivable = o.responses.some((res) => res.outcome === 'survive')
        expect(survivable, `${r.id}/${o.id} is unwinnable`).toBe(true)
      }
    }
  })

  it('every objection offers at least one non-surviving response with a teaching rebuttal', () => {
    for (const r of ROOMS) {
      for (const o of r.objections) {
        expect(o.responses.length, `${r.id}/${o.id} response count`).toBeGreaterThanOrEqual(2)
        expect(
          o.responses.some((res) => res.outcome !== 'survive'),
          `${r.id}/${o.id} has no wrong answer`,
        ).toBe(true)
        for (const res of o.responses) {
          /* The rebuttal must teach, not just score. */
          expect(res.rebuttal.length, `${r.id}/${o.id}/${res.id} rebuttal`).toBeGreaterThan(60)
          expect(res.label.length, `${r.id}/${o.id}/${res.id} label`).toBeGreaterThan(20)
        }
      }
    }
  })

  it('the ask is a function of the dossier and never throws on an empty one', () => {
    for (const r of ROOMS) {
      for (const o of r.objections) {
        expect(() => o.ask({}), `${r.id}/${o.id} ask({})`).not.toThrow()
        expect(o.ask({}).length, `${r.id}/${o.id} ask text`).toBeGreaterThan(40)
        expect(() => o.fires({}), `${r.id}/${o.id} fires({})`).not.toThrow()
      }
    }
  })
})

describe('objections are predicates over the dossier', () => {
  it('an empty dossier fires the gap-hunting objections', () => {
    /* A partial dossier is a realistic dossier, and the gaps are what adversaries hunt for. */
    const fired = objectionsFor(THE_CFO, {})
    expect(fired.length).toBeGreaterThan(0)
    expect(fired.map((o) => o.id)).toContain('daily_scan_unbudgeted')
  })

  it('supplying the missing number retires the objection it was hunting', () => {
    const before = objectionsFor(THE_CFO, {}).map((o) => o.id)
    const after = objectionsFor(THE_CFO, { dailyScanBytes: 1.2e12, growthModelled: true }).map((o) => o.id)
    expect(before).toContain('daily_scan_unbudgeted')
    expect(after).not.toContain('daily_scan_unbudgeted')
  })

  /** THE test. One number changes; the room changes with it. */
  it('changing ONE number changes which objections fire', () => {
    const base: Dossier = {
      dailyScanBytes: 1.2e12,
      growthModelled: true,
      promisedPruningRatio: 0.5,
      pruningMeasured: true,
    }
    const ambitious: Dossier = { ...base, promisedPruningRatio: 0.95, pruningMeasured: false }

    const a = new Set(objectionsFor(THE_CFO, base).map((o) => o.id))
    const b = new Set(objectionsFor(THE_CFO, ambitious).map((o) => o.id))
    expect(b.has('pruning_promised_not_measured')).toBe(true)
    expect(a.has('pruning_promised_not_measured')).toBe(false)
  })

  it('objections are returned worst-first', () => {
    const fired = objectionsFor(THE_CFO, {})
    const severities = fired.map((o) => o.severity)
    expect(severities).toEqual([...severities].sort((x, y) => y - x))
  })

  it('predicates are pure: the same dossier always produces the same room', () => {
    const d: Dossier = { dailyScanBytes: 4e12, exitCost: undefined, choice: 'managed-warehouse' }
    const first = objectionsFor(THE_CFO, d).map((o) => o.id)
    const second = objectionsFor(THE_CFO, d).map((o) => o.id)
    expect(first).toEqual(second)
  })

  it('criticalObjections returns only severity-3 objections that fired', () => {
    const crit = criticalObjections(THE_CFO, {})
    for (const o of crit) expect(o.severity).toBe(3)
  })
})

describe('the vendor room carries the course’s honesty test', () => {
  /**
   * columnspaces deep-dives a platform it cannot run. The learner must be able
   * to say what a POC would measure and what result would change their mind —
   * so an undefined POC has to be a critical objection, by construction.
   */
  it('an undefined POC is a critical objection', () => {
    const o = THE_VENDOR.objections.find((x) => x.id === 'poc_undefined')
    expect(o, 'poc_undefined objection exists').toBeDefined()
    expect(o!.severity).toBe(3)
    expect(o!.fires({})).toBe(true)
    expect(o!.fires({ pocDefined: true })).toBe(false)
  })

  it('quoting vendor numbers as your own is critical and retired by measuring yourself', () => {
    const o = THE_VENDOR.objections.find((x) => x.id === 'vendor_numbers_as_ours')
    expect(o).toBeDefined()
    expect(o!.severity).toBe(3)
    expect(o!.fires({ vendorNumbersQuoted: true })).toBe(true)
    expect(o!.fires({ vendorNumbersQuoted: true, benchmarkedOurselves: true })).toBe(false)
  })
})

describe('desks', () => {
  it('ids are unique and every desk grades named checks', () => {
    const ids = DESKS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const d of DESKS) {
      expect(d.checks.length, `${d.id} checks`).toBeGreaterThanOrEqual(4)
      expect(new Set(d.checks).size, `${d.id} duplicate checks`).toBe(d.checks.length)
      expect(d.takeaway, `${d.id} takeaway has a number`).toMatch(/\d/)
      expect(d.decision.endsWith('?'), `${d.id} decision is a question`).toBe(true)
    }
  })

  it('desks span the 300–500 levels', () => {
    const levels = new Set(DESKS.map((d) => d.level))
    expect(levels.has(300)).toBe(true)
    expect(levels.has(400)).toBe(true)
    expect(levels.has(500)).toBe(true)
  })
})
