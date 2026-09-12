/**
 * DeskSubmission — the desk as something you can submit to.
 *
 * Three properties this component exists to preserve:
 *
 *   omission is visible    — every blank says what it costs and which check
 *                            charges for it, BEFORE the learner submits. Several
 *                            desk checks fail on an omitted term even when the
 *                            point estimate is perfect, and a form that hid that
 *                            would be a form that taught the wrong lesson.
 *   the model does the     — the report is rendered check by check with the
 *   teaching                 model's own diagnostic message, verbatim. Nothing
 *                            here paraphrases a grader, and nothing here grades.
 *   the numbers travel     — a passing desk offers its outputs to the dossier as
 *                            an explicit action. Nothing is copied silently,
 *                            because overwriting a figure the learner defended
 *                            in a room would be worse than not offering it.
 *
 * The controls follow `DossierEditor` deliberately: grouped by provenance,
 * tri-state booleans so a blank is a distinct visible position, and units in the
 * unit a person types rather than the unit the model stores.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Check as CheckIcon, RotateCcw, Send, X } from 'lucide-react'
import type { DeskMeta } from '@/lib/desks'
import { allPassed } from '@/lib/desks/kit'
import type { DeskReport } from '@/lib/desks/kit'
import {
  DESK_TASK_ID,
  allFields,
  briefValues,
  deskSimId,
  getDeskForm,
  isStated,
  missingRequired,
} from '@/lib/desks/fields'
import type { DeskField, DeskFieldGroup, DeskForm, DeskValue, DeskValues, DossierOffer } from '@/lib/desks/fields'
import { useProgress } from '@/lib/progress'
import { cn } from '@/lib/utils'

const INPUT =
  'w-full rounded-md border border-line bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text-1 placeholder:text-text-3/70 focus:border-accent focus:outline-none'

const ROLE_CHIP: Record<DeskFieldGroup['role'], { label: string; cls: string }> = {
  given: { label: 'given', cls: 'border-line text-text-3' },
  claim: { label: 'you derive', cls: 'border-accent/50 text-accent' },
  discipline: { label: 'graded on absence', cls: 'border-amber-400/40 text-amber-400' },
}

/** Entry-unit display of a stored value, so bytes are typed in TB and not in digits. */
function displayNumber(field: DeskField, raw: DeskValue | undefined): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return ''
  const scaled = raw / (field.factor ?? 1)
  /* Trim float noise from dividing by 1e12 without rounding a real value away. */
  return String(Number(scaled.toPrecision(12)))
}

