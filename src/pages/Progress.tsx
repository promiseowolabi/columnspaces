/**
 * PROGRESS — /progress (progress.md).
 * "htop for your brain": rank panel, KPI tweens, per-track memory-map bars,
 * GitHub-style heatmap, a derived achievement set, and export/import/reset with
 * double-confirm. Consumes src/lib/progress.ts as-is.
 *
 * Counts and conditions on this page derive from the registries. The achievement
 * catalog previously described a row-store course — it awarded "page whisperer"
 * for finishing T0 and "recall is a curve" for an `hnsw` lab, neither of which
 * exists here, so ten of fifteen badges were permanently unreachable.
 *
 * NOTE on the denominator: lib/progress exports TOTAL_LESSONS = 37, which the
 * curriculum outgrew. This page uses TOTAL_LESSON_COUNT from the lesson manifest
 * instead. Fixing the constant at its source is a change to lib/progress.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AnimatePresence, animate, motion, useInView, useReducedMotion } from 'framer-motion'
import {
  Braces,
  Check,
  Cog,
  Cpu,
  Download,
  Flame,
  Gauge,
  Lock,
  Play,
  Power,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  useProgress,
  rankForXp,
  nextRank,
  selectStreak,
  selectRoomsSurvived,
  exportProgress,
} from '@/lib/progress'
import type { ProgressState } from '@/lib/progress'
import { TRACKS, CAPSTONE, SIMS } from '@/lib/tracks'
import { ORDERED_LESSON_IDS, TOTAL_LESSON_COUNT, lessonMeta } from '@/data/lessons/manifest'
import { FORGE_LABS } from '@/data/labs'
import { BROWSER_LABS } from '@/data/browser-labs'
import { DUCK_LABS } from '@/data/duck-labs'
import { DRILLS } from '@/data/drills'
import { DESKS } from '@/lib/desks'
import { ROOMS } from '@/data/rooms'
import { standing } from '@/lib/rooms/encounter'
import ProgressRing from '@/components/ProgressRing'
import { cn } from '@/lib/utils'

/* ---------------- shared bits ---------------- */

function useCountUp(target: number, start: boolean, duration = 0.8): number {
  const reduced = useReducedMotion()
  const [v, setV] = useState(0)
  useEffect(() => {
    if (!start || reduced) return
    const controls = animate(0, target, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (x) => setV(x),
    })
    return () => controls.stop()
  }, [target, start, duration, reduced])
  return reduced && start ? target : v
}

const RANK_FLAVOR: Record<string, string> = {
  'SEQ SCAN': 'reads everything, every time',
  'INDEX SCAN': 'knows where things live',
  PLANNER: 'costs every path before walking one',
  OPTIMIZER: 'rewrites your query for you',
  SUPERUSER: 'bypasses all permission checks',
}

/* ---------------- achievements catalog (progress.md §5) ---------------- */

interface AchievementDef {
  id: string
  name: string
  cond: string
  icon: LucideIcon
  color?: string
  derived: (s: ProgressState) => boolean
}

const trackDone = (s: ProgressState, tid: string, n: number) =>
  Object.entries(s.lessons).filter(
    ([id, l]) => id.startsWith(`${tid}.`) && l.status === 'done',
  ).length >= n

const labDone = (s: ProgressState, id: string) => s.labs[id]?.done ?? false

/** Browser and duck labs record completion as a sim task, not a lab. */
const simTaskDone = (s: ProgressState, simId: string) =>
  s.sims[simId]?.tasksDone.includes('complete') ?? false

/* No all-browser-labs achievement: BROWSER_LABS declares seven and not all are
   built, so the badge would be permanently unreachable — which is the exact
   defect this catalog was rewritten to remove. GradedSurfaces reports the
   partial count instead. */
const duckLabsDone = (s: ProgressState) =>
  DUCK_LABS.filter((l) => simTaskDone(s, `dlab:${l.id}`)).length

const drillsDone = (s: ProgressState) => s.fleetWeek.actsDone.includes('drills')

const lessonsDone = (s: ProgressState) =>
  ORDERED_LESSON_IDS.filter((id) => s.lessons[id]?.status === 'done').length

