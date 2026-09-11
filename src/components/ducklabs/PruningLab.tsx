/**
 * PruningLab — the three dials that decide what a scan is allowed to skip.
 *
 * C0.L4 told the reader that pruning is a property of physical order rather than
 * of the format, and quoted 39.8× for a shuffle. C2 fronts this lab because the
 * claim needs to be turned into a dial the reader can move, and because the
 * sharpest version of it is not the shuffle at all — it is the WRONG COLUMN.
 *
 * The shuffle case is easy to file away as "so keep the loader sorted". The wrong
 * column is not escapable: the file below is perfectly clustered, freshly
 * written, statistics complete, and a predicate on `customer_id` prunes nothing
 * whatsoever at a selectivity where the same file's `order_ts` predicate prunes
 * 96.8%. Nothing is misconfigured. A table has one physical order, and every
 * predicate that does not name it pays full price. The mirror file — the same
 * rows in customer order — proves the trade is symmetric rather than a property
 * of timestamps.
 *
 * Three design decisions carry the pedagogy:
 *
 *   · The row-group sweep reports COUNTS of metadata (row groups, statistics
 *     entries, footer bytes) beside the pruning percentage. A lab that showed
 *     only the percentage would teach "smaller is better", which is false at the
 *     bottom of the dial and is where the two-year row goes backwards.
 *   · The wrong-column predicate is built to the SAME selectivity as the
 *     timestamp window it is paired with, so nothing but the column name differs.
 *   · Every configuration is audited for false negatives — matching rows sitting
 *     in a skipped block — because that is the one number in this lab that is a
 *     correctness claim rather than a cost claim. Over-reading is a bill;
 *     under-reading is a silently wrong answer.
 *
 * Tasks grade what the reader observes, not what they click through.
 */

import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Play, ShieldCheck, Table2 } from 'lucide-react'
import { DuckLabShell, type DuckTask } from '@/components/ducklabs/shell'
import { fmtBytes, fmtFactor } from '@/lib/duckdb/bill'
import {
  CUSTOMER_CLUSTERED,
  PRUNING_ROWS,
  PRUNING_SPAN_SECONDS,
  PROJECTION,
  REFERENCE_FILE_ID,
  REFERENCE_WINDOW_ID,
  ROW_GROUP_VARIANTS,
  WINDOWS,
  cellKey,
  customerPredicate,
  fmtCount,
  fmtPercent,
  fmtSelectivity,
  loadPruningFixtures,
  measureAll,
  pruningConfigurations,
  tsPredicate,
  type PruningGrid,
} from '@/lib/duckdb/pruning'
import { cn } from '@/lib/utils'

/** How many measurements a complete run produces. Pure — safe at module scope. */
const CONFIG_COUNT = pruningConfigurations().length

const SPAN_DAYS = Math.round(PRUNING_SPAN_SECONDS / 86_400)

const COARSEST = ROW_GROUP_VARIANTS[0]
const FINEST = ROW_GROUP_VARIANTS[ROW_GROUP_VARIANTS.length - 1]
const NEXT_FINEST = ROW_GROUP_VARIANTS[ROW_GROUP_VARIANTS.length - 2]

const WIDEST_WINDOW = WINDOWS[WINDOWS.length - 1]

