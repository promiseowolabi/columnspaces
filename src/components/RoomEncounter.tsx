/**
 * RoomEncounter — the room as a graded encounter rather than a reading.
 *
 * Three properties this component exists to preserve, all of them easy to lose
 * by accident:
 *
 *   only what fires   — the objections shown are exactly `objectionsFor(room,
 *                       dossier)`, worst severity first, one at a time. Nothing
 *                       generic is asked. If your dossier does not deserve an
 *                       objection, you never see it.
 *   answer, then hear — the rebuttal and its outcome are hidden until a response
 *                       is chosen. In study mode they are all visible, which is
 *                       useful before an attempt and useless as a test.
 *   why this one      — every objection carries the dossier fields that decided
 *                       it, computed from the predicate itself. Change one and
 *                       come back to a different room. That is the pedagogy.
 *
 * The grading lives in `@/data/rooms` and the aggregation rule in
 * `@/lib/rooms/encounter`; none of it is reimplemented here.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, HelpCircle, RotateCcw, ShieldCheck, Skull, TriangleAlert } from 'lucide-react'
import type { Dossier, Objection, Outcome, Room } from '@/data/rooms'
import { WOUND_BUDGET, answerFor, attribution, runState } from '@/lib/rooms/encounter'
import type { Answer, Verdict } from '@/lib/rooms/encounter'
import { fieldLabel } from '@/lib/rooms/dossier-fields'
import { useProgress } from '@/lib/progress'
import { cn } from '@/lib/utils'

const OUTCOME: Record<Outcome, { label: string; cls: string }> = {
  survive: { label: 'survive', cls: 'text-accent border-accent/50' },
  wounded: { label: 'wounded', cls: 'text-amber-400 border-amber-400/40' },
  fatal: { label: 'fatal', cls: 'text-rose-400 border-rose-400/40' },
}

const VERDICT: Record<Verdict, { title: string; note: string; cls: string }> = {
  survived: {
    title: 'you survived the room',
    note: 'No wounds. Every objection answered with a number you brought or a tradeoff you had already named.',
    cls: 'border-accent/50 text-accent',
  },
  'survived-wounded': {
    title: 'you survived — wounded',
    note: `One wound is inside the budget of ${WOUND_BUDGET}. You conceded ground once; a second concession would have lost the room.`,
    cls: 'border-amber-400/40 text-amber-400',
  },
  lost: {
    title: 'you lost the room',
    note: 'Either a critical objection exposed a cost you never modelled, or the wounds added up. Change the numbers, not the answers.',
    cls: 'border-rose-400/40 text-rose-400',
  },
}

function Why({ objection, dossier }: { objection: Objection; dossier: Dossier }) {
  const [open, setOpen] = useState(false)
  const a = useMemo(() => attribution(objection, dossier), [objection, dossier])
  const count = a.submitted.length + a.omitted.length

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3 hover:text-text-1"
      >
        <HelpCircle size={12} />
        why am I facing this?
      </button>

      {open && (
        <div className="mt-2 rounded-md border border-line bg-surface-2/60 px-4 py-3">
          {count === 0 && (
            <p className="text-body-sm text-text-3">
              Nothing in your dossier retires this one — it is asked of every plan.
            </p>
          )}

          {a.omitted.length > 0 && (
            <p className="text-body-sm text-text-2">
              <span className="font-mono text-[10px] uppercase tracking-wide text-amber-400">
                because you left blank —{' '}
              </span>
              {a.omitted.map((k) => fieldLabel(k)).join(' · ')}
            </p>
          )}

          {a.submitted.length > 0 && (
            <p className={cn('text-body-sm text-text-2', a.omitted.length > 0 && 'mt-2')}>
              <span className="font-mono text-[10px] uppercase tracking-wide text-text-3">
                because you submitted —{' '}
              </span>
              {a.submitted.map((k) => fieldLabel(k)).join(' · ')}
            </p>
          )}

          {count > 0 && (
            <p className="mt-2 border-t border-line pt-2 text-body-sm italic text-text-3">
              Change one of those in your dossier and this objection stops firing. That is not a loophole; it is
              the design — you are being asked about the plan you actually submitted.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Ledger({ answers, objections }: { answers: Answer[]; objections: Objection[] }) {
  return (
    <ul className="mt-4 space-y-1.5">
      {answers.map((a) => {
        const o = objections.find((x) => x.id === a.objectionId)
        const style = OUTCOME[a.outcome]
        return (
          <li key={a.objectionId} className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-text-2">
              {a.objectionId}
              <span className="ml-2 text-text-3">sev {o?.severity ?? a.severity}</span>
            </span>
            <span className={cn('rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase', style.cls)}>
              {style.label}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function RoomEncounter({ room, dossier }: { room: Room; dossier: Dossier }) {
  const [answers, setAnswers] = useState<Answer[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  const recordRoomRun = useProgress((s) => s.recordRoomRun)
  const recorded = useRef<string | null>(null)

  const run = useMemo(() => runState(room, dossier, answers), [room, dossier, answers])
  const current = run.cursor >= 0 ? run.queue[run.cursor] : undefined

  /* Persist the attempt exactly once per completed run. Verdicts are
     deterministic given the dossier, so re-recording the same run is noise. */
  useEffect(() => {
    if (!run.complete || run.queue.length === 0) return
    const signature = `${room.id}:${answers.map((a) => `${a.objectionId}=${a.responseId}`).join(',')}`
    if (recorded.current === signature) return
    recorded.current = signature
    const outcomes: Record<string, Outcome> = {}
    for (const a of answers) outcomes[a.objectionId] = a.outcome
    recordRoomRun(room.id, run.verdict, outcomes)
  }, [run.complete, run.verdict, run.queue.length, answers, room.id, recordRoomRun])

  const restart = () => {
    setAnswers([])
    setPicked(null)
    recorded.current = null
  }

  if (run.queue.length === 0) {
    return (
      <section className="mt-10 rounded-lg border border-accent/40 bg-surface-1 px-5 py-5">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-accent" strokeWidth={1.75} />
          <p className="font-display text-body font-medium text-text-1">
            {room.adversary} has nothing to attack
          </p>
        </div>
        <p className="mt-2 max-w-prose text-body-sm text-text-2">
          Not one objection in this room fires against your current dossier. That is the intended win
          condition and it is worth being suspicious of: delete a figure you are least sure of and see who
          starts asking questions again.
        </p>
        <p className="mt-3 max-w-prose text-body-sm text-text-3">{room.closing}</p>
      </section>
    )
  }

  const chosen = current && picked ? current.responses.find((r) => r.id === picked) : undefined

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="font-mono text-label uppercase tracking-wide text-text-3">
          {run.complete
            ? `${run.queue.length} objections faced`
            : `objection ${run.cursor + 1} of ${run.queue.length}`}
        </p>
        <p className="font-mono text-[11px] text-text-3">
          wounds {run.wounds}/{WOUND_BUDGET}
          {run.answers.length > 0 && !run.complete && ' · running'}
        </p>
      </div>

      {current && (
        <article className="mt-3 rounded-lg border border-line bg-surface-1 px-5 py-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-[11px] uppercase tracking-wide text-text-3">{current.id}</span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase',
                current.severity === 3 ? 'border-rose-400/40 text-rose-400' : 'border-line text-text-3',
              )}
            >
              severity {current.severity}
            </span>
            <span className="font-mono text-[10px] text-text-3">{current.artifact}</span>
          </div>

          <p className="mt-4 max-w-prose text-body text-text-1">{current.ask(dossier)}</p>

          <Why objection={current} dossier={dossier} />

          <ul className="mt-5 space-y-3">
            {current.responses.map((r) => {
              const isPick = picked === r.id
              const style = OUTCOME[r.outcome]
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    disabled={picked !== null}
                    onClick={() => setPicked(r.id)}
                    className={cn(
                      'w-full rounded-md border px-4 py-3 text-left transition-colors',
                      isPick ? style.cls : 'border-line text-text-2',
                      picked === null ? 'hover:border-text-3' : !isPick && 'opacity-40',
                    )}
                  >
                    <p className="text-body-sm">{r.label}</p>
                    {isPick && (
                      <span
                        className={cn(
                          'mt-2 inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase',
                          style.cls,
                        )}
                      >
                        {style.label}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>

          {chosen && (
            <div className="mt-5 border-t border-line pt-4">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                {room.adversary} answers
              </p>
              <p className="mt-2 max-w-prose text-body text-text-1">{chosen.rebuttal}</p>
              <button
                type="button"
                onClick={() => {
                  const a = answerFor(current, chosen.id)
                  if (a) setAnswers((prev) => [...prev, a])
                  setPicked(null)
                }}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-text-2 hover:border-text-3 hover:text-text-1"
              >
                {run.cursor === run.queue.length - 1 ? 'close the meeting' : 'next objection'}
                <ArrowRight size={12} />
              </button>
            </div>
          )}
        </article>
      )}

      {run.complete && (
        <div className={cn('mt-3 rounded-lg border bg-surface-1 px-5 py-5', VERDICT[run.verdict].cls)}>
          <div className="flex items-center gap-2">
            {run.verdict === 'lost' ? (
              <Skull size={16} strokeWidth={1.75} />
            ) : run.verdict === 'survived' ? (
              <ShieldCheck size={16} strokeWidth={1.75} />
            ) : (
              <TriangleAlert size={16} strokeWidth={1.75} />
            )}
            <p className="font-display text-body font-medium">{VERDICT[run.verdict].title}</p>
          </div>
          <p className="mt-2 max-w-prose text-body-sm text-text-2">{VERDICT[run.verdict].note}</p>

          <Ledger answers={run.answers} objections={run.queue} />

          {run.verdict !== 'lost' && (
            <p className="mt-4 border-t border-line pt-3 max-w-prose text-body-sm italic text-text-2">
              {room.closing}
            </p>
          )}

          <button
            type="button"
            onClick={restart}
            className="mt-4 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3 hover:text-text-1"
          >
            <RotateCcw size={12} />
            walk back in
          </button>
        </div>
      )}

      {run.answers.length > 0 && !run.complete && (
        <div className="mt-3 rounded-lg border border-line bg-surface-1 px-5 py-4">
          <p className="font-mono text-label uppercase tracking-wide text-text-3">so far</p>
          <Ledger answers={run.answers} objections={run.queue} />
        </div>
      )}
    </section>
  )
}
