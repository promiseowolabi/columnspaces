/**
 * The Warehouse — the persistent world.
 *
 * One columnar platform, driven by a deterministic query trace. The reader
 * describes a LAYOUT (partition key, sort key, clustering, row-group size, file
 * size, per-column encodings, compaction cadence), runs one of four traces
 * against it, and reads the counts — beside the same counts for the reference
 * layout, so every number on the page is a controlled comparison rather than a
 * claim.
 *
 * Every metric is a COUNT, never wall-clock: a count means the same thing on
 * every machine, which is what makes a run replayable and diffable against the
 * reference. There is no timer, no animation loop and no engine in this page —
 * the model in `lib/warehouse/engine.ts` is pure arithmetic over a seeded
 * trace, so the same knobs give the same answer on every machine and in CI.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Database, Gauge, Layers, Network, Play, RotateCcw, Scissors, Table2 } from 'lucide-react'
import { SIMS } from '@/lib/tracks'
import { useProgress } from '@/lib/progress'
import { cn } from '@/lib/utils'
import { fmtBytes, fmtCount, pct } from '@/lib/desks/kit'
import {
  COLUMNS,
  COLUMN_IDS,
  PARTITION_KEYS,
  TABLE_ROWS,
  type ColumnId,
  type PartitionKeyId,
} from '@/lib/warehouse/table'
import { TRACE_MODES, buildTrace, type TraceModeId } from '@/lib/warehouse/trace'
import {
  ENCODINGS,
  REFERENCE_LAYOUT,
  SHUFFLE_BUCKETS,
  cloneLayout,
  compareToReference,
  type EncodingId,
  type Layout,
  type Metrics,
} from '@/lib/warehouse/engine'

/* ------------------------------- metric copy ------------------------------ */

const fmtRatio = (n: number) => `${n.toFixed(2)}×`

const METRIC_META: {
  key: keyof Metrics
  icon: typeof Gauge
  name: string
  line: string
  fmt: (n: number) => string
}[] = [
  {
    key: 'bytesScanned',
    icon: Gauge,
    name: 'bytes scanned',
    line: 'The bill. Projection × pruning × frequency, measured rather than asserted.',
    fmt: fmtBytes,
  },
  {
    key: 'pruningRatio',
    icon: Scissors,
    name: 'pruning ratio',
    line: 'Row groups skipped unread ÷ row groups the trace could have read. Falls the moment clustering degrades.',
    fmt: pct,
  },
  {
    key: 'rowGroupsRead',
    icon: Table2,
    name: 'row groups read',
    line: 'The blocks that were actually opened and decoded. The count pruning is trying to drive down.',
    fmt: fmtCount,
  },
  {
    key: 'rowGroupsPruned',
    icon: Scissors,
    name: 'row groups pruned',
    line: 'Blocks skipped on statistics alone, summed over the trace. Free reads are the ones you never issue.',
    fmt: fmtCount,
  },
  {
    key: 'compressionRatio',
    icon: Layers,
    name: 'compression ratio',
    line: 'Whole table, uncompressed ÷ stored. Per column below — the average hides the column that sets your floor.',
    fmt: fmtRatio,
  },
  {
    key: 'filesTouched',
    icon: Database,
    name: 'files touched',
    line: 'Planning cost scales with file count, not data size. This is the number a small-file storm moves.',
    fmt: fmtCount,
  },
  {
    key: 'bytesShuffled',
    icon: Network,
    name: 'bytes shuffled',
    line: 'Across the exchange. Read it with max-over-mean below, because the largest bucket is the runtime.',
    fmt: fmtBytes,
  },
]

/* ------------------------------ layout options ---------------------------- */

const ROW_GROUP_OPTIONS = [8_192, 32_768, 131_072, 524_288, 1_048_576]
const FILE_OPTIONS = [262_144, 1_048_576, 4_194_304, 16_777_216]

