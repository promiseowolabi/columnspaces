import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { motion } from 'framer-motion'
import { Check, ChevronRight, Play } from 'lucide-react'
import { DRILLS, type DrillIncident, type DrillSeries } from '@/data/drills'
import { useProgress, XP } from '@/lib/progress'
import { cn } from '@/lib/utils'

/**
 * Column Week — the incident-reading exam for the architecture half. Scripted
 * cards, static telemetry, no wasm: read the curves, call cause + mitigation.
 *
 * Every count on this page derives from DRILLS. It previously said "four
 * incidents" in three places while the registry held five, which is the exact
 * failure mode this course spends a track warning about.
 *
 * The telemetry is MODELLED, not measured: each series is a scripted shape
 * chosen to make one diagnosis readable from counts alone. That is stated on
 * the page, because a drill that looks like production data and is not would be
 * teaching the wrong lesson about where numbers come from.
 */
export default function Drills() {
  const [idx, setIdx] = useState(0)
  const [cause, setCause] = useState<string | null>(null)
  const [mitigation, setMitigation] = useState<string | null>(null)
  const [called, setCalled] = useState(false)
  const [solved, setSolved] = useState<string[]>([])
  const completeAct = useProgress((s) => s.completeFleetWeekAct)

  const incident: DrillIncident = DRILLS[idx]
  const causeOk = incident.causes.find((c) => c.id === cause)?.correct ?? false
  const mitOk = incident.mitigations.find((m) => m.id === mitigation)?.correct ?? false
  const calledRight = called && causeOk && mitOk

  const open = (i: number) => {
    setIdx(i)
    setCause(null)
    setMitigation(null)
    setCalled(false)
  }

  const submit = () => {
    if (!cause || !mitigation) return
    setCalled(true)
    if (causeOk && mitOk) {
      const next = solved.includes(incident.id) ? solved : [...solved, incident.id]
      setSolved(next)
      if (next.length >= DRILLS.length) completeAct('drills', 1)
    }
  }

  const allSolved = solved.length >= DRILLS.length

  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-16 lg:px-12">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">
        the architecture half · column week
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text-1">Read the dying engine.</h1>
      <p className="mt-4 max-w-2xl text-body-lg text-text-2">
        {DRILLS.length} incidents, no simulator to hide behind. For each card: read the briefing and
        the curves, call the root cause and the mitigation. Diagnose all {DRILLS.length} — the
        debrief is the lesson.{' '}
        <span className="text-text-3">(+{XP.fleetWeekAct} XP on the full set)</span>
      </p>
      <p className="mt-3 max-w-2xl text-body-sm text-text-3">
        Every curve here is a modelled series, not a capture from a running cluster — shapes chosen
        so the diagnosis is readable from counts alone. Cost is a count throughout: bytes, files,
        row groups, requests. Nothing on this page is timed.
      </p>

      <div className="mt-8 flex flex-wrap gap-2 font-mono text-[12px]">
        {DRILLS.map((d, i) => (
          <button
            key={d.id}
            type="button"
            aria-pressed={idx === i}
            onClick={() => open(i)}
            className={cn(
              'rounded border px-3 py-1.5 transition-colors',
              idx === i ? 'border-accent/60 bg-accent/10 text-accent' : 'border-line text-text-3 hover:text-text-1',
            )}
          >
            {solved.includes(d.id) ? '✓ ' : ''}
            {d.title.split('—')[0].trim()}
            {solved.includes(d.id) && <span className="sr-only"> (diagnosed)</span>}
          </button>
        ))}
      </div>

      <section className="mt-6 rounded-lg border border-line bg-surface-1 p-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-3">{incident.title}</p>
        <p className="mt-3 max-w-3xl text-body-sm text-text-2">{incident.briefing}</p>

        <TelemetryGrid series={incident.telemetry} />

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-3" id="drill-cause-label">
              root cause
            </p>
            <div className="mt-2 space-y-1.5" role="group" aria-labelledby="drill-cause-label">
              {incident.causes.map((c) => (
                <Option key={c.id} active={cause === c.id} onClick={() => { setCause(c.id); setCalled(false) }} label={c.label} />
              ))}
            </div>
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-3" id="drill-mitigation-label">
              mitigation
            </p>
            <div className="mt-2 space-y-1.5" role="group" aria-labelledby="drill-mitigation-label">
              {incident.mitigations.map((m) => (
                <Option key={m.id} active={mitigation === m.id} onClick={() => { setMitigation(m.id); setCalled(false) }} label={m.label} />
              ))}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={!cause || !mitigation}
          className="mt-5 inline-flex items-center gap-2 rounded-md border border-accent/60 bg-accent/10 px-4 py-2 font-mono text-sm text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
        >
          <Play className="h-4 w-4" /> call it <ChevronRight className="h-3.5 w-3.5" />
        </button>

        {called && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            role="status"
            aria-live="polite"
            className={cn('mt-4 rounded-md border p-4', calledRight ? 'border-accent/50 bg-accent/10' : 'border-amber/50 bg-amber/5')}
          >
            {calledRight ? (
              <>
                <p className="font-mono text-sm text-accent">
                  <Check className="mr-1 inline h-4 w-4" /> CORRECT CALL — {solved.length}/
                  {DRILLS.length} diagnosed
                </p>
                <p className="mt-2 text-body-sm text-text-2">{incident.debrief}</p>
                {allSolved && (
                  <p className="mt-3 font-mono text-[12px] text-accent">
                    all {DRILLS.length} diagnosed — the engine fears you. Re-run the trace in{' '}
                    <Link to="/warehouse" className="underline">The Warehouse</Link>, or take the
                    numbers you produced at the{' '}
                    <Link to="/desks" className="underline">desks</Link> into{' '}
                    <Link to="/rooms" className="underline">Design Review</Link>.
                  </p>
                )}
              </>
            ) : (
              <p className="font-mono text-sm text-amber">
                WRONG CALL — cause {causeOk ? '✓ correct' : '✗ wrong'} · mitigation{' '}
                {mitOk ? '✓ correct' : '✗ wrong'}. Re-read the curves: what moves first, and what
                never moves at all?
              </p>
            )}
          </motion.div>
        )}
      </section>
    </div>
  )
}

