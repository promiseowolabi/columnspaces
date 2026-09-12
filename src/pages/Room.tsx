/**
 * Design Review rooms.
 *
 * The room is the grader for the architecture half: you submit numbers, an
 * adversary attacks the numbers you submitted, and every objection is a pure
 * predicate over your dossier. This page is now an encounter rather than a
 * reading — it has three modes, and which one you should be in depends on where
 * you are:
 *
 *   dossier    the numbers you produced at the desks, grouped by where they came
 *              from. Persisted, exportable, and deliberately un-validated.
 *   encounter  only the objections your dossier fires, worst first, one at a
 *              time, rebuttal after the answer. Graded, with a verdict.
 *   study      the old read-only surface: every objection in the room with every
 *              outcome visible. Kept reachable on purpose — the rebuttals teach
 *              more than the score does, and reading them before an attempt is
 *              preparation, not cheating.
 *
 * All grading logic is imported from `@/data/rooms` and `@/lib/rooms/encounter`.
 * This file decides layout and nothing else.
 */

import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ChevronLeft, Gavel } from 'lucide-react'
import { ROOMS, getRoom, objectionsFor } from '@/data/rooms'
import type { Outcome, Room } from '@/data/rooms'
import type { RoomId } from '@/data/lessons/types'
import { standing } from '@/lib/rooms/encounter'
import { DossierEditor } from '@/components/DossierEditor'
import { RoomEncounter } from '@/components/RoomEncounter'
import { useProgress } from '@/lib/progress'
import { cn } from '@/lib/utils'

const OUTCOME_STYLE: Record<Outcome, { label: string; cls: string }> = {
  survive: { label: 'survive', cls: 'text-accent border-accent/50' },
  wounded: { label: 'wounded', cls: 'text-amber-400 border-amber-400/40' },
  fatal: { label: 'fatal', cls: 'text-rose-400 border-rose-400/40' },
}

const VERDICT_LABEL: Record<string, string> = {
  survived: 'survived',
  'survived-wounded': 'survived — wounded',
  lost: 'lost',
}

type Mode = 'encounter' | 'study' | 'dossier'

