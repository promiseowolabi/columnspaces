/**
 * SnapshotLab — a three-row update, priced.
 *
 * ── What this is, said before anything else, and said again in the UI ──────
 * Neither Iceberg nor Delta Lake runs in duckdb-wasm. So this lab does not claim
 * to be either. What it does is perform the copy-on-write ALGORITHM by hand over
 * real Parquet files that DuckDB writes and reads in the reader's tab: lay a
 * table out as N data files, find which files hold the three affected rows from
 * those files' own footers, rewrite every affected file in full because a Parquet
 * file is immutable, and leave the originals in place as the previous snapshot.
 *
 * Every byte count is `file_size_bytes` from a real footer. The update is
 * verified by reading both snapshots back: exactly three rows differ, the row
 * count is unchanged, and the old snapshot still returns the old values. Then
 * expiry is PERFORMED — the superseded files are deleted — so "the storage comes
 * back and time travel stops working" is an observation rather than an assertion.
 *
 * The gap between this and a real table format is named in the UI at the top of
 * the lab, not buried in a footnote: manifests, atomic commits, snapshot
 * isolation, conflict detection, schema and partition evolution, and
 * merge-on-read as the whole other branch of the tradeoff. The lab even reports
 * the cost that manifests exist to remove — the number of footers it had to read
 * to locate three rows — because that count is the argument for them.
 *
 * ── The second half of the lesson, which the first half argues against ────
 * Shrinking the files shrinks the amplification. If the lab stopped there it
 * would be an argument for one-row files, so it measures the bill for that too:
 * more files means more footers on every plan, more manifest entries to keep,
 * more per-file overhead and more total bytes for the same rows. Both directions
 * are on screen at once.
 *
 * Tasks grade what the reader observes, not what they click through.
 */

import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, History, Play, ShieldCheck, Table2 } from 'lucide-react'
import { DuckLabShell, type DuckTask } from '@/components/ducklabs/shell'
import { fmtBytes, fmtFactor } from '@/lib/duckdb/bill'
import {
  REFERENCE_LAYOUT_ID,
  SNAPSHOT_COLUMNS,
  SNAPSHOT_LAYOUTS,
  SNAPSHOT_NEW_STATUS,
  SNAPSHOT_ROWS,
  SNAPSHOT_UPDATED_ROWS,
  fmtAmplification,
  fmtCount,
  fmtOverhead,
  loadSnapshotSource,
  runAllLayouts,
  snapshotLayout,
  snapshotTargets,
  type SnapshotGrid,
} from '@/lib/duckdb/snapshot'
import { browserFileStore } from '@/lib/duckdb/vfs'
import { cn } from '@/lib/utils'

const COARSEST = SNAPSHOT_LAYOUTS[0]
const FINEST = SNAPSHOT_LAYOUTS[SNAPSHOT_LAYOUTS.length - 1]
const REFERENCE = snapshotLayout(REFERENCE_LAYOUT_ID)
const TARGETS = snapshotTargets(SNAPSHOT_ROWS)

/** What a real table format adds on top of what runs here. Stated, not implied. */
const WHAT_A_REAL_FORMAT_ADDS = [
  {
    name: 'manifests',
    md: 'This lab reads every data file’s footer to find three rows. Iceberg reads a manifest list, then manifest files, so file selection costs a couple of reads rather than one per file. The “footers read” column below is exactly the cost manifests exist to delete — and it is the column that grows fastest as files shrink.',
  },
  {
    name: 'atomic commit',
    md: 'Here a snapshot is a list of paths held in a variable. A real format swaps one pointer — a catalog compare-and-set, or an atomic metadata write — so a reader never sees half a commit. Nothing in this lab provides that, and a crash mid-rewrite would leave an inconsistent table.',
  },
  {
    name: 'snapshot isolation and conflict detection',
    md: 'Two writers touching the same file here would silently clobber each other. A real format detects the overlap at commit time and fails the loser, which is what makes concurrent writes to one table safe rather than merely possible.',
  },
  {
    name: 'schema and partition evolution',
    md: 'Field ids, so a renamed column is still the same column; partition specs that can change without rewriting history; hidden partitioning so a query does not have to name the partition column. None of that exists here — the layout is a fixed id range per file.',
  },
  {
    name: 'merge-on-read',
    md: 'The whole other branch. Instead of rewriting a file, write a small delete file (positional or by equality) and let every subsequent reader apply it. That moves the cost from this one write onto every read until compaction. This lab measures only the copy-on-write side, so it earns no conclusion about which is better — only the observation that the choice is where to put the cost.',
  },
  {
    name: 'expiry and orphan cleanup as policy',
    md: 'Expiry runs here because this module deletes the files. In a real deployment it is a maintenance job with a retention window, and it has to know which snapshots a reader might still be holding. Orphan files — written by a job that failed before commit — are a separate cleanup problem this simulation cannot have, because it has no commit to fail.',
  },
]