const fmtRows = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(n % 1_048_576 === 0 ? 0 : 1)}M rows` : `${Math.round(n / 1024)}K rows`

const sameLayout = (a: Layout, b: Layout) => JSON.stringify(a) === JSON.stringify(b)

/* --------------------------------- page ---------------------------------- */

export default function Warehouse() {
  const sim = SIMS.find((s) => s.id === 'warehouse')

  const [mode, setMode] = useState<TraceModeId>('dashboard')
  const [draft, setDraft] = useState<Layout>(() => cloneLayout(REFERENCE_LAYOUT))
  /* The committed run. Kept separate from the draft so the counts on screen
   * always belong to a layout the reader deliberately ran — a live-updating
   * panel would make it impossible to say which change moved which number. */
  const [run, setRun] = useState<{ mode: TraceModeId; layout: Layout }>(() => ({
    mode: 'dashboard',
    layout: cloneLayout(REFERENCE_LAYOUT),
  }))

  const recordSimVisit = useProgress((s) => s.recordSimVisit)
  const recordSimTask = useProgress((s) => s.recordSimTask)
  const setSimConfig = useProgress((s) => s.setSimConfig)

  useEffect(() => {
    recordSimVisit('warehouse')
  }, [recordSimVisit])

  const trace = useMemo(() => buildTrace(run.mode), [run.mode])
  const { student, reference, deltas } = useMemo(
    () => compareToReference(trace, run.layout),
    [trace, run.layout],
  )

  const dirty = mode !== run.mode || !sameLayout(draft, run.layout)
  const isReference = sameLayout(draft, REFERENCE_LAYOUT)
  const bytesDelta = deltas.find((d) => d.key === 'bytesScanned')
  const wonDashboard = run.mode === 'dashboard' && student.metrics.bytesScanned <= reference.metrics.bytesScanned

  useEffect(() => {
    recordSimTask('warehouse', `trace-${run.mode}`)
  }, [run.mode, recordSimTask])

  useEffect(() => {
    /* The completion hook. Bytes scanned is the metric the dashboard workload is
     * billed for, so that is what is graded — a reader who optimises pruning
     * while their scan bill rises has not solved the problem. */
    if (wonDashboard) recordSimTask('warehouse', 'dashboard-beats-reference')
  }, [wonDashboard, recordSimTask])

  useEffect(() => {
    const id = window.setTimeout(() => setSimConfig('warehouse', { mode: run.mode, layout: run.layout }), 400)
    return () => window.clearTimeout(id)
  }, [run, setSimConfig])

  const patch = (p: Partial<Layout>) => setDraft((d) => ({ ...d, ...p }))
  const setEncoding = (id: ColumnId, enc: EncodingId) =>
    setDraft((d) => ({ ...d, encodings: { ...d.encodings, [id]: enc } }))

  const maxQueryBytes = Math.max(1, ...student.queries.map((q) => q.bytesScanned))

  return (
    <div className="mx-auto max-w-app px-6 pb-24 pt-24 lg:px-12">
      <p className="font-mono text-label uppercase tracking-[0.16em] text-text-3">the persistent world</p>
      <h1 className="mt-3 font-display text-h1 font-semibold text-text-1">The Warehouse</h1>
      <p className="mt-3 max-w-prose text-body text-text-2">{sim?.hook}</p>
      <p className="mt-3 max-w-prose text-body-sm text-text-3">
        {fmtCount(TABLE_ROWS)} rows, {COLUMNS.length} columns, one physical order. Describe the layout, run a
        trace, read the counts — beside the reference layout's counts on the same trace. No wall clock
        anywhere: every number is a count, so your run and the reference's are comparable, and both are
        reproducible from the seed.
      </p>

      {/* ------------------------------ trace mode ----------------------------- */}
      <section className="mt-10">
        <h2 className="font-mono text-label uppercase tracking-wide text-text-3">1 · the trace</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {TRACE_MODES.map((t) => (
            <button
              key={t.id}
              onClick={() => setMode(t.id)}
              className={cn(
                'rounded-lg border px-5 py-4 text-left transition-colors',
                mode === t.id
                  ? 'border-accent/60 bg-accent/5'
                  : 'border-line bg-surface-1 hover:border-line-bright',
              )}
            >
              <p
                className={cn(
                  'font-mono text-[11px] uppercase tracking-wide',
                  mode === t.id ? 'text-accent' : 'text-text-1',
                )}
              >
                {t.name}
              </p>
              <p className="mt-1.5 text-body-sm text-text-2">{t.line}</p>
            </button>
          ))}
        </div>
      </section>

      {/* -------------------------------- layout ------------------------------- */}
      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-mono text-label uppercase tracking-wide text-text-3">2 · the layout</h2>
          <button
            onClick={() => setDraft(cloneLayout(REFERENCE_LAYOUT))}
            disabled={isReference}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-1 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-text-2 transition-colors hover:text-text-1',
              isReference && 'pointer-events-none opacity-40',
            )}
          >
            <RotateCcw className="h-3.5 w-3.5" /> reset to reference
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="space-y-4 rounded-lg border border-line bg-surface-1 px-5 py-4">
            <Field label="partition key" hint={PARTITION_KEYS.find((p) => p.id === draft.partitionKey)?.line}>
              <Select
                value={draft.partitionKey}
                onChange={(v) => patch({ partitionKey: v as PartitionKeyId })}
                options={PARTITION_KEYS.map((p) => ({ value: p.id, label: p.label }))}
              />
            </Field>

            <Field
              label="sort key"
              hint="The physical order inside each partition. Statistics can only prune on this column — a table has exactly one order, so name the predicate you are starving."
            >
              <Select
                value={draft.sortKey}
                onChange={(v) => patch({ sortKey: v as Layout['sortKey'] })}
                options={[
                  { value: 'none', label: 'none (insertion order)' },
                  ...COLUMN_IDS.map((c) => ({ value: c, label: c })),
                ]}
              />
            </Field>

            <Field
              label={`clustering ${draft.clustering.toFixed(2)}`}
              hint="How well physical order actually matches the sort key. 1.00 = tight, disjoint row-group ranges; 0.00 = every group spans the domain and statistics prune nothing. Production tables drift downward on their own."
            >
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draft.clustering}
                onChange={(e) => patch({ clustering: Number(e.target.value) })}
                className="w-full accent-accent"
                aria-label="clustering"
              />
            </Field>
          </div>

          <div className="space-y-4 rounded-lg border border-line bg-surface-1 px-5 py-4">
            <Field label="row group" hint="The granularity min/max statistics can prune at. Smaller prunes finer; the metadata to describe it grows.">
              <Select
                value={String(draft.rowGroupRows)}
                onChange={(v) => patch({ rowGroupRows: Number(v) })}
                options={ROW_GROUP_OPTIONS.map((n) => ({ value: String(n), label: fmtRows(n) }))}
              />
            </Field>

            <Field label="target file" hint="Rows per file. Every candidate file's footer is read to prune it at all, so file count is a scan cost, not just a planning one.">
              <Select
                value={String(draft.fileRows)}
                onChange={(v) => patch({ fileRows: Number(v) })}
                options={FILE_OPTIONS.map((n) => ({ value: String(n), label: fmtRows(n) }))}
              />
            </Field>

            <Field
              label={draft.compactEvery === 0 ? 'compaction: never' : `compaction: every ${draft.compactEvery} commits`}
              hint="Merge-on-read only: appends, updates and deletes add files that every later read must open. Compaction pays that down by rewriting bytes — write amplification is the price, and it is counted below."
            >
              <input
                type="range"
                min={0}
                max={12}
                step={1}
                value={draft.compactEvery}
                onChange={(e) => patch({ compactEvery: Number(e.target.value) })}
                className="w-full accent-accent"
                aria-label="compaction cadence"
              />
            </Field>
          </div>
        </div>

        {/* encodings */}
        <div className="mt-4 rounded-lg border border-line bg-surface-1 px-5 py-4">
          <p className="font-mono text-[11px] uppercase tracking-wide text-text-1">encodings</p>
          <p className="mt-1 max-w-prose text-body-sm text-text-3">
            One choice per column. The model prices losses as carefully as wins: run-length on unclustered
            data expands, a dictionary on a nearly-unique column costs more than it saves.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {COLUMNS.map((c) => {
              const cost = student.columns.find((x) => x.id === c.id)
              const committed = run.layout.encodings[c.id] === draft.encodings[c.id]
              return (
                <div key={c.id} className="space-y-1.5">
                  <p className="font-mono text-[11px] text-text-1">
                    {c.id} <span className="text-text-3">· {c.width}B · {fmtCount(c.cardinality)} distinct</span>
                  </p>
                  <Select
                    value={draft.encodings[c.id]}
                    onChange={(v) => setEncoding(c.id, v as EncodingId)}
                    options={ENCODINGS.map((e) => ({ value: e.id, label: e.label }))}
                  />
                  <p className="font-mono text-[10px] text-text-3">
                    {committed && cost ? (
                      <span className={cn(cost.ratio < 1 && 'text-danger')}>
                        {fmtRatio(cost.ratio)} · {cost.bytesPerRow.toFixed(2)} B/row
                      </span>
                    ) : (
                      <span className="text-text-3/60">not run</span>
                    )}
                  </p>
                </div>
              )
            })}
          </div>
          <p className="mt-4 border-t border-line pt-3 font-mono text-[10px] leading-relaxed text-text-3">
            {ENCODINGS.map((e) => `${e.label}: ${e.line}`).join('  ·  ')}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={() => setRun({ mode, layout: cloneLayout(draft) })}
            disabled={!dirty}
            className={cn(
              'inline-flex items-center gap-2 rounded-md border border-accent/60 bg-accent/10 px-4 py-2 font-mono text-[12px] uppercase tracking-wide text-accent transition-colors hover:bg-accent/20',
              !dirty && 'pointer-events-none opacity-40',
            )}
          >
            <Play className="h-4 w-4" /> run the trace
          </button>
          <p className="font-mono text-[11px] text-text-3">
            {dirty
              ? 'unrun changes — the counts below still belong to the previous layout'
              : `showing ${run.mode} · ${trace.queries.length} queries · seed 0x${trace.seed.toString(16).toUpperCase()}`}
          </p>
        </div>
      </section>

      {/* ------------------------------- the counts ----------------------------- */}
      <section className="mt-10">
        <h2 className="font-mono text-label uppercase tracking-wide text-text-3">3 · the counts</h2>
        <p className="mt-2 max-w-prose text-body-sm text-text-3">
          Yours against the reference layout, on the identical trace. Both runs share the same query list, so
          any divergence is attributable to the layout and nothing else.
        </p>

        <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface-1">
          <table className="w-full min-w-[640px] text-left">
            <thead>
              <tr className="border-b border-line font-mono text-[10px] uppercase tracking-wide text-text-3">
                <th className="px-5 py-3 font-normal">metric</th>
                <th className="px-5 py-3 text-right font-normal">yours</th>
                <th className="px-5 py-3 text-right font-normal">reference</th>
                <th className="px-5 py-3 text-right font-normal">divergence</th>
              </tr>
            </thead>
            <tbody>
              {METRIC_META.map((m) => {
                const d = deltas.find((x) => x.key === m.key)
                if (!d) return null
                const rel = d.relative
                return (
                  <tr key={m.key} className="border-b border-line/60 last:border-0">
                    <td className="px-5 py-3">
                      <div className="flex items-start gap-3">
                        <m.icon className="mt-0.5 h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} />
                        <div>
                          <p className="font-mono text-[12px] uppercase tracking-wide text-text-1">{m.name}</p>
                          <p className="mt-0.5 max-w-prose text-body-sm text-text-2">{m.line}</p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-[13px] text-text-1">
                      {m.fmt(d.student)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-[13px] text-text-3">
                      {m.fmt(d.reference)}
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap px-5 py-3 text-right font-mono text-[13px]',
                        d.delta === 0 ? 'text-text-3' : d.better ? 'text-accent' : 'text-danger',
                      )}
                    >
                      {d.delta === 0 ? 'tie' : `${rel > 0 ? '+' : '−'}${(Math.abs(rel) * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* the counts that need a second number to mean anything */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="read amplification"
            value={`${student.detail.readAmplification.toFixed(2)}×`}
            line="Bytes read ÷ bytes the answers needed. A floor, not a ceiling: predicate independence is assumed."
          />
          <Stat
            label="metadata bytes"
            value={fmtBytes(student.detail.metadataBytes)}
            line={`Footers and delete files inside the scan total. ${fmtCount(student.detail.smallFilesOpen)} uncompacted files and ${fmtCount(student.detail.deleteFilesOpen)} delete files open at the end.`}
          />
          <Stat
            label="shuffle max ÷ mean"
            value={student.detail.shuffleSkew === 0 ? 'no exchange' : `${student.detail.shuffleSkew.toFixed(2)}×`}
            line={`Busiest of ${SHUFFLE_BUCKETS} buckets: ${fmtBytes(student.detail.shuffleMaxBytes)} against a ${fmtBytes(student.detail.shuffleMeanBytes)} mean. The largest bucket is the runtime.`}
          />
          <Stat
            label="bytes rewritten"
            value={fmtBytes(student.detail.bytesRewritten)}
            line="What compaction cost to buy that read amplification. Zero here means either no writes or no policy."
          />
        </div>
      </section>

      {/* ------------------------------ the trace ------------------------------- */}
      <section className="mt-10">
        <h2 className="font-mono text-label uppercase tracking-wide text-text-3">4 · query by query</h2>
        <p className="mt-2 max-w-prose text-body-sm text-text-3">
          The whole trace, in order. Bars are scaled to the most expensive query in this run — the shape is
          the workload's signature, and it is the same shape for every reader.
        </p>
        <div className="mt-4 max-h-96 overflow-y-auto rounded-lg border border-line bg-ink px-4 py-3">
          <div className="space-y-1">
            {student.queries.map((q) => (
              <div key={q.id} className="flex items-center gap-3 font-mono text-[10.5px]">
                <span className="w-6 shrink-0 text-right text-text-3/60">{q.id}</span>
                <span
                  className={cn(
                    'w-40 shrink-0 truncate',
                    q.kind === 'scan' ? 'text-text-2' : 'text-amber/80',
                  )}
                >
                  {q.label}
                </span>
                <span className="h-1.5 w-full min-w-8 rounded bg-line/60">
                  <span
                    className="block h-1.5 rounded bg-accent/70"
                    style={{ width: `${Math.max(q.bytesScanned > 0 ? 1 : 0, (q.bytesScanned / maxQueryBytes) * 100)}%` }}
                  />
                </span>
                <span className="w-24 shrink-0 text-right text-text-3">
                  {q.kind === 'scan' ? fmtBytes(q.bytesScanned) : q.kind}
                </span>
                <span className="hidden w-28 shrink-0 text-right text-text-3/70 sm:block">
                  {q.kind === 'scan' ? `${fmtCount(q.rowGroupsRead)} groups` : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------- the verdict ------------------------------- */}
      <section
        className={cn(
          'mt-10 rounded-lg border px-6 py-6',
          run.mode !== 'dashboard'
            ? 'border-line bg-surface-1'
            : wonDashboard
              ? 'border-accent/40 bg-accent/5'
              : 'border-amber/40 bg-amber/5',
        )}
      >
        {run.mode !== 'dashboard' ? (
          <>
            <p className="font-mono text-label uppercase tracking-wide text-text-3">the task</p>
            <p className="mt-2 max-w-prose text-body-sm text-text-2">
              Completion is graded on the <span className="font-mono text-text-1">dashboard</span> trace: match
              or beat the reference layout's bytes scanned. The other three traces are here to be lost — run
              them to find out which decision each one punishes, then come back.
            </p>
          </>
        ) : wonDashboard ? (
          <>
            <p className="font-mono text-label uppercase tracking-wide text-accent">
              dashboard trace · reference matched or beaten
            </p>
            <p className="mt-2 max-w-prose text-body-sm text-text-2">
              {fmtBytes(student.metrics.bytesScanned)} scanned against the reference's{' '}
              {fmtBytes(reference.metrics.bytesScanned)}
              {bytesDelta && bytesDelta.delta < 0
                ? ` — ${(Math.abs(bytesDelta.relative) * 100).toFixed(1)}% less.`
                : ' — a tie, which means you reconstructed the reasoning.'}{' '}
              Now switch to <span className="font-mono text-text-1">the analyst</span> and watch the same
              layout lose.
            </p>
          </>
        ) : (
          <>
            <p className="font-mono text-label uppercase tracking-wide text-amber">
              dashboard trace · behind the reference
            </p>
            <p className="mt-2 max-w-prose text-body-sm text-text-2">
              {fmtBytes(student.metrics.bytesScanned)} scanned against the reference's{' '}
              {fmtBytes(reference.metrics.bytesScanned)}. Three levers, in order of size: project fewer
              columns (you cannot — the trace decides), prune more row groups (partition and sort key), and
              store fewer bytes per row (encodings). The reference leaves real wins on the table in the third.
            </p>
          </>
        )}
      </section>

      <div className="mt-10 flex flex-wrap items-center gap-4 rounded-lg border border-dashed border-line bg-surface-1 px-6 py-5">
        <p className="min-w-0 flex-1 text-body-sm text-text-2">
          This is v0: a model, not an engine — no data, no reader, no wall clock. The empirical half lives in
          the DuckDB labs, where the same claims are put to a real Parquet file and can come out against the
          lesson.
        </p>
        <Link
          to="/curriculum"
          className="font-mono text-[11px] uppercase tracking-wide text-text-2 underline decoration-dotted hover:text-text-1"
        >
          back to the curriculum
        </Link>
      </div>
    </div>
  )
}

/* ------------------------------- components ------------------------------- */

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-wide text-text-1">{label}</p>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1.5 text-body-sm text-text-3">{hint}</p>}
    </div>
  )
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-line bg-ink px-2.5 py-1.5 font-mono text-[12px] text-text-1 focus:border-accent/60 focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function Stat({ label, value, line }: { label: string; value: string; line: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-1 px-5 py-4">
      <p className="font-mono text-[10px] uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-1 font-mono text-h4 text-text-1">{value}</p>
      <p className="mt-1.5 text-body-sm text-text-3">{line}</p>
    </div>
  )
}
