/**
 * Design Review rooms.
 *
 * The room is the grader for the architecture half: you submit numbers, an
 * adversary attacks the numbers you submitted, and every objection is a pure
 * predicate over your dossier. This page renders the rooms and their objection
 * trees — the adversary, how they open, what they ask, and what each response
 * costs you.
 *
 * The dossier editor (which decides WHICH objections fire) lands in phase 6
 * (PLAN.md). Until then every objection is shown, with its outcomes visible,
 * which is deliberately a study surface rather than a test: the responses teach
 * more than the score does.
 */

import { Link, useParams } from 'react-router'
import { ChevronLeft, Gavel } from 'lucide-react'
import { ROOMS, getRoom } from '@/data/rooms'
import type { Outcome, Room } from '@/data/rooms'
import type { RoomId } from '@/data/lessons/types'
import { cn } from '@/lib/utils'

const OUTCOME_STYLE: Record<Outcome, { label: string; cls: string }> = {
  survive: { label: 'survive', cls: 'text-accent border-accent/50' },
  wounded: { label: 'wounded', cls: 'text-amber-400 border-amber-400/40' },
  fatal: { label: 'fatal', cls: 'text-rose-400 border-rose-400/40' },
}

function RoomIndex() {
  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
      <p className="font-mono text-label uppercase tracking-[0.16em] text-text-3">the architecture half</p>
      <h1 className="mt-3 font-display text-h1 font-semibold text-text-1">Design Review</h1>
      <p className="mt-3 max-w-prose text-body text-text-2">
        Five adversaries. They do not ask generic questions — every objection is a predicate over the numbers
        you submitted, so the same dossier always faces the same room, and changing one number changes which
        objection you face.
      </p>

      <div className="mt-10 space-y-4">
        {ROOMS.map((r) => (
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
              {r.objections.length} objections · {r.objections.filter((o) => o.severity === 3).length} critical
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}

function RoomDetail({ room }: { room: Room }) {
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

      <blockquote className="mt-8 border-l-2 border-line pl-5 text-body text-text-2">{room.opening}</blockquote>

      <section className="mt-12 space-y-8">
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

      <p className="mt-10 max-w-prose text-body-sm text-text-3">
        Every objection is shown here with its outcomes visible. Once the dossier editor lands, only the
        objections your own numbers trigger will fire — and the rebuttals will arrive after you choose, not
        before.
      </p>
    </div>
  )
}

export default function RoomPage() {
  const { roomId } = useParams()
  const room = roomId ? getRoom(roomId as RoomId) : undefined
  return room ? <RoomDetail room={room} /> : <RoomIndex />
}
