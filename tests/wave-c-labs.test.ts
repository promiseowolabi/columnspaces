/**
 * Wave C browser labs — model tests for `merge-policy` and `shuffle-planner`.
 *
 * Neither lab's arithmetic is restated here. Both modules are imported and
 * executed, so a bug in the production model fails this suite — which is the only
 * arrangement worth having, because these two labs make claims that would be
 * embarrassing to get wrong in front of a reader who checks:
 *
 *   merge-policy    read amplification and write amplification move in OPPOSITE
 *                   directions, and a dual constraint is satisfiable by a small
 *                   minority of policies rather than by dragging a dial to its end.
 *
 *   shuffle-planner the broadcast/partition crossover is exactly the arithmetic
 *                   `small × (w − 1) < probe`, and skew changes which worker holds
 *                   the bytes without changing a single byte total.
 *
 * ── The assertion style ────────────────────────────────────────────────────
 * Cost claims in bands and by direction; correctness claims as absolutes. The
 * merge model's row accounting (physical − tombstoned = live, checked after every
 * commit) is asserted exactly, in every policy, on every workload. The
 * amplification figures are asserted as orderings and ranges, because they are
 * outputs of a model whose constants are stated rather than measured.
 *
 * The crossover is the exception that proves the rule: it is asserted EXACTLY,
 * against a brute-force sweep, because it is arithmetic rather than a cost model.
 * A closed form that is nearly right is worse than no closed form at all.
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MergePolicyLab from '@/components/browserlabs/MergePolicyLab'
import ShufflePlannerLab from '@/components/browserlabs/ShufflePlannerLab'
import {
  COMMITS,
  DELETE_POS_BYTES,
  FOOTER_BYTES,
  OPENING_POLICY,
  POLICY_GRID,
  REFERENCE_TARGET_ROWS,
  REFERENCE_WORKLOAD,
  ROW_BYTES,
  TARGETS,
  TARGET_CHOICES,
  TRIGGER_CHOICES,
  WORKLOADS,
  amplificationCorrelation,
  bestReadPolicy,
  bestWritePolicy,
  commitSequence,
  meetsTargets,
  policyKey,
  policyReport,
  policySweep,
  runPolicy,
  solvingPolicies,
  strandedTarget,
  strandedTargets,
  targetAxis,
  triggerAxis,
  workloadSpec,
} from '@/lib/merge/policy'
import {
  JOINS,
  OPENING_JOIN,
  PLAN_IDS,
  WORKER_CHOICES,
  atWorkers,
  comparePlans,
  costPlan,
  crossoverHotShare,
  crossoverPick,
  crossoverSmallSideBytes,
  crossoverWorkers,
  flippingJoins,
  joinStats,
  skewToleratedJoins,
  skewedChoice,
  stableJoins,
  uniformChoice,
} from '@/lib/shuffle/plan'
import { DELETE_POS_BYTES as ENGINE_DELETE_POS, FOOTER_BYTES as ENGINE_FOOTER, SHUFFLE_BUCKETS } from '@/lib/warehouse/engine'

/** Every number reachable from a value, flattened, for the NaN/negative sweep. */
function numbersOf(value: unknown, path = 'root', out: [string, number][] = []): [string, number][] {
  if (typeof value === 'number') out.push([path, value])
  else if (Array.isArray(value)) value.forEach((v, i) => numbersOf(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) numbersOf(v, `${path}.${k}`, out)
  }
  return out
}

/* ========================================================================== */
/*                               merge-policy                                 */
/* ========================================================================== */

describe('merge-policy · the policy space', () => {
  it('is the product of the two dials and nothing else', () => {
    expect(POLICY_GRID).toHaveLength(TRIGGER_CHOICES.length * TARGET_CHOICES.length)
    expect(new Set(POLICY_GRID.map(policyKey)).size).toBe(POLICY_GRID.length)
    expect(POLICY_GRID.map(policyKey)).toContain(policyKey(OPENING_POLICY))
  })

  it('reuses the engine’s file constants rather than re-choosing them', () => {
    expect(FOOTER_BYTES).toBe(ENGINE_FOOTER)
    expect(DELETE_POS_BYTES).toBe(ENGINE_DELETE_POS)
  })

  it('builds one commit sequence per workload, independent of any policy', () => {
    for (const w of WORKLOADS) {
      const a = commitSequence(w)
      const b = commitSequence(w)
      /* Memoised and identical — the same object, so every policy is priced
       * against literally the same stream. */
      expect(a).toBe(b)
      expect(a).toHaveLength(COMMITS)
      expect(a.every((c) => c.rowsWritten >= 0 && c.rowsDeleted >= 0)).toBe(true)
      expect(a.some((c) => c.kind === 'append')).toBe(true)
      expect(a.some((c) => c.kind === 'update')).toBe(true)
      expect(a.some((c) => c.kind === 'delete')).toBe(true)
    }
  })

  it('is deterministic: the same policy and workload price identically, twice', () => {
    for (const w of WORKLOADS) {
      for (const p of POLICY_GRID) {
        const a = runPolicy(p, workloadSpec(w.id))
        const b = runPolicy(p, workloadSpec(w.id))
        expect(a).toEqual(b)
      }
    }
  })
})