function TriState({
  value,
  onChange,
  hasDiscipline,
}: {
  value: boolean | undefined
  onChange: (v: boolean | undefined) => void
  hasDiscipline: boolean
}) {
  const opts: { v: boolean | undefined; label: string }[] = [
    { v: undefined, label: hasDiscipline ? 'not stated' : 'blank' },
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
  values,
  drafts,
  setValue,
  setDraft,
}: {
  field: DeskField
  values: DeskValues
  drafts: Record<string, string>
  setValue: (path: string, v: DeskValue | undefined) => void
  setDraft: (path: string, s: string) => void
}) {
  const raw = values[field.path]
  const blank = !isStated(raw) && typeof raw !== 'boolean'
  const id = `desk-${field.path.replace(/\./g, '-')}`

  return (
    <div className="border-t border-line/60 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-body-sm text-text-1">
          {field.label}
          {field.unit && <span className="ml-1.5 font-mono text-[11px] text-text-3">{field.unit}</span>}
          {field.required && <span className="ml-1.5 font-mono text-[10px] uppercase text-amber-400">required</span>}
        </label>
        <span className="font-mono text-[10px] text-text-3">{field.path}</span>
      </div>

      <div className="mt-2 max-w-md">
        {field.kind === 'boolean' && (
          <TriState
            value={typeof raw === 'boolean' ? raw : undefined}
            hasDiscipline={field.discipline !== undefined}
            onChange={(v) => setValue(field.path, v)}
          />
        )}

        {field.kind === 'number' && (
          <input
            id={id}
            type="text"
            inputMode="decimal"
            value={drafts[field.path] ?? displayNumber(field, raw)}
            placeholder={field.nullable ? 'not stated' : '0'}
            onChange={(e) => {
              const text = e.target.value
              setDraft(field.path, text)
              if (text.trim() === '') {
                setValue(field.path, undefined)
                return
              }
              const n = Number(text)
              if (Number.isFinite(n)) setValue(field.path, n * (field.factor ?? 1))
            }}
            className={cn(INPUT, blank && 'border-amber-400/30')}
          />
        )}

        {field.kind === 'text' && (
          <input
            id={id}
            type="text"
            value={typeof raw === 'string' ? raw : ''}
            placeholder="not stated"
            onChange={(e) => setValue(field.path, e.target.value === '' ? undefined : e.target.value)}
            className={cn(INPUT, blank && 'border-amber-400/30')}
          />
        )}

        {field.kind === 'enum' && (
          <select
            id={id}
            value={typeof raw === 'string' ? raw : ''}
            onChange={(e) => setValue(field.path, e.target.value === '' ? undefined : e.target.value)}
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

      <p className="mt-2 max-w-prose text-body-sm text-text-3">{field.help}</p>

      {blank && field.discipline && (
        <p className="mt-2 flex max-w-prose items-start gap-1.5 text-body-sm text-text-2">
          <AlertTriangle size={12} className="mt-1 shrink-0 text-amber-400" strokeWidth={1.75} />
          <span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-amber-400">
              blank fails {field.discipline.check} —{' '}
            </span>
            {field.discipline.cost}
          </span>
        </p>
      )}
    </div>
  )
}

function Report({ report, form, values }: { report: DeskReport; form: DeskForm; values: DeskValues }) {
  const reference = useMemo(() => form.reference(values), [form, values])
  const passed = report.checks.filter((c) => c.pass).length

  return (
    <div className="mt-8">
      <div
        className={cn(
          'rounded-lg border px-5 py-4',
          allPassed(report) ? 'border-accent/50 bg-accent/5' : 'border-amber-400/40 bg-surface-1',
        )}
      >
        <p className="font-mono text-label uppercase tracking-wide text-text-3">the desk’s answer</p>
        <p className="mt-2 max-w-prose text-body text-text-1">
          {passed} of {report.checks.length} checks passed.{' '}
          {allPassed(report)
            ? 'Every term is present and every figure is inside its band. The numbers below are yours to carry into a room.'
            : 'A failed check is graded in bands or on an omission, and the message says which. A point estimate can be exact and still fail, because the term you left out is the failure mode.'}
        </p>
      </div>

      <ul className="mt-4 space-y-3">
        {report.checks.map((c) => (
          <li
            key={c.id}
            className={cn(
              'rounded-lg border px-5 py-4',
              c.pass ? 'border-line bg-surface-1' : 'border-rose-400/40 bg-surface-1',
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-center gap-2">
                {c.pass ? (
                  <CheckIcon size={13} className="text-accent" strokeWidth={2.25} />
                ) : (
                  <X size={13} className="text-rose-400" strokeWidth={2.25} />
                )}
                <span className="text-body-sm text-text-1">{c.label}</span>
              </span>
              <span className="font-mono text-[10px] text-text-3">{c.id}</span>
            </div>
            <p className="mt-2 max-w-prose text-body-sm text-text-2">{c.msg}</p>
          </li>
        ))}
      </ul>

      <section className="mt-8 rounded-lg border border-line bg-surface-1 px-5 py-4">
        <h3 className="font-mono text-label uppercase tracking-wide text-text-3">the reference computation</h3>
        <p className="mt-2 max-w-prose text-body-sm text-text-2">
          What the model computed from the same inputs. Shown beside the grade rather than instead of it: the desk
          grades in bands because a sizing model is not correct, it is within tolerance and honestly caveated.
        </p>
        <dl className="mt-3 space-y-2">
          {reference.map((line) => (
            <div key={line.label} className="border-t border-line/60 pt-2 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-body-sm text-text-2">{line.label}</dt>
                <dd className="font-mono text-[12px] text-text-1">{line.value}</dd>
              </div>
              {line.note && <p className="mt-1 max-w-prose text-body-sm text-text-3">{line.note}</p>}
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

function DossierHandoff({ offers, passing }: { offers: DossierOffer[]; passing: boolean }) {
  const dossier = useProgress((s) => s.dossier)
  const setDossier = useProgress((s) => s.setDossier)
  const [copied, setCopied] = useState(false)

  if (offers.length === 0) return null

  const collisions = offers.filter((o) => dossier[o.key] !== undefined && dossier[o.key] !== o.value)

  return (
    <section className="mt-8 rounded-lg border border-line bg-surface-1 px-5 py-4">
      <h3 className="font-mono text-label uppercase tracking-wide text-text-3">carry these into the rooms</h3>
      <p className="mt-2 max-w-prose text-body-sm text-text-2">
        Several dossier fields ARE desk outputs. Copying them is the whole arc of the architecture half — the five
        adversaries then attack numbers you actually produced rather than numbers you guessed at the last minute.
        Nothing is copied unless you press the button, and a value already in your dossier is shown beside the new
        one so an overwrite is a decision.
      </p>

      <dl className="mt-3 space-y-2">
        {offers.map((o) => {
          const current = dossier[o.key]
          const differs = current !== undefined && current !== o.value
          return (
            <div key={o.key} className="border-t border-line/60 pt-2 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-body-sm text-text-2">{o.label}</dt>
                <dd className="font-mono text-[12px] text-text-1">
                  {String(o.value)}
                  {differs && <span className="ml-2 text-amber-400">(replaces {String(current)})</span>}
                </dd>
              </div>
              <p className="mt-1 max-w-prose text-body-sm text-text-3">
                {o.derivation}
                <span className="ml-1.5 font-mono text-[10px] text-text-3">{o.key}</span>
              </p>
            </div>
          )
        })}
      </dl>

      {!passing && (
        <p className="mt-3 flex max-w-prose items-start gap-1.5 text-body-sm text-text-2">
          <AlertTriangle size={12} className="mt-1 shrink-0 text-amber-400" strokeWidth={1.75} />
          <span>
            Not every check passed. You may still copy these — a dossier is allowed to be wrong, and being wrong in
            a room is the point — but the figure you hand over is the one the desk just disputed.
          </span>
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          setDossier(Object.fromEntries(offers.map((o) => [o.key, o.value])))
          setCopied(true)
        }}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-accent/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-accent transition-colors hover:bg-accent/10"
      >
        <ArrowRight size={12} />
        copy {offers.length} figure{offers.length === 1 ? '' : 's'} into my dossier
        {collisions.length > 0 && ` — ${collisions.length} overwrite${collisions.length === 1 ? '' : 's'}`}
      </button>

      {copied && (
        <p className="mt-2 text-body-sm text-accent">
          Copied. They persist immediately and ride the same export snapshot as the rest of your progress.
        </p>
      )}
    </section>
  )
}

export function DeskSubmission({ desk }: { desk: DeskMeta }) {
  const form = getDeskForm(desk.id)
  const run = useProgress((s) => s.desks[desk.id])
  const recordDeskRun = useProgress((s) => s.recordDeskRun)
  const recordSimTask = useProgress((s) => s.recordSimTask)

  /* Reopen on the last submission when there is one: returning to a desk should
   * resume the work, not the scenario. */
  const [values, setValues] = useState<DeskValues>(() =>
    run?.lastValues && Object.keys(run.lastValues).length > 0
      ? { ...run.lastValues }
      : form
        ? briefValues(form)
        : {},
  )
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [report, setReport] = useState<DeskReport | null>(null)

  if (!form) return null

  const blocking = missingRequired(form, values)
  const setValue = (path: string, v: DeskValue | undefined) =>
    setValues((prev) => {
      const next = { ...prev }
      if (v === undefined) delete next[path]
      else next[path] = v
      return next
    })

  const submit = () => {
    const r = form.grade(values)
    setReport(r)
    recordDeskRun(desk.id, values, r.checks.map((c) => ({ id: c.id, pass: c.pass })))
    if (allPassed(r)) recordSimTask(deskSimId(desk.id), DESK_TASK_ID)
  }

  const reset = () => {
    setValues(briefValues(form))
    setDrafts({})
    setReport(null)
  }

  const total = allFields(form).length
  const stated = allFields(form).filter((f) => values[f.path] !== undefined).length

  return (
    <div className="mt-12">
      <h2 className="font-display text-h2 font-semibold text-text-1">Submit to this desk</h2>
      <p className="mt-2 max-w-prose text-body text-text-2">{form.brief}</p>

      <div className="mt-4 rounded-lg border border-line bg-surface-1 px-5 py-4">
        <p className="max-w-prose text-body-sm text-text-2">
          {stated} of {total} fields stated. The scenario is prefilled and editable; the figures you derive and the
          terms this desk grades on absence are blank on purpose. A blank is a submission, and the fields marked{' '}
          <span className="text-amber-400">graded on absence</span> say which check charges for it.
        </p>
        {run && (
          <p className="mt-2 max-w-prose text-body-sm text-text-3">
            {run.attempts} attempt{run.attempts === 1 ? '' : 's'} so far · best {run.bestPassed} of {run.bestTotal}{' '}
            checks
            {run.passedAt ? ` · first passed ${run.passedAt.slice(0, 10)}` : ''}. Your last submission was reloaded
            into the form.
          </p>
        )}
      </div>

      <div className="mt-8 space-y-8">
        {form.groups.map((g) => {
          const chip = ROLE_CHIP[g.role]
          const blanks = g.fields.filter((f) => values[f.path] === undefined).length
          return (
            <section key={g.id} className="rounded-lg border border-line bg-surface-1 px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-display text-body font-medium text-text-1">{g.title}</h3>
                <span className="flex items-center gap-2">
                  <span className={cn('rounded-full border px-2 py-0.5 font-mono text-[10px]', chip.cls)}>
                    {chip.label}
                  </span>
                  <span className="font-mono text-[11px] text-text-3">
                    {g.fields.length - blanks}/{g.fields.length} stated
                  </span>
                </span>
              </div>
              <p className="mt-1 max-w-prose text-body-sm text-text-2">{g.blurb}</p>

              <div className="mt-3">
                {g.fields.map((f) => (
                  <FieldRow
                    key={f.path}
                    field={f}
                    values={values}
                    drafts={drafts}
                    setValue={setValue}
                    setDraft={(path, s) => setDrafts((d) => ({ ...d, [path]: s }))}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={submit}
          disabled={blocking.length > 0}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-4 py-2 font-mono text-[11px] uppercase tracking-wide transition-colors',
            blocking.length > 0
              ? 'cursor-not-allowed border-line text-text-3'
              : 'border-accent/60 text-accent hover:bg-accent/10',
          )}
        >
          <Send size={12} />
          submit to the desk
        </button>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3 hover:text-text-1"
        >
          <RotateCcw size={12} />
          back to the brief
        </button>
      </div>

      {blocking.length > 0 && (
        <p className="mt-3 max-w-prose text-body-sm text-amber-400">
          The model cannot represent a blank for {blocking.map((f) => f.label).join(', ')} — there is no value that
          means "not stated" for these, so pick one. Every other blank is submittable, and several of them are
          graded.
        </p>
      )}

      {report && (
        <>
          <Report report={report} form={form} values={values} />
          <DossierHandoff offers={form.offers(values)} passing={allPassed(report)} />
        </>
      )}
    </div>
  )
}
