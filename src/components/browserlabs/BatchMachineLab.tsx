/**
 * BatchMachineLab — the C4 browser lab.
 *
 * C1.L5 told the reader that summing a run-length-encoded column is one
 * multiplication and that decoding it first is 300,000 additions for the same
 * answer. This lab is where that sentence becomes a number they moved
 * themselves. One column, one query, three execution modes stepped side by side:
 *
 *   tuple-at-a-time      per-row overhead, counted item by item
 *   batch + selection    the same overhead paid per batch, survivors addressed
 *   execute-on-compressed  one predicate per RUN, sum = value × length
 *
 * The claim the whole lab rests on is EQUIVALENCE: at every row cursor, all
 * three modes report the identical `{ matched, sum }`, and all three are checked
 * against a reference computed independently of them. That is graded as task 1,
 * because a fast path that disagrees with the reference is not an optimisation —
 * it is a correctness bug with better benchmarks. Forge lab 03 grades the same
 * thing in Rust as `compressed_path`.
 *
 * Three tradeoffs are forced rather than offered, and each one is a case where
 * the obvious lever runs out:
 *
 *   1. BIGGER IS NOT BETTER. The batch size that minimises the batched count is
 *      not the largest one on any column with nulls in it, because a batch
 *      containing a single null loses the one-check-per-vector validity
 *      shortcut. The graded pick asks for the minimising size on two different
 *      columns, and the answer differs on each.
 *   2. THE SELECTION VECTOR IS NOT FREE. It avoids copying survivors, and pays
 *      an indirection per survivor per consumer. Above roughly two consumers,
 *      copying wins. Both directions have to be observed.
 *   3. RLE IS A PROPERTY OF THE DATA. On the random column the compressed path
 *      is within a few percent of the batched one, because runs ≈ rows. The lab
 *      says so on screen rather than letting the reader generalise a win that
 *      belongs to the clustering, not to the code.
 *
 * All arithmetic lives in `@/lib/vector/machine` and every number is a COUNT of
 * modelled operations. There is no wall-clock here and no `Math.random`: columns
 * come from the seeded xorshift in `desks/kit`. The honest limit is stated in the
 * page's last panel — counts describe the work you stopped issuing, and are
 * silent about cache residency and SIMD width, which is where a real engine wins
 * the rest.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronsRight,
  Copy,
  Equal,
  Play,
  RotateCcw,
  Rows3,
  Sigma,
  X,
} from 'lucide-react'
/* LabShell comes from the registry module, which will import this component
 * back once the orchestrator wires it. The cycle is safe because both sides only
 * touch each other at RENDER time, and `LabTask` is a type-only import. */
import { LabShell } from '@/components/browserlabs'
import type { LabTask } from '@/components/browserlabs/shared'
import { fmtCount, pct } from '@/lib/desks/kit'
import {
  BATCH_CHOICES,
  COMPRESSED_TARGET,
  DEFAULT_CONFIG,
  DOWNSTREAM_CHOICES,
  MODE_IDS,
  OPS_FIELDS,
  OPS_LABEL,
  OVERHEAD_TARGET,
  PER_BATCH_OVERHEAD,
  PREDICATE,
  ROWS,
  SHAPES,
  achievementsOf,
  bestBatchSize,
  compactionCompare,
  mergeAchievements,
  modeSpec,
  plateauBatchSize,
  runAll,
  shapeSpec,
  type Achievements,
  type ColumnShapeId,
  type Config,
  type ModeId,
  type ModeReport,
} from '@/lib/vector/machine'
import { cn } from '@/lib/utils'

/** Batch sizes read better as 2Ki than as 2,048 once there are nine of them. */
const fmtBatch = (n: number): string =>
  n >= 1024 ? `${n / 1024}Ki` : `${n}`

const RATIO_EPS = 0.05