const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: 'first-boot',
    name: 'first boot',
    cond: 'complete any lesson',
    icon: Power,
    color: '#3EF2A4',
    derived: (s) => Object.values(s.lessons).some((l) => l.status === 'done'),
  },
  /* One per track, generated from the registry — a renamed or resized track can
     no longer leave an unreachable badge behind. */
  ...TRACKS.map<AchievementDef>((t) => ({
    id: `track-${t.id}`,
    name: `${t.code.toLowerCase()} complete`,
    cond: `complete ${t.code} — ${t.name}`,
    icon: t.glyph,
    color: t.color,
    derived: (s) => trackDone(s, t.id, t.lessons),
  })),
  {
    id: 'forge-first',
    name: 'first forge',
    cond: 'pass any forge lab',
    icon: Cog,
    color: '#FBBF24',
    derived: (s) => Object.values(s.labs).some((l) => l.done),
  },
  {
    id: 'forge-complete',
    name: 'the whole forge',
    cond: `pass all ${FORGE_LABS.length} forge labs`,
    icon: Wrench,
    color: '#A3E635',
    derived: (s) => FORGE_LABS.every((l) => labDone(s, l.id)),
  },
  {
    id: 'empiricist',
    name: 'empiricist',
    cond: `check every claim in all ${DUCK_LABS.length} DuckDB labs`,
    icon: Cpu,
    color: '#22D3EE',
    derived: (s) => duckLabsDone(s) >= DUCK_LABS.length,
  },
  {
    id: 'incident-commander',
    name: 'incident commander',
    cond: `diagnose all ${DRILLS.length} Column Week incidents`,
    icon: Gauge,
    color: '#FB7185',
    derived: drillsDone,
  },
  {
    id: 'dossier-complete',
    name: 'every figure submitted',
    cond: `submit every figure the ${DESKS.length} desks produce`,
    icon: Braces,
    color: '#5CA8FF',
    derived: (s) => {
      const st = standing(ROOMS, s.dossier)
      return st.total > 0 && st.filled >= st.total
    },
  },
  {
    id: 'room-survivor',
    name: 'survived the review',
    cond: `survive all ${ROOMS.length} Design Review rooms`,
    icon: ShieldCheck,
    color: '#FBBF24',
    derived: (s) => selectRoomsSurvived(s) >= ROOMS.length,
  },
  {
    id: 'week-uptime',
    name: 'week uptime',
    cond: '7-day streak',
    icon: Flame,
    color: '#FF5C6C',
    derived: (s) => selectStreak(s) >= 7,
  },
  {
    id: 'superuser',
    name: 'superuser',
    cond: 'every lesson done · every forge lab green · every room survived',
    icon: Sparkles,
    color: '#FFB224',
    derived: (s) =>
      lessonsDone(s) >= TOTAL_LESSON_COUNT &&
      FORGE_LABS.every((l) => labDone(s, l.id)) &&
      selectRoomsSurvived(s) >= ROOMS.length,
  },
]

/* ---------------- section 1: rank panel ---------------- */

function RankPanel() {
  const xp = useProgress((s) => s.xp)
  const lessons = useProgress((s) => s.lessons)
  const labs = useProgress((s) => s.labs)
  const rank = rankForXp(xp)
  const next = nextRank(xp)
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true })
  const shownXp = useCountUp(xp, inView)
  const done = ORDERED_LESSON_IDS.filter((id) => lessons[id]?.status === 'done').length
  const scored = Object.values(lessons).filter((l) => l.quizScore != null)
  const quizAvg = scored.length
    ? Math.round((scored.reduce((a, l) => a + (l.quizScore ?? 0), 0) / scored.length) * 100)
    : 0
  const labsDone = FORGE_LABS.filter((l) => labs[l.id]?.done).length
  const pctToNext = next ? Math.min(100, (xp / next.minXp) * 100) : 100

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-lg border border-line bg-surface-1 p-6"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-grad-brand" aria-hidden />
      <p className="font-mono text-[11px] uppercase tracking-[0.10em] text-text-3">rank</p>
      <p className="mt-2 font-display text-[40px] font-bold leading-none text-text-1">
        {rank.name}
      </p>
      <p className="mt-2 font-mono text-[11px] text-text-3">{RANK_FLAVOR[rank.name]}</p>
      <div className="mt-5">
        <div className="flex justify-between font-mono text-[11px] text-text-3">
          <span>
            {Math.round(shownXp)}
            {next ? `/${next.minXp}` : ''} XP
          </span>
          <span>{next ? `next: ${next.name}` : 'max rank'}</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-3">
          <motion.div
            className="h-full rounded-full bg-grad-brand"
            initial={{ width: 0 }}
            animate={{ width: `${pctToNext}%` }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>
      </div>
      <p className="mt-4 border-t border-line pt-3 font-mono text-[11px] text-text-3">
        lessons {done}/{TOTAL_LESSON_COUNT} · quizzes {quizAvg}% · labs {labsDone}/{FORGE_LABS.length}
      </p>
    </motion.div>
  )
}

/* ---------------- section 2: KPI band ---------------- */

