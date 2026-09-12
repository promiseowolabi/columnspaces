/**
 * Capstone — The Platform Decision.
 *
 * The ending of the course, and deliberately NOT new content: there is no
 * capstone lesson, no capstone quiz and no capstone grader. Everything on this
 * page is already true somewhere else — the objection predicates in
 * `@/data/rooms`, the verdict rule in `@/lib/rooms/encounter`, the attempt
 * history in the progress store — and this page reads it back as one status.
 * Aggregation only; the arithmetic lives in `@/lib/rooms/capstone`.
 *
 * Four sections, in the order they matter:
 *
 *   the four artifacts   what you are holding, which of your own numbers feed
 *                        each one, and what is still blank. The field → artifact
 *                        mapping is COMPUTED from the objections, so it cannot
 *                        drift from what the rooms actually attack.
 *   the five rooms       how much heat your dossier is taking right now, and the
 *                        best verdict you have earned in each.
 *   the verdict          passed when all five rooms have been survived. Stated
 *                        honestly, including "passed with wounds", because a
 *                        review you barely survived is not one you aced.
 *   the honest ending    the point of the whole course. No cluster, no measured
 *                        figure, therefore a proof-of-concept PLAN and not a
 *                        recommendation. Read from the learner's own dossier.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { AlertTriangle, ChevronRight, FlaskConical, ShieldCheck } from 'lucide-react'
import { ROOMS } from '@/data/rooms'
import type { Objection } from '@/data/rooms'
import { CAPSTONE } from '@/lib/tracks'
import { DESKS } from '@/lib/desks'
import { fieldLabel } from '@/lib/rooms/dossier-fields'
import type { DossierKey } from '@/lib/rooms/dossier-fields'
import { standing } from '@/lib/rooms/encounter'
import type { Verdict } from '@/lib/rooms/encounter'
import {
  CAPSTONE_SIM_ID,
  CAPSTONE_TASK_ID,
  POC_FIELDS,
  UNATTACKED_GROUPS,
  artifactStandings,
  capstoneVerdict,
  pocStanding,
  roomStandings,
} from '@/lib/rooms/capstone'
import type { ArtifactStanding, PocStanding, RoomStanding } from '@/lib/rooms/capstone'
import { DossierEditor } from '@/components/DossierEditor'
import { useProgress } from '@/lib/progress'
import { cn } from '@/lib/utils'

const VERDICT_LABEL: Record<Verdict, string> = {
  survived: 'survived',
  'survived-wounded': 'survived — wounded',
  lost: 'lost',
}

const deskName = (id: string | undefined): string | undefined => DESKS.find((d) => d.id === id)?.name

function Chip({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'idle'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide',
        tone === 'good' && 'border-accent/50 text-accent',
        tone === 'warn' && 'border-amber-400/40 text-amber-400',
        tone === 'bad' && 'border-rose-400/40 text-rose-400',
        tone === 'idle' && 'border-line text-text-3',
      )}
    >
      {children}
    </span>
  )
}

/** A blank field, shown as what an adversary does with it rather than as a gap. */
function BlankList({ keys }: { keys: DossierKey[] }) {
  if (keys.length === 0) return null
  return (
    <ul className="mt-3 space-y-1.5">
      {keys.map((k) => (
        <li key={k} className="flex items-start gap-1.5 text-body-sm text-text-3">
          <AlertTriangle size={12} className="mt-1 shrink-0 text-amber-400" strokeWidth={1.75} />
          <span>
            {fieldLabel(k)} <span className="font-mono text-[10px] text-text-3">{k}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function FiringList({ firing }: { firing: Objection[] }) {
  if (firing.length === 0) return null
  return (
    <p className="mt-3 font-mono text-[11px] text-text-3">
      firing —{' '}
      {firing.map((o, i) => (
        <span key={o.id}>
          {i > 0 && ' · '}
          <span className={o.severity === 3 ? 'text-rose-400' : undefined}>{o.id}</span>
        </span>
      ))}
    </p>
  )
}

function ArtifactCard({ a }: { a: ArtifactStanding }) {
  return (
    <section className="rounded-lg border border-line bg-surface-1 px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-body font-medium text-text-1">{a.meta.name}</h3>
        <div className="flex items-center gap-2">
          <Chip tone={a.complete ? 'good' : 'warn'}>
            {a.submitted.length}/{a.fields.length} stated
          </Chip>
          <span className="font-mono text-[10px] text-text-3">{a.meta.id}</span>
        </div>
      </div>
      <p className="mt-1.5 max-w-prose text-body-sm text-text-2">{a.meta.question}</p>

      <p className="mt-3 font-mono text-[11px] text-text-3">
        fed by{' '}
        {a.groups.map((g, i) => (
          <span key={g.group.id}>
            {i > 0 && ' · '}
            {deskName(g.group.desk) ?? g.group.title} ({g.submitted}/{g.fields.length})
          </span>
        ))}
      </p>

      <p className="mt-2 text-body-sm text-text-2">
        {a.objections} objections attack it across the five rooms;{' '}
        <span className={a.firing.length > 0 ? 'text-amber-400' : 'text-accent'}>
          {a.firing.length} fire against your dossier
        </span>
        {a.critical > 0 && <span className="text-rose-400"> · {a.critical} critical</span>}.
      </p>
      <FiringList firing={a.firing} />
      <BlankList keys={a.blank} />
    </section>
  )
}

function RoomRow({ s }: { s: RoomStanding }) {
  return (
    <Link
      to={`/room/${s.room.id}`}
      className="block rounded-lg border border-line bg-surface-1 px-5 py-4 transition-colors hover:border-text-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-body font-medium text-text-1">{s.room.adversary}</span>
        <div className="flex items-center gap-2">
          {s.bestVerdict ? (
            <Chip tone={s.bestVerdict === 'survived' ? 'good' : s.wounded ? 'warn' : 'bad'}>
              {VERDICT_LABEL[s.bestVerdict]}
            </Chip>
          ) : (
            <Chip tone="idle">not entered</Chip>
          )}
          <ChevronRight size={14} className="text-text-3" />
        </div>
      </div>
      <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wide text-text-3">{s.room.role}</p>
      <p className="mt-2 text-body-sm text-text-2">
        {s.firing} of {s.room.objections.length} objections fire against your dossier
        {s.critical > 0 && <span className="text-rose-400"> · {s.critical} critical</span>}
        {s.attempts > 0 && (
          <span className="text-text-3">
            {' '}
            · {s.attempts} attempt{s.attempts === 1 ? '' : 's'}
          </span>
        )}
      </p>
    </Link>
  )
}

/**
 * The honest ending. This is the section the course exists to arrive at, so it is
 * stated in the UI rather than left as an implication: nothing here was measured
 * by us, therefore what the learner is holding is a plan to measure, not a
 * result. It mirrors THE_VENDOR's severity-3 `poc_undefined` — deliberately, and
 * it reads the same field that objection reads.
 */
function HonestEnding({ poc }: { poc: PocStanding }) {
  const tone = poc.status === 'complete' ? 'good' : poc.status === 'partial' ? 'warn' : 'bad'
  return (
    <section
      className={cn(
        'rounded-lg border bg-surface-1 px-5 py-5',
        poc.status === 'complete' ? 'border-accent/40' : 'border-amber-400/40',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FlaskConical size={16} className="text-amber-400" strokeWidth={1.75} />
          <h2 className="font-display text-h4 text-text-1">The honest ending</h2>
        </div>
        <Chip tone={tone}>
          {poc.status === 'complete'
            ? 'poc plan defined'
            : poc.status === 'partial'
              ? 'poc plan incomplete'
              : 'no poc plan'}
        </Chip>
      </div>

      <p className="mt-3 max-w-prose text-body text-text-1">
        There is no cluster behind this course. We do not run VAST, or a warehouse, or anything else you have
        been reasoning about at the desks. <strong className="font-medium">No performance figure anywhere in
        this course was measured by us</strong> — the labs measure the engine you built and DuckDB in your own
        browser tab, and every vendor claim is quarantined in a dated, sourced vendor block precisely so it can
        never be mistaken for our result.
      </p>
      <p className="mt-3 max-w-prose text-body text-text-2">
        So the deliverable at the end of this is not a recommendation you can act on. It is a{' '}
        <strong className="font-medium text-text-1">proof-of-concept plan</strong>: the measurements someone
        with the hardware would have to take, on your data and your query mix, before the memo you have written
        becomes a decision. Anything stronger than that would be the overclaim this whole course is an argument
        against.
      </p>

      <div className="mt-5 space-y-3">
        <div className="rounded-md border border-line px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-body-sm text-text-1">the POC has defined measurements</p>
            <Chip tone={poc.defined ? 'good' : 'bad'}>{poc.defined ? 'stated' : 'blank'}</Chip>
          </div>
          {!poc.defined && (
            <p className="mt-2 text-body-sm text-text-3">
              This is the field THE_VENDOR&apos;s severity-3 <span className="font-mono text-[11px]">poc_undefined</span>{' '}
              reads. Blank, it is the single most expensive gap in the course: six weeks of trial producing a
              result nobody can act on.
            </p>
          )}
        </div>

        <div className="rounded-md border border-line px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-body-sm text-text-1">metrics the POC collects</p>
            <Chip tone={poc.hasMetrics ? 'good' : 'bad'}>
              {poc.hasMetrics ? `${poc.metrics.length} stated` : 'blank'}
            </Chip>
          </div>
          {poc.hasMetrics ? (
            <ul className="mt-2 space-y-1">
              {poc.metrics.map((m) => (
                <li key={m} className="font-mono text-[11px] text-text-2">
                  {m}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-body-sm text-text-3">
              Without a metric list the trial measures whatever the vendor&apos;s engineers find easiest to
              show you.
            </p>
          )}
        </div>

        <div
          className={cn(
            'rounded-md border px-4 py-3',
            poc.falsifier ? 'border-line' : 'border-rose-400/40',
          )}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-body-sm text-text-1">a result that would make us decline</p>
            <Chip tone={poc.falsifier ? 'good' : 'bad'}>{poc.falsifier ? 'stated' : 'blank'}</Chip>
          </div>
          {poc.falsifier ? (
            <p className="mt-2 text-body-sm text-text-3">
              You have written the exit criterion before the trial. That is what makes it an evaluation rather
              than a purchase with extra steps — and it is the one thing on this page no objection in the five
              rooms currently checks, so nobody made you do it.
            </p>
          ) : (
            <p className="mt-2 text-body-sm text-text-2">
              You have not named one.{' '}
              <strong className="font-medium text-text-1">
                A plan with no result that would change the recommendation is not an evaluation.
              </strong>{' '}
              It is a purchase with extra steps: every outcome confirms the decision you have already taken,
              which means the six weeks buy you nothing but a date.
            </p>
          )}
        </div>
      </div>

      <p className="mt-4 max-w-prose text-body-sm text-text-3">
        Two more of your own answers bear on this: you recorded that you{' '}
        {poc.benchmarkedOurselves ? 'did' : 'did not'} measure the platform on your own data, and that
        vendor-published figures {poc.vendorNumbersQuoted ? 'do' : 'do not'} appear in your business case. If
        both of those are true at once, every performance number in your memo belongs to someone with an
        interest in the answer.
      </p>
      {poc.blank.length > 0 && (
        <p className="mt-3 font-mono text-[11px] text-text-3">
          still blank — {poc.blank.map((k) => k).join(' · ')} · edit them in the dossier below
        </p>
      )}
    </section>
  )
}

export default function CapstonePage() {
  const dossier = useProgress((s) => s.dossier)
  const rooms = useProgress((s) => s.rooms)
  const recordSimTask = useProgress((s) => s.recordSimTask)
  const recorded = useProgress((s) => s.sims[CAPSTONE_SIM_ID]?.tasksDone ?? [])
  const [showDossier, setShowDossier] = useState(false)

  const overall = useMemo(() => standing(ROOMS, dossier), [dossier])
  const artifacts = useMemo(() => artifactStandings(dossier), [dossier])
  const roomRows = useMemo(() => roomStandings(dossier, rooms), [dossier, rooms])
  const verdict = useMemo(() => capstoneVerdict(roomRows), [roomRows])
  const poc = useMemo(() => pocStanding(dossier), [dossier])

  const done = recorded.includes(CAPSTONE_TASK_ID)
  useEffect(() => {
    if (verdict.passed && !done) recordSimTask(CAPSTONE_SIM_ID, CAPSTONE_TASK_ID)
  }, [verdict.passed, done, recordSimTask])

  const artifactsComplete = artifacts.filter((a) => a.complete).length

  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
      <p className="font-mono text-label uppercase tracking-[0.16em] text-text-3">
        the architecture half · the ending
      </p>
      <div className="mt-3 flex items-center gap-3">
        <ShieldCheck className="h-6 w-6" strokeWidth={1.75} style={{ color: CAPSTONE.color }} />
        <h1 className="font-display text-h1 font-semibold text-text-1">{CAPSTONE.name}</h1>
      </div>
      <p className="mt-3 max-w-prose text-body text-text-2">{CAPSTONE.promise}</p>
      <p className="mt-3 max-w-prose text-body-sm text-text-3">
        Nothing new is graded here. This is your dossier read back to you as four artifacts, five rooms and one
        verdict — recomputed from the numbers you submitted, every time you open it.
      </p>

      {/* ------------------------------ the verdict ------------------------------ */}
      <section
        className={cn(
          'mt-10 rounded-lg border px-5 py-5',
          verdict.passed
            ? verdict.withWounds
              ? 'border-amber-400/50 bg-surface-1'
              : 'border-accent/50 bg-surface-1'
            : 'border-line bg-surface-1',
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-h4 text-text-1">The verdict</h2>
          <Chip tone={verdict.passed ? (verdict.withWounds ? 'warn' : 'good') : 'idle'}>
            {verdict.passed ? (verdict.withWounds ? 'passed — with wounds' : 'passed') : 'not yet passed'}
          </Chip>
        </div>
        <p className="mt-3 max-w-prose text-body text-text-2">
          The capstone is passed when all five rooms have been survived — on any verdict that is not{' '}
          <span className="font-mono text-[12px]">lost</span>. You have survived{' '}
          <span className="text-text-1">
            {verdict.survived} of {verdict.rooms}
          </span>
          .
        </p>
        {verdict.passed && verdict.withWounds && (
          <p className="mt-2 max-w-prose text-body text-amber-400">
            Passed with wounds in {verdict.wounded} room{verdict.wounded === 1 ? '' : 's'}. That is a pass and
            it is not rounded up: in each of those rooms you conceded ground or deferred, and the wound is
            recorded because a review you barely survived is not one you aced.
          </p>
        )}
        {verdict.lost.length > 0 && (
          <p className="mt-2 max-w-prose text-body-sm text-rose-400">
            lost, best attempt so far — {verdict.lost.join(' · ')}. Change the numbers, not the answers: the
            room recomputes from the dossier.
          </p>
        )}
        {verdict.unattempted.length > 0 && (
          <p className="mt-2 max-w-prose text-body-sm text-text-3">
            never entered — {verdict.unattempted.join(' · ')}. A room you have not walked into is not a room
            you survived.
          </p>
        )}
        <p className="mt-3 font-mono text-[11px] text-text-3">
          {overall.filled}/{overall.total} figures submitted · {artifactsComplete}/{artifacts.length} artifacts
          complete · {overall.firing} objections firing ·{' '}
          <span className={overall.critical > 0 ? 'text-rose-400' : 'text-accent'}>
            {overall.critical} critical
          </span>
        </p>
      </section>

      {/* ----------------------------- the artifacts ----------------------------- */}
      <h2 className="mt-14 font-display text-h3 text-text-1">The four artifacts</h2>
      <p className="mt-2 max-w-prose text-body-sm text-text-2">
        What you are holding at the end. Which of your figures feeds each one is not a list somebody typed —
        it is computed from the objections themselves, by perturbing one field at a time and watching which
        predicates move. A field an adversary only quotes back at you is not part of the artifact, because it
        does not decide anything. &ldquo;Complete&rdquo; below means stated, never correct: no part of this
        course can tell you a number is right.
      </p>
      <div className="mt-6 space-y-4">
        {artifacts.map((a) => (
          <ArtifactCard key={a.meta.id} a={a} />
        ))}
      </div>
      {UNATTACKED_GROUPS.length > 0 && (
        <p className="mt-4 max-w-prose text-body-sm text-text-3">
          Not part of any artifact:{' '}
          {UNATTACKED_GROUPS.map((g) => `${g.title.toLowerCase()} (${g.fields.length} figures)`).join(', ')}.
          Real numbers, produced at a real desk, that none of the five present rooms reads — so the capstone
          does not claim they were defended.
        </p>
      )}

      {/* ------------------------------- the rooms ------------------------------- */}
      <h2 className="mt-14 font-display text-h3 text-text-1">The five rooms</h2>
      <p className="mt-2 max-w-prose text-body-sm text-text-2">
        Objection counts are live against the dossier as it stands now; verdicts are the best you have earned,
        because re-entering a room with better numbers is the intended way to improve and losing a room you had
        already survived should not erase that you survived it.
      </p>
      <div className="mt-6 space-y-4">
        {roomRows.map((s) => (
          <RoomRow key={s.room.id} s={s} />
        ))}
      </div>

      {/* ---------------------------- the honest ending ---------------------------- */}
      <h2 className="mt-14 font-display text-h3 text-text-1">What this is, and is not</h2>
      <div className="mt-6">
        <HonestEnding poc={poc} />
      </div>

      {/* -------------------------------- dossier -------------------------------- */}
      <div className="mt-14">
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
        {showDossier && (
          <div className="mt-8">
            <DossierEditor />
          </div>
        )}
      </div>

      <p className="mt-14 max-w-prose text-body-sm text-text-3">
        {POC_FIELDS.length} fields decide the ending and{' '}
        {overall.total - POC_FIELDS.length} decide the rest of it. Every one of them is optional, and that is
        the argument: the plans that fail a review fail on what was left blank.
      </p>
    </div>
  )
}
