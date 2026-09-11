/**
 * The Warehouse — the persistent world.
 *
 * One columnar platform, assembled cumulatively from the reader's own lab
 * artifacts, driven by a deterministic query trace. Replaces tablespace's
 * Engine page (which simulated a buffer pool); the metrics here are the ones
 * this course is about.
 *
 * Every metric is a COUNT, never wall-clock: a count means the same thing on
 * every machine, which is what makes a run replayable and diffable against the
 * reference. The trace player and the visualisation land in phase 2 (PLAN.md);
 * this page states the contract it will be built against, because a stub that
 * lies about what is coming is worse than no stub.
 */

import { Link } from 'react-router'
import { Database, Gauge, Layers, Network, Scissors } from 'lucide-react'
import { SIMS } from '@/lib/tracks'

const METRICS = [
  {
    icon: Gauge,
    name: 'bytes scanned',
    line: 'The bill. Projection × pruning × frequency, measured rather than asserted.',
  },
  {
    icon: Scissors,
    name: 'pruning ratio',
    line: 'Blocks skipped unread ÷ blocks that matched the predicate range. Falls the moment clustering degrades.',
  },
  {
    icon: Layers,
    name: 'compression ratio',
    line: 'Per column, not per table — the average hides the column that sets your floor.',
  },
  {
    icon: Database,
    name: 'files touched',
    line: 'Planning cost scales with file count, not data size. This is the number a small-file storm moves.',
  },
  {
    icon: Network,
    name: 'bytes shuffled',
    line: 'Reported as max-over-mean per partition, because the largest partition is the runtime.',
  },
]

const TRACES = [
  {
    id: 'dashboard',
    name: 'the dashboard',
    line: 'Narrow, repetitive, highly prunable. The workload a good layout makes nearly free — and the one that quietly triples when clustering breaks.',
  },
  {
    id: 'adhoc',
    name: 'the analyst',
    line: 'Wide, unpredictable projections with weak predicates. The pruning killer, and the reason quotas exist.',
  },
  {
    id: 'ingest',
    name: 'ingest & update',
    line: 'Continuous small commits with updates and deletes. The merge-on-read adversary: read amplification grows until compaction pays it down.',
  },
  {
    id: 'skew',
    name: 'the skewed join',
    line: 'One join key holding a disproportionate share of rows. Mean partition size stays flat while the job gets slower.',
  },
]

export default function Warehouse() {
  const sim = SIMS.find((s) => s.id === 'warehouse')

  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
      <p className="font-mono text-label uppercase tracking-[0.16em] text-text-3">the persistent world</p>
      <h1 className="mt-3 font-display text-h1 font-semibold text-text-1">The Warehouse</h1>
      <p className="mt-3 max-w-prose text-body text-text-2">{sim?.hook}</p>

      <section className="mt-12">
        <h2 className="font-display text-h3 font-medium text-text-1">What it measures</h2>
        <p className="mt-2 max-w-prose text-body-sm text-text-3">
          Five counts. No wall clock anywhere — a count means the same thing on every machine, so a run is
          replayable and can be diffed against the reference.
        </p>
        <ul className="mt-6 space-y-4">
          {METRICS.map((m) => (
            <li key={m.name} className="flex items-start gap-4">
              <m.icon className="mt-0.5 h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} />
              <div>
                <p className="font-mono text-[12px] uppercase tracking-wide text-text-1">{m.name}</p>
                <p className="mt-0.5 max-w-prose text-body-sm text-text-2">{m.line}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-h3 font-medium text-text-1">Trace modes</h2>
        <p className="mt-2 max-w-prose text-body-sm text-text-3">
          Four deterministic query streams, each one an adversary for a different design decision.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {TRACES.map((t) => (
            <div key={t.id} className="rounded-lg border border-line bg-surface-1 px-5 py-4">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-1">{t.name}</p>
              <p className="mt-1.5 text-body-sm text-text-2">{t.line}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-12 rounded-lg border border-dashed border-line bg-surface-1 px-6 py-6">
        <p className="font-mono text-label uppercase tracking-wide text-text-3">build state</p>
        <p className="mt-2 max-w-prose text-body-sm text-text-2">
          The trace player is not built yet. It arrives with the C0 track, and the contract above is what it
          will be built against — the metrics, the counts and the four traces are fixed now precisely so that
          the lessons can be written against them.
        </p>
        <Link
          to="/curriculum"
          className="mt-4 inline-block font-mono text-[11px] uppercase tracking-wide text-text-2 underline decoration-dotted hover:text-text-1"
        >
          back to the curriculum
        </Link>
      </section>
    </div>
  )
}