function ModeTabs({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const tabs: { id: Mode; label: string }[] = [
    { id: 'encounter', label: 'encounter' },
    { id: 'study', label: 'study' },
    { id: 'dossier', label: 'dossier' },
  ]
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-pressed={mode === t.id}
          onClick={() => setMode(t.id)}
          className={cn(
            'rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide transition-colors',
            mode === t.id ? 'border-accent/60 text-accent' : 'border-line text-text-3 hover:border-text-3',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function RoomIndex() {
  const dossier = useProgress((s) => s.dossier)
  const rooms = useProgress((s) => s.rooms)
  const [showDossier, setShowDossier] = useState(false)
  const s = useMemo(() => standing(ROOMS, dossier), [dossier])

  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
      <p className="font-mono text-label uppercase tracking-[0.16em] text-text-3">the architecture half</p>
      <h1 className="mt-3 font-display text-h1 font-semibold text-text-1">Design Review</h1>
      <p className="mt-3 max-w-prose text-body text-text-2">
        Five adversaries. They do not ask generic questions — every objection is a predicate over the numbers
        you submitted, so the same dossier always faces the same room, and changing one number changes which
        objection you face.
      </p>
      <p className="mt-3 max-w-prose text-body-sm text-text-3">
        {s.filled} of {s.total} figures submitted · {s.firing} objections firing across the five rooms ·{' '}
        <span className={cn(s.critical > 0 ? 'text-rose-400' : 'text-accent')}>{s.critical} critical</span>
      </p>

      <div className="mt-6">
        <button
          type="button"
          aria-pressed={showDossier}
          onClick={() => setShowDossier((v) => !v)}
          className={cn(
            'rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide transition-colors',
            showDossier ? 'border-accent/60 text-accent' : 'border-line text-text-3 hover:border-text-3',
          )}
        >
          {showDossier ? 'hide the dossier' : 'edit the dossier'}
        </button>
      </div>

      {showDossier && (
        <div className="mt-8">
          <DossierEditor />
        </div>
      )}

      <div className="mt-10 space-y-4">
        {ROOMS.map((r) => {
          const firing = objectionsFor(r, dossier)
          const crit = firing.filter((o) => o.severity === 3).length
          const run = rooms[r.id]
          return (
            <Link
              key={r.id}
              to={`/room/${r.id}`}
              className="block rounded-lg border border-line bg-surface-1 px-5 py-4 transition-colors hover:border-text-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-display text-body font-medium text-text-1">{r.adversary}</span>
                <span className="font-mono text-[11px] text-text-3">{r.id}</span>
              </div>
              <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wide text-text-3">{r.role}</p>
              <p className="mt-2 max-w-prose text-body-sm text-text-2">
                {firing.length} of {r.objections.length} objections fire against your dossier
                {crit > 0 && <span className="text-rose-400"> · {crit} critical</span>}
              </p>
              {run?.bestVerdict && (
                <p className="mt-1 font-mono text-[11px] text-text-3">
                  best: {VERDICT_LABEL[run.bestVerdict] ?? run.bestVerdict} · {run.attempts} attempt
                  {run.attempts === 1 ? '' : 's'}
                </p>
              )}
            </Link>
          )
        })}
      </div>
    </div>
  )
}

/** The original read-only surface: every objection, every outcome visible. */
function StudyMode({ room }: { room: Room }) {
  return (
    <>
      <p className="mt-8 max-w-prose text-body-sm text-text-3">
        Study mode shows every objection in the room with its outcomes visible, regardless of what you
        submitted. Read it before an attempt: the rebuttals are the teaching, and knowing them in advance does
        not help you if your dossier has a hole in it.
      </p>

      <section className="mt-8 space-y-8">
        {room.objections.map((o) => (
          <article key={o.id} className="rounded-lg border border-line bg-surface-1 px-5 py-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-[11px] uppercase tracking-wide text-text-3">{o.id}</span>
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase',
                  o.severity === 3 ? 'border-rose-400/40 text-rose-400' : 'border-line text-text-3',
                )}
              >
                severity {o.severity}
              </span>
              <span className="font-mono text-[10px] text-text-3">{o.artifact}</span>
            </div>

            <p className="mt-3 text-body text-text-1">{o.ask({})}</p>

            <ul className="mt-5 space-y-3">
              {o.responses.map((r) => {
                const style = OUTCOME_STYLE[r.outcome]
                return (
                  <li key={r.id} className="rounded-md border border-line px-4 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <p className="text-body-sm text-text-2">{r.label}</p>
                      <span
                        className={cn(
                          'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase',
                          style.cls,
                        )}
                      >
                        {style.label}
                      </span>
                    </div>
                    <p className="mt-2 border-t border-line pt-2 text-body-sm italic text-text-3">
                      {r.rebuttal}
                    </p>
                  </li>
                )
              })}
            </ul>
          </article>
        ))}
      </section>

      <section className="mt-12 rounded-lg border border-line bg-surface-1 px-5 py-4">
        <p className="font-mono text-label uppercase tracking-wide text-text-3">if you survive the room</p>
        <p className="mt-2 max-w-prose text-body-sm text-text-1">{room.closing}</p>
      </section>
    </>
  )
}

function RoomDetail({ room }: { room: Room }) {
  const dossier = useProgress((s) => s.dossier)
  const run = useProgress((s) => s.rooms[room.id])
  const [mode, setMode] = useState<Mode>('encounter')

  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
      <Link
        to="/rooms"
        className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3 hover:text-text-1"
      >
        <ChevronLeft size={12} />
        all rooms
      </Link>

      <div className="mt-6 flex items-center gap-3">
        <Gavel className="h-5 w-5 text-text-3" strokeWidth={1.75} />
        <h1 className="font-display text-h1 font-semibold text-text-1">{room.adversary}</h1>
      </div>
      <p className="mt-1 font-mono text-[11px] uppercase tracking-wide text-text-3">{room.role}</p>
      {run?.bestVerdict && (
        <p className="mt-1 font-mono text-[11px] text-text-3">
          best verdict: {VERDICT_LABEL[run.bestVerdict] ?? run.bestVerdict} over {run.attempts} attempt
          {run.attempts === 1 ? '' : 's'}
        </p>
      )}

      <blockquote className="mt-8 border-l-2 border-line pl-5 text-body text-text-2">{room.opening}</blockquote>

      <div className="mt-8">
        <ModeTabs mode={mode} setMode={setMode} />
      </div>

      {mode === 'encounter' && <RoomEncounter room={room} dossier={dossier} />}
      {mode === 'study' && <StudyMode room={room} />}
      {mode === 'dossier' && (
        <div className="mt-10">
          <p className="max-w-prose text-body-sm text-text-3">
            Edit the numbers, then switch back to the encounter. The room recomputes from the dossier every
            time — this is the intended loop, not a way around the grading.
          </p>
          <div className="mt-6">
            <DossierEditor />
          </div>
        </div>
      )}
    </div>
  )
}

export default function RoomPage() {
  const { roomId } = useParams()
  const room = roomId ? getRoom(roomId as RoomId) : undefined
  return room ? <RoomDetail room={room} /> : <RoomIndex />
}
