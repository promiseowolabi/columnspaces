/**
 * LayoutDesignerLab — the C2 browser lab.
 *
 * The reader has been told, in C0.L4, that a table has exactly one physical
 * order and that pruning follows that order rather than the format. This lab is
 * where that sentence stops being a sentence. Five query classes are priced
 * side by side against ONE layout, so the constraint is on screen rather than
 * in a paragraph: every improvement to one class is visibly paid for by
 * another, because there is one partition key and one sort key to go round.
 *
 * The teaching point is made structurally, not stated. Three ways:
 *
 *   1. The worst-served class is ALWAYS displayed. There is no design the
 *      reader can reach that has nothing to show there — the panel cannot go
 *      blank, because a strictly worst class exists for all 120 designs.
 *   2. One graded task is to NAME the starved class, and a second is to name a
 *      DIFFERENT one, which is only possible by moving the physical order. The
 *      reader cannot finish the lab believing the starved class is a property
 *      of the workload rather than of their design.
 *   3. The scan-bill task pairs a target with a ceiling. Exactly two of the 120
 *      designs satisfy both, and the design that minimises the dashboard bill
 *      is not one of them: it misses the ceiling by 14×. The tradeoff is
 *      forced rather than offered.
 *
 * All arithmetic lives in `@/lib/layout/mix`, which reuses the Warehouse engine
 * rather than modelling anything a second time. Every number on screen is a
 * COUNT — bytes, row groups, files — and every one is deterministic: the same
 * three choices always produce the same numbers, on any machine, with no
 * wall-clock and no Math.random anywhere beneath this file.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Layers, Rows3, SortAsc, Target, X } from 'lucide-react'
/* LabShell comes from the registry module, which will import this component
 * back once the orchestrator wires it. The cycle is safe because both sides
 * only touch each other at RENDER time (hoisted function declarations), never
 * during module initialisation — and `LabTask` is imported from ./shared as a
 * type, so it contributes no runtime edge at all. */
import { LabShell } from '@/components/browserlabs'
import type { LabTask } from '@/components/browserlabs/shared'
import { fmtBytes, fmtCount, pct } from '@/lib/desks/kit'
import {
  CLASS_IDS,
  OPENING_DESIGN,
  PARTITION_CHOICES,
  ROW_GROUP_CHOICES,
  SORT_KEY_CHOICES,
  TARGETS,
  bestDesignFor,
  costMix,
  designKey,
  fileRowsFor,
  meetsTargets,
  queryClass,
  quotaClassId,
  type Design,
  type QueryClassId,
} from '@/lib/layout/mix'
import { partitionKey } from '@/lib/warehouse/table'
import { cn } from '@/lib/utils'

/** Row-group sizes read better as 8Ki than as 8,192 once there are five of them. */
const fmtRows = (n: number): string =>
  n >= 1024 * 1024 ? `${n / (1024 * 1024)}Mi` : n >= 1024 ? `${n / 1024}Ki` : `${n}`

const SORT_KEY_LABEL: Record<string, string> = {
  none: 'no sort key',
  ts: 'ts',
  tenant_id: 'tenant_id',
  region: 'region',
  event_type: 'event_type',
  user_id: 'user_id',
}