export default function PruningLab({ trackColor }: { trackColor: string }) {
  const [status, setStatus] = useState<string>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [grid, setGrid] = useState<PruningGrid>({})
  /** Which window the row-group sweep is shown at. Switching costs no re-run. */
  const [sweepWindow, setSweepWindow] = useState<string>(REFERENCE_WINDOW_ID)

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await loadPruningFixtures((s) => setStatus(s))
      setGrid(await measureAll((s) => setStatus(s)))
      setStatus('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('failed')
    } finally {
      setBusy(false)
    }
  }, [])

  const measured = Object.keys(grid).length === CONFIG_COUNT
  const at = useCallback(
    (fileId: string, windowId: string, column: 'order_ts' | 'customer_id') =>
      grid[cellKey(fileId, windowId, column)],
    [grid],
  )

  /* The row-group sweep, at whichever window is selected. */
  const sweep = useMemo(
    () =>
      ROW_GROUP_VARIANTS.map((f) => ({ file: f, m: at(f.id, sweepWindow, 'order_ts') })),
    [at, sweepWindow],
  )

  /* The 2×2 that is the lesson: two physical orders × two predicate columns. */
  const matrix = useMemo(
    () => [
      {
        order: 'order_ts',
        column: 'order_ts' as const,
        m: at(REFERENCE_FILE_ID, REFERENCE_WINDOW_ID, 'order_ts'),
        note: 'The predicate names the sort key. Each row group covers a narrow slice of history, so all but a couple are provably impossible.',
      },
      {
        order: 'order_ts',
        column: 'customer_id' as const,
        m: at(REFERENCE_FILE_ID, REFERENCE_WINDOW_ID, 'customer_id'),
        note: 'The same file, the same number of matching rows, a different column. Every row group holds customers from across the whole domain, so no range can be excluded. This is the row that matters.',
      },
      {
        order: 'customer_id',
        column: 'order_ts' as const,
        m: at(CUSTOMER_CLUSTERED.id, REFERENCE_WINDOW_ID, 'order_ts'),
        note: 'Byte-identical rows written in customer order. The timestamp predicate that pruned 96% above now prunes nothing — the layout moved, the query did not.',
      },
      {
        order: 'customer_id',
        column: 'customer_id' as const,
        m: at(CUSTOMER_CLUSTERED.id, REFERENCE_WINDOW_ID, 'customer_id'),
        note: 'And the mirror completes: the starved predicate is now the served one. The trade is symmetric, which is what makes it a design decision rather than a bug.',
      },
    ],
    [at],
  )

  /* Selectivity, on the matching column, at the reference row-group size. */
  const selectivity = useMemo(
    () => WINDOWS.map((w) => ({ window: w, m: at(REFERENCE_FILE_ID, w.id, 'order_ts') })),
    [at],
  )

  const all = useMemo(() => Object.values(grid), [grid])
  const audited = all.filter((m) => m.auditRan)
  const falseNegatives = audited.reduce((n, m) => n + m.falseNegativeRows, 0)
  const rowsChecked = audited.reduce((n, m) => n + m.matchingRows, 0)
  const anomalies = all.filter((m) => m.anomaly !== null)

  const refTs = at(REFERENCE_FILE_ID, REFERENCE_WINDOW_ID, 'order_ts')
  const refCust = at(REFERENCE_FILE_ID, REFERENCE_WINDOW_ID, 'customer_id')
  const mirrorTs = at(CUSTOMER_CLUSTERED.id, REFERENCE_WINDOW_ID, 'order_ts')
  const mirrorCust = at(CUSTOMER_CLUSTERED.id, REFERENCE_WINDOW_ID, 'customer_id')
  const coarse7 = at(COARSEST.id, REFERENCE_WINDOW_ID, 'order_ts')
  const fine7 = at(FINEST.id, REFERENCE_WINDOW_ID, 'order_ts')
  const nextFine7 = at(NEXT_FINEST.id, REFERENCE_WINDOW_ID, 'order_ts')
  const coarseWide = at(COARSEST.id, WIDEST_WINDOW.id, 'order_ts')
  const fineWide = at(FINEST.id, WIDEST_WINDOW.id, 'order_ts')

  const selectivityFalls =
    selectivity.every((s) => !!s.m) &&
    selectivity.every((s, i) => i === 0 || s.m!.pruningRatio <= selectivity[i - 1].m!.pruningRatio) &&
    selectivity[selectivity.length - 1].m!.pruningRatio === 0

  const tasks: DuckTask[] = useMemo(
    () => [
      {
        id: 'run',
        label: `Write the six fixtures and measure all ${CONFIG_COUNT} configurations`,
        done: measured,
        hint: `Press run. ${fmtCount(PRUNING_ROWS)} rows become six real Parquet files, then every count below is read out of their footers.`,
      },
      {
        id: 'finer',
        label: `Observe pruning on the sort key climb from at most 60% at ${COARSEST.label} to at least 98% at ${FINEST.label}`,
        done: !!coarse7 && !!fine7 && coarse7.pruningRatio <= 0.6 && fine7.pruningRatio >= 0.98,
        hint: 'Two row groups cannot skip more than one of themselves, whatever the predicate says. Resolution is a ceiling.',
      },
      {
        id: 'metadata',
        label: `Observe the last refinement multiplying statistics entries by at least 3× while adding under 5 points of pruning`,
        done:
          !!fine7 &&
          !!nextFine7 &&
          fine7.statsEntries / Math.max(nextFine7.statsEntries, 1) >= 3 &&
          fine7.pruningRatio - nextFine7.pruningRatio < 0.05,
        hint: `Compare the ${NEXT_FINEST.label} and ${FINEST.label} rows on the metadata columns, not the pruning column. This is where the dial stops paying.`,
      },
      {
        id: 'wrong-column',
        label:
          'Observe a same-selectivity predicate on customer_id pruning at most 5% of the SAME file that prunes at least 90% on order_ts',
        done:
          !!refTs &&
          !!refCust &&
          refTs.pruningRatio >= 0.9 &&
          refCust.pruningRatio <= 0.05,
        hint: 'Same file, same row groups, same statistics, near-identical matching row count. If this surprises you, the lesson landed.',
      },
      {
        id: 'one-order',
        label:
          'Observe the mirror: written in customer order, the same file prunes the customer predicate and starves the timestamp one',
        done:
          !!mirrorCust &&
          !!mirrorTs &&
          mirrorCust.pruningRatio >= 0.9 &&
          mirrorTs.pruningRatio <= 0.05,
        hint: 'Neither column is privileged by the format. A table has one physical order, and that order picks a winner.',
      },
      {
        id: 'selectivity',
        label: `Observe pruning fall as the window widens, reaching 0% once the window covers the whole ${SPAN_DAYS}-day history`,
        done: selectivityFalls,
        hint: 'A predicate that excludes nothing cannot exclude any block. No layout fixes an unselective query.',
      },
      {
        id: 'losing-edge',
        label: `Observe that at the ${WIDEST_WINDOW.label} window the ${FINEST.label} file reads MORE bytes than the ${COARSEST.label} one`,
        done: !!coarseWide && !!fineWide && fineWide.bytesRead > coarseWide.bytesRead,
        hint: 'Switch the sweep to the widest window. When nothing prunes, finer row groups are pure overhead — smaller pages, more page headers, more footer.',
      },
      {
        id: 'no-false-negatives',
        label: `Observe 0 false negatives across every audited configuration`,
        done: audited.length > 0 && falseNegatives === 0,
        hint: 'Every configuration counts matching rows per row group and checks none of them sat in a block that was skipped. This is the one number here that is correctness, not cost.',
      },
    ],
    [
      measured,
      coarse7,
      fine7,
      nextFine7,
      refTs,
      refCust,
      mirrorTs,
      mirrorCust,
      coarseWide,
      fineWide,
      selectivityFalls,
      audited.length,
      falseNegatives,
    ],
  )

  return (
    <DuckLabShell labId="pruning-lab" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        This runs <strong>DuckDB</strong> in this tab over {fmtCount(PRUNING_ROWS)} rows and writes{' '}
        <strong>six</strong> real Parquet files: the same table at five row-group sizes in timestamp
        order, plus one copy written in customer order. Every count below —{' '}
        row groups skipped, statistics entries, footer bytes, bytes read — comes out of those files’
        own footers, which are the same min/max pairs the planner reads before it decides what to
        skip.
      </p>

      <div className="mt-4 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
          what these numbers are, and are not
        </p>
        <ul className="mt-2 space-y-1.5 text-body-sm text-text-3">
          <li>
            · The first run downloads the engine (~33 MB) from a CDN. Code comes down; queries and
            data stay in this tab.
          </li>
          <li>
            · These are <strong>Snappy-compressed Parquet files written by DuckDB’s writer at
            reduced scale</strong> — {fmtCount(PRUNING_ROWS)} rows over {SPAN_DAYS} days of history,
            against the lesson’s two billion. The <em>ratios</em> transfer because ratios are
            scale-free; the absolute byte counts are about four thousandths of the lesson’s.
          </li>
          <li>
            · The bill is <strong>the planner’s bill, not a syscall trace</strong>. It is{' '}
            <span className="font-mono text-[11.5px]">SUM(total_compressed_size)</span> over the
            chunks of the projected columns in the row groups whose statistics cannot rule them out —
            computed the way the planner computes it, from the same footer. A real engine reads a
            little more (page headers, the footer itself, read-ahead) and occasionally a little less
            (dictionary-only pages, late materialization).
          </li>
          <li>
            · <strong>{FINEST.label} is DuckDB’s floor, not a recommendation.</strong> Production
            row groups are 100k–1M rows. That size is in the sweep to show where refinement stops
            paying, and the widest window shows it going actively negative.
          </li>
          <li>
            · Anything that comes out <strong>against</strong> the story above is printed in the
            anomalies panel at the bottom rather than dropped — including the false-negative audit
            failing to run at all.
          </li>
        </ul>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className={cn(
            'inline-flex items-center gap-2 rounded-md border px-4 py-2 font-mono text-[12px] uppercase tracking-wide transition-colors',
            busy
              ? 'cursor-wait border-line text-text-3'
              : 'border-accent/60 bg-accent/10 text-accent hover:bg-accent/20',
          )}
        >
          <Play size={13} />
          {busy ? 'running' : measured ? 'run again' : 'run the lab'}
        </button>
        <span className="font-mono text-[11px] text-text-3">{status}</span>
        {audited.length > 0 && (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-[11px]"
            style={{ color: falseNegatives === 0 ? trackColor : '#FB7185' }}
          >
            <ShieldCheck size={12} />
            {falseNegatives} false negatives in {audited.length} audited configurations
          </span>
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-rose-400/40 px-4 py-3">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-rose-400" />
          <div>
            <p className="font-mono text-[11px] uppercase text-rose-400">the lab failed</p>
            <p className="mt-1 text-body-sm text-text-2">{error}</p>
            <p className="mt-1 text-body-sm text-text-3">
              Most likely the engine download was blocked. The reasoning still works on paper: divide
              the window by the history to get the fraction of blocks that can possibly match, and
              then ask whether the physical order puts those rows next to each other.
            </p>
          </div>
        </div>
      )}

      {!measured && !busy && (
        <div className="mt-6 flex items-center gap-2 rounded-md border border-dashed border-line px-4 py-6 text-text-3">
          <Table2 size={15} />
          <span className="font-mono text-[11px]">no measurements yet — run the lab</span>
        </div>
      )}

      {measured && (
        <div className="mt-6 space-y-8">
          {/* ---------------------------- dial 1: resolution ---------------------------- */}
          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  dial 1 — rows per row group
                </p>
                <p className="mt-1 max-w-2xl text-body-sm text-text-3">
                  Identical rows, identical order, identical codec. Only the size of the summarised
                  block differs. The predicate is a trailing window on{' '}
                  <span className="font-mono text-[11.5px]">order_ts</span>, the column the file is
                  clustered on — so this panel is pruning at its best, and the interesting columns
                  are the metadata ones.
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {WINDOWS.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setSweepWindow(w.id)}
                    aria-pressed={sweepWindow === w.id}
                    className={cn(
                      'rounded-sm border px-2 py-0.5 font-mono text-[10.5px] transition-colors',
                      sweepWindow === w.id
                        ? 'border-accent/60 bg-accent/10 text-accent'
                        : 'border-line text-text-3 hover:border-text-3 hover:text-text-2',
                    )}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {[
                      'rows/group',
                      'row groups',
                      'stats entries',
                      'footer',
                      'groups read',
                      'pruned',
                      'bytes read',
                      'vs coarsest',
                    ].map((h) => (
                      <th
                        key={h}
                        className="py-2 pr-4 font-mono text-[10px] uppercase tracking-wide text-text-3"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sweep.map(({ file, m }) => {
                    const base = sweep[0].m
                    if (!m) return null
                    const factor = base ? base.bytesRead / Math.max(m.bytesRead, 1) : 1
                    return (
                      <tr key={file.id} className="border-b border-line/60 align-top">
                        <td className="py-3 pr-4">
                          <p className="font-mono text-[12px] text-text-1">
                            {fmtCount(m.groupRows)}
                          </p>
                          <p className="mt-1 max-w-sm text-body-sm text-text-3">{file.why}</p>
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.rowGroups)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.statsEntries)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {m.footerBytes === null ? '—' : fmtBytes(m.footerBytes)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.rowGroupsRead)}/{fmtCount(m.rowGroups)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                          {fmtPercent(m.pruningRatio)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                          {fmtBytes(m.bytesRead)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: trackColor }}>
                          {file.id === sweep[0].file.id ? '—' : fmtFactor(factor)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {fine7 && nextFine7 && coarse7 && (
              <div className="mt-4 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  where the dial stops paying
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  At the {WINDOWS.find((w) => w.id === REFERENCE_WINDOW_ID)!.label} window, going
                  from {fmtCount(COARSEST.rowGroupSize)} to {fmtCount(NEXT_FINEST.rowGroupSize)} rows
                  per group took pruning from {fmtPercent(coarse7.pruningRatio)} to{' '}
                  {fmtPercent(nextFine7.pruningRatio)} — worth{' '}
                  {fmtFactor(coarse7.bytesRead / Math.max(nextFine7.bytesRead, 1))} in bytes. The
                  next step, to {fmtCount(FINEST.rowGroupSize)}, multiplies statistics entries by{' '}
                  {fmtFactor(fine7.statsEntries / Math.max(nextFine7.statsEntries, 1))}
                  {fine7.footerBytes !== null && nextFine7.footerBytes !== null && (
                    <>
                      {' '}
                      and the footer from {fmtBytes(nextFine7.footerBytes)} to{' '}
                      {fmtBytes(fine7.footerBytes)}
                    </>
                  )}{' '}
                  and buys{' '}
                  {((fine7.pruningRatio - nextFine7.pruningRatio) * 100).toFixed(2)} more points of
                  pruning. The metadata is not free and it is not skippable: the planner reads the
                  whole footer before it can skip a single byte of data.
                </p>
              </div>
            )}
          </section>

          {/* ------------------------- dial 2: which column ---------------------------- */}
          <section>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              dial 2 — which column the predicate names
            </p>
            <p className="mt-1 max-w-2xl text-body-sm text-text-3">
              Two physical orders × two predicate columns, at {fmtCount(NEXT_FINEST.rowGroupSize)}{' '}
              rows per group. The two predicates are built to the same selectivity, so the matching
              row counts agree to within a fraction of a percent and the only thing that differs is
              which column is named. Both columns are projected in every row, so the byte counts are
              not measuring type width either.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {[
                      'written in order of',
                      'predicate on',
                      'rows matched',
                      'groups with a match',
                      'groups read',
                      'pruned',
                      'bytes read',
                    ].map((h) => (
                      <th
                        key={h}
                        className="py-2 pr-4 font-mono text-[10px] uppercase tracking-wide text-text-3"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.map(({ order, column, m, note }) => {
                    if (!m) return null
                    const served = order === column
                    return (
                      <tr key={`${order}|${column}`} className="border-b border-line/60 align-top">
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">{order}</td>
                        <td className="py-3 pr-4">
                          <p className="font-mono text-[12px] text-text-1">{column}</p>
                          <p className="mt-1 max-w-sm text-body-sm text-text-3">{note}</p>
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.matchingRows)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {m.auditRan ? `${fmtCount(m.groupsWithMatches)}/${fmtCount(m.rowGroups)}` : '—'}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.rowGroupsRead)}/{fmtCount(m.rowGroups)}
                        </td>
                        <td
                          className="py-3 pr-4 font-mono text-[12px]"
                          style={{ color: served ? trackColor : '#FB7185' }}
                        >
                          {fmtPercent(m.pruningRatio)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                          {fmtBytes(m.bytesRead)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {refTs && refCust && mirrorCust && (
              <div className="mt-4 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  the claim under test
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  One file. {fmtCount(refTs.rowGroups)} row groups, complete statistics on every
                  column, freshly written, nothing shuffled and nothing misconfigured. The{' '}
                  <span className="font-mono text-[11.5px]">order_ts</span> predicate matches{' '}
                  {fmtCount(refTs.matchingRows)} rows and skips{' '}
                  <strong>{fmtPercent(refTs.pruningRatio)}</strong> of the blocks. The{' '}
                  <span className="font-mono text-[11.5px]">customer_id</span> predicate matches{' '}
                  {fmtCount(refCust.matchingRows)} rows — the same needle — and skips{' '}
                  <strong>{fmtPercent(refCust.pruningRatio)}</strong>, reading{' '}
                  {fmtFactor(refCust.bytesRead / Math.max(refTs.bytesRead, 1))} more bytes to find
                  it.
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  Look at the <span className="font-mono text-[11.5px]">groups with a match</span>{' '}
                  column before you call the second row a failure, because it says something more
                  uncomfortable than “the statistics were useless”.{' '}
                  {refCust.auditRan && refCust.groupsWithMatches === refCust.rowGroups
                    ? `All ${fmtCount(refCust.rowGroups)} row groups contain at least one matching customer.`
                    : `${fmtCount(refCust.groupsWithMatches)} of ${fmtCount(refCust.rowGroups)} row groups contain at least one matching customer.`}{' '}
                  So there is nothing for a min/max pair to exclude: the statistics are correct, they
                  are complete, and the pruning decision is <em>optimal</em>. The needle is simply
                  smeared across every block, which is what an uncorrelated column means physically.
                  That is why no amount of statistics tuning fixes this row and why the fix is always
                  a layout change — a different sort key, a partition, a secondary index, or an
                  accepted bill. The waste is therefore invisible per group and obvious per row:{' '}
                  {refCust.matchingRows > 0 && refTs.matchingRows > 0 && (
                    <>
                      {fmtCount(Math.round(refCust.bytesRead / refCust.matchingRows))} bytes read per
                      row returned, against{' '}
                      {fmtCount(Math.round(refTs.bytesRead / refTs.matchingRows))} on the served
                      predicate.
                    </>
                  )}
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  And the mirror file shows there is nothing special about timestamps: written in
                  customer order, the customer predicate prunes{' '}
                  {fmtPercent(mirrorCust.pruningRatio)} instead. A table has exactly one physical
                  order. Naming the predicate it starves is the whole design conversation.
                </p>
              </div>
            )}
          </section>

          {/* ------------------------- dial 3: selectivity ----------------------------- */}
          <section>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              dial 3 — how much of the table the predicate asks for
            </p>
            <p className="mt-1 max-w-2xl text-body-sm text-text-3">
              The matching column, at {fmtCount(NEXT_FINEST.rowGroupSize)} rows per group, with the
              window widened from a day to the whole history. Pruning is bounded by selectivity from
              above: you cannot skip a block the predicate might match.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {[
                      'window',
                      'of the table',
                      'rows matched',
                      'groups with a match',
                      'groups read',
                      'pruned',
                      'bytes read',
                    ].map((h) => (
                      <th
                        key={h}
                        className="py-2 pr-4 font-mono text-[10px] uppercase tracking-wide text-text-3"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectivity.map(({ window: w, m }) => {
                    if (!m) return null
                    return (
                      <tr key={w.id} className="border-b border-line/60 align-top">
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">{w.label}</td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtSelectivity(w.selectivity)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.matchingRows)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {m.auditRan ? fmtCount(m.groupsWithMatches) : '—'}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.rowGroupsRead)}/{fmtCount(m.rowGroups)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                          {fmtPercent(m.pruningRatio)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: trackColor }}>
                          {fmtBytes(m.bytesRead)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {coarseWide && fineWide && (
              <div className="mt-4 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  the other edge of dial 1
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  The last row prunes nothing on any layout, because a window covering the whole
                  history excludes no block. That is the case where dial 1 goes backwards: at the{' '}
                  {WIDEST_WINDOW.label} window the {FINEST.label} file reads{' '}
                  <strong>{fmtBytes(fineWide.bytesRead)}</strong> against the {COARSEST.label} file’s{' '}
                  <strong>{fmtBytes(coarseWide.bytesRead)}</strong> — smaller pages mean more page
                  headers and less for the codec to work with
                  {fineWide.footerBytes !== null && coarseWide.footerBytes !== null && (
                    <>
                      , and the footer it must parse first grows from{' '}
                      {fmtBytes(coarseWide.footerBytes)} to {fmtBytes(fineWide.footerBytes)}
                    </>
                  )}
                  . The penalty is small — {fmtPercent(fineWide.bytesRead / coarseWide.bytesRead - 1)}{' '}
                  on data bytes — and it is strictly a penalty. Fine row groups are a bet on
                  selective predicates. Price the bet before you place it: the unpredicated ad-hoc
                  scan pays it every time and gets nothing back.
                </p>
              </div>
            )}
          </section>

          {/* --------------------------- the invariant --------------------------------- */}
          <section>
            <div className="rounded-md border border-line bg-surface-2/50 px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                the invariant — {falseNegatives} false negatives in {audited.length} configurations
              </p>
              <p className="mt-2 text-body-sm text-text-2">
                Every configuration above was audited, not just costed. For each one the engine
                counted the matching rows in each row group with its own typed evaluation of the
                predicate — {fmtCount(rowsChecked)} matching rows across{' '}
                {fmtCount(audited.length)} configurations — and then checked that none of them sat in
                a block the statistics had ruled out.{' '}
                {falseNegatives === 0
                  ? 'None did.'
                  : `${fmtCount(falseNegatives)} did, which is a correctness bug and is reported as one below.`}{' '}
                That is the asymmetry worth taking out of this lab. The wrong-column row is
                expensive and <em>right</em>: it read every block, returned the correct answer, and
                over-reading is always available as the safe move. Skipping a block you could not
                prove impossible is cheap and <em>wrong</em>, with no error and a plausible number in
                a report. The rule that follows is one-directional: skip only what you can prove
                cannot match, and read anything you cannot speak to — a block with no statistics, a
                predicate wrapped in a function, a null whose comparison semantics differ from a
                value’s.
              </p>
              <p className="mt-2 text-body-sm text-text-3">
                The audit re-derives the surviving set in SQL and cross-checks its size against the
                TypeScript that produced the byte counts, so the two are not grading each other’s
                homework. A disagreement appears in the anomalies panel.
              </p>
            </div>
          </section>

          {/* ---------------------------- anomalies ----------------------------------- */}
          {anomalies.length > 0 && (
            <section>
              <div className="rounded-md border border-amber-400/40 px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-amber-400">
                  {anomalies.length} result{anomalies.length === 1 ? '' : 's'} that came out against
                  the expected story
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  These are printed rather than dropped. A lab that only ever confirms its author is
                  a demo.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {anomalies.map((m) => (
                    <li key={m.key} className="text-body-sm text-text-3">
                      <span className="font-mono text-[11.5px] text-text-2">
                        {m.fileId} · {m.windowId} · {m.predicateColumn}
                      </span>
                      <br />
                      {m.anomaly}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* ------------------------ the reproduction recipe -------------------------- */}
          <section>
            <div className="rounded-md border border-line px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                the two predicates, in full
              </p>
              <p className="mt-2 font-mono text-[11.5px] text-text-2">
                {tsPredicate(WINDOWS.find((w) => w.id === REFERENCE_WINDOW_ID)!).sql}
              </p>
              <p className="mt-1 font-mono text-[11.5px] text-text-2">
                {customerPredicate(WINDOWS.find((w) => w.id === REFERENCE_WINDOW_ID)!).sql}
              </p>
              <p className="mt-2 text-body-sm text-text-3">
                Projected columns:{' '}
                <span className="font-mono text-[11.5px]">{PROJECTION.join(', ')}</span>. The same
                SQL, the same fixture DDL and the same measurement functions run against native
                DuckDB in{' '}
                <span className="font-mono text-[11.5px]">tests/pruning-lab.test.ts</span>, which
                asserts the relationships in bands rather than the byte counts — and asserts the
                false-negative count as an absolute.
              </p>
            </div>
          </section>
        </div>
      )}
    </DuckLabShell>
  )
}