function KpiBand() {
  const lessons = useProgress((s) => s.lessons)
  const streakDays = useProgress((s) => s.streakDays)
  const streak = useProgress(selectStreak)
  const sims = useProgress((s) => s.sims)
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-10% 0px' })

  /* Registry-scoped: a snapshot imported from a sibling course carries lesson
     ids this curriculum does not have, and counting those overruns 100%. */
  const done = ORDERED_LESSON_IDS.filter((id) => lessons[id]?.status === 'done').length
  const pct = Math.round((done / TOTAL_LESSON_COUNT) * 100)
  const scored = Object.values(lessons).filter((l) => l.quizScore != null)
  const passed = scored.filter((l) => (l.quizScore ?? 0) >= 0.8).length
  const quizAvg = scored.length
    ? Math.round((scored.reduce((a, l) => a + (l.quizScore ?? 0), 0) / scored.length) * 100)
    : 0
  const runs = Object.values(sims).reduce((a, s) => a + s.visits, 0)
  const topSim = useMemo(() => {
    let best: string | null = null
    let bestN = 0
    for (const [id, s] of Object.entries(sims)) {
      if (s.visits > bestN) {
        bestN = s.visits
        best = id
      }
    }
    return best ? (SIMS.find((x) => x.id === best)?.name ?? best) : null
  }, [sims])

  const shownPct = useCountUp(pct, inView)
  const shownStreak = useCountUp(streak, inView)
  const shownQuiz = useCountUp(quizAvg, inView)
  const shownRuns = useCountUp(runs, inView)

  const last14 = useMemo(() => {
    const set = new Set(streakDays)
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date()
      d.setDate(d.getDate() - (13 - i))
      return set.has(d.toISOString().slice(0, 10))
    })
  }, [streakDays])

  return (
    <div ref={ref} className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
      {[
        <div key="k0" className="flex items-center gap-4">
          <ProgressRing value={pct} size={64} />
          <div>
            <p className="font-display text-stat text-text-1">{Math.round(shownPct)}%</p>
            <p className="font-mono text-[11px] text-text-3">
              {done}/{TOTAL_LESSON_COUNT} lessons
            </p>
          </div>
        </div>,
        <div key="k1">
          <p className="font-display text-stat text-text-1">{Math.round(shownStreak)}d</p>
          <p className="font-mono text-[11px] text-text-3">uptime</p>
          <div
            className="mt-2 flex gap-1"
            role="img"
            aria-label={`${last14.filter(Boolean).length} of the last 14 days active`}
          >
            {last14.map((on, i) => (
              <span
                key={i}
                className={cn('h-1.5 w-1.5 rounded-full', on ? 'bg-accent' : 'bg-surface-3')}
              />
            ))}
          </div>
        </div>,
        <div key="k2">
          <p className="font-display text-stat text-text-1">{Math.round(shownQuiz)}%</p>
          <p className="font-mono text-[11px] text-text-3">best quiz average</p>
          <p className="mt-1 font-mono text-[11px] text-text-3">{passed} checkpoints passed</p>
        </div>,
        <div key="k3">
          <p className="font-display text-stat text-text-1">{Math.round(shownRuns)}</p>
          <p className="font-mono text-[11px] text-text-3">simulator runs</p>
          {topSim && (
            <p className="mt-1 inline-block rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-text-2">
              {topSim}
            </p>
          )}
        </div>,
      ].map((content, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 24 }}
          animate={inView ? { opacity: 1, y: 0 } : undefined}
          transition={{ duration: 0.5, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
          className="rounded-md border border-line bg-surface-1 p-5"
        >
          {content}
        </motion.div>
      ))}
    </div>
  )
}

/* ---------------- section 3: track breakdown + address map ---------------- */