describe('merge-policy · the two amplifications oppose each other', () => {
  /**
   * The target axis is the clean theorem: the data bytes a read touches do not
   * depend on the target at all, so the only target-dependent read term is the
   * footer per file — which falls as files get bigger. Meanwhile every compaction
   * rewrites a larger open file. Strictly opposed, at every trigger, on every
   * workload.
   */
  it('holds along the target axis for every trigger, on every workload', () => {
    for (const w of WORKLOADS) {
      for (const trig of TRIGGER_CHOICES) {
        const a = targetAxis(trig, w.id)
        expect(a.readMonotone, `${w.id} trigger=${trig} read`).toBe('down')
        expect(a.writeMonotone, `${w.id} trigger=${trig} write`).toBe('up')
        expect(a.opposed).toBe(true)
      }
    }
  })

  /**
   * The trigger axis is opposed wherever the trigger still has a grip on the read
   * bill — that is, at the target sizes at or above the reference. Below it the
   * stranded-tombstone term dominates and the trigger stops mattering, which is
   * the interaction the lab asks the reader to name. Asserting opposition
   * everywhere would be asserting something the model does not claim.
   */
  it('holds along the trigger axis at the reference target size and above', () => {
    for (const w of WORKLOADS) {
      for (const tgt of TARGET_CHOICES.filter((t) => t >= REFERENCE_TARGET_ROWS)) {
        const a = triggerAxis(tgt, w.id)
        expect(a.readMonotone, `${w.id} target=${tgt} read`).toBe('up')
        expect(a.writeMonotone, `${w.id} target=${tgt} write`).toBe('down')
        expect(a.opposed).toBe(true)
      }
    }
  })

  it('is a frontier across the whole grid, not a dashboard with a best setting', () => {
    for (const w of WORKLOADS) {
      /* Strongly negative rank correlation between the two amplifications. */
      expect(amplificationCorrelation(w.id), w.id).toBeLessThan(-0.4)

      /* And no policy is best at both — the definition of a tradeoff. */
      const sweep = policySweep(w.id)
      const minRead = Math.min(...sweep.map((r) => r.readAmplification))
      const minWrite = Math.min(...sweep.map((r) => r.writeAmplification))
      expect(
        sweep.some((r) => r.readAmplification === minRead && r.writeAmplification === minWrite),
      ).toBe(false)
      expect(policyKey(bestReadPolicy(w.id))).not.toBe(policyKey(bestWritePolicy(w.id)))
    }
  })

  it('makes each single-objective optimum expensive on the other axis', () => {
    const read = policyReport(bestReadPolicy(), REFERENCE_WORKLOAD)
    const write = policyReport(bestWritePolicy(), REFERENCE_WORKLOAD)
    expect(read.writeAmplification).toBeGreaterThan(write.writeAmplification * 2)
    expect(write.readAmplification).toBeGreaterThan(read.readAmplification)
  })
})