function Option({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'block w-full rounded border px-3 py-2 text-left font-mono text-[12px] transition-colors',
        active ? 'border-accent/60 bg-accent/10 text-text-1' : 'border-line bg-ink text-text-2 hover:border-text-3',
      )}
    >
      {label}
    </button>
  )
}

function TelemetryGrid({ series }: { series: DrillSeries[] }) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {series.map((s) => (
        <div key={s.label} className="rounded-md border border-line bg-ink p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-3">{s.label}</p>
          <Sparkline values={s.values} color={s.color} />
          {/* The numbers, not just the shape: the sparkline is decorative and the
              diagnosis has to be possible without seeing colour or curve. */}
          <p className="mt-1 font-mono text-[10px] text-text-3">
            start: {s.values[0]} · final: {s.values[s.values.length - 1]} · min{' '}
            {Math.min(...s.values)} · max {Math.max(...s.values)}
          </p>
        </div>
      ))}
    </div>
  )
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const d = useMemo(() => {
    if (values.length < 2) return ''
    const max = Math.max(...values, 1e-9)
    const min = Math.min(...values)
    return values
      .map((v, i) => `${(i / (values.length - 1)) * 100},${34 - ((v - min) / Math.max(1e-9, max - min)) * 30}`)
      .join(' ')
  }, [values])
  if (!d) return <div className="h-9" />
  return (
    <svg viewBox="0 0 100 36" className="mt-1 h-9 w-full" preserveAspectRatio="none" aria-hidden focusable="false">
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  )
}