function TrackBreakdown() {
  const lessons = useProgress((s) => s.lessons)
  /* Capstone standing = Column Week diagnosed + every room survived. It used to
     read `labs['hnsw']`, a lab id this course has never had, so the row was
     pinned at 0/2 for everyone and linked to a 404. */
  const drillsAct = useProgress((s) => s.fleetWeek.actsDone.includes('drills'))
  const roomsSurvived = useProgress(selectRoomsSurvived)
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-10% 0px' })

  const capstoneParts = [drillsAct, roomsSurvived >= ROOMS.length]
  const capstoneDone = capstoneParts.filter(Boolean).length
  const capstonePct = Math.round((capstoneDone / capstoneParts.length) * 100)

  const nextId = ORDERED_LESSON_IDS.find((id) => lessons[id]?.status !== 'done') ?? null

  const rows = TRACKS.map((t) => {
    const doneN = Object.entries(lessons).filter(
      ([id, l]) => id.startsWith(`${t.id}.`) && l.status === 'done',
    ).length
    return { track: t, doneN, pct: Math.round((doneN / t.lessons) * 100) }
  })

  return (
    <div ref={ref} className="mt-14">
      <h2 className="font-display text-h3 text-text-1">memory map</h2>
      <div className="mt-5 grid gap-6 xl:grid-cols-[2fr_1fr]">
        <div className="space-y-2.5">
          {rows.map(({ track, doneN, pct }, i) => {
            const Icon = track.glyph
            return (
              <motion.div
                key={track.id}
                initial={{ opacity: 0, y: 12 }}
                animate={inView ? { opacity: 1, y: 0 } : undefined}
                transition={{ duration: 0.4, delay: i * 0.1 }}
              >
                <Link
                  to={`/tracks/${track.id}`}
                  className="group flex items-center gap-4 rounded-md border border-line bg-surface-1 px-4 py-3 transition-colors duration-180 hover:border-line-bright hover:bg-surface-2"
                >
                  <ProgressRing value={pct} size={40} color={track.color} strokeWidth={3} />
                  <span
                    className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 font-mono text-[11px]"
                    style={{ color: track.color }}
                  >
                    <Icon size={11} strokeWidth={1.75} />
                    {track.code}
                  </span>
                  <span className="hidden w-44 truncate text-body-sm text-text-2 sm:inline">
                    {track.name}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ backgroundColor: track.color }}
                      initial={{ width: 0 }}
                      animate={inView ? { width: `${pct}%` } : undefined}
                      transition={{ duration: 0.8, delay: 0.2 + i * 0.1, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right font-mono text-[11px] text-text-3">
                    {doneN}/{track.lessons} · {pct}%
                  </span>
                </Link>
              </motion.div>
            )
          })}
          {/* capstone row: Column Week + the Design Review, weighted equally */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={inView ? { opacity: 1, y: 0 } : undefined}
            transition={{ duration: 0.4, delay: 0.6 }}
          >
            <Link
              to="/capstone"
              className="group flex items-center gap-4 rounded-md border border-line bg-surface-1 px-4 py-3 transition-colors duration-180 hover:border-line-bright hover:bg-surface-2"
            >
              <ProgressRing value={capstonePct} size={40} strokeWidth={3} />
              <span className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-grad-brand">
                {CAPSTONE.code}
              </span>
              <span className="hidden w-44 truncate text-body-sm text-text-2 sm:inline">
                Capstone
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
                <motion.div
                  className="h-full rounded-full bg-grad-brand"
                  initial={{ width: 0 }}
                  animate={inView ? { width: `${capstonePct}%` } : undefined}
                  transition={{ duration: 0.8, delay: 0.8, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
              <span className="w-20 shrink-0 text-right font-mono text-[11px] text-text-3">
                {capstoneDone}/{capstoneParts.length} · {capstonePct}%
              </span>
            </Link>
          </motion.div>
        </div>

        {/* address map (xl only) */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={inView ? { opacity: 1 } : undefined}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="hidden rounded-md border border-line bg-surface-1 p-4 xl:block"
        >
          <div className="flex h-full gap-3">
            <div className="flex h-[240px] flex-1 flex-col gap-[2px]">
              {ORDERED_LESSON_IDS.map((id, i) => {
                const trackId = id.split('.')[0]
                const track = TRACKS.find((t) => t.id === trackId)
                const done = lessons[id]?.status === 'done'
                const isNext = id === nextId
                return (
                  <motion.div
                    key={id}
                    initial={{ opacity: 0 }}
                    animate={inView ? { opacity: 1 } : undefined}
                    transition={{ delay: 0.4 + i * 0.03 }}
                    className="flex-1"
                  >
                    <Link
                      to={`/lesson/${id}`}
                      title={id}
                      aria-label={`Lesson ${id}${done ? ' (done)' : ''}`}
                      className={cn(
                        'block h-full w-full rounded-[1px] border transition-transform duration-120 hover:scale-y-125',
                        isNext && 'animate-breathe',
                      )}
                      style={{
                        backgroundColor: done ? track?.color : 'transparent',
                        borderColor: isNext ? '#3EF2A4' : done ? track?.color : '#2C3A4F',
                      }}
                    />
                  </motion.div>
                )
              })}
            </div>
            <div className="flex h-[240px] flex-col justify-between font-mono text-[10px] text-text-3">
              <span>0x00</span>
              <span>0x12</span>
              <span>0x24</span>
            </div>
          </div>
          <p className="mt-3 font-mono text-[10px] text-text-3">
            {ORDERED_LESSON_IDS.length} lesson blocks · solid = allocated · glow = next instruction
          </p>
        </motion.div>
      </div>
    </div>
  )
}

/* ---------------- section 3b: everything that is not a lesson ---------------- */

/**
 * The graded surfaces the page used to ignore. Before this existed, Progress
 * reported lessons and forge labs and nothing else — a reader could finish every
 * DuckDB lab, every desk and every room and see no acknowledgement of it.
 *
 * Denominators come from the registries. Browser labs are the one honest
 * exception: BROWSER_LABS declares the full set but not all of them are built
 * yet, so the row says so instead of implying the missing ones are just undone.
 */
function GradedSurfaces() {
  const labs = useProgress((s) => s.labs)
  const sims = useProgress((s) => s.sims)
  const dossier = useProgress((s) => s.dossier)
  const roomRuns = useProgress((s) => s.rooms)
  const drillsAct = useProgress((s) => s.fleetWeek.actsDone.includes('drills'))
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-10% 0px' })

  const taskDone = (simId: string) => sims[simId]?.tasksDone.includes('complete') ?? false
  const dossierStanding = useMemo(() => standing(ROOMS, dossier), [dossier])
  const survived = Object.values(roomRuns).filter(
    (r) => r.bestVerdict !== undefined && r.bestVerdict !== 'lost',
  ).length

  const rows = [
    {
      to: '/labs',
      label: 'forge labs',
      done: FORGE_LABS.filter((l) => labs[l.id]?.done).length,
      total: FORGE_LABS.length,
      note: 'Rust, graded by the same checks in your terminal and in the tab.',
    },
    {
      to: '/curriculum',
      label: 'browser labs',
      done: BROWSER_LABS.filter((l) => taskDone(`blab:${l.id}`)).length,
      total: BROWSER_LABS.length,
      note: 'In-lesson micro-labs. Some are still being built — those cannot be completed yet.',
    },
    {
      to: '/curriculum',
      label: 'duckdb labs',
      done: DUCK_LABS.filter((l) => taskDone(`dlab:${l.id}`)).length,
      total: DUCK_LABS.length,
      note: 'A real columnar engine in the tab, run against real files, so a claim can come out false.',
    },
    {
      to: '/drills',
      label: 'column week',
      done: drillsAct ? DRILLS.length : 0,
      total: DRILLS.length,
      note: 'Modelled telemetry, not captured — diagnosable from counts alone.',
    },
    {
      to: '/desks',
      label: 'dossier figures',
      done: dossierStanding.filled,
      total: dossierStanding.total,
      note: `The numbers the ${DESKS.length} desks produce, graded against reference models in tolerance bands.`,
    },
    {
      to: '/rooms',
      label: 'rooms survived',
      done: survived,
      total: ROOMS.length,
      note: 'Each objection is a predicate over the dossier above, so the same numbers always face the same room.',
    },
  ]

  return (
    <div ref={ref} className="mt-14">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-h3 text-text-1">graded surfaces</h2>
        <p className="font-mono text-[11px] text-text-3">
          everything that is not a lesson · counts, never clocks
        </p>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r, i) => {
          const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0
          return (
            <motion.div
              key={r.label}
              initial={{ opacity: 0, y: 12 }}
              animate={inView ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: 0.4, delay: i * 0.06 }}
            >
              <Link
                to={r.to}
                className="flex h-full flex-col rounded-md border border-line bg-surface-1 px-4 py-3.5 transition-colors duration-180 hover:border-line-bright hover:bg-surface-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-[0.10em] text-text-3">
                    {r.label}
                  </span>
                  <span className="font-mono text-[11px] text-text-2">
                    {r.done}/{r.total}
                    <span className="text-text-3"> · {pct}%</span>
                  </span>
                </div>
                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <motion.div
                    className="h-full rounded-full bg-accent"
                    initial={{ width: 0 }}
                    animate={inView ? { width: `${pct}%` } : undefined}
                    transition={{ duration: 0.7, delay: 0.15 + i * 0.06, ease: [0.16, 1, 0.3, 1] }}
                  />
                </div>
                <p className="mt-2.5 text-body-sm text-text-3">{r.note}</p>
              </Link>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------- section 4: activity heatmap ---------------- */

function Heatmap() {
  const streakDays = useProgress((s) => s.streakDays)
  // NOTE: object-returning selectors (selectActivityMap) break zustand's
  // useSyncExternalStore snapshot stability → infinite re-render loop.
  // Subscribe to raw state and memoize the derived map instead.
  const lessons = useProgress((s) => s.lessons)
  const activity = useMemo(() => {
    const map: Record<string, number> = {}
    for (const l of Object.values(lessons)) {
      if (l.completedAt) {
        const day = l.completedAt.slice(0, 10)
        map[day] = (map[day] ?? 0) + 1
      }
    }
    return map
  }, [lessons])
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-10% 0px' })
  const reduced = useReducedMotion()

  const { weeks, longest, totalActive } = useMemo(() => {
    const days = new Set(streakDays)
    const counts = new Map<string, number>()
    for (const d of streakDays) counts.set(d, (counts.get(d) ?? 0) + 1)
    for (const [d, n] of Object.entries(activity)) counts.set(d, (counts.get(d) ?? 0) + n)

    // 20 weeks ending with the current week, columns = weeks (Sun..Sat rows)
    const today = new Date()
    const end = new Date(today)
    end.setDate(end.getDate() - end.getDay()) // start of this week (Sunday)
    const start = new Date(end)
    start.setDate(start.getDate() - 19 * 7)

    const weeks: { date: string; n: number; future: boolean }[][] = []
    for (let w = 0; w < 20; w++) {
      const col: { date: string; n: number; future: boolean }[] = []
      for (let d = 0; d < 7; d++) {
        const cur = new Date(start)
        cur.setDate(start.getDate() + w * 7 + d)
        const iso = cur.toISOString().slice(0, 10)
        col.push({
          date: iso,
          n: days.has(iso) ? (counts.get(iso) ?? 1) : (counts.get(iso) ?? 0),
          future: cur > today,
        })
      }
      weeks.push(col)
    }

    // longest streak
    const sorted = [...days].sort()
    let longest = 0
    let run = 0
    let prev = ''
    for (const d of sorted) {
      if (prev) {
        const diff = (new Date(d).getTime() - new Date(prev).getTime()) / 86400000
        run = diff === 1 ? run + 1 : 1
      } else {
        run = 1
      }
      longest = Math.max(longest, run)
      prev = d
    }
    return { weeks, longest, totalActive: days.size }
  }, [streakDays, activity])

  const intensity = (n: number): string => {
    if (n <= 0) return 'bg-surface-3'
    if (n === 1) return 'bg-accent/25'
    if (n === 2) return 'bg-accent/50'
    if (n === 3) return 'bg-accent/75'
    return 'bg-accent'
  }

  const empty = totalActive === 0

  return (
    <div ref={ref} className="mt-14">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-h3 text-text-1">Activity</h2>
        <p className="font-mono text-[11px] text-text-3">
          longest streak {longest}d · total active days {totalActive}
        </p>
      </div>
      <div className="relative mt-5 overflow-x-auto rounded-md border border-line bg-surface-1 p-4 scrollbar-slim">
        <div className="flex min-w-[640px] gap-[3px]" role="img" aria-label={`Activity heatmap — ${totalActive} active days in the last 20 weeks`}>
          {weeks.map((col, w) => (
            <div key={w} className="flex flex-col gap-[3px]">
              {col.map((cell, d) => (
                <motion.div
                  key={cell.date}
                  initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                  animate={inView ? { opacity: 1, scale: 1 } : undefined}
                  transition={{ delay: reduced ? 0 : (w * 7 + d) * 0.012, duration: 0.2 }}
                  whileHover={{ scale: 1.15 }}
                  title={`${cell.date} — ${cell.n} ${cell.n === 1 ? 'activity' : 'activities'}`}
                  className={cn(
                    'h-3 w-3 rounded-[2px]',
                    cell.future ? 'bg-surface-2' : intensity(cell.n),
                    empty && !cell.future && 'bg-surface-3/60',
                  )}
                />
              ))}
            </div>
          ))}
        </div>
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-ink/60">
            <p className="font-mono text-body-sm text-text-2">
              no activity yet — day 0 starts with {ORDERED_LESSON_IDS[0].toUpperCase()}
            </p>
            <Link
              to={`/lesson/${ORDERED_LESSON_IDS[0]}`}
              className="pointer-events-auto mt-3 rounded-md bg-accent px-4 py-2 font-display text-[14px] font-semibold text-accent-foreground transition-transform active:scale-[.97]"
            >
              begin →
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- section 5: achievements ---------------- */

function Achievements() {
  const state = useProgress()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-10% 0px' })
  const unlocked = new Set(state.achievements)

  return (
    <div ref={ref} className="mt-14">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-h3 text-text-1">privilege escalations</h2>
        <p className="font-mono text-[11px] text-text-3">
          {ACHIEVEMENTS.filter((a) => unlocked.has(a.id) || a.derived(state)).length}/
          {ACHIEVEMENTS.length} unlocked
        </p>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {ACHIEVEMENTS.map((a, i) => {
          const earned = unlocked.has(a.id) || a.derived(state)
          const Icon = earned ? a.icon : Lock
          return (
            <motion.div
              key={a.id}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={inView ? { opacity: 1, scale: 1 } : undefined}
              transition={{ duration: 0.4, delay: i * 0.06, ease: [0.3, 1.4, 0.4, 1] }}
              title={earned ? a.name : `locked — ${a.cond}`}
              className={cn(
                'flex h-[180px] flex-col items-center justify-center rounded-lg border p-4 text-center',
                earned ? 'border-line bg-surface-1' : 'border-line/60 bg-surface-1/50',
              )}
            >
              <div
                className={cn(
                  'flex h-16 w-16 items-center justify-center rounded-full border-2',
                  !earned && 'opacity-35 grayscale',
                )}
                style={{
                  borderColor: earned ? (a.color ?? '#3EF2A4') : '#2C3A4F',
                  backgroundColor: earned ? `${a.color ?? '#3EF2A4'}14` : 'transparent',
                }}
              >
                <Icon
                  size={26}
                  strokeWidth={1.75}
                  style={{ color: earned ? (a.color ?? '#3EF2A4') : '#5D6B80' }}
                />
              </div>
              <p
                className={cn(
                  'mt-3 font-display text-[15px] font-medium',
                  earned ? 'text-text-1' : 'text-text-3',
                )}
              >
                {a.name}
              </p>
              <p className="mt-1 font-mono text-[11px] leading-tight text-text-3">
                {earned ? 'unlocked' : `locked — ${a.cond}`}
              </p>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------- section 6: data ownership ---------------- */

function Modal({
  open,
  onClose,
  children,
  label,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  label: string
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/70 p-6 backdrop-blur-sm"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label={label}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-md rounded-lg border border-line-bright bg-surface-1 p-6 shadow-[0_24px_80px_rgba(0,0,0,.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function DataOwnership() {
  const resetProgress = useProgress((s) => s.resetProgress)
  const importProgressStore = useProgress((s) => s.importProgress)
  const [toast, setToast] = useState<string | null>(null)
  const [importData, setImportData] = useState<{
    json: string
    lessons: number
    xp: number
    days: number
  } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [resetStep, setResetStep] = useState<0 | 1 | 2>(0)
  const [resetText, setResetText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const readKB = () => {
    try {
      const raw = localStorage.getItem('columnspaces:v1')
      return raw ? (raw.length / 1024).toFixed(1) : '0.0'
    } catch {
      return '0.0'
    }
  }
  const [storeKB, setStoreKB] = useState(readKB)

  const flashToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3500)
  }

  const doExport = () => {
    const json = exportProgress()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const date = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `columnspaces-progress-${date}.json`
    a.click()
    URL.revokeObjectURL(url)
    flashToast(`exported · ${(blob.size / 1024).toFixed(1)} KB`)
  }

  const onFile = async (file: File) => {
    setImportError(null)
    try {
      const json = await file.text()
      const data = JSON.parse(json)
      if (
        data?.version !== 1 ||
        typeof data.lessons !== 'object' ||
        data.lessons === null ||
        typeof data.xp !== 'number'
      ) {
        setImportError('invalid snapshot — expected a columnspaces v1 export')
        return
      }
      const lessons = Object.values(data.lessons as Record<string, { status?: string }>).filter(
        (l) => l?.status === 'done',
      ).length
      setImportData({
        json,
        lessons,
        xp: data.xp,
        days: Array.isArray(data.streakDays) ? data.streakDays.length : 0,
      })
    } catch {
      setImportError('could not parse that file — is it JSON?')
    }
  }

  const confirmImport = () => {
    if (!importData) return
    const ok = importProgressStore(importData.json)
    setImportData(null)
    setStoreKB(readKB())
    flashToast(ok ? 'progress imported ✓' : 'import failed — schema mismatch')
  }

  const doReset = () => {
    resetProgress()
    setResetStep(0)
    setResetText('')
    setStoreKB(readKB())
    flashToast('progress wiped — day 0')
  }

  return (
    <div className="mt-14">
      <h2 className="font-display text-h3 text-text-1">data ownership</h2>
      <div className="mt-5 divide-y divide-line rounded-lg border border-line bg-surface-1">
        {[
          {
            icon: Download,
            title: 'Export progress',
            desc: 'JSON snapshot of everything.',
            action: (
              <button
                type="button"
                onClick={doExport}
                className="rounded-md border border-line bg-surface-2 px-4 py-2 font-mono text-xs text-text-1 transition-colors hover:border-line-bright"
              >
                download
              </button>
            ),
          },
          {
            icon: Upload,
            title: 'Import progress',
            desc: 'Restore a snapshot — validated before anything is written.',
            action: (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="rounded-md border border-dashed border-line-bright px-4 py-2 font-mono text-xs text-text-2 transition-colors hover:border-accent hover:text-accent"
              >
                choose file
              </button>
            ),
          },
          {
            icon: Trash2,
            title: 'Reset everything',
            desc: 'Wipe lessons, XP, streaks, achievements. Irreversible.',
            action: (
              <button
                type="button"
                onClick={() => setResetStep(1)}
                className="rounded-md border border-danger/60 px-4 py-2 font-mono text-xs text-danger transition-colors hover:bg-danger/10"
              >
                reset
              </button>
            ),
          },
        ].map((row) => (
          <div
            key={row.title}
            className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-surface-2"
          >
            <row.icon size={18} strokeWidth={1.75} className="shrink-0 text-text-3" />
            <div className="min-w-0 flex-1">
              <p className="text-body-sm font-medium text-text-1">{row.title}</p>
              <p className="text-body-sm text-text-3">{row.desc}</p>
            </div>
            {row.action}
          </div>
        ))}
      </div>
      <p className="mt-3 font-mono text-[11px] text-text-3">
        stored locally · ~{storeKB} KB · no account · no tracking
      </p>
      {importError && <p className="mt-2 font-mono text-[11px] text-danger">{importError}</p>}

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onFile(f)
          e.target.value = ''
        }}
      />

      {/* import diff modal */}
      <Modal open={importData != null} onClose={() => setImportData(null)} label="Import preview">
        {importData && (
          <>
            <p className="font-display text-h4 text-text-1">Apply this snapshot?</p>
            <p className="mt-3 font-mono text-[12px] leading-relaxed text-text-2">
              will set: {importData.lessons} lessons · {importData.xp.toLocaleString()} XP ·{' '}
              {importData.days} active days
            </p>
            <p className="mt-1 font-mono text-[11px] text-text-3">
              this replaces your current local progress
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setImportData(null)}
                className="rounded-md border border-line bg-surface-2 px-4 py-2 font-mono text-xs text-text-2 hover:border-line-bright"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={confirmImport}
                className="rounded-md bg-accent px-4 py-2 font-mono text-xs font-semibold text-accent-foreground transition-transform active:scale-[.97]"
              >
                apply import
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* reset double-confirm modal */}
      <Modal open={resetStep > 0} onClose={() => setResetStep(0)} label="Reset confirmation">
        {resetStep === 1 && (
          <>
            <p className="font-display text-h4 text-text-1">Reset everything?</p>
            <p className="mt-3 text-body-sm text-text-2">
              Every lesson, XP point, streak day, sim task and achievement will be wiped from
              this browser. There is no undo.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setResetStep(0)}
                className="rounded-md border border-line bg-surface-2 px-4 py-2 font-mono text-xs text-text-2 hover:border-line-bright"
              >
                keep my progress
              </button>
              <button
                type="button"
                onClick={() => setResetStep(2)}
                className="rounded-md border border-danger/60 px-4 py-2 font-mono text-xs text-danger hover:bg-danger/10"
              >
                continue →
              </button>
            </div>
          </>
        )}
        {resetStep === 2 && (
          <>
            <p className="font-display text-h4 text-danger">Type RESET to confirm</p>
            <input
              value={resetText}
              onChange={(e) => setResetText(e.target.value)}
              placeholder="RESET"
              autoFocus
              className="mt-4 w-full rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-text-1 placeholder:text-text-3 focus:border-danger focus:outline-none"
            />
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setResetStep(0)}
                className="rounded-md border border-line bg-surface-2 px-4 py-2 font-mono text-xs text-text-2 hover:border-line-bright"
              >
                cancel
              </button>
              <button
                type="button"
                disabled={resetText !== 'RESET'}
                onClick={doReset}
                className="rounded-md bg-danger px-4 py-2 font-mono text-xs font-semibold text-ink transition-all enabled:hover:brightness-110 disabled:opacity-40"
              >
                wipe it
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25 }}
            className="fixed bottom-16 right-6 z-[80] flex items-center gap-2 rounded-md border border-line bg-surface-2 px-4 py-2.5 font-mono text-xs text-text-1 shadow-lg lg:bottom-14"
          >
            <Check size={13} className="text-accent" />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ---------------- section 7: up next ---------------- */

function UpNext() {
  const lessons = useProgress((s) => s.lessons)
  const reduced = useReducedMotion()
  const nextId = ORDERED_LESSON_IDS.find((id) => lessons[id]?.status !== 'done') ?? null

  const reviewId = useMemo(() => {
    if (nextId) return null
    let worst: string | null = null
    let worstScore = Infinity
    for (const [id, l] of Object.entries(lessons)) {
      if (l.quizScore != null && l.quizScore < worstScore) {
        worstScore = l.quizScore
        worst = id
      }
    }
    return worst
  }, [nextId, lessons])

  const target = nextId ?? reviewId
  if (!target) return null
  const track = TRACKS.find((t) => t.id === target.split('.')[0])
  const targetMeta = lessonMeta(target)

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-lg border border-line bg-surface-1 p-5"
    >
      <div className="absolute inset-x-0 top-0 h-px overflow-hidden" aria-hidden>
        {!reduced && (
          <motion.div
            className="h-full w-1/3 bg-grad-brand"
            animate={{ x: ['-100%', '300%'] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
          />
        )}
        {reduced && <div className="h-full bg-grad-brand" />}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.10em] text-text-3">
            {nextId ? 'recommended next instruction' : 'review'}
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-2">
            <span
              className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px]"
              style={{ color: track?.color }}
            >
              {track?.code}
            </span>
            <span className="font-mono text-body-sm text-text-1">{target}</span>
            <span className="font-mono text-[11px] text-text-3">
              · {track?.name}
              {targetMeta ? ` · ~${targetMeta.minutes} min read` : ''}
            </span>
          </p>
        </div>
        <Link
          to={`/lesson/${target}`}
          className="flex items-center gap-2 rounded-md bg-accent px-5 py-3 font-display text-[15px] font-semibold text-accent-foreground transition-all duration-150 ease-snap hover:-translate-y-px active:scale-[.97]"
        >
          <Play size={14} /> execute →
        </Link>
      </div>
    </motion.div>
  )
}

/* ---------------- page assembly ---------------- */

export default function Progress() {
  const streakDays = useProgress((s) => s.streakDays)
  const lessons = useProgress((s) => s.lessons)
  const hasAny = streakDays.length > 0 || Object.keys(lessons).length > 0

  return (
    <div className="bg-grad-radial-glow">
      <section className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
        <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <p className="section-label">0x06 — process stats</p>
            <h1 className="mt-4 font-display text-display-lg text-text-1">Progress</h1>
            <p className="mt-4 max-w-[60ch] text-body text-text-2">
              Everything below lives in your browser's localStorage. Export it, move it, nuke
              it — it's yours.
            </p>
            {hasAny && (
              <div className="mt-6">
                <UpNext />
              </div>
            )}
          </motion.div>
          <RankPanel />
        </div>

        <KpiBand />
        <TrackBreakdown />
        <GradedSurfaces />
        <Heatmap />
        <Achievements />
        <DataOwnership />
        {!hasAny && (
          <div className="mt-14">
            <UpNext />
          </div>
        )}
        <div className="mt-16 font-mono text-[11px] text-text-3">
          <Link to="/curriculum" className="hover:text-accent">
            ← back to curriculum
          </Link>
        </div>
      </section>
    </div>
  )
}
