/**
 * plan.ts — broadcast against partitioned, as arithmetic, and then again once the
 * key turns out to be skewed.
 *
 * ── The two costs ─────────────────────────────────────────────────────────
 * Both are one line, and both are exact:
 *
 *     broadcast    = smallSide × workers          (every worker gets a full copy)
 *     partitioned  = smallSide + probeSide        (both sides move once)
 *
 * So broadcast is cheaper exactly while `smallSide × (workers − 1) < probeSide`.
 * That is the whole decision, it is a multiplication and a comparison, and a
 * reader who can do it does not need a planner's opinion. The crossover is
 * computed here as a closed form rather than searched, and the test suite checks
 * the closed form against a brute-force sweep — because a crossover that is
 * nearly right is worse than no crossover at all.
 *
 * ── Why the decision changes when the key is skewed ───────────────────────
 * Bytes moved is a TOTAL. A job does not wait on a total; it waits on the worker
 * with the most work. Those are the same number only when the work divides
 * evenly, which is what a hash partitioning does when the key is uniform and
 * emphatically not what it does when one key holds a fifth of the rows.
 *
 *     partitioned, busiest worker = (small + probe) × max(hotShare, 1/workers)
 *     broadcast, busiest worker   = small + probe/workers
 *
 * Broadcast is skew-IMMUNE on the probe side: the probe rows are never
 * re-routed, so they stay spread the way the files were written. Skew therefore
 * leaves the broadcast term alone and multiplies the partitioned one, which is
 * how a decision that was arithmetic on total bytes can flip on the term that
 * decides the runtime.
 *
 * ── Reuse, and what is modelled ───────────────────────────────────────────
 * `SHUFFLE_BUCKETS` and the skew definition (busiest ÷ mean) come from
 * `@/lib/warehouse/engine` rather than being re-picked, so `skewFactor` here and
 * `shuffleSkew` there mean the same thing, and both agree with what the C6 duck
 * lab measures from real data with `hash(key) % 32`.
 *
 * Everything in this file is a COUNT of bytes and rows. There is no clock, no
 * `Math.random` and no data: the statistics are STATED, exactly as they arrive in
 * a planning conversation, and the point is what follows from them.
 */

import { SHUFFLE_BUCKETS } from '@/lib/warehouse/engine'

export type PlanId = 'broadcast' | 'partitioned'

export const PLAN_IDS: PlanId[] = ['broadcast', 'partitioned']

export interface PlanSpec {
  id: PlanId
  label: string
  line: string
  /** What it is bad at, which is the half people leave out. */
  weakness: string
}

export const PLANS: Record<PlanId, PlanSpec> = {
  broadcast: {
    id: 'broadcast',
    label: 'broadcast',
    line: 'Send the whole small side to every worker; leave the big side where it is and join locally.',
    weakness:
      'The small side is paid for `workers` times, and every worker must hold all of it in memory. Grow the small side or the cluster and this is the plan that falls over.',
  },
  partitioned: {
    id: 'partitioned',
    label: 'partitioned (hash) shuffle',
    line: 'Hash both sides on the join key so matching rows meet on the same worker. Each side moves exactly once.',
    weakness:
      'The key decides the split. A key that is not uniform hands one worker a disproportionate share, and the job waits on that worker rather than on the total.',
  },
}

/* ------------------------------- the statistics --------------------------- */

export interface JoinStats {
  id: string
  label: string
  /** Bytes on the build (small) side, after projection. */
  smallSideBytes: number
  /** Bytes on the probe (large) side, after projection. */
  probeSideBytes: number
  workers: number
  /**
   * Share of the join key's rows held by the single hottest key, as revealed at
   * step two. The reader is NOT shown this when they make the first decision —
   * which is exactly the position a planner is in before it has sampled.
   */
  hotShare: number
  /** The key, named, because a hot key always has a name. */
  hotKeyLabel: string
  why: string
}

/**
 * Three joins. The first two are chosen so the initial arithmetic gives opposite
 * answers — otherwise a reader could pass by always saying "broadcast the small
 * side", which is the folklore this lab is trying to price. The third sits within
 * a few percent of the crossover, so neither answer is obvious and the decision
 * has to be computed.
 */
export const JOINS: JoinStats[] = [
  {
    id: 'dim-join',
    label: 'orders ⋈ customers',
    smallSideBytes: 180 * 1024 * 1024,
    probeSideBytes: 42 * 1024 * 1024 * 1024,
    workers: SHUFFLE_BUCKETS,
    hotShare: 0.22,
    hotKeyLabel: 'customer_id = 0 (the unattributed-orders sentinel)',
    why: 'A textbook star-schema join: a dimension small enough to fit anywhere against a fact table three orders of magnitude larger.',
  },
  {
    id: 'fat-dim',
    label: 'events ⋈ user_profiles',
    smallSideBytes: 9 * 1024 * 1024 * 1024,
    probeSideBytes: 64 * 1024 * 1024 * 1024,
    workers: SHUFFLE_BUCKETS,
    hotShare: 0.06,
    hotKeyLabel: 'user_id of the anonymous session bucket',
    why: 'The same shape with a build side that has grown. Nobody re-ran the arithmetic when the profile table went from megabytes to gigabytes, which is how a broadcast hint outlives its justification.',
  },
  {
    id: 'near-crossover',
    label: 'clicks ⋈ campaigns',
    smallSideBytes: 1_600 * 1024 * 1024,
    probeSideBytes: 47 * 1024 * 1024 * 1024,
    workers: SHUFFLE_BUCKETS,
    hotShare: 0.4,
    hotKeyLabel: 'campaign_id of the always-on evergreen campaign',
    why: 'Within a few percent of the crossover, where "obviously broadcast it" and "obviously shuffle it" are both wrong until you have multiplied.',
  },
]

