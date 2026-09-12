/**
 * Desks — the architecture half's numeric labs.
 *
 * A desk is graded in bands against a reference model, because a sizing model
 * is not "correct", it is within tolerance and honestly caveated. This page
 * renders the registry: the decision each desk stands in for, what the learner
 * submits, and the checks it grades.
 *
 * The reference models and the submission forms land in phase 6 (PLAN.md). The
 * metadata is shown now because it is the contract the A1/A2 lessons are
 * written against — a lesson may only promise what a desk actually grades.
 */

import { Link, useParams } from 'react-router'
import { Calculator, ChevronLeft } from 'lucide-react'
import { DESKS, getDesk } from '@/lib/desks'
import type { DeskId } from '@/data/lessons/types'

function DeskIndex() {
  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
      <p className="font-mono text-label uppercase tracking-[0.16em] text-text-3">the architecture half</p>
      <h1 className="mt-3 font-display text-h1 font-semibold text-text-1">The Desks</h1>
      <p className="mt-3 max-w-prose text-body text-text-2">
        Eight decisions an architect is actually asked to make. Each is graded against a reference model in
        bands rather than against a single value, and every cost is a count — bytes, files, partitions,
        engineer-months — never wall-clock.
      </p>

      <div className="mt-10 space-y-4">
        {DESKS.map((d) => (
          <Link
            key={d.id}
            to={`/desk/${d.id}`}
            className="block rounded-lg border border-line bg-surface-1 px-5 py-4 transition-colors hover:border-text-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-display text-body font-medium text-text-1">{d.name}</span>
              <span className="font-mono text-[11px] text-text-3">L{d.level}</span>
            </div>
            <p className="mt-1.5 max-w-prose text-body-sm text-text-2">{d.decision}</p>
            <p className="mt-2 font-mono text-[11px] text-text-3">grades — {d.checks.join(' · ')}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}

function DeskDetail({ id }: { id: DeskId }) {
  const desk = getDesk(id)
  if (!desk) return <DeskIndex />

  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
      <Link
        to="/desks"
        className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3 hover:text-text-1"
      >
        <ChevronLeft size={12} />
        all desks
      </Link>

      <div className="mt-6 flex items-center gap-3">
        <Calculator className="h-5 w-5 text-text-3" strokeWidth={1.75} />
        <h1 className="font-display text-h1 font-semibold text-text-1">{desk.name}</h1>
      </div>
      <p className="mt-1 font-mono text-[11px] uppercase tracking-wide text-text-3">level {desk.level}</p>

      <section className="mt-10">
        <h2 className="font-mono text-label uppercase tracking-wide text-text-3">the decision</h2>
        <p className="mt-2 max-w-prose text-body text-text-2">{desk.decision}</p>
      </section>

      <section className="mt-8">
        <h2 className="font-mono text-label uppercase tracking-wide text-text-3">you submit</h2>
        <p className="mt-2 max-w-prose text-body text-text-2">{desk.submits}</p>
      </section>

      <section className="mt-8">
        <h2 className="font-mono text-label uppercase tracking-wide text-text-3">graded checks</h2>
        <ul className="mt-2 space-y-1.5">
          {desk.checks.map((c) => (
            <li key={c} className="font-mono text-[12px] text-text-2">
              {c}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8 rounded-lg border border-line bg-surface-1 px-5 py-4">
        <h2 className="font-mono text-label uppercase tracking-wide text-text-3">the number you leave with</h2>
        <p className="mt-2 max-w-prose text-body-sm text-text-1">{desk.takeaway}</p>
      </section>

      <p className="mt-10 max-w-prose text-body-sm text-text-3">
        The reference model for this desk is implemented in <code>src/lib/desks/</code> and graded in
        tolerance bands — a sizing model is not correct, it is within tolerance and honestly caveated.
        Several of the checks above fail on an <em>omission</em> even when the point estimate is perfect,
        because the term you left out is the failure mode. The in-page submission form is not built yet;
        until it is, the desks are gradeable from their models and the A1/A2 lessons teach the arithmetic
        each one checks.
      </p>
    </div>
  )
}

export default function DeskPage() {
  const { deskId } = useParams()
  return deskId ? <DeskDetail id={deskId as DeskId} /> : <DeskIndex />
}
