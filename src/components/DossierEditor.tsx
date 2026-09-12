/**
 * DossierEditor — the numbers you produced, not a form.
 *
 * Grouped by the desk that produced each figure, because that is the fiction
 * that makes the rooms work: you are not filling in a questionnaire, you are
 * assembling the artifacts you already built and handing them to five people
 * who will read them adversarially.
 *
 * The design decision that shapes every control here: OMISSION IS MEANINGFUL.
 * Every field is optional and a blank is a submission — most of the critical
 * objections in the course fire on absence, not on a wrong value. So booleans
 * are tri-state (blank is a distinct, visible position, never a default `false`),
 * every blank field shows what an adversary does with the gap, and each field
 * carries a live count of objections currently hanging off it. Nothing is
 * validated: a plan can be wrong here, and being wrong is the point.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, Eraser } from 'lucide-react'
import { ROOMS } from '@/data/rooms'
import type { Dossier } from '@/data/rooms'
import { DOSSIER_GROUPS } from '@/lib/rooms/dossier-fields'
import type { DossierField } from '@/lib/rooms/dossier-fields'
import { objectionsTurningOn, standing } from '@/lib/rooms/encounter'
import { useProgress } from '@/lib/progress'
import { cn } from '@/lib/utils'

const INPUT =
  'w-full rounded-md border border-line bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text-1 placeholder:text-text-3/70 focus:border-accent focus:outline-none'

function Heat({ n }: { n: number }) {
  if (n === 0) return null
  return (
    <span
      className="shrink-0 rounded-full border border-amber-400/40 px-2 py-0.5 font-mono text-[10px] text-amber-400"
      title="objections that stop firing if you change this field"
    >
      {n} objection{n === 1 ? '' : 's'}
    </span>
  )
}

function TriState({
  value,
  onChange,
}: {
  value: boolean | undefined
  onChange: (v: boolean | undefined) => void
}) {
  const opts: { v: boolean | undefined; label: string }[] = [
    { v: undefined, label: 'blank' },
    { v: true, label: 'yes' },
    { v: false, label: 'no' },
  ]
  return (
    <div className="flex gap-1.5">
      {opts.map((o) => (
        <button
          key={o.label}
          type="button"
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            'rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors',
            value === o.v
              ? o.v === undefined
                ? 'border-amber-400/50 text-amber-400'
                : 'border-accent/60 text-accent'
              : 'border-line text-text-3 hover:border-text-3',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function FieldRow({
  field,
  dossier,
  draft,
  setDraft,
}: {
  field: DossierField
  dossier: Dossier
  draft: string | undefined
  setDraft: (s: string | undefined) => void
}) {
  const setDossierField = useProgress((s) => s.setDossierField)
  const raw = dossier[field.key]
  const blank = raw === undefined
  const heat = useMemo(() => objectionsTurningOn(ROOMS, dossier, field.key), [dossier, field.key])

  const commitNumber = (text: string) => {
    setDraft(text)
    if (text.trim() === '') {
      setDossierField(field.key, undefined)
      return
    }
    const n = Number(text)
    if (Number.isFinite(n)) {
      setDossierField(field.key, ((field.factor ?? 1) * n) as never)
    }
  }

  const numberDisplay =
    draft ?? (typeof raw === 'number' ? String(raw / (field.factor ?? 1)) : '')

  return (
    <div className="border-t border-line/60 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={`dossier-${field.key}`} className="text-body-sm text-text-1">
          {field.label}
          {field.unit && <span className="ml-1.5 font-mono text-[11px] text-text-3">{field.unit}</span>}
        </label>
        <div className="flex items-center gap-2">
          <Heat n={heat} />
          <span className="font-mono text-[10px] text-text-3">{field.key}</span>
        </div>
      </div>

      <div className="mt-2 max-w-md">
        {field.kind === 'boolean' && (
          <TriState
            value={typeof raw === 'boolean' ? raw : undefined}
            onChange={(v) => setDossierField(field.key, v as never)}
          />
        )}

        {field.kind === 'number' && (
          <input
            id={`dossier-${field.key}`}
            type="text"
            inputMode="decimal"
            value={numberDisplay}
            placeholder="not stated"
            onChange={(e) => commitNumber(e.target.value)}
            className={cn(INPUT, blank && 'border-amber-400/30')}
          />
        )}

        {field.kind === 'text' && (
          <input
            id={`dossier-${field.key}`}
            type="text"
            value={typeof raw === 'string' ? raw : ''}
            placeholder="not stated"
            onChange={(e) => setDossierField(field.key, e.target.value as never)}
            className={cn(INPUT, blank && 'border-amber-400/30')}
          />
        )}

        {field.kind === 'list' && (
          <input
            id={`dossier-${field.key}`}
            type="text"
            value={Array.isArray(raw) ? raw.join(', ') : ''}
            placeholder="comma separated — not stated"
            onChange={(e) => {
              const parts = e.target.value
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean)
              setDossierField(field.key, (parts.length ? parts : undefined) as never)
            }}
            className={cn(INPUT, blank && 'border-amber-400/30')}
          />
        )}

        {field.kind === 'enum' && (
          <select
            id={`dossier-${field.key}`}
            value={typeof raw === 'string' ? raw : ''}
            onChange={(e) => setDossierField(field.key, (e.target.value || undefined) as never)}
            className={cn(INPUT, blank && 'border-amber-400/30')}
          >
            <option value="">— not stated —</option>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        )}
      </div>

      {blank && (
        <p className="mt-2 flex items-start gap-1.5 text-body-sm text-text-3">
          <AlertTriangle size={12} className="mt-1 shrink-0 text-amber-400" strokeWidth={1.75} />
          <span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-amber-400">blank — </span>
            {field.silence}
          </span>
        </p>
      )}
    </div>
  )
}

export function DossierEditor() {
  const dossier = useProgress((s) => s.dossier)
  const clearDossier = useProgress((s) => s.clearDossier)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const s = useMemo(() => standing(ROOMS, dossier), [dossier])

  return (
    <div>
      <div className="rounded-lg border border-line bg-surface-1 px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="font-mono text-label uppercase tracking-wide text-text-3">your dossier, right now</p>
          <button
            type="button"
            onClick={() => {
              clearDossier()
              setDrafts({})
            }}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3 hover:text-text-1"
          >
            <Eraser size={12} />
            clear
          </button>
        </div>
        <p className="mt-2 max-w-prose text-body-sm text-text-2">
          {s.filled} of {s.total} figures submitted. Across the five rooms that currently fires{' '}
          <span className="text-text-1">{s.firing} objections</span>, of which{' '}
          <span className={cn(s.critical > 0 ? 'text-rose-400' : 'text-accent')}>{s.critical} are critical</span>.
          Every field is optional and none of them is validated — a blank is a submission, and most of the
          objections that lose a room fire on absence rather than on a wrong number.
        </p>
        <p className="mt-2 max-w-prose text-body-sm text-text-3">
          Numbers persist immediately and survive a reload; they ride the same export snapshot as the rest of
          your progress. Nothing here is scored on its own — it is scored by five people reading it.
        </p>
      </div>

      <div className="mt-8 space-y-8">
        {DOSSIER_GROUPS.map((g) => {
          const blanks = g.fields.filter((f) => dossier[f.key] === undefined).length
          return (
            <section key={g.id} className="rounded-lg border border-line bg-surface-1 px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-display text-body font-medium text-text-1">{g.title}</h3>
                <span className="font-mono text-[11px] text-text-3">
                  {g.desk ?? 'artifact'} · {g.fields.length - blanks}/{g.fields.length} stated
                </span>
              </div>
              <p className="mt-1 max-w-prose text-body-sm text-text-2">{g.provenance}</p>

              <div className="mt-3">
                {g.fields.map((f) => (
                  <FieldRow
                    key={f.key}
                    field={f}
                    dossier={dossier}
                    draft={drafts[f.key]}
                    setDraft={(v) =>
                      setDrafts((d) => ({ ...d, [f.key]: v ?? '' }))
                    }
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