export const joinStats = (id: string): JoinStats => {
  const j = JOINS.find((x) => x.id === id)
  if (!j) throw new Error(`no join ${id}`)
  return j
}

export const OPENING_JOIN = JOINS[0].id

/* --------------------------------- costing -------------------------------- */

export interface PlanCost {
  plan: PlanId
  /** Bytes crossing the exchange, in total, across all workers. */
  bytesMoved: number
  /** Bytes the busiest single worker must receive and process. The runtime term. */
  busiestWorkerBytes: number
  /** bytesMoved ÷ workers — what a capacity model built on the mean would say. */
  meanWorkerBytes: number
  /** busiestWorkerBytes ÷ meanWorkerBytes. Same definition as the engine's shuffleSkew. */
  skewFactor: number
  /** Bytes each worker must hold in memory to run the join at all. */
  memoryPerWorkerBytes: number
  /** How the bytesMoved figure was arrived at, for the panel that shows the arithmetic. */
  arithmetic: string
}

/**
 * Cost one plan. `skewed` selects which of the two questions is being asked:
 * the uniform assumption the statistics imply, or the distribution the sampler
 * later reports.
 *
 * Broadcast's busiest worker does not change between the two, and that is the
 * teaching point rather than an omission: the probe side is read from files and
 * never re-routed, so no key distribution can pile it up on one worker.
 */
export function costPlan(plan: PlanId, stats: JoinStats, skewed: boolean): PlanCost {
  const { smallSideBytes: small, probeSideBytes: probe, workers } = stats
  const evenShare = 1 / workers
  const share = skewed ? Math.max(stats.hotShare, evenShare) : evenShare

  if (plan === 'broadcast') {
    const bytesMoved = small * workers
    /* Every worker receives the whole small side and reads its own slice of the
     * probe side locally. The slice is even because the probe rows were never
     * re-routed by the join key — which is why this term is the same number
     * whether or not the key is skewed. */
    const perWorker = small + probe * evenShare
    return {
      plan,
      bytesMoved,
      busiestWorkerBytes: perWorker,
      meanWorkerBytes: perWorker,
      /* Exactly 1, by construction: every worker does the identical amount of
       * work. Broadcast trades a multiplied total for a guaranteed even split. */
      skewFactor: 1,
      memoryPerWorkerBytes: small,
      arithmetic: `${fmtBytesShort(small)} × ${workers} workers`,
    }
  }

  const bytesMoved = small + probe
  const mean = bytesMoved / workers
  const busiest = bytesMoved * share
  return {
    plan,
    bytesMoved,
    busiestWorkerBytes: busiest,
    meanWorkerBytes: mean,
    skewFactor: mean > 0 ? busiest / mean : 0,
    /* Only the partition that lands on this worker has to be held. */
    memoryPerWorkerBytes: small * share,
    arithmetic: `${fmtBytesShort(small)} + ${fmtBytesShort(probe)}`,
  }
}

export interface PlanComparison {
  stats: JoinStats
  skewed: boolean
  broadcast: PlanCost
  partitioned: PlanCost
  /** The plan with the fewer bytes moved. The answer to the first question. */
  cheaperOnBytes: PlanId
  /** The plan with the smaller busiest worker. The answer to the second. */
  cheaperOnBusiest: PlanId
  /** True when the two questions have different answers — the point of the lab. */
  decisionFlips: boolean
  bytesRatio: number
  busiestRatio: number
}

export function comparePlans(stats: JoinStats, skewed: boolean): PlanComparison {
  const broadcast = costPlan('broadcast', stats, skewed)
  const partitioned = costPlan('partitioned', stats, skewed)
  const cheaperOnBytes: PlanId =
    broadcast.bytesMoved <= partitioned.bytesMoved ? 'broadcast' : 'partitioned'
  const cheaperOnBusiest: PlanId =
    broadcast.busiestWorkerBytes <= partitioned.busiestWorkerBytes ? 'broadcast' : 'partitioned'
  return {
    stats,
    skewed,
    broadcast,
    partitioned,
    cheaperOnBytes,
    cheaperOnBusiest,
    decisionFlips: cheaperOnBytes !== cheaperOnBusiest,
    bytesRatio:
      Math.max(broadcast.bytesMoved, partitioned.bytesMoved) /
      Math.max(1, Math.min(broadcast.bytesMoved, partitioned.bytesMoved)),
    busiestRatio:
      Math.max(broadcast.busiestWorkerBytes, partitioned.busiestWorkerBytes) /
      Math.max(1, Math.min(broadcast.busiestWorkerBytes, partitioned.busiestWorkerBytes)),
  }
}

