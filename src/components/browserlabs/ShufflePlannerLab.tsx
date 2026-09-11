/**
 * ShufflePlannerLab — the C6 browser lab.
 *
 * Two plans, one multiplication each:
 *
 *     broadcast    = smallSide × workers
 *     partitioned  = smallSide + probeSide
 *
 * That is the entire cost model, and it is exact. The lab exists because the
 * decision it produces is not the decision that decides the runtime. Bytes moved
 * is a TOTAL, and a job waits on the worker with the most work — the same number
 * only when the key divides evenly. So the reader is asked twice:
 *
 *   1. From the stated statistics, which plan moves fewer bytes?
 *   2. Now that the sampler reports one key holding a large share, which plan
 *      finishes first — which is to say, which has the smaller busiest worker?
 *
 * Both answers are graded, and the second is not always different. One of the
 * three joins flips, one has skew that is real and still does not change the
 * plan, and one is decided before skew is mentioned at all. A lab where skew
 * always argued for broadcast would replace one piece of folklore with another.
 *
 * The honest asymmetry, stated on screen: broadcast is skew-IMMUNE because the
 * probe side is never re-routed, and it pays for that immunity by holding the
 * whole small side on every worker — so it is the plan that dies of memory rather
 * than of imbalance.
 *
 * All arithmetic lives in `@/lib/shuffle/plan`, which takes `SHUFFLE_BUCKETS` and
 * the skew definition (busiest ÷ mean) from the Warehouse engine so that this
 * lab, the Warehouse's `shuffleSkew` and the C6 duck lab's measured
 * `hash(key) % 32` all mean the same thing by the same statistic. Every number is
 * a count of bytes. There is no clock and no `Math.random`: the statistics are
 * STATED, exactly as they arrive in a planning conversation.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Check, Eye, Network, Scale, Users, X } from 'lucide-react'
/* LabShell comes from the registry module, which will import this component back
 * once the orchestrator wires it. The cycle is safe because both sides only touch
 * each other at RENDER time, and `LabTask` is a type-only import. */
import { LabShell } from '@/components/browserlabs'
import type { LabTask } from '@/components/browserlabs/shared'
import {
  JOINS,
  OPENING_JOIN,
  PLANS,
  PLAN_IDS,
  WORKER_CHOICES,
  atWorkers,
  comparePlans,
  crossoverHotShare,
  crossoverPick,
  crossoverSmallSideBytes,
  crossoverWorkers,
  flippingJoins,
  fmtBytesShort,
  fmtFactor,
  fmtSharePct,
  joinStats,
  skewToleratedJoins,
  skewedChoice,
  uniformChoice,
  type PlanId,
} from '@/lib/shuffle/plan'
import { cn } from '@/lib/utils'

const FLIP_JOIN = flippingJoins()[0]
/** The join where the key is genuinely hot and the shuffle is still right. */
const STABLE_JOIN = skewToleratedJoins()[0]