describe('merge-policy · the dual-constraint task', () => {
  it('does not open inside its own solution region', () => {
    /* An opener that already passed would grade nothing. This one reads well and
     * blows the write budget, which is the mistake the lab is about. */
    const c = meetsTargets(OPENING_POLICY, REFERENCE_WORKLOAD)
    expect(c.ok).toBe(false)
    expect(c.readOk).toBe(true)
    expect(c.writeOk).toBe(false)
    expect(TARGET_CHOICES).toContain(REFERENCE_TARGET_ROWS)
  })

  it('is satisfiable, and only by a small minority of policies', () => {
    const solving = solvingPolicies(REFERENCE_WORKLOAD)
    expect(solving.length).toBeGreaterThan(0)
    /* A task that a fifth of the space passes is a preference, not a design. */
    expect(solving.length / POLICY_GRID.length).toBeLessThanOrEqual(0.2)
  })

  it('excludes both single-objective optima, so no dial can be dragged to its end', () => {
    const solvingKeys = solvingPolicies(REFERENCE_WORKLOAD).map(policyKey)
    expect(solvingKeys).not.toContain(policyKey(bestReadPolicy(REFERENCE_WORKLOAD)))
    expect(solvingKeys).not.toContain(policyKey(bestWritePolicy(REFERENCE_WORKLOAD)))
  })

  it('needs both dials: no single trigger row and no single target column solves it alone', () => {
    const solving = solvingPolicies(REFERENCE_WORKLOAD)
    /* If every solution shared one trigger AND one target there would be exactly
     * one, which would make the task a lookup rather than a region. */
    expect(new Set(solving.map((p) => p.triggerFiles)).size).toBeGreaterThan(1)
    for (const trig of TRIGGER_CHOICES) {
      const row = TARGET_CHOICES.map((t) => meetsTargets({ triggerFiles: trig, targetFileRows: t }))
      expect(row.every((c) => c.ok), `trigger=${trig} cannot be uniformly fine`).toBe(false)
    }
  })

  it('grades the two constraints independently and honestly', () => {
    for (const p of POLICY_GRID) {
      const c = meetsTargets(p)
      const r = policyReport(p)
      expect(c.readAmplification).toBe(r.readAmplification)
      expect(c.writeAmplification).toBe(r.writeAmplification)
      expect(c.readOk).toBe(r.readAmplification <= TARGETS.readAmpCeiling)
      expect(c.writeOk).toBe(r.writeAmplification <= TARGETS.writeAmpBudget)
      expect(c.ok).toBe(c.readOk && c.writeOk)
    }
  })

  it('names exactly one target size that no trigger can rescue', () => {
    /* The graded pick needs a unique answer, and the mechanism needs to be the
     * stranded tombstones rather than an arbitrary threshold. */
    const stranded = strandedTargets(REFERENCE_WORKLOAD)
    expect(stranded).toHaveLength(1)
    expect(strandedTarget(REFERENCE_WORKLOAD)).toBe(stranded[0])
    /* It is the small-file end, and the policies there strand rows. */
    expect(stranded[0]).toBe(Math.min(...TARGET_CHOICES))
    for (const trig of TRIGGER_CHOICES) {
      const r = policyReport({ triggerFiles: trig, targetFileRows: stranded[0] })
      expect(r.readAmplification).toBeGreaterThan(TARGETS.readAmpCeiling)
      expect(r.deadStranded).toBeGreaterThan(0)
    }
  })
})

