import { Link } from 'react-router'
import { motion } from 'framer-motion'
import { ArrowRight, Gavel, Hammer, Warehouse } from 'lucide-react'
import { TRACKS, TOTAL_TRACK_LESSONS, ORDERED_LESSON_IDS } from '@/lib/tracks'
import TrackCard from '@/components/TrackCard'
import { FORGE_LABS } from '@/data/labs'
import { DESKS } from '@/lib/desks'
import { ROOMS } from '@/data/rooms'
import { DRILLS } from '@/data/drills'
import { DUCK_LABS } from '@/data/duck-labs'

export default function Home() {
  const objections = ROOMS.reduce((n, r) => n + r.objections.length, 0)

  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="mx-auto max-w-3xl text-center"
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
          columnspaces · a columnar database course
        </p>
        <h1 className="mt-5 text-5xl font-semibold tracking-tight text-text-1 sm:text-6xl">
          Your warehouse bill is a physics readout.
          <br />
          <span className="text-accent">Learn to read it. Then design against it.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-body-lg text-text-2">
          {TOTAL_TRACK_LESSONS} lessons across {TRACKS.length} tracks, in two halves. Build the
          columnar layer — encodings, pruning, table formats, vectorized execution — as{' '}
          {FORGE_LABS.length} Rust labs graded in your browser, and check every claim against a real
          columnar engine running in the tab. Then architect a platform on it and defend the numbers
          to a CFO, a hostile principal and a vendor. No servers, no accounts.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to={`/lesson/${ORDERED_LESSON_IDS[0]}`}
            className="inline-flex items-center gap-2 rounded-md border border-accent/60 bg-accent/10 px-5 py-2.5 font-mono text-sm text-accent transition-colors hover:bg-accent/20"
          >
            start the curriculum <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            to="/warehouse"
            className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-1 px-5 py-2.5 font-mono text-sm text-text-2 transition-colors hover:text-text-1"
          >
            <Warehouse className="h-4 w-4" /> open the warehouse
          </Link>
        </div>
        <div className="mt-6 flex flex-wrap justify-center gap-2 font-mono text-[11px] text-text-3">
          {['rust + wasm', 'duckdb in-browser', 'local-first', 'no servers', 'agent-friendly'].map((chip) => (
            <span key={chip} className="rounded-full border border-line px-2.5 py-1">
              {chip}
            </span>
          ))}
        </div>
        <p className="mx-auto mt-5 max-w-xl text-body-sm text-text-3">
          Cost is always a count here — bytes, files, row groups, engineer-months — never a
          wall-clock number and never a price. The {DUCK_LABS.length} DuckDB labs run a real engine
          against real files; the desks and the {DRILLS.length} Column Week incidents are modelled,
          and say so on the page.
        </p>
      </motion.div>

      {/* tracks */}
      <div className="mt-20 grid gap-4 md:grid-cols-2">
        {TRACKS.map((t, i) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 + i * 0.06, ease: [0.16, 1, 0.3, 1] }}
          >
            <TrackCard track={t} />
          </motion.div>
        ))}
      </div>

      {/* forge + design review */}
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.4 }}>
          <Link
            to="/labs"
            className="group block rounded-lg border border-line bg-surface-1 p-6 transition-colors hover:border-accent/50"
          >
            <div className="flex items-center gap-2.5">
              <Hammer className="h-5 w-5 text-accent" />
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-3">the forge</p>
            </div>
            <p className="mt-3 text-h4 font-medium text-text-1">{FORGE_LABS[0].title}</p>
            <p className="mt-2 text-body-sm text-text-2">{FORGE_LABS[0].hook}</p>
            <p className="mt-4 font-mono text-[11px] text-accent">
              {FORGE_LABS.length} labs · graded on invariants, in your browser{' '}
              <ArrowRight className="inline h-3 w-3" />
            </p>
          </Link>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.48 }}>
          <Link
            to="/rooms"
            className="group block rounded-lg border border-amber/40 bg-surface-1 p-6 transition-colors hover:border-amber/70"
          >
            <div className="flex items-center gap-2.5">
              <Gavel className="h-5 w-5 text-amber" />
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-3">
                the architecture half
              </p>
            </div>
            <p className="mt-3 text-h4 font-medium text-text-1">Defend it in the room</p>
            <p className="mt-2 text-body-sm text-text-2">
              {DESKS.length} numeric desks graded in tolerance bands, then {ROOMS.length} adversaries
              and {objections} objections that attack the numbers <em>you</em> submitted — because
              judgement does not compile, and an essay is not a grade.
            </p>
            <p className="mt-4 font-mono text-[11px] text-amber">
              desks + design review <ArrowRight className="inline h-3 w-3" />
            </p>
          </Link>
        </motion.div>
      </div>

      {/* the remaining graded surfaces — each one is otherwise only in the nav */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.56 }}
        className="mt-4 grid gap-4 sm:grid-cols-3"
      >
        {[
          {
            to: '/desks',
            label: 'the desks',
            title: `${DESKS.length} numeric desks`,
            body: 'One decision each, submitted as numbers and graded against a reference model in tolerance bands.',
          },
          {
            to: '/drills',
            label: 'column week',
            title: `${DRILLS.length} incidents`,
            body: 'Modelled telemetry, read from counts alone: call the root cause and the mitigation before the debrief.',
          },
          {
            to: '/capstone',
            label: 'the capstone',
            title: 'One recommendation',
            body: 'Your own measurements recomputed into a platform decision, then taken into every room.',
          },
        ].map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className="group block rounded-lg border border-line bg-surface-1 p-5 transition-colors hover:border-accent/50"
          >
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-3">{c.label}</p>
            <p className="mt-2 font-medium text-text-1">{c.title}</p>
            <p className="mt-1.5 text-body-sm text-text-2">{c.body}</p>
            <p className="mt-3 font-mono text-[11px] text-accent">
              open <ArrowRight className="inline h-3 w-3" />
            </p>
          </Link>
        ))}
      </motion.div>
    </div>
  )
}