export default function ShufflePlannerLab({ trackColor }: { trackColor: string }) {
  const [joinId, setJoinId] = useState<string>(OPENING_JOIN)
  /** Which joins the reader has asked the sampler about. Skew is not free knowledge. */
  const [revealed, setRevealed] = useState<string[]>([])
  const [bytesPicks, setBytesPicks] = useState<Record<string, PlanId>>({})
  const [busiestPicks, setBusiestPicks] = useState<Record<string, PlanId>>({})
  const [workerPicks, setWorkerPicks] = useState<Record<string, number>>({})

  const stats = joinStats(joinId)
  const isRevealed = revealed.includes(joinId)
  const uniform = useMemo(() => comparePlans(stats, false), [stats])
  const skewed = useMemo(() => comparePlans(stats, true), [stats])

  const reveal = useCallback(() => {
    setRevealed((prev) => (prev.includes(joinId) ? prev : [...prev, joinId]))
  }, [joinId])

  const pickBytes = useCallback(
    (p: PlanId) => setBytesPicks((prev) => ({ ...prev, [joinId]: p })),
    [joinId],
  )
  const pickBusiest = useCallback(
    (p: PlanId) => setBusiestPicks((prev) => ({ ...prev, [joinId]: p })),
    [joinId],
  )
  const pickWorkers = useCallback(
    (w: number) => setWorkerPicks((prev) => ({ ...prev, [joinId]: w })),
    [joinId],
  )

  /* The graded booleans, derived rather than latched: each one is a fact about
   * the picks the reader has made, so nothing depends on an effect firing. */
  const openingStats = joinStats(OPENING_JOIN)
  const openingBytesRight = bytesPicks[OPENING_JOIN] === uniformChoice(openingStats)
  const openingWorkersRight = workerPicks[OPENING_JOIN] === crossoverPick(openingStats)
  const flipBytesRight = bytesPicks[FLIP_JOIN.id] === uniformChoice(FLIP_JOIN)
  const flipBusiestRight = busiestPicks[FLIP_JOIN.id] === skewedChoice(FLIP_JOIN)
  const stableBytesRight = bytesPicks[STABLE_JOIN.id] === uniformChoice(STABLE_JOIN)
  const stableBusiestRight = busiestPicks[STABLE_JOIN.id] === skewedChoice(STABLE_JOIN)

  const tasks: LabTask[] = useMemo(
    () => [
      {
        id: 'initial',
        label: 'Cost both plans from the stated statistics and pick the one that moves fewer bytes',
        done: openingBytesRight,
        hint: 'smallSide × workers against smallSide + probeSide. Two multiplications; no judgement required.',
      },
      {
        id: 'crossover',
        label: 'Name the largest worker count at which broadcast still moves no more bytes than the shuffle',
        done: openingWorkersRight,
        hint: 'Solve small × w ≤ small + probe for w. The answer is 1 + probe ÷ small, and then round down to a size you can actually run.',
      },
      {
        id: 'reveal',
        label: `Re-cost ${FLIP_JOIN.label} with the hot key revealed and pick the plan that finishes first`,
        done: flipBusiestRight,
        hint: 'The busiest worker is the runtime. Ask the sampler, then compare the two busiest-worker columns rather than the two totals.',
      },
      {
        id: 'flip',
        label: 'Get BOTH answers right on the join where they differ — the decision that flips',
        done: flipBytesRight && flipBusiestRight,
        hint: 'One join in the set is cheaper on total bytes under one plan and finishes sooner under the other. Skew did not change any byte total; it changed which worker holds them.',
      },
      {
        id: 'stable',
        label: `Answer ${STABLE_JOIN.label}, where the key is genuinely skewed and the plan does not change`,
        done: stableBytesRight && stableBusiestRight,
        hint: `Its hot key holds ${fmtSharePct(STABLE_JOIN.hotShare)}, and the share at which the decision would flip is ${fmtSharePct(crossoverHotShare(STABLE_JOIN))}. Skew is a number to compare against a threshold, not a verdict.`,
      },
    ],
    [
      openingBytesRight,
      openingWorkersRight,
      flipBytesRight,
      flipBusiestRight,
      stableBytesRight,
      stableBusiestRight,
    ],
  )

  return (
    <LabShell labId="shuffle-planner" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        A join, two plans and two multiplications. <strong>Broadcast</strong> sends the whole small
        side to every worker: <span className="font-mono text-[11.5px]">smallSide × workers</span>.{' '}
        <strong>Partitioned</strong> hashes both sides on the join key so matching rows meet:{' '}
        <span className="font-mono text-[11.5px]">smallSide + probeSide</span>. Pick the cheaper one
        from the statistics — then ask the sampler what the key distribution actually looks like and
        cost it again.
      </p>
      <p className="mt-2 text-body-sm text-text-3">
        Nothing here is measured. The statistics are <em>stated</em>, the way they arrive in a
        planning conversation, and the lab is about what follows from them. Both plans return exactly
        the same rows — that is not in question and never is. What changes is which count you pay.
      </p>

      {/* ------------------------------- the join ----------------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3">
            <Network size={13} />
            the join
          </span>
          <span className="font-mono text-[10.5px] text-text-3">
            {fmtBytesShort(stats.smallSideBytes)} build side · {fmtBytesShort(stats.probeSideBytes)}{' '}
            probe side · {stats.workers} workers
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {JOINS.map((j) => (
            <Chip key={j.id} active={joinId === j.id} color={trackColor} onClick={() => setJoinId(j.id)}>
              {j.label}
            </Chip>
          ))}
        </div>
        <p className="mt-2 max-w-2xl text-body-sm text-text-3">{stats.why}</p>
      </div>

      {/* --------------------------- step 1: the totals ----------------------- */}
      <div className="mt-5">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
          step 1 — bytes across the exchange
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                {['plan', 'arithmetic', 'bytes moved', 'per worker', 'memory per worker'].map((h) => (
                  <th
                    key={h}
                    className="py-2 pr-4 font-mono text-[10px] uppercase tracking-wide text-text-3"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PLAN_IDS.map((id) => {
                const c = id === 'broadcast' ? uniform.broadcast : uniform.partitioned
                const cheaper = uniform.cheaperOnBytes === id
                return (
                  <tr key={id} className="border-b border-line/60 align-top">
                    <td className="py-3 pr-4">
                      <p className="font-mono text-[12px] text-text-1">{PLANS[id].label}</p>
                      <p className="mt-1 max-w-sm text-body-sm text-text-3">{PLANS[id].line}</p>
                    </td>
                    <td className="py-3 pr-4 font-mono text-[11.5px] text-text-2">{c.arithmetic}</td>
                    <td
                      className="py-3 pr-4 font-mono text-[12px]"
                      style={{ color: cheaper ? trackColor : undefined }}
                    >
                      {fmtBytesShort(c.bytesMoved)}
                      {cheaper && <span className="block text-[10px] uppercase">fewer bytes</span>}
                    </td>
                    <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                      {fmtBytesShort(c.meanWorkerBytes)}
                    </td>
                    <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                      {fmtBytesShort(c.memoryPerWorkerBytes)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <Question
          prompt="Which plan moves fewer bytes across the exchange?"
          picked={bytesPicks[joinId] ?? null}
          correct={uniform.cheaperOnBytes}
          onPick={pickBytes}
          trackColor={trackColor}
          note={`It is ${fmtBytesShort(uniform.broadcast.bytesMoved)} against ${fmtBytesShort(uniform.partitioned.bytesMoved)} — a factor of ${fmtFactor(uniform.bytesRatio)}. Broadcast stops being cheaper on bytes above ${crossoverWorkers(stats)} workers, or above a ${fmtBytesShort(crossoverSmallSideBytes(stats))} build side at this worker count.`}
        />
      </div>

      {/* ---------------------------- the crossover --------------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <Users size={12} /> the crossover
        </p>
        <p className="mt-2 text-body-sm text-text-2">
          Broadcast costs <span className="font-mono text-[11.5px]">small × w</span> and the shuffle
          costs <span className="font-mono text-[11.5px]">small + probe</span>, so broadcast wins on
          bytes exactly while{' '}
          <span className="font-mono text-[11.5px]">small × (w − 1) &lt; probe</span>. Which is the
          largest of these worker counts where that still holds for this join?
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {WORKER_CHOICES.map((w) => (
            <Chip key={w} active={workerPicks[joinId] === w} color={trackColor} onClick={() => pickWorkers(w)}>
              {w}
            </Chip>
          ))}
        </div>
        {workerPicks[joinId] !== undefined && (
          <p
            className={cn(
              'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
              workerPicks[joinId] === crossoverPick(stats) ? 'text-accent' : 'text-rose-400',
            )}
          >
            {workerPicks[joinId] === crossoverPick(stats) ? <Check size={12} /> : <X size={12} />}
            {workerPicks[joinId] === crossoverPick(stats)
              ? `correct — the exact crossover is ${crossoverWorkers(stats)} workers, so ${crossoverPick(stats)} is the largest of these that holds`
              : `at ${workerPicks[joinId]} workers broadcast moves ${fmtBytesShort(comparePlans(atWorkers(stats, workerPicks[joinId]), false).broadcast.bytesMoved)} against the shuffle’s ${fmtBytesShort(uniform.partitioned.bytesMoved)} — recompute 1 + probe ÷ small`}
          </p>
        )}
        <p className="mt-2 text-body-sm text-text-3">
          This is the arithmetic behind every stale broadcast hint in production. A hint added when
          the build side was {fmtBytesShort(crossoverSmallSideBytes(stats) / 8)} is still there when
          it reaches {fmtBytesShort(crossoverSmallSideBytes(stats) * 2)}, and the cluster it was
          measured on had a quarter of the workers. Nothing failed; the inequality quietly reversed.
        </p>
      </div>

      {/* ----------------------- step 2: the busiest worker ------------------- */}
      <div className="mt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
            step 2 — the worker the job waits on
          </p>
          {!isRevealed && (
            <button
              type="button"
              onClick={reveal}
              className="inline-flex items-center gap-2 rounded-md border border-accent/60 bg-accent/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-accent transition-colors hover:bg-accent/20"
            >
              <Eye size={12} /> ask the sampler about the key
            </button>
          )}
        </div>

        {!isRevealed ? (
          <p className="mt-2 max-w-2xl text-body-sm text-text-3">
            You have decided on a total. A job does not wait on a total. Before you commit the plan,
            ask what the distribution of the join key looks like — which is the one statistic the
            numbers above assumed and never checked.
          </p>
        ) : (
          <>
            <div className="mt-2 rounded-md border border-amber-400/40 bg-amber-400/[0.04] px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-amber-400">
                the sampler reports a heavy hitter
              </p>
              <p className="mt-2 text-body-sm text-text-2">
                <span className="font-mono text-[11.5px]">{stats.hotKeyLabel}</span> holds{' '}
                <strong>{fmtSharePct(stats.hotShare)}</strong> of the join key’s rows. An even split
                across {stats.workers} workers would be {fmtSharePct(1 / stats.workers)} each, so
                that one key is worth{' '}
                {fmtFactor(stats.hotShare / (1 / stats.workers))} of a fair share — and every row of
                it hashes to the same place, because that is what a hash partitioning is for.
              </p>
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {[
                      'plan',
                      'bytes moved',
                      'mean worker',
                      'busiest worker',
                      'skew (busiest ÷ mean)',
                      'what it dies of',
                    ].map((h) => (
                      <th
                        key={h}
                        className="py-2 pr-4 font-mono text-[10px] uppercase tracking-wide text-text-3"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PLAN_IDS.map((id) => {
                    const c = id === 'broadcast' ? skewed.broadcast : skewed.partitioned
                    const wins = skewed.cheaperOnBusiest === id
                    return (
                      <tr key={id} className="border-b border-line/60 align-top">
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                          {PLANS[id].label}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytesShort(c.bytesMoved)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytesShort(c.meanWorkerBytes)}
                        </td>
                        <td
                          className="py-3 pr-4 font-mono text-[12px]"
                          style={{ color: wins ? trackColor : '#FB7185' }}
                        >
                          {fmtBytesShort(c.busiestWorkerBytes)}
                          {wins && <span className="block text-[10px] uppercase">finishes first</span>}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtFactor(c.skewFactor)}
                        </td>
                        <td className="py-3 pr-4 max-w-xs text-body-sm text-text-3">
                          {PLANS[id].weakness}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <Question
              prompt="Now that the key is known to be skewed, which plan finishes first?"
              picked={busiestPicks[joinId] ?? null}
              correct={skewed.cheaperOnBusiest}
              onPick={pickBusiest}
              trackColor={trackColor}
              note={
                skewed.decisionFlips
                  ? `The decision flipped. Not one byte total moved: ${fmtBytesShort(skewed.partitioned.bytesMoved)} still crosses the exchange under the shuffle, and it is still ${fmtFactor(skewed.bytesRatio)} against broadcast on the total. What changed is that ${fmtSharePct(stats.hotShare)} of it lands on one worker, so the busiest worker holds ${fmtBytesShort(skewed.partitioned.busiestWorkerBytes)} against broadcast’s ${fmtBytesShort(skewed.broadcast.busiestWorkerBytes)}.`
                  : `The decision held. The hot key is real at ${fmtSharePct(stats.hotShare)}, and the share it would take to flip this join is ${fmtSharePct(crossoverHotShare(stats))}. Skew is a number you compare against a threshold, not a verdict — and this is the case a lab that always flipped would have taught you to get wrong.`
              }
            />
          </>
        )}
      </div>

      {/* ------------------------------ the summary --------------------------- */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <Scale size={12} /> what to carry out of this
        </p>
        <ul className="mt-2 space-y-1.5 text-body-sm text-text-3">
          <li>
            · <strong>The plan choice is arithmetic.</strong> Broadcast wins on bytes exactly while{' '}
            <span className="font-mono text-[11.5px]">small × (w − 1) &lt; probe</span>. Both sides of
            that inequality drift — the build side grows, the cluster is resized — so a hint is a
            snapshot of an inequality, not a decision.
          </li>
          <li>
            · <strong>Skew does not change a single byte total.</strong> It changes which worker holds
            them, and the busiest worker is the runtime. A key holding fraction <em>f</em> puts{' '}
            <em>f</em> of both sides on one worker, so the partitioned plan’s runtime term is{' '}
            <em>f</em> × <em>w</em> times its own mean.
          </li>
          <li>
            · <strong>Broadcast is skew-immune and memory-bound.</strong> The probe side is never
            re-routed, so no distribution can pile it up; the price is that every worker holds the
            whole build side ({fmtBytesShort(stats.smallSideBytes)} here). The two plans fail in
            different ways, which is why "which is faster" is the wrong question and "which failure
            can I afford" is the right one.
          </li>
          <li>
            · <strong>A third option exists and it is not on this page:</strong> split the hot key
            across sub-partitions and replicate its build-side rows to match. The C6 duck lab measures
            that on real data with{' '}
            <span className="font-mono text-[11.5px]">hash(key) % 32</span>, including what the
            replication costs — because salting is a trade, not a fix.
          </li>
          <li>
            · <strong>This is a cost model, not a planner.</strong> It prices bytes and workers, and
            it is silent about everything else a real exchange has: the network itself, spilling when
            a partition outgrows a worker’s memory, and adaptive execution that may re-partition once
            it sees the skew at runtime. Those change the numbers; they do not change the inequality
            or which term the runtime lives in.
          </li>
        </ul>
      </div>
    </LabShell>
  )
}

/* ------------------------------- fragments ------------------------------ */

function Chip({
  active,
  color,
  onClick,
  children,
}: {
  active: boolean
  color: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-sm border px-2.5 py-1 font-mono text-[11.5px] transition-colors',
        active ? 'text-text-1' : 'border-line text-text-3 hover:text-text-2',
      )}
      style={active ? { borderColor: color, backgroundColor: `${color}1a` } : undefined}
    >
      {children}
    </button>
  )
}

/** A two-way graded pick. Feedback is immediate, because the arithmetic is the answer key. */
function Question({
  prompt,
  picked,
  correct,
  onPick,
  trackColor,
  note,
}: {
  prompt: string
  picked: PlanId | null
  correct: PlanId
  onPick: (p: PlanId) => void
  trackColor: string
  note: string
}) {
  const right = picked !== null && picked === correct
  return (
    <div className="mt-4 rounded-md border border-line px-4 py-3">
      <p className="text-body-sm text-text-2">{prompt}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {PLAN_IDS.map((id) => (
          <Chip key={id} active={picked === id} color={trackColor} onClick={() => onPick(id)}>
            {PLANS[id].label}
          </Chip>
        ))}
      </div>
      {picked !== null && (
        <p
          className={cn(
            'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
            right ? 'text-accent' : 'text-rose-400',
          )}
        >
          {right ? <Check size={12} /> : <X size={12} />}
          {right ? 'correct' : `not ${PLANS[picked].label} — redo the multiplication`}
        </p>
      )}
      {picked !== null && <p className="mt-2 text-body-sm text-text-3">{note}</p>}
    </div>
  )
}