export default function BatchMachineLab({ trackColor }: { trackColor: string }) {
  const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG)
  /** Rows fed to the machine so far. Starts complete; the stepper rewinds it. */
  const [cursor, setCursor] = useState<number>(ROWS)
  const [latched, setLatched] = useState<Achievements>(() => achievementsOf(DEFAULT_CONFIG))
  const [verified, setVerified] = useState<ColumnShapeId[]>([])
  const [pick, setPick] = useState<number | null>(null)
  const [pickedShapes, setPickedShapes] = useState<ColumnShapeId[]>([])

  /* Every knob change re-derives what the new configuration demonstrates and
   * latches the union, so the task list is a record of what was on screen. */
  const choose = useCallback((patch: Partial<Config>) => {
    setCfg((prev) => {
      const next = { ...prev, ...patch }
      setLatched((old) => mergeAchievements(old, achievementsOf(next)))
      setPick(null)
      return next
    })
  }, [])

  const partial = useMemo(() => runAll(cfg, cursor), [cfg, cursor])
  const full = useMemo(() => (cursor >= ROWS ? partial : runAll(cfg)), [cfg, cursor, partial])
  const cmp = useMemo(() => compactionCompare(cfg), [cfg])
  const best = useMemo(() => bestBatchSize(cfg), [cfg])
  const plateau = useMemo(() => plateauBatchSize(cfg), [cfg])

  const shape = shapeSpec(cfg.shape)
  const runs = partial.column.runs.length
  const batched = full.reports.batch
  const compressed = full.reports.compressed
  const tuple = full.reports.tuple
  /* Within 5% is a wash, and saying so is the difference between teaching the
   * mechanism and selling it. */
  const compressedRatio = compressed.total > 0 ? batched.total / compressed.total : 0
  const compressedIsWash = Math.abs(compressedRatio - 1) < RATIO_EPS

  const verify = useCallback(() => {
    if (!partial.agree) return
    setVerified((prev) => (prev.includes(cfg.shape) ? prev : [...prev, cfg.shape]))
  }, [partial.agree, cfg.shape])

  const answerPick = useCallback(
    (b: number) => {
      setPick(b)
      if (b === best) {
        setPickedShapes((prev) => (prev.includes(cfg.shape) ? prev : [...prev, cfg.shape]))
      }
    },
    [best, cfg.shape],
  )

  const step = useCallback(
    (batches: number) => {
      setCursor((c) => Math.min(ROWS, c + Math.max(1, cfg.batchSize) * batches))
    },
    [cfg.batchSize],
  )

  const tasks: LabTask[] = useMemo(
    () => [
      {
        id: 'equivalence',
        label: 'Verify that all three modes return the identical answer — on all three column shapes',
        done: verified.length === 3,
        hint: 'This is the task that matters. A fast path that disagrees with the reference is not an optimisation, it is a correctness bug with better benchmarks.',
      },
      {
        id: 'amortise',
        label: `Amortise the per-batch overhead below ${pct(OVERHEAD_TARGET)} of the batched count`,
        done: latched.overheadAmortised,
        hint: `Each batch costs ${PER_BATCH_OVERHEAD} operations before it looks at a single row. Divide that by more rows.`,
      },
      {
        id: 'batch-loses',
        label: 'Find a batch size where batching costs MORE than tuple-at-a-time',
        done: latched.batchLost,
        hint: 'A batch of one row is a volcano engine carrying paperwork. The dial goes down that far on purpose.',
      },
      {
        id: 'plateau',
        label: 'Name the batch size that minimises the batched count — on two different columns, where the answer differs',
        done: pickedShapes.length >= 2,
        hint: 'It is not the largest on any column that contains a null. Ask what a bigger vector does to the odds that the whole vector is valid.',
      },
      {
        id: 'compressed',
        label: `Make the compressed path answer the whole query in under ${COMPRESSED_TARGET} operations per row (1 per 1,000)`,
        done: latched.compressedTiny,
        hint: 'Work is proportional to run fragments, so you need a column with almost no runs AND a vector wide enough not to cut the one run it has.',
      },
      {
        id: 'copies',
        label: 'Find where the selection vector beats copying survivors, and where copying wins instead',
        done: latched.selectionWon && latched.compactionWon,
        hint: 'A selection vector pays one indirection per survivor per consumer. A copy is paid once. Change how many aggregate expressions read the batch.',
      },
    ],
    [verified.length, latched, pickedShapes.length],
  )

  return (
    <LabShell labId="batch-machine" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        One column of {fmtCount(ROWS)} rows, one query —{' '}
        <span className="font-mono text-[11.5px] text-text-1">
          select count(*), sum(v) where v &gt;= {PREDICATE.lo} and v &lt;= {PREDICATE.hi}
        </span>{' '}
        — and three ways to execute it. Step them together and watch two things at once:{' '}
        <strong>the answer never differs</strong>, and the number of operations it took differs by
        orders of magnitude.
      </p>
      <p className="mt-2 text-body-sm text-text-3">
        Every number here is a <strong>count of modelled operations</strong>, not a measurement:
        virtual calls, null checks, comparisons, branches, selection writes, indirections, copies,
        allocations, arithmetic. Nothing on this page is timed, and nothing needs to be — a count
        means the same thing on every machine. What a count cannot tell you is stated at the bottom
        of the page, before you draw a conclusion from it.
      </p>

      {/* -------------------------------- knobs ------------------------------- */}
      <div className="mt-5 space-y-3">
        <Knob
          icon={<Rows3 size={13} />}
          label="column shape"
          note={`${fmtCount(runs)} runs · ${fmtCount(partial.column.nullCount)} nulls · ${shape.line}`}
        >
          {SHAPES.map((s) => (
            <Chip
              key={s.id}
              active={cfg.shape === s.id}
              color={trackColor}
              onClick={() => choose({ shape: s.id })}
            >
              {s.name}
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<Boxes size={13} />}
          label="batch size"
          note={`${fmtCount(PER_BATCH_OVERHEAD)} operations per batch before any row is read · ${fmtCount(batched.batches)} batches · 2Ki is DuckDB's standard vector size`}
        >
          {BATCH_CHOICES.map((b) => (
            <Chip
              key={b}
              active={cfg.batchSize === b}
              color={trackColor}
              onClick={() => choose({ batchSize: b })}
            >
              {fmtBatch(b)}
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<Sigma size={13} />}
          label="downstream consumers"
          note="aggregate expressions reading the surviving rows — count(*), sum(v), min(v), max(v). Each one pays the selection vector's indirection again."
        >
          {DOWNSTREAM_CHOICES.map((d) => (
            <Chip
              key={d}
              active={cfg.downstream === d}
              color={trackColor}
              onClick={() => choose({ downstream: d })}
            >
              {d} {d === 1 ? 'expression' : 'expressions'}
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<Copy size={13} />}
          label="survivors"
          note={
            cmp.winner === 'tie'
              ? 'dead heat at these settings'
              : `${cmp.winner === 'selection' ? 'addressing' : 'copying'} wins here by ${fmtCount(Math.abs(cmp.selection - cmp.compaction))} operations`
          }
        >
          <Chip active={!cfg.compact} color={trackColor} onClick={() => choose({ compact: false })}>
            address them (selection vector)
          </Chip>
          <Chip active={cfg.compact} color={trackColor} onClick={() => choose({ compact: true })}>
            copy them into a dense batch
          </Chip>
        </Knob>
      </div>

      {/* ------------------------------- stepper ------------------------------ */}
      <div className="mt-6 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
            fed {fmtCount(cursor)} / {fmtCount(ROWS)} rows
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={false} color={trackColor} onClick={() => step(1)}>
              <ChevronsRight size={11} className="mr-1 inline" />1 batch
            </Chip>
            <Chip active={false} color={trackColor} onClick={() => step(16)}>
              <ChevronsRight size={11} className="mr-1 inline" />16 batches
            </Chip>
            <Chip active={false} color={trackColor} onClick={() => setCursor(ROWS)}>
              <Play size={11} className="mr-1 inline" />run to end
            </Chip>
            <Chip active={false} color={trackColor} onClick={() => setCursor(0)}>
              <RotateCcw size={11} className="mr-1 inline" />rewind
            </Chip>
          </div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-sm bg-line">
          <div
            className="h-full transition-[width]"
            style={{ width: `${(cursor / ROWS) * 100}%`, backgroundColor: trackColor }}
          />
        </div>
        <p className="mt-2 text-body-sm text-text-3">
          The cursor drives all three modes at once, so every row of counts below describes the same
          prefix of the same column. The running answer is shared: if the three ever diverged, you
          would see it here, at the batch where it happened, rather than in a report at the end.
        </p>
      </div>

      {/* ------------------------------- the modes ---------------------------- */}
      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        {MODE_IDS.map((id) => (
          <ModePanel
            key={id}
            id={id}
            report={partial.reports[id]}
            cheapest={partial.cheapest === id}
            dearest={partial.dearest === id}
            agrees={
              partial.reports[id].answer.matched === partial.reference.matched &&
              partial.reports[id].answer.sum === partial.reference.sum
            }
            trackColor={trackColor}
          />
        ))}
      </div>

      {/* ------------------------------ equivalence --------------------------- */}
      <div
        className={cn(
          'mt-5 rounded-md border px-4 py-3',
          partial.agree ? 'border-accent/50 bg-accent/[0.05]' : 'border-rose-400/50 bg-rose-400/[0.05]',
        )}
      >
        <p
          className={cn(
            'flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide',
            partial.agree ? 'text-accent' : 'text-rose-400',
          )}
        >
          <Equal size={12} />
          {partial.agree ? 'three modes, one answer' : 'divergence — this would be a bug'}
        </p>
        <p className="mt-2 text-body-sm text-text-2">
          Reference, computed by a loop that knows nothing about batches or runs:{' '}
          <span className="font-mono text-[11.5px] text-text-1">
            count = {fmtCount(partial.reference.matched)}, sum = {fmtCount(partial.reference.sum)}
          </span>
          . All three modes report the same pair over the same {fmtCount(cursor)} rows, and the
          cheapest of them got there in{' '}
          <strong>{fmtCount(partial.reports[partial.cheapest].total)}</strong> operations against{' '}
          <strong>{fmtCount(partial.reports[partial.dearest].total)}</strong> for the dearest.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={verify}
            className="rounded-sm border border-line px-2.5 py-1 font-mono text-[11.5px] text-text-2 transition-colors hover:text-text-1"
          >
            verify on the {shape.name} column
          </button>
          {SHAPES.map((s) => (
            <span
              key={s.id}
              className={cn(
                'rounded-sm border px-2 py-1 font-mono text-[10.5px]',
                verified.includes(s.id)
                  ? 'border-accent/60 bg-accent/10 text-accent'
                  : 'border-line text-text-3',
              )}
            >
              {verified.includes(s.id) ? <Check size={10} className="mr-1 inline" /> : null}
              {s.name}
            </span>
          ))}
        </div>
        <p className="mt-2 text-body-sm text-text-3">
          Verify all three shapes. Equivalence on one column shape is an anecdote — the interesting
          failures live in the shapes you did not try: the column with nulls in every batch, and the
          column that is one long run cut by a vector boundary.
        </p>
      </div>

      {/* --------------------------- the batch-size pick ---------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="text-body-sm text-text-2">
          Which batch size <strong>minimises</strong> the batched count on the {shape.name} column?
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {BATCH_CHOICES.map((b) => (
            <Chip key={b} active={pick === b} color={trackColor} onClick={() => answerPick(b)}>
              {fmtBatch(b)}
            </Chip>
          ))}
        </div>
        {pick !== null && (
          <p
            className={cn(
              'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
              pick === best ? 'text-accent' : 'text-rose-400',
            )}
          >
            {pick === best ? <Check size={12} /> : <X size={12} />}
            {pick === best
              ? `correct — ${fmtBatch(best)} rows`
              : `not ${fmtBatch(pick)} — set the batch size there and read the total again`}
          </p>
        )}
        <p className="mt-2 text-body-sm text-text-3">
          Two effects pull against each other, and only one of them is the famous one. A bigger batch
          amortises the {PER_BATCH_OVERHEAD} fixed operations per batch — but past{' '}
          {fmtBatch(plateau)} rows that is worth less than {pct(0.005)} of the count, so it has
          stopped being the story. A bigger batch is also <strong>less likely to be all-valid</strong>
          , and a batch holding one null loses the one-check-per-vector shortcut and pays a null check
          per row instead. This column holds {fmtCount(partial.column.nullCount)} nulls in{' '}
          {fmtCount(ROWS)} rows, spread the way its shape spreads them — so answer it on two shapes:
          the size that is right for one is wrong for the other, and neither answer is a constant you
          can memorise.
        </p>
      </div>

      {/* ---------------------------- what it bought -------------------------- */}
      <p className="mt-6 font-mono text-[11px] uppercase tracking-wide text-text-3">
        over the whole column, at these settings
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <Gauge
          label="tuple → batch"
          value={`${(tuple.total / batched.total).toFixed(2)}× fewer ops`}
          ok={batched.total < tuple.total}
          note={`${fmtCount(tuple.ops.virtualCalls - batched.ops.virtualCalls)} virtual calls and ${fmtCount(tuple.ops.branches - batched.ops.branches)} branches you stopped issuing`}
        />
        <Gauge
          label="per-batch overhead"
          value={pct(batched.overheadShare)}
          ok={batched.overheadShare < OVERHEAD_TARGET}
          note={`${fmtCount(batched.batchOverhead)} of ${fmtCount(batched.total)} operations are fixed per-batch cost`}
        />
        <Gauge
          label="batch → compressed"
          value={
            compressedIsWash ? 'a wash' : `${compressedRatio.toFixed(compressedRatio > 20 ? 0 : 2)}×`
          }
          ok={!compressedIsWash && compressedRatio > 1}
          note={
            compressedIsWash
              ? `${fmtCount(runs)} runs for ${fmtCount(ROWS)} rows — RLE has nothing to hold on to here, and no amount of engine work invents it`
              : `${fmtCount(compressed.fragments)} run fragments instead of ${fmtCount(ROWS)} rows`
          }
        />
      </div>

      {/* ------------------------------ the caveat ---------------------------- */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <AlertTriangle size={12} /> what this lab is not
        </p>
        <ul className="mt-2 space-y-1.5 text-body-sm text-text-3">
          <li>
            <strong className="text-text-2">These are modelled counts, not measurements.</strong> This
            lab simulates a three-operator pipeline in TypeScript and charges named costs for it. It
            is not an engine, nothing here is timed, and the charges are a teaching model — a real
            engine's per-tuple overhead is a virtual call plus a cache miss you cannot count from
            inside a browser.
          </li>
          <li>
            <strong className="text-text-2">A count cannot express the other half of the win.</strong>{' '}
            Batching also makes loops branch-free and dense enough for SIMD, and keeps the working set
            inside cache. Those are the effects that show up on a clock and not in this table. What
            you counted here is the work you stopped <em>issuing</em>; the memory system's opinion of
            the rest is out of scope, and pretending otherwise would be the exact overclaim the
            course warns about.
          </li>
          <li>
            <strong className="text-text-2">The RLE fast path is narrower than it looks.</strong> It
            applies here only because the filter and the aggregate are both on the run-length-encoded
            column itself. A predicate on a <em>different</em> column produces row positions that do
            not align with these runs, and the fast path evaporates. Dictionary columns get their own
            version of this (compare codes, not strings — C1.L5), and joining on codes across blocks
            is unsafe because dictionaries are per block.
          </li>
          <li>
            <strong className="text-text-2">Real engines do more than this.</strong> Adaptive vector
            sizes, constant and dictionary vectors that never materialise at all, compressed
            execution per encoding rather than RLE alone, spill-aware hash aggregates, and profiles
            that decide at runtime whether to flatten a selection. Forge lab 03 has you build the
            batched filter, the composing selection vector, the hash aggregate and the compressed
            path in Rust, and grades the equivalence across 2,000 seeded batches including partial
            final batches and selections that survive nothing.
          </li>
        </ul>
      </div>

      <p className="mt-5 font-mono text-[10.5px] text-text-3">
        {shape.name} column · seed {partial.column.seed} · batch {fmtBatch(cfg.batchSize)} ·{' '}
        {cfg.downstream} consumer{cfg.downstream === 1 ? '' : 's'} ·{' '}
        {cfg.compact ? 'copying survivors' : 'addressing survivors'} · {shape.origin}
      </p>
    </LabShell>
  )
}

/* ------------------------------- fragments ------------------------------ */

function ModePanel({
  id,
  report,
  cheapest,
  dearest,
  agrees,
  trackColor,
}: {
  id: ModeId
  report: ModeReport
  cheapest: boolean
  dearest: boolean
  agrees: boolean
  trackColor: string
}) {
  const spec = modeSpec(id)
  return (
    <div
      className={cn(
        'rounded-md border px-4 py-3',
        dearest ? 'border-rose-400/40 bg-rose-400/[0.04]' : 'border-line',
      )}
      style={cheapest ? { borderColor: trackColor, backgroundColor: `${trackColor}0d` } : undefined}
    >
      <p className="font-mono text-[11.5px] text-text-1">{spec.name}</p>
      <p className="mt-1 text-body-sm text-text-3">{spec.line}</p>

      <p className="mt-3 font-mono text-[18px] text-text-1" style={cheapest ? { color: trackColor } : undefined}>
        {fmtCount(report.total)}
        <span className="ml-1.5 text-[10.5px] text-text-3">ops</span>
      </p>
      <p className="font-mono text-[10.5px] text-text-3">
        {report.perRow < 0.01 ? report.perRow.toFixed(5) : report.perRow.toFixed(2)} per row ·{' '}
        {fmtCount(report.units)} {report.unitLabel}
        {cheapest && <span className="ml-1 uppercase">· cheapest</span>}
        {dearest && <span className="ml-1 uppercase text-rose-400">· dearest</span>}
      </p>

      <table className="mt-3 w-full border-collapse text-left">
        <tbody>
          {OPS_FIELDS.filter((f) => report.ops[f] > 0).map((f) => (
            <tr key={f}>
              <td className="py-0.5 pr-2 font-mono text-[10.5px] text-text-3">{OPS_LABEL[f]}</td>
              <td className="py-0.5 text-right font-mono text-[11px] text-text-2">
                {fmtCount(report.ops[f])}
              </td>
            </tr>
          ))}
          {OPS_FIELDS.every((f) => report.ops[f] === 0) && (
            <tr>
              <td className="py-0.5 font-mono text-[10.5px] text-text-3">nothing fed yet</td>
            </tr>
          )}
        </tbody>
      </table>

      <p
        className={cn(
          'mt-3 flex items-center gap-1.5 font-mono text-[11px]',
          agrees ? 'text-accent' : 'text-rose-400',
        )}
      >
        {agrees ? <Check size={11} /> : <X size={11} />}
        count {fmtCount(report.answer.matched)} · sum {fmtCount(report.answer.sum)}
      </p>
      <p className="mt-2 text-body-sm text-text-3">{spec.caveat}</p>
    </div>
  )
}

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

function Gauge({
  label,
  value,
  ok,
  note,
}: {
  label: string
  value: string
  ok: boolean
  note: string
}) {
  return (
    <div
      className={cn(
        'rounded-sm border px-3 py-2',
        ok ? 'border-accent/50 bg-accent/[0.06]' : 'border-line',
      )}
    >
      <p className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wide text-text-3">
        {ok ? <Check size={11} className="text-accent" /> : <AlertTriangle size={11} className="text-text-3" />}
        {label}
      </p>
      <p className={cn('mt-1 font-mono text-[12px]', ok ? 'text-accent' : 'text-text-1')}>{value}</p>
      <p className="mt-1 font-mono text-[10px] text-text-3">{note}</p>
    </div>
  )
}