export default function LayoutDesignerLab({ trackColor }: { trackColor: string }) {
  /* Every design the reader has looked at, oldest first. Keeping the trail
   * rather than a pile of booleans means the latched tasks below are DERIVED
   * from what happened, not from an effect that fired at the right moment. */
  const [visited, setVisited] = useState<Design[]>([OPENING_DESIGN])
  const [named, setNamed] = useState<QueryClassId | null>(null)
  const [namedRight, setNamedRight] = useState<QueryClassId[]>([])
  const [quotaPick, setQuotaPick] = useState<QueryClassId | null>(null)

  const design = visited[visited.length - 1]
  const mix = useMemo(() => costMix(design), [design])
  const targets = useMemo(() => meetsTargets(design), [design])
  const quota = quotaClassId()

  const choose = useCallback((patch: Partial<Design>) => {
    setVisited((prev) => {
      const next = { ...prev[prev.length - 1], ...patch }
      return [...prev, next]
    })
  }, [])

  /* Naming is graded against the design in front of the reader at the moment
   * they answer, and a correct answer is remembered per class — so task 2 can
   * ask for a second, different starved class and mean it. */
  const nameIt = useCallback(
    (id: QueryClassId) => {
      setNamed(id)
      if (id === mix.worst.id) {
        setNamedRight((prev) => (prev.includes(id) ? prev : [...prev, id]))
      }
    },
    [mix.worst.id],
  )

  const starvedTheDashboard = useMemo(
    () => visited.some((d) => costMix(d).worst.id === 'dashboard'),
    [visited],
  )
  const hitTargets = useMemo(() => visited.some((d) => meetsTargets(d).ok), [visited])

  /* The design the starved class actually wanted. A sweep of the grid, but a
   * cached one — every cost in it was memoised the first time it was priced. */
  const wanted = useMemo(() => bestDesignFor(mix.worst.id), [mix.worst.id])

  const tasks: LabTask[] = useMemo(
    () => [
      {
        id: 'name',
        label: 'Name the query class this design starves',
        done: namedRight.length >= 1,
        hint: 'Starvation is a ratio, not a bill: how many times more bytes a class reads here than under the best design for it.',
      },
      {
        id: 'moves',
        label: 'Move the physical order until a DIFFERENT class is worst-served, and name that one too',
        done: namedRight.length >= 2,
        hint: 'The starved class is a property of your design, not of the workload. Change the partition key and watch it move.',
      },
      {
        id: 'starve-dashboard',
        label: 'Find a design that starves the dashboard itself',
        done: starvedTheDashboard,
        hint: 'It is the cheapest class in absolute bytes and still the easiest to starve — its best case is 17.9 MiB, so it has the furthest to fall.',
      },
      {
        id: 'tradeoff',
        label: `Get the dashboard under ${fmtBytes(TARGETS.dashboardBytes)} per pass while keeping the starved class under ${fmtBytes(TARGETS.starvedCeiling)}`,
        done: hitTargets,
        hint: 'The design that minimises the dashboard alone misses the ceiling by 14×. You cannot re-order the table for two predicates — but you can change how fine the statistics are.',
      },
      {
        id: 'quota',
        label: 'Name the class that NO design in the space rescues — the one that needs a quota rather than a layout',
        done: quotaPick === quota,
        hint: 'Compare each class’s best case, not its bill here. One of them is still the largest number in the mix even after you design for it.',
      },
    ],
    [namedRight.length, starvedTheDashboard, hitTargets, quotaPick, quota],
  )

  return (
    <LabShell labId="layout-designer" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        One table, five query classes, and <strong>one physical order</strong> to serve them with. You
        get three decisions: the partition key, the sort key, and how many rows a row group holds.
        Every number below is a count, computed by the same model the Warehouse runs, against
        byte-identical queries — so any difference you see is caused by your design and nothing else.
      </p>
      <p className="mt-2 text-body-sm text-text-3">
        Nothing here can return a wrong answer. Over-reading is a bill; skipping a block that held a
        match would be a correctness bug, and the model never does it. Everything on this page is the
        price of the conservative choice.
      </p>

      {/* ------------------------------- knobs ------------------------------- */}
      <div className="mt-5 space-y-3">
        <Knob
          icon={<Layers size={13} />}
          label="partition key"
          note={`${fmtCount(partitionKey(design.partitionKey).count)} partitions · prunes only predicates on ${partitionKey(design.partitionKey).column ?? 'nothing'}`}
        >
          {PARTITION_CHOICES.map((p) => (
            <Chip
              key={p}
              active={design.partitionKey === p}
              color={trackColor}
              onClick={() => choose({ partitionKey: p })}
            >
              {partitionKey(p).label}
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<SortAsc size={13} />}
          label="sort key"
          note="the one column min/max statistics can prune on — a table has exactly one physical order"
        >
          {SORT_KEY_CHOICES.map((s) => (
            <Chip
              key={s}
              active={design.sortKey === s}
              color={trackColor}
              onClick={() => choose({ sortKey: s })}
            >
              {SORT_KEY_LABEL[s] ?? s}
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<Rows3 size={13} />}
          label="row group"
          note={`${fmtCount(design.rowGroupRows)} rows per group · ${fmtCount(fileRowsFor(design.rowGroupRows))} rows per file · finer statistics, more footers to open`}
        >
          {ROW_GROUP_CHOICES.map((r) => (
            <Chip
              key={r}
              active={design.rowGroupRows === r}
              color={trackColor}
              onClick={() => choose({ rowGroupRows: r })}
            >
              {fmtRows(r)}
            </Chip>
          ))}
        </Knob>
      </div>

      {/* ------------------------------- the mix ----------------------------- */}
      <div className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              {['query class', 'bytes / pass', 'bytes / day', 'pruned', 'files', 'best possible', 'starvation'].map(
                (h) => (
                  <th
                    key={h}
                    className="py-2 pr-4 font-mono text-[10px] uppercase tracking-wide text-text-3"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {mix.classes.map((c) => {
              const spec = queryClass(c.id)
              const isWorst = c.id === mix.worst.id
              const isBest = c.id === mix.best.id
              return (
                <tr
                  key={c.id}
                  className={cn(
                    'border-b border-line/60 align-top',
                    isWorst && 'bg-rose-400/[0.06]',
                  )}
                >
                  <td className="py-3 pr-4">
                    <p className="font-mono text-[12px] text-text-1">{spec.name}</p>
                    <p className="mt-1 max-w-sm text-body-sm text-text-3">{spec.line}</p>
                    <p className="mt-1 max-w-sm font-mono text-[10.5px] text-text-3">
                      wants: {spec.wants}
                    </p>
                  </td>
                  <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                    {fmtBytes(c.bytesScanned)}
                  </td>
                  <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                    {fmtBytes(c.bytesPerDay)}
                    <span className="block text-[10px] text-text-3">
                      {fmtCount(spec.runsPerDay)} runs/day
                    </span>
                  </td>
                  <td className="py-3 pr-4 font-mono text-[12px] text-text-2">{pct(c.pruningRatio)}</td>
                  <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                    {fmtCount(c.filesTouched)}
                    <span className="block text-[10px] text-text-3">{fmtBytes(c.metadataBytes)} footers</span>
                  </td>
                  <td className="py-3 pr-4 font-mono text-[12px] text-text-3">{fmtBytes(c.bestBytes)}</td>
                  <td
                    className="py-3 pr-4 font-mono text-[12px]"
                    style={{ color: isWorst ? '#FB7185' : isBest ? trackColor : undefined }}
                  >
                    {c.starvation.toFixed(2)}×
                    {isWorst && <span className="block text-[10px] uppercase">starved</span>}
                    {isBest && !isWorst && <span className="block text-[10px] uppercase">best served</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* --------------------------- the worst class -------------------------- */}
      <div className="mt-5 rounded-md border border-rose-400/40 bg-rose-400/[0.04] px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-rose-400">
          this design starves: {mix.worst.name}
        </p>
        <p className="mt-2 text-body-sm text-text-2">
          It reads <strong>{fmtBytes(mix.worst.bytesScanned)}</strong> per pass, which is{' '}
          <strong>{mix.worst.starvation.toFixed(2)}×</strong> the {fmtBytes(mix.worst.bestBytes)} it
          would read under the best design for it —{' '}
          <span className="font-mono text-[11.5px] text-text-1">
            {partitionKey(wanted.partitionKey).label} / {SORT_KEY_LABEL[wanted.sortKey] ?? wanted.sortKey} /{' '}
            {fmtRows(wanted.rowGroupRows)} rows
          </span>
          . The second-worst class, {mix.runnerUp.name}, sits at {mix.runnerUp.starvation.toFixed(2)}×.
          There is no design without a row in this panel: one physical order cannot lead with five
          different columns.
        </p>
      </div>

      {/* ------------------------------ name it ------------------------------ */}
      <Question
        prompt="Which class does the design above starve?"
        note={
          namedRight.length >= 2
            ? 'Both named. Notice what that took: the starved class moved because your physical order moved.'
            : 'Answer for this design, then change the order until a different class is worst and answer again.'
        }
        picked={named}
        correctId={mix.worst.id}
        onPick={nameIt}
        trackColor={trackColor}
      />

      {/* ------------------------------ targets ------------------------------ */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <Target size={12} /> the scan-bill task
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Gauge
            label={`dashboard ≤ ${fmtBytes(TARGETS.dashboardBytes)}`}
            value={fmtBytes(targets.dashboardBytes)}
            ok={targets.dashboardOk}
          />
          <Gauge
            label={`starved class ≤ ${fmtBytes(TARGETS.starvedCeiling)}`}
            value={`${fmtBytes(targets.starvedBytes)} · ${queryClass(targets.starvedId).name}`}
            ok={targets.starvedOk}
          />
        </div>
        <p className="mt-3 text-body-sm text-text-3">
          {targets.ok
            ? 'Both held at once. You gave up roughly 4.6× on the dashboard to keep the starved class inside its ceiling — that trade, stated out loud, is what a layout review is.'
            : 'Two of the 120 designs satisfy both. The one that minimises the dashboard alone misses the ceiling by 14×, so the answer is not "make the dashboard fast".'}
        </p>
      </div>

      {/* ------------------------------- quota ------------------------------- */}
      <Question
        prompt="One of these five is not a layout problem. Which class does no design in this space rescue?"
        note="Compare the best-possible column, not the bill in front of you. A class whose best case is still the largest number in the mix needs a fence — a quota, a separate pool — and C0.L5 reports it as a bound rather than a forecast."
        picked={quotaPick}
        correctId={quota}
        onPick={setQuotaPick}
        trackColor={trackColor}
      />

      <p className="mt-5 font-mono text-[10.5px] text-text-3">
        design {designKey(design)} · {visited.length} tried · clustering pinned at 0.9, because in
        production it is set by whoever writes the table, not by you — that is forge lab 02’s subject,
        not this one.
      </p>
    </LabShell>
  )
}

/* ------------------------------- fragments ------------------------------ */

function Knob({
  icon,
  label,
  note,
  children,
}: {
  icon: ReactNode
  label: string
  note: string
  children: ReactNode
}) {
  return (
    <div className="rounded-md border border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3">
          {icon}
          {label}
        </span>
        <span className="font-mono text-[10.5px] text-text-3">{note}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function Chip({
  active,
  color,
  onClick,
  children,
}: {
  active: boolean
  color: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-sm border px-2.5 py-1 font-mono text-[11.5px] transition-colors',
        active ? 'text-text-1' : 'border-line text-text-3 hover:text-text-2',
      )}
      style={active ? { borderColor: color, backgroundColor: `${color}1a` } : undefined}
    >
      {children}
    </button>
  )
}

/** A five-way graded pick. Feedback is immediate, because the model is the answer key. */
function Question({
  prompt,
  note,
  picked,
  correctId,
  onPick,
  trackColor,
}: {
  prompt: string
  note: string
  picked: QueryClassId | null
  correctId: QueryClassId
  onPick: (id: QueryClassId) => void
  trackColor: string
}) {
  const right = picked !== null && picked === correctId
  return (
    <div className="mt-5 rounded-md border border-line px-4 py-3">
      <p className="text-body-sm text-text-2">{prompt}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {CLASS_IDS.map((id) => (
          <Chip key={id} active={picked === id} color={trackColor} onClick={() => onPick(id)}>
            {queryClass(id).name}
          </Chip>
        ))}
      </div>
      {picked !== null && (
        <p
          className={cn(
            'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
            right ? 'text-accent' : 'text-rose-400',
          )}
        >
          {right ? <Check size={12} /> : <X size={12} />}
          {right ? 'correct' : `not ${queryClass(picked).name} — read the starvation column again`}
        </p>
      )}
      <p className="mt-2 text-body-sm text-text-3">{note}</p>
    </div>
  )
}

function Gauge({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div
      className={cn(
        'rounded-sm border px-3 py-2',
        ok ? 'border-accent/50 bg-accent/[0.06]' : 'border-line',
      )}
    >
      <p className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wide text-text-3">
        {ok ? <Check size={11} className="text-accent" /> : <AlertTriangle size={11} className="text-rose-400" />}
        {label}
      </p>
      <p className={cn('mt-1 font-mono text-[12px]', ok ? 'text-accent' : 'text-text-1')}>{value}</p>
    </div>
  )
}