/** The answer to step one: cheaper on total bytes moved, under the uniform assumption. */
export const uniformChoice = (stats: JoinStats): PlanId => comparePlans(stats, false).cheaperOnBytes

/** The answer to step two: cheaper on the busiest worker, once the key is known to be skewed. */
export const skewedChoice = (stats: JoinStats): PlanId => comparePlans(stats, true).cheaperOnBusiest

/**
 * Joins where the two questions have different answers once the key is known to
 * be skewed. There is exactly one in the set above, and the test suite pins that:
 * if every join flipped, the lab would be teaching "skew means broadcast", which
 * is the next piece of folklore along.
 */
export const flippingJoins = (): JoinStats[] =>
  JOINS.filter((j) => comparePlans(j, true).decisionFlips)

/** Joins where the skew is real and still does not change the plan. */
export const stableJoins = (): JoinStats[] =>
  JOINS.filter((j) => !comparePlans(j, true).decisionFlips)

/**
 * The join the "skew is not a verdict" task is built on: a key that is genuinely
 * hot — above an even share — where the partitioned shuffle is the right answer
 * on bytes AND still the right answer on the busiest worker, because the hot
 * share sits below `crossoverHotShare`.
 *
 * It matters that this case exists and is graded. Without it a reader finishes
 * the lab having learnt "skew means broadcast", which is the next piece of
 * folklore along and is wrong for exactly the joins where the build side is large.
 */
export const skewToleratedJoins = (): JoinStats[] =>
  JOINS.filter(
    (j) =>
      j.hotShare > 1 / j.workers &&
      uniformChoice(j) === 'partitioned' &&
      skewedChoice(j) === 'partitioned',
  )

/* -------------------------------- crossovers ------------------------------ */

/**
 * The largest worker count at which broadcast still moves no more bytes than a
 * partitioned shuffle. Closed form, from `small × w ≤ small + probe`:
 *
 *     w ≤ 1 + probe ÷ small
 *
 * Returned as an integer because workers are integral, and the test suite checks
 * it against a brute-force sweep so the algebra cannot silently drift.
 */
export const crossoverWorkers = (stats: JoinStats): number =>
  Math.floor(1 + stats.probeSideBytes / stats.smallSideBytes)

/**
 * The largest small side, in bytes, for which broadcast still moves no more bytes
 * than a partitioned shuffle at this worker count. From
 * `small × w ≤ small + probe`:
 *
 *     small ≤ probe ÷ (w − 1)
 */
export const crossoverSmallSideBytes = (stats: JoinStats): number =>
  stats.workers <= 1 ? Number.POSITIVE_INFINITY : stats.probeSideBytes / (stats.workers - 1)

/**
 * The hot-key share above which the partitioned plan's busiest worker exceeds the
 * broadcast plan's. Closed form, from
 * `(small + probe) × share ≥ small + probe/w`:
 *
 *     share ≥ (small + probe/w) ÷ (small + probe)
 *
 * Clamped below at the even share, because a share under 1/w is not skew.
 */
export function crossoverHotShare(stats: JoinStats): number {
  const { smallSideBytes: small, probeSideBytes: probe, workers } = stats
  const total = small + probe
  if (total <= 0) return 1
  return Math.max(1 / workers, (small + probe / workers) / total)
}

/** Worker counts offered as answers to the crossover question. */
export const WORKER_CHOICES: number[] = [8, 16, 32, 64, 128, 256, 512]

/**
 * The graded crossover pick: the largest offered worker count at which broadcast
 * is still no more expensive on bytes moved. Derived from the closed form rather
 * than listed, so the answer key and the arithmetic cannot disagree.
 */
export function crossoverPick(stats: JoinStats): number {
  const limit = crossoverWorkers(stats)
  const under = WORKER_CHOICES.filter((w) => w <= limit)
  return under.length > 0 ? under[under.length - 1] : WORKER_CHOICES[0]
}

/** Re-cost a join at a different worker count, keeping every other statistic. */
export const atWorkers = (stats: JoinStats, workers: number): JoinStats => ({ ...stats, workers })

/* -------------------------------- formatting ------------------------------ */

/** Compact bytes, for inline arithmetic where `fmtBytes`'s precision is noise. */
export function fmtBytesShort(bytes: number): string {
  const GIB = 1024 * 1024 * 1024
  const MIB = 1024 * 1024
  if (Math.abs(bytes) >= GIB) {
    const g = bytes / GIB
    return `${g % 1 === 0 ? g.toFixed(0) : g.toFixed(1)} GiB`
  }
  if (Math.abs(bytes) >= MIB) {
    const m = bytes / MIB
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)} MiB`
  }
  return `${Math.round(bytes / 1024)} KiB`
}

export const fmtFactor = (r: number): string => `${r.toFixed(2)}×`

export const fmtSharePct = (r: number): string => `${(r * 100).toFixed(1)}%`