describe('merge-policy · the invariants', () => {
  it('conserves rows in every policy on every workload — physical − tombstoned = live', () => {
    for (const w of WORKLOADS) {
      for (const p of POLICY_GRID) {
        const r = policyReport(p, w.id)
        expect(r.rowsConserved, `${w.id} ${policyKey(p)}`).toBe(true)
        expect(r.physicalRows - r.deadRows).toBe(r.liveRows)
      }
    }
  })

  it('never reads fewer bytes than it needs, and never writes fewer than it ingests', () => {
    for (const w of WORKLOADS) {
      for (const p of POLICY_GRID) {
        const r = policyReport(p, w.id)
        expect(r.readAmplification).toBeGreaterThanOrEqual(1)
        expect(r.writeAmplification).toBeGreaterThanOrEqual(1)
        expect(r.storageHeldBytes).toBeGreaterThanOrEqual(r.liveBytes)
      }
    }
  })

  it('produces no NaN and no negative metric across the whole sweep', () => {
    for (const w of WORKLOADS) {
      for (const p of POLICY_GRID) {
        for (const [path, n] of numbersOf(policyReport(p, w.id), `${w.id}/${policyKey(p)}`)) {
          expect(Number.isFinite(n), `${path} is ${n}`).toBe(true)
          expect(n, `${path} is negative`).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('accounts for every scanned byte as data or metadata, and for the metadata term exactly', () => {
    const r = policyReport(OPENING_POLICY)
    expect(r.bytesScannedData).toBeGreaterThan(0)
    expect(r.bytesScannedMetadata).toBeGreaterThan(0)
    expect(r.readAmplification).toBeCloseTo(
      (r.bytesScannedData + r.bytesScannedMetadata) / r.bytesNeeded,
      12,
    )
    expect(r.writeAmplification).toBeCloseTo(
      (r.bytesIngested + r.bytesRewritten) / r.bytesIngested,
      12,
    )
    /* Bytes are rows × a stated width, everywhere. */
    expect(r.liveBytes).toBe(r.liveRows * ROW_BYTES)
  })

  it('renders, and says on the page that it is a model rather than a compactor', () => {
    const html = renderToString(createElement(MergePolicyLab, { trackColor: '#7DD3FC' }))
    expect(html).toContain('read amplification')
    expect(html).toContain('write amplification')
    /* Anti-overclaim: the limits are stated in the UI, not just in the source. */
    expect(html).toContain('model, not a compactor')
    expect(html).toContain('amplification here is a floor')
    expect(html).toContain('object-store request counts')
    expect(html).not.toContain('NaN')
  })
})

/* ========================================================================== */
/*                              shuffle-planner                               */
/* ========================================================================== */

describe('shuffle-planner · the arithmetic', () => {
  it('costs broadcast as smallSide × workers and partitioned as both sides once', () => {
    for (const j of JOINS) {
      const b = costPlan('broadcast', j, false)
      const p = costPlan('partitioned', j, false)
      expect(b.bytesMoved).toBe(j.smallSideBytes * j.workers)
      expect(p.bytesMoved).toBe(j.smallSideBytes + j.probeSideBytes)
    }
  })

  it('takes its worker count and its skew definition from the model engine', () => {
    for (const j of JOINS) expect(j.workers).toBe(SHUFFLE_BUCKETS)
    const p = costPlan('partitioned', JOINS[0], true)
    /* busiest ÷ mean, exactly as the engine reports shuffleSkew. */
    expect(p.skewFactor).toBeCloseTo(p.busiestWorkerBytes / p.meanWorkerBytes, 12)
  })

  it('is deterministic and free of NaN or negative counts across a full sweep', () => {
    for (const j of JOINS) {
      for (const w of WORKER_CHOICES) {
        for (const skewed of [false, true]) {
          const a = comparePlans(atWorkers(j, w), skewed)
          const b = comparePlans(atWorkers(j, w), skewed)
          expect(a).toEqual(b)
          for (const [path, n] of numbersOf(a, `${j.id}/w${w}/${skewed}`)) {
            expect(Number.isFinite(n), `${path} is ${n}`).toBe(true)
            expect(n, `${path} is negative`).toBeGreaterThanOrEqual(0)
          }
        }
      }
    }
  })

  /**
   * The crossover, asserted EXACTLY against a brute-force sweep rather than in a
   * band. It is arithmetic, not a cost model: broadcast is cheaper on bytes iff
   * `small × (w − 1) < probe`, and a closed form that is nearly right would be
   * worse than none.
   */
  it('matches the brute-force crossover on workers, exactly', () => {
    for (const j of JOINS) {
      const closed = crossoverWorkers(j)
      let brute = 1
      for (let w = 1; w <= 4096; w++) {
        const c = comparePlans(atWorkers(j, w), false)
        if (c.broadcast.bytesMoved <= c.partitioned.bytesMoved) brute = w
      }
      expect(closed, j.id).toBe(brute)
      /* And the inequality it came from holds on both sides of the boundary. */
      expect(j.smallSideBytes * (closed - 1)).toBeLessThanOrEqual(j.probeSideBytes)
      expect(j.smallSideBytes * closed).toBeGreaterThan(j.probeSideBytes)
    }
  })

  it('matches the brute-force crossover on the build-side size', () => {
    for (const j of JOINS) {
      const limit = crossoverSmallSideBytes(j)
      const under = comparePlans({ ...j, smallSideBytes: Math.floor(limit) }, false)
      const over = comparePlans({ ...j, smallSideBytes: Math.ceil(limit) + 1 }, false)
      expect(under.cheaperOnBytes).toBe('broadcast')
      expect(over.cheaperOnBytes).toBe('partitioned')
    }
  })

  it('offers a crossover pick that is the largest offered worker count under the limit', () => {
    for (const j of JOINS) {
      const pick = crossoverPick(j)
      expect(WORKER_CHOICES).toContain(pick)
      expect(pick).toBeLessThanOrEqual(crossoverWorkers(j))
      const bigger = WORKER_CHOICES.filter((w) => w > pick)
      for (const w of bigger) expect(w).toBeGreaterThan(crossoverWorkers(j))
    }
  })

  it('has joins on both sides of the crossover, so "broadcast the small side" cannot pass', () => {
    const answers = new Set(JOINS.map((j) => uniformChoice(j)))
    expect(answers.has('broadcast')).toBe(true)
    expect(answers.has('partitioned')).toBe(true)
  })
})

describe('shuffle-planner · what skew changes, and what it does not', () => {
  it('changes no byte total at all', () => {
    for (const j of JOINS) {
      const u = comparePlans(j, false)
      const s = comparePlans(j, true)
      for (const id of PLAN_IDS) {
        expect(s[id].bytesMoved, `${j.id} ${id}`).toBe(u[id].bytesMoved)
        expect(s[id].meanWorkerBytes).toBe(u[id].meanWorkerBytes)
      }
      expect(s.cheaperOnBytes).toBe(u.cheaperOnBytes)
    }
  })

  it('leaves the broadcast plan’s busiest worker untouched — it is skew-immune', () => {
    for (const j of JOINS) {
      expect(comparePlans(j, true).broadcast.busiestWorkerBytes).toBe(
        comparePlans(j, false).broadcast.busiestWorkerBytes,
      )
      expect(comparePlans(j, true).broadcast.skewFactor).toBe(1)
    }
  })

  it('multiplies the partitioned plan’s busiest worker by hotShare × workers', () => {
    for (const j of JOINS) {
      const s = comparePlans(j, true).partitioned
      const share = Math.max(j.hotShare, 1 / j.workers)
      expect(s.busiestWorkerBytes).toBeCloseTo((j.smallSideBytes + j.probeSideBytes) * share, 6)
      expect(s.skewFactor).toBeCloseTo(share * j.workers, 9)
      if (j.hotShare > 1 / j.workers) expect(s.skewFactor).toBeGreaterThan(1)
    }
  })

  it('flips the decision on exactly one join, and leaves the others alone', () => {
    /* Exactly one, deliberately. A lab where skew always argued for broadcast
     * would swap one piece of folklore for another. */
    expect(flippingJoins()).toHaveLength(1)
    expect(stableJoins().length).toBe(JOINS.length - 1)
    const flip = flippingJoins()[0]
    expect(uniformChoice(flip)).not.toBe(skewedChoice(flip))
    for (const j of stableJoins()) {
      expect(comparePlans(j, true).decisionFlips).toBe(false)
    }
  })

  it('includes exactly one join whose key is genuinely skewed and whose plan still does not change', () => {
    /* The graded "skew is not a verdict" task needs a unique answer, and it needs
     * the mechanism to be the threshold rather than the absence of skew. */
    const tolerated = skewToleratedJoins()
    expect(tolerated).toHaveLength(1)
    const j = tolerated[0]
    expect(j.hotShare).toBeGreaterThan(1 / j.workers)
    expect(j.hotShare).toBeLessThan(crossoverHotShare(j))
    expect(uniformChoice(j)).toBe('partitioned')
    expect(skewedChoice(j)).toBe('partitioned')
    /* And it is not the join that flips, or the two tasks would collide. */
    expect(j.id).not.toBe(flippingJoins()[0].id)
  })

  it('matches the hot-share crossover against a brute-force sweep', () => {
    for (const j of JOINS) {
      const threshold = crossoverHotShare(j)
      const below = comparePlans({ ...j, hotShare: threshold * 0.98 }, true)
      const above = comparePlans({ ...j, hotShare: Math.min(1, threshold * 1.02) }, true)
      expect(below.cheaperOnBusiest).toBe('partitioned')
      expect(above.cheaperOnBusiest).toBe('broadcast')
    }
  })

  it('keeps the opening join’s answer knowable from the stated statistics alone', () => {
    const opening = joinStats(OPENING_JOIN)
    expect(uniformChoice(opening)).toBe(
      opening.smallSideBytes * opening.workers <= opening.smallSideBytes + opening.probeSideBytes
        ? 'broadcast'
        : 'partitioned',
    )
  })

  it('renders, and says on the page that it is a cost model rather than a planner', () => {
    const html = renderToString(createElement(ShufflePlannerLab, { trackColor: '#7DD3FC' }))
    expect(html).toContain('broadcast')
    expect(html).toContain('bytes across the exchange')
    /* Anti-overclaim: nothing here is measured, and the page says so. */
    expect(html).toContain('Nothing here is measured')
    expect(html).toContain('cost model, not a planner')
    expect(html).toContain('adaptive execution')
    expect(html).not.toContain('NaN')
  })
})