export default function SnapshotLab({ trackColor }: { trackColor: string }) {
  const [status, setStatus] = useState<string>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [grid, setGrid] = useState<SnapshotGrid>({})

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await loadSnapshotSource((s) => setStatus(s))
      setGrid(
        await runAllLayouts({
          store: browserFileStore(),
          onStep: (s) => setStatus(s),
        }),
      )
      setStatus('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('failed')
    } finally {
      setBusy(false)
    }
  }, [])

  const measured = Object.keys(grid).length === SNAPSHOT_LAYOUTS.length
  const ordered = useMemo(
    () => SNAPSHOT_LAYOUTS.map((l) => ({ layout: l, r: grid[l.id] })),
    [grid],
  )

  const ref = grid[REFERENCE.id]
  const coarse = grid[COARSEST.id]
  const fine = grid[FINEST.id]

  const all = useMemo(() => Object.values(grid), [grid])
  const anomalies = all.filter((r) => r.anomaly !== null)
  const correctEverywhere =
    measured && all.every((r) => r.rowsDiffering === SNAPSHOT_UPDATED_ROWS && r.missedFiles === 0)
  const timeTravelEverywhere =
    measured && all.every((r) => r.timeTravelRowsIntact === SNAPSHOT_UPDATED_ROWS)
  const expiryEverywhere =
    measured &&
    all.every(
      (r) =>
        r.expiryRan &&
        r.onDiskAfterExpiry !== null &&
        r.onDiskAfterExpiry === r.snapshotTwoBytes &&
        r.snapshotOneReadableAfterExpiry === false,
    )

  const amplificationFalls =
    measured &&
    ordered.every((o, i) => {
      if (i === 0 || !o.r) return !!o.r
      const prev = ordered[i - 1].r
      return !!prev && o.r.rowAmplification < prev.rowAmplification
    })

  const countsRise =
    measured &&
    ordered.every((o, i) => {
      if (i === 0 || !o.r) return !!o.r
      const prev = ordered[i - 1].r
      return !!prev && o.r.footersRead > prev.footersRead && o.r.snapshotOneBytes > prev.snapshotOneBytes
    })

  const tasks: DuckTask[] = useMemo(
    () => [
      {
        id: 'run',
        label: `Lay ${fmtCount(SNAPSHOT_ROWS)} rows out at four file sizes and run the same three-row update against each`,
        done: measured,
        hint: 'Press run. Every layout is written as real Parquet, then updated the way a copy-on-write engine must.',
      },
      {
        id: 'amplification',
        label: `Observe the reference layout rewriting more than 1,000× the rows the update changed`,
        done: !!ref && ref.rowAmplification > 1_000,
        hint: `Three rows in, ${REFERENCE.rowsPerFile.toLocaleString('en-US')}-row files out. A Parquet file cannot be edited in place, so the unit of change is the file.`,
      },
      {
        id: 'bytes',
        label: 'Observe bytes written and bytes READ both dwarfing the logical change',
        done: !!ref && ref.byteAmplification > 1_000 && ref.bytesRead > 0,
        hint: 'The rewrite has to read every row of every affected file before it can write them back. The read side is the half people forget when they price an update.',
      },
      {
        id: 'still-correct',
        label: `Confirm that exactly ${SNAPSHOT_UPDATED_ROWS} rows differ between the two snapshots, in every layout`,
        done: correctEverywhere,
        hint: 'Amplification is a cost claim, not a correctness one. The update must still change only what it was asked to — and no file holding a target row may be missed by the footer statistics.',
      },
      {
        id: 'old-files-stay',
        label: 'Observe the superseded files still occupying storage after the commit',
        done: !!coarse && coarse.storageOverhead > 1.8 && coarse.supersededBytes > 0,
        hint: 'On the one-file layout, retaining one previous snapshot doubles the table’s storage. That is what time travel is made of.',
      },
      {
        id: 'time-travel',
        label: `Observe the old snapshot still returning the ${SNAPSHOT_UPDATED_ROWS} pre-update values`,
        done: timeTravelEverywhere,
        hint: 'The old file list is still a complete, readable table. Nothing special is required to read it — which is the whole trick.',
      },
      {
        id: 'expiry',
        label:
          'Observe expiry reclaiming exactly the superseded bytes — and the old snapshot becoming unreadable',
        done: expiryEverywhere,
        hint: 'The files are really deleted, then the sizes are re-read. Expiry is not free either: it is the moment time travel stops being available.',
      },
      {
        id: 'tradeoff-down',
        label: 'Observe the amplification factor falling monotonically as the files get smaller',
        done: amplificationFalls,
        hint: 'This is the real lever on update cost, and it is a physical layout decision rather than an engine setting.',
      },
      {
        id: 'tradeoff-up',
        label:
          'Observe the bill for that: more footers to read on every plan, and more total bytes for the same rows',
        done: countsRise,
        hint: 'If smaller were free the answer would be one row per file. Read the two right-hand columns before you go and shrink your target file size.',
      },
    ],
    [
      measured,
      ref,
      coarse,
      correctEverywhere,
      timeTravelEverywhere,
      expiryEverywhere,
      amplificationFalls,
      countsRise,
    ],
  )

  return (
    <DuckLabShell labId="snapshot-lab" trackColor={trackColor} tasks={tasks}>
      <div className="rounded-md border border-amber-400/40 bg-amber-400/5 px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-amber-400">
          read this before the numbers
        </p>
        <p className="mt-2 text-body-sm text-text-2">
          <strong>This is not Iceberg and it is not Delta Lake.</strong> Neither runs in
          duckdb-wasm. What runs here is the <strong>copy-on-write algorithm</strong>, executed by
          this lab over <strong>real Parquet files</strong> that DuckDB writes and reads in your tab:
          lay {fmtCount(SNAPSHOT_ROWS)} rows out as N data files, locate the three affected rows from
          those files’ own footers, rewrite every affected file in full, and leave the originals as
          the previous snapshot. The byte counts are real{' '}
          <span className="font-mono text-[11.5px]">file_size_bytes</span> values from real footers,
          and expiry really deletes files. What is <em>simulated</em> is the table format: the
          snapshot is a list of paths in a variable, and there is no manifest, no catalog and no
          commit.
        </p>
      </div>

      <p className="mt-4 text-body-sm text-text-2">
        The update is a status change on {SNAPSHOT_UPDATED_ROWS} rows — order ids{' '}
        <span className="font-mono text-[11.5px]">{TARGETS.join(', ')}</span>, set to{' '}
        <span className="font-mono text-[11.5px]">&apos;{SNAPSHOT_NEW_STATUS}&apos;</span>, a value
        that cannot already be present so that “exactly three rows differ” is guaranteed rather than
        lucky. The same update runs against four layouts of the identical rows, from one large file to{' '}
        {FINEST.files} small ones.
      </p>

      <div className="mt-4 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
          what a real table format adds
        </p>
        <ul className="mt-2 space-y-2 text-body-sm text-text-3">
          {WHAT_A_REAL_FORMAT_ADDS.map((x) => (
            <li key={x.name}>
              · <span className="font-mono text-[11.5px] text-text-2">{x.name}</span> — {x.md}
            </li>
          ))}
        </ul>
      </div>

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
            · {fmtCount(SNAPSHOT_ROWS)} rows and {SNAPSHOT_COLUMNS.length} columns, against a
            production table’s billions. Real data files are hundreds of megabytes, so the{' '}
            <em>absolute</em> byte counts here are tiny. The <strong>amplification factors are
            scale-free</strong> and are the numbers to carry out — and they get <em>worse</em>, not
            better, at production file sizes.
          </li>
          <li>
            · Amplification is measured as <span className="font-mono text-[11.5px]">rows rewritten
            ÷ rows changed</span> and{' '}
            <span className="font-mono text-[11.5px]">bytes written ÷ (rows changed × mean stored
            bytes per row)</span>. The denominator is deliberately generous: a real engine cannot
            write three rows’ worth of bytes even in principle, so the true ratio against any
            achievable minimum is smaller than the ratio against zero and larger than nothing.
          </li>
          <li>
            · The three target rows are spread across the key space, so at small file sizes they land
            in {SNAPSHOT_UPDATED_ROWS} different files. Three rows inside <em>one</em> file is the
            lucky case; the one-file layout shows it, and it is still a whole-table rewrite.
          </li>
          <li>
            · Anything that comes out <strong>against</strong> the story above is printed in the
            anomalies panel rather than dropped — including expiry failing to free anything.
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
          {busy ? 'running' : measured ? 'run again' : 'commit the update'}
        </button>
        <span className="font-mono text-[11px] text-text-3">{status}</span>
        {measured && (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-[11px]"
            style={{ color: correctEverywhere ? trackColor : '#FB7185' }}
          >
            <ShieldCheck size={12} />
            {correctEverywhere
              ? `exactly ${SNAPSHOT_UPDATED_ROWS} rows changed in all ${all.length} layouts`
              : 'the update did not change exactly what it was asked to'}
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
              Most likely the engine download was blocked. The arithmetic works on paper: divide your
              rows-per-file by the rows you are changing, and that is your amplification factor. Then
              multiply your file size by the number of files a change touches, and that is what a
              commit writes.
            </p>
          </div>
        </div>
      )}

      {!measured && !busy && (
        <div className="mt-6 flex items-center gap-2 rounded-md border border-dashed border-line px-4 py-6 text-text-3">
          <Table2 size={15} />
          <span className="font-mono text-[11px]">nothing committed yet — run the lab</span>
        </div>
      )}

      {measured && (
        <div className="mt-6 space-y-8">
          {/* --------------------- the amplification table ---------------------- */}
          <section>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              what a {SNAPSHOT_UPDATED_ROWS}-row update costs, by file size
            </p>
            <p className="mt-1 max-w-2xl text-body-sm text-text-3">
              Identical rows, identical update, identical engine. Only the file boundaries move.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {[
                      'layout',
                      'files touched',
                      'rows changed',
                      'rows rewritten',
                      'amplification',
                      'bytes read',
                      'bytes written',
                      'bytes amplification',
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
                  {ordered.map(({ layout: l, r }) => {
                    if (!r) return null
                    return (
                      <tr key={l.id} className="border-b border-line/60 align-top">
                        <td className="py-3 pr-4">
                          <p className="font-mono text-[12px] text-text-1">{l.label}</p>
                          <p className="mt-1 max-w-sm text-body-sm text-text-3">{l.why}</p>
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(r.filesAffected)}/{fmtCount(r.fileCount)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(r.rowsChanged)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                          {fmtCount(r.rowsRewritten)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: '#FB7185' }}>
                          {fmtAmplification(r.rowAmplification)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytes(r.bytesRead)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytes(r.bytesWritten)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: '#FB7185' }}>
                          {fmtAmplification(r.byteAmplification)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {ref && (
              <div className="mt-4 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  the claim under test
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  At {REFERENCE.label}, changing <strong>{fmtCount(ref.rowsChanged)} rows</strong>
                  {' '}rewrote <strong>{fmtCount(ref.rowsRewritten)}</strong> of them —{' '}
                  {fmtAmplification(ref.rowAmplification)} — and moved{' '}
                  {fmtBytes(ref.bytesRead)} in and {fmtBytes(ref.bytesWritten)} out against roughly{' '}
                  {fmtBytes(Math.round(ref.logicalBytesChanged))} of actual change. Nothing was
                  misconfigured. A Parquet file has no in-place update: the footer records every
                  chunk’s byte offset, so changing one value would invalidate the offsets after it.
                  The unit of mutation is the file, and that is a property of the format rather than a
                  limitation of the engine.
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  Note the <span className="font-mono text-[11.5px]">bytes read</span> column, which
                  is the half that gets left out of the estimate. The rewrite cannot write the new
                  file without first reading every row of the old one, so a commit that changes three
                  cells is billed for {fmtBytes(ref.bytesRead + ref.bytesWritten)} of I/O — and on a
                  consumption platform both directions are line items.
                </p>
              </div>
            )}
          </section>

          {/* ------------------- storage, time travel, expiry -------------------- */}
          <section>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              what time travel is keeping alive, and what expiry reclaims
            </p>
            <p className="mt-1 max-w-2xl text-body-sm text-text-3">
              After the commit both file sets exist. The old list is still a complete, readable table —
              that is all a snapshot is. Storage does not come back until something deletes the files
              the new snapshot no longer references.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {[
                      'layout',
                      'snapshot 1',
                      'snapshot 2 (live)',
                      'on disk',
                      'storage overhead',
                      'superseded',
                      'old values readable',
                      'after expiry',
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
                  {ordered.map(({ layout: l, r }) => {
                    if (!r) return null
                    return (
                      <tr key={l.id} className="border-b border-line/60">
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">{l.label}</td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytes(r.snapshotOneBytes)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytes(r.snapshotTwoBytes)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                          {fmtBytes(r.onDiskBytes)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: '#FB7185' }}>
                          {fmtOverhead(r.storageOverhead)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytes(r.supersededBytes)} · {fmtCount(r.supersededFiles)} file
                          {r.supersededFiles === 1 ? '' : 's'}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: trackColor }}>
                          {r.timeTravelRowsIntact === null
                            ? '—'
                            : `${fmtCount(r.timeTravelRowsIntact)}/${fmtCount(r.rowsChanged)}`}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[11.5px] text-text-2">
                          {r.expiryRan && r.onDiskAfterExpiry !== null ? (
                            <>
                              {fmtBytes(r.onDiskAfterExpiry)}
                              <br />
                              <span className="text-text-3">
                                {r.snapshotOneReadableAfterExpiry === false
                                  ? 'snapshot 1 gone'
                                  : 'snapshot 1 STILL readable'}
                              </span>
                            </>
                          ) : (
                            <span className="text-amber-400">not performed</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {coarse && (
              <div className="mt-4 flex items-start gap-2 rounded-md border border-line px-4 py-3">
                <History size={14} className="mt-0.5 shrink-0 text-text-3" />
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                    the price of being able to go back
                  </p>
                  <p className="mt-2 text-body-sm text-text-2">
                    On the {COARSEST.label} layout, retaining one previous snapshot puts storage at{' '}
                    <strong>{fmtOverhead(coarse.storageOverhead)}</strong> of the live table —{' '}
                    {fmtBytes(coarse.onDiskBytes)} on disk for {fmtBytes(coarse.snapshotTwoBytes)} of
                    current data, because the whole file was superseded. That is the bill for{' '}
                    <em>one</em> update and <em>one</em> retained version. A table updated hourly with
                    a seven-day retention window is holding 168 of them, and the ones nobody will ever
                    read cost exactly as much as the one somebody might.
                  </p>
                  <p className="mt-2 text-body-sm text-text-2">
                    {coarse.expiryRan && coarse.onDiskAfterExpiry !== null ? (
                      <>
                        Expiry was <strong>performed</strong>, not estimated:{' '}
                        {fmtCount(coarse.supersededFiles)} file
                        {coarse.supersededFiles === 1 ? '' : 's'} deleted,{' '}
                        {fmtBytes(coarse.expiryReclaimedBytes)} reclaimed, on-disk back to{' '}
                        {fmtBytes(coarse.onDiskAfterExpiry)}. And the cost of that is on the same row:
                        snapshot 1 is{' '}
                        {coarse.snapshotOneReadableAfterExpiry === false
                          ? 'no longer readable'
                          : 'unexpectedly still readable — see the anomalies panel'}
                        . Retention is not a storage setting, it is the length of your ability to
                        answer “what did this table say on Tuesday?”
                      </>
                    ) : (
                      <>
                        Expiry could <strong>not</strong> be performed in this build:{' '}
                        {coarse.expiryUnavailableReason}. The reclaimable figure above is measured
                        from the real superseded files, but the deletion and its consequence were not
                        observed here.
                      </>
                    )}
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* ------------------------- the tradeoff ----------------------------- */}
          <section>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              the tradeoff — the same dial, read the other way
            </p>
            <p className="mt-1 max-w-2xl text-body-sm text-text-3">
              Amplification falls as files shrink. If that were the whole story the answer would be
              one row per file, so here is the bill for it: counts, not adjectives.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {[
                      'layout',
                      'rows/file',
                      'amplification',
                      'storage overhead',
                      'live files',
                      'footers read to find 3 rows',
                      'footer bytes',
                      'table bytes',
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
                  {ordered.map(({ layout: l, r }) => {
                    if (!r) return null
                    return (
                      <tr key={l.id} className="border-b border-line/60">
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">{l.label}</td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(r.rowsPerFile)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: trackColor }}>
                          {fmtAmplification(r.rowAmplification)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: trackColor }}>
                          {fmtOverhead(r.storageOverhead)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: '#FB7185' }}>
                          {fmtCount(r.liveFileCount)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: '#FB7185' }}>
                          {fmtCount(r.footersRead)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {r.liveFooterBytes === null ? '—' : fmtBytes(r.liveFooterBytes)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytes(r.snapshotOneBytes)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {coarse && fine && (
              <div className="mt-4 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  both directions, in one paragraph
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  Going from {COARSEST.label} to {FINEST.label} divides the amplification by{' '}
                  <strong>
                    {fmtFactor(coarse.rowAmplification / Math.max(fine.rowAmplification, 1))}
                  </strong>{' '}
                  and takes the storage a retained snapshot holds from{' '}
                  {fmtOverhead(coarse.storageOverhead)} to {fmtOverhead(fine.storageOverhead)}. The
                  bill is on the right: live files go from {fmtCount(coarse.liveFileCount)} to{' '}
                  {fmtCount(fine.liveFileCount)} —{' '}
                  {fmtFactor(fine.liveFileCount / Math.max(coarse.liveFileCount, 1))} the footers to
                  read on <em>every</em> plan, not just on update
                  {coarse.liveFooterBytes !== null && fine.liveFooterBytes !== null && (
                    <>
                      , and {fmtFactor(fine.liveFooterBytes / Math.max(coarse.liveFooterBytes, 1))} the
                      per-file metadata ({fmtBytes(coarse.liveFooterBytes)} →{' '}
                      {fmtBytes(fine.liveFooterBytes)})
                    </>
                  )}
                  . Total table bytes rise too, from {fmtBytes(coarse.snapshotOneBytes)} to{' '}
                  {fmtBytes(fine.snapshotOneBytes)} — only{' '}
                  {(
                    (fine.snapshotOneBytes / Math.max(coarse.snapshotOneBytes, 1) - 1) *
                    100
                  ).toFixed(1)}
                  % here, and that small number is worth being honest about: at this scale the byte
                  penalty for small files is minor. The <strong>count</strong> penalty is not, and it
                  is the one that hurts on object storage, where every file is at least one round trip
                  and the planner has to touch all of them before it reads a row.
                </p>
                <p className="mt-2 text-body-sm text-text-3">
                  Which is exactly the pressure that produces the two things this lab does not have:
                  manifests, so the planner reads a summary instead of {fmtCount(fine.footersRead)}{' '}
                  footers, and compaction, so the small files that ingest produces get folded back into
                  large ones — paying the amplification deliberately, in a batch, at a time you chose.
                </p>
              </div>
            )}
          </section>

          {/* --------------------------- anomalies ------------------------------ */}
          {anomalies.length > 0 && (
            <section>
              <div className="rounded-md border border-amber-400/40 px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-amber-400">
                  {anomalies.length} result{anomalies.length === 1 ? '' : 's'} that came out against
                  the expected story
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  Printed rather than dropped. A lab that only ever confirms its author is a demo.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {anomalies.map((r) => (
                    <li key={r.layoutId} className="text-body-sm text-text-3">
                      <span className="font-mono text-[11.5px] text-text-2">{r.label}</span>
                      <br />
                      {r.anomaly}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* ------------------------ the reproduction recipe ------------------- */}
          <section>
            <div className="rounded-md border border-line px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                the arithmetic to take into a design review
              </p>
              <p className="mt-2 text-body-sm text-text-2">
                <span className="font-mono text-[11.5px]">
                  rows rewritten ≈ files touched × rows per file
                </span>
                . You already know your target file size and roughly how many files a day’s worth of
                updates scatters across, so you can put a number on your update path before you build
                it — and the number is a <em>count</em>, which means it is the same number on every
                machine and it is arguable in a room.
              </p>
              <p className="mt-2 text-body-sm text-text-3">
                The same fixture SQL, the same copy-on-write routine and the same measurement run
                against native DuckDB in{' '}
                <span className="font-mono text-[11.5px]">tests/c3-labs.test.ts</span>, which asserts
                the relationships in bands rather than byte counts — and asserts as absolutes that
                exactly {SNAPSHOT_UPDATED_ROWS} rows differ, that no file holding a target row is ever
                missed, and that expiry returns exactly the superseded bytes.
              </p>
            </div>
          </section>
        </div>
      )}
    </DuckLabShell>
  )
}
