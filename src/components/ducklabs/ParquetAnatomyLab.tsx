/**
 * ParquetAnatomyLab — a file described by its own footer, and the bill for that
 * description.
 *
 * The claim under test has two halves and the lab is built so either can lose.
 *
 * Half one is about WHERE. Parquet keeps no file-level statistics. The
 * min/max/null-count triple lives on the column chunk — one per column per row
 * group — and a planner that wants a file-level bound folds them itself. The lab
 * proves the grain by counting rather than by asserting: entries come out at
 * exactly `row groups × leaf columns` in all eight configurations, and the folded
 * bound is checked against the true extremes read from the data.
 *
 * Half two is about COST, and the reason this lab exists next to C2's pruning lab
 * is that the pruning lab turns the row-group dial for resolution and only
 * gestures at the bill. Here the bill is the subject, and it has two independent
 * drivers that get conflated constantly:
 *
 *   · ENTRY COUNT, which is the product of both dials — so wide tables and small
 *     row groups are not two separate problems, they multiply.
 *   · ENTRY SIZE, because a statistics entry quotes the actual minimum and maximum
 *     VALUES. A 160-character key carries its 160 characters twice, per chunk.
 *     The long-key file is in the fixture for exactly this, and it is the part
 *     most readers have never priced.
 *
 * The corner where the footer takes a double-digit share of the file is included
 * on purpose. "Metadata is not free" is easy to wave away at 0.024%, which is
 * where the first row of the sweep sits.
 *
 * The refusal panel is where the lab is most likely to be accused of theatre, so
 * it is built to make theatre impossible: real bytes are mutated, the engine is
 * asked to read the result, and its OWN error text is printed. Three mutations are
 * refused. The fourth is not — and that is the finding worth more than the three
 * refusals, because it means a corrupted VALUE comes back as a plausible wrong
 * answer with no error at all.
 *
 * Tasks grade what the reader observes, not what they click through.
 */

import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, FileWarning, Play, ShieldCheck, Table2 } from 'lucide-react'
import { DuckLabShell, type DuckTask } from '@/components/ducklabs/shell'
import { fmtBytes, fmtFactor } from '@/lib/duckdb/bill'
import {
  ANATOMY_FILES,
  ANATOMY_ROWS,
  CHECKSUM_COLUMN,
  HEAVY_FILE_ID,
  LONG_KEY_CHARS,
  PROOF_COLUMN,
  REFERENCE_FILE_ID,
  SIGNIFICANT_METADATA_SHARE,
  WIDE_COLUMNS,
  anatomyFile,
  anatomyPath,
  fmtCount,
  fmtShare,
  loadAnatomyFixtures,
  measureAll,
  runCorruptionProbes,
  walk,
  type AnatomyGrid,
  type AnatomyWalk,
  type CorruptionResult,
} from '@/lib/duckdb/anatomy'
import { browserFileStore } from '@/lib/duckdb/vfs'
import { cn } from '@/lib/utils'

/* Pure module-scope derivations — safe, and they keep the JSX readable. */
const NARROW = ANATOMY_FILES.filter((f) => f.family === 'narrow')
const COARSEST = NARROW[0]
const FINEST = NARROW[NARROW.length - 1]
const REFERENCE = anatomyFile(REFERENCE_FILE_ID)
const HEAVY = anatomyFile(HEAVY_FILE_ID)
const LONGKEY = anatomyFile('longkey-8k')

/** The four levels the walk descends, and what each one is authoritative for. */
const LEVELS = [
  {
    n: 0,
    name: 'file',
    holds: 'row count, row-group count, format version, the writer’s name, and the length of the footer itself',
    read: 'parquet_file_metadata()',
  },
  {
    n: 1,
    name: 'schema',
    holds: 'one synthetic root plus one leaf per column: physical type, logical type, and the repetition that decides whether definition levels are needed at all',
    read: 'parquet_schema()',
  },
  {
    n: 2,
    name: 'row group',
    holds: 'the horizontal partition — a row count and the sum of its chunks. The unit pruning skips.',
    read: 'parquet_metadata(), grouped',
  },
  {
    n: 3,
    name: 'column chunk',
    holds: 'one column inside one row group: offsets, encodings, compressed and uncompressed size, and THE STATISTICS. This is the grain everything in C2 stands on.',
    read: 'parquet_metadata()',
  },
  {
    n: 4,
    name: 'page',
    holds: 'the codec’s actual unit. The footer carries only its OFFSETS — page headers are serialised inline with the data, so the walk stops here.',
    read: 'offsets only',
  },
]

export default function ParquetAnatomyLab({ trackColor }: { trackColor: string }) {
  const [status, setStatus] = useState<string>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [grid, setGrid] = useState<AnatomyGrid>({})
  const [detail, setDetail] = useState<AnatomyWalk | null>(null)
  const [probes, setProbes] = useState<CorruptionResult[]>([])

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await loadAnatomyFixtures((s) => setStatus(s))
      setGrid(await measureAll((s) => setStatus(s)))

      setStatus('walking the reference file level by level')
      setDetail(await walk(REFERENCE))

      setStatus('corrupting copies and asking the engine to read them')
      setProbes(
        await runCorruptionProbes(browserFileStore(), anatomyPath(REFERENCE), {
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

  const measured = Object.keys(grid).length === ANATOMY_FILES.length
  const at = useCallback((id: string) => grid[id], [grid])

  const coarsest = at(COARSEST.id)
  const finest = at(FINEST.id)
  const reference = at(REFERENCE.id)
  const heavy = at(HEAVY.id)
  const longkey = at(LONGKEY.id)
  const wideSameGroups = at('wide-8k')

  const anomalies = useMemo(
    () => [
      ...Object.values(grid)
        .filter((m) => m.anomaly !== null)
        .map((m) => ({ where: m.fileId, what: m.anomaly! })),
      ...probes
        .filter((p) => p.anomaly !== null)
        .map((p) => ({ where: p.kind, what: p.anomaly! })),
      ...probes
        .filter((p) => !p.ran)
        .map((p) => ({ where: p.kind, what: `not run — ${p.unavailableReason}` })),
    ],
    [grid, probes],
  )

  const gridExactEverywhere =
    measured && Object.values(grid).every((m) => m.gridIsExact && m.entriesWithStats === m.statsEntries)

  const structural = probes.filter((p) => p.shouldRefuse)
  const refusedAll = structural.length > 0 && structural.every((p) => p.ran && p.refused && !!p.error)
  const flip = probes.find((p) => p.kind === 'flip-a-data-byte')
  const silentCorruption = !!flip && flip.ran && !flip.refused && flip.answerMatchedOriginal === false

  const entriesByGroups =
    coarsest && finest ? finest.statsEntries / Math.max(coarsest.statsEntries, 1) : 0
  const entriesByColumns =
    reference && wideSameGroups ? wideSameGroups.statsEntries / Math.max(reference.statsEntries, 1) : 0
  const perEntryRatio =
    reference?.footerBytesPerEntry && longkey?.footerBytesPerEntry
      ? longkey.footerBytesPerEntry / reference.footerBytesPerEntry
      : 0

  const tasks: DuckTask[] = useMemo(
    () => [
      {
        id: 'run',
        label: `Write ${ANATOMY_FILES.length} real Parquet files and read every count out of their own footers`,
        done: measured && !!detail,
        hint: `Press run. ${fmtCount(ANATOMY_ROWS)} rows become eight files at three shapes, then nothing below is authored — it is all read back from the files.`,
      },
      {
        id: 'grain',
        label:
          'Observe the statistics entry count coming out at exactly row groups × leaf columns, in every file',
        done: gridExactEverywhere,
        hint: 'This one is exact rather than a band, because it is not a measurement — it is the grain the format defines.',
      },
      {
        id: 'no-file-stats',
        label: `Observe that there are 0 file-level statistics, and that folding the chunk entries reproduces the true ${PROOF_COLUMN} range`,
        done: !!detail && detail.stats.fileLevelEntries === 0 && detail.stats.boundsHold,
        hint: 'A planner asking "could this file match?" has no single answer to read. It folds. That is why the entries exist and why there are so many of them.',
      },
      {
        id: 'row-group-dial',
        label: `Observe the entry count multiply by at least 32× going from ${COARSEST.rowGroupSize.toLocaleString('en-US')} to ${FINEST.rowGroupSize.toLocaleString('en-US')} rows per group`,
        done: entriesByGroups >= 32,
        hint: 'Same rows, same columns, same codec. Only the block size moved, and the footer grew with it.',
      },
      {
        id: 'column-dial',
        label:
          'Observe the entry count multiply again with COLUMN count at a fixed row-group size — the grid is a product, not a sum',
        done: entriesByColumns >= 5,
        hint: `Compare the 4-column and ${WIDE_COLUMNS + 1}-column rows at 8k rows/group. This is why wide tables and small files are one problem rather than two.`,
      },
      {
        id: 'significant-share',
        label: `Find a configuration where the footer is more than ${(SIGNIFICANT_METADATA_SHARE * 100).toFixed(0)}% of the file`,
        done: !!heavy && heavy.metadataShare !== null && heavy.metadataShare > SIGNIFICANT_METADATA_SHARE,
        hint: 'It is the last wide row. Compressible values shrink the data side while the entry grid keeps growing — and both roads there are real: streaming ingest, and wide event tables.',
      },
      {
        id: 'entry-size',
        label: `Observe bytes-per-entry more than double on the ${LONG_KEY_CHARS}-character key file, which has FEWER columns and the same row groups`,
        done: perEntryRatio >= 2,
        hint: 'Statistics quote values, not hashes of values. Cost per entry is the driver nobody prices, and it is the argument for not making your sort key a long string.',
      },
      {
        id: 'refusal',
        label: 'Observe the engine refusing all three structural corruptions, and read its own error text',
        done: refusedAll,
        hint: 'Real bytes, mutated, handed back to the engine. The messages in the table are the engine’s, not the author’s.',
      },
      {
        id: 'silence',
        label:
          'Observe the fourth mutation NOT being refused — a flipped data byte returning the right row count and a wrong answer',
        done: silentCorruption,
        hint: 'Page CRCs are optional in Parquet and this writer does not emit them. Structural damage is loud; value damage is silent. That is the finding to take away.',
      },
    ],
    [
      measured,
      detail,
      gridExactEverywhere,
      entriesByGroups,
      entriesByColumns,
      heavy,
      perEntryRatio,
      refusedAll,
      silentCorruption,
    ],
  )

  return (
    <DuckLabShell labId="parquet-anatomy" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        This runs <strong>DuckDB</strong> in this tab, writes {ANATOMY_FILES.length}{' '}
        <strong>real Parquet files</strong> over {fmtCount(ANATOMY_ROWS)} rows, and then describes one
        of them from its own footer — file, schema, row group, column chunk, page. Every count below
        comes out of{' '}
        <span className="font-mono text-[11.5px]">parquet_file_metadata()</span>,{' '}
        <span className="font-mono text-[11.5px]">parquet_schema()</span> and{' '}
        <span className="font-mono text-[11.5px]">parquet_metadata()</span> — the same structures a
        planner reads before it decides what to skip.
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
            · These are <strong>genuine Parquet files written by DuckDB’s writer</strong>, not a
            Parquet-shaped teaching format. The footer sizes, encodings and statistics are the
            writer’s own. Another writer — parquet-mr, Arrow C++, pyarrow — makes different choices
            about dictionaries, page sizes and whether to emit a ColumnIndex, so the <em>shares</em>{' '}
            below are DuckDB’s shares. The <em>structure</em> is the format’s.
          </li>
          <li>
            · <strong>The walk stops at the page level, and that is a limit rather than a choice.</strong>{' '}
            Page headers are serialised inline with the data, so the footer carries page OFFSETS and
            nothing else. Exactly one page-level byte count is therefore derivable here — a dictionary
            page’s size, as the gap to the first data page — and it is the only one this lab claims.
            Per-page statistics (Parquet’s optional ColumnIndex/OffsetIndex) are not exposed by these
            views, so they are reported as absent rather than invented.
          </li>
          <li>
            · The corruption panel mutates <strong>real bytes of a real file</strong> and prints the
            engine’s <strong>verbatim</strong> error. If this build cannot hand a lab raw file bytes,
            the panel says the observation was not made — it does not print a plausible message.
          </li>
          <li>
            · Anything that comes out <strong>against</strong> the story above is printed in the
            anomalies panel at the bottom rather than dropped.
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
          {busy ? 'running' : measured ? 'run again' : 'open the footer'}
        </button>
        <span className="font-mono text-[11px] text-text-3">{status}</span>
        {detail && (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-[11px]"
            style={{ color: detail.stats.boundsHold ? trackColor : '#FB7185' }}
          >
            <ShieldCheck size={12} />
            folded bound {detail.stats.boundsHold ? 'contains' : 'does NOT contain'} the data
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
              Most likely the engine download was blocked. The structure still holds on paper: four
              levels, statistics on the third, and one entry per column per row group — so multiply
              your column count by your row-group count before you argue about row-group size.
            </p>
          </div>
        </div>
      )}

      {!measured && !busy && (
        <div className="mt-6 flex items-center gap-2 rounded-md border border-dashed border-line px-4 py-6 text-text-3">
          <Table2 size={15} />
          <span className="font-mono text-[11px]">no footer read yet — run the lab</span>
        </div>
      )}

      {measured && (
        <div className="mt-6 space-y-8">
          {/* ------------------------- the four levels -------------------------- */}
          <section>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              the walk — {REFERENCE.label}
            </p>
            <p className="mt-1 max-w-2xl text-body-sm text-text-3">
              One file, described entirely by itself. Read the “holds” column as an answer to the only
              question that matters at each level: what can a planner decide here without reading any
              data?
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {['level', 'what it holds', 'read from', 'this file'].map((h) => (
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
                  {LEVELS.map((l) => (
                    <tr key={l.n} className="border-b border-line/60 align-top">
                      <td className="py-3 pr-4">
                        <p className="font-mono text-[12px] text-text-1">
                          {l.n} · {l.name}
                        </p>
                      </td>
                      <td className="py-3 pr-4 max-w-md text-body-sm text-text-3">{l.holds}</td>
                      <td className="py-3 pr-4 font-mono text-[11px] text-text-3">{l.read}</td>
                      <td className="py-3 pr-4 font-mono text-[11.5px] text-text-2">
                        {detail && levelSummary(l.n, detail)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* -------------------- level 3: where the stats live ------------------ */}
          {detail && (
            <section>
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                level 3 — the column chunks of row group 0, and where the statistics live
              </p>
              <p className="mt-1 max-w-2xl text-body-sm text-text-3">
                Four chunks, because there are four columns. Every one carries its own min, max and
                null count. Multiply this table by the {detail.rowGroups.length} row groups and you
                have the whole footer.
              </p>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-line">
                      {[
                        'column',
                        'physical type',
                        'encodings',
                        'stored',
                        'stats min',
                        'stats max',
                        'nulls',
                        'distinct',
                        'dictionary page',
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
                    {detail.chunks.map((c) => (
                      <tr key={c.column} className="border-b border-line/60">
                        <td className="py-2.5 pr-4 font-mono text-[12px] text-text-1">{c.column}</td>
                        <td className="py-2.5 pr-4 font-mono text-[11.5px] text-text-2">
                          {c.parquetType ?? '—'}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-[11px] text-text-3">
                          {c.encodings ?? '—'}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-[11.5px] text-text-2">
                          {fmtBytes(c.compressedBytes)}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-[11px] text-text-2">
                          {c.statsMin ?? '—'}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-[11px] text-text-2">
                          {c.statsMax ?? '—'}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-[11.5px] text-text-3">
                          {c.nullCount ?? '—'}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-[11.5px] text-text-3">
                          {c.distinctCount ?? '—'}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-[11.5px]" style={{ color: trackColor }}>
                          {c.dictionaryPageBytes === null
                            ? 'none'
                            : `${fmtBytes(c.dictionaryPageBytes)} @ ${fmtCount(c.dictionaryPageOffset!)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  there is no file-level minimum
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  Parquet defines <strong>{detail.stats.fileLevelEntries}</strong> file-level
                  statistics blocks. Asking “could this file contain{' '}
                  {PROOF_COLUMN} = X?” therefore means reading{' '}
                  {fmtCount(detail.stats.entries)} chunk entries for that one column and folding
                  them. Folded, this file spans{' '}
                  <span className="font-mono text-[11.5px]">{detail.stats.foldedMin}</span> …{' '}
                  <span className="font-mono text-[11.5px]">{detail.stats.foldedMax}</span>; read
                  straight from the data it spans{' '}
                  <span className="font-mono text-[11.5px]">{detail.stats.trueMin}</span> …{' '}
                  <span className="font-mono text-[11.5px]">{detail.stats.trueMax}</span>.{' '}
                  {detail.stats.boundsHold
                    ? 'They agree, which is the property every pruning decision in C2 stands on: a chunk’s statistics must bound its data, or a skip can be wrong.'
                    : 'They do NOT agree, which would make every pruning decision built on these statistics unsound — see the anomalies panel.'}
                </p>
                <p className="mt-2 text-body-sm text-text-3">
                  The page level, for completeness:{' '}
                  {detail.chunks.some((c) => c.dictionaryPageBytes !== null) ? (
                    <>
                      the dictionary-encoded column’s dictionary page is{' '}
                      {fmtBytes(
                        detail.chunks.find((c) => c.dictionaryPageBytes !== null)!
                          .dictionaryPageBytes!,
                      )}
                      , derived as{' '}
                      <span className="font-mono text-[11px]">
                        data_page_offset − dictionary_page_offset
                      </span>
                      . That is a real byte count, and it is the only page-level one the footer
                      gives.
                    </>
                  ) : (
                    <>
                      no chunk in this row group has a dictionary page, so not even the one derivable
                      page-level byte count is available here.
                    </>
                  )}{' '}
                  Page counts, page headers and page-level statistics are not in these views, and this
                  lab does not estimate them.
                </p>
              </div>
            </section>
          )}

          {/* ---------------------- metadata is not free ------------------------ */}
          <section>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              the entry grid, and what it costs
            </p>
            <p className="mt-1 max-w-2xl text-body-sm text-text-3">
              Eight files. The first four are the same four columns at four row-group sizes; the next
              three are {WIDE_COLUMNS + 1} columns at three of the same sizes; the last is two columns
              with a {LONG_KEY_CHARS}-character key. Read <span className="font-mono text-[11.5px]">entries</span>{' '}
              against <span className="font-mono text-[11.5px]">groups × cols</span>, and then read the
              two right-hand columns against each other — they are different costs.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {[
                      'file',
                      'row groups',
                      'leaf cols',
                      'entries',
                      'groups × cols',
                      'data',
                      'footer',
                      'footer share',
                      'bytes/entry',
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
                  {ANATOMY_FILES.map((f) => {
                    const m = at(f.id)
                    if (!m) return null
                    const significant =
                      m.metadataShare !== null && m.metadataShare > SIGNIFICANT_METADATA_SHARE
                    return (
                      <tr key={f.id} className="border-b border-line/60 align-top">
                        <td className="py-3 pr-4">
                          <p className="font-mono text-[12px] text-text-1">{f.label}</p>
                          <p className="mt-1 max-w-sm text-body-sm text-text-3">{f.why}</p>
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.rowGroups)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.leafColumns)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                          {fmtCount(m.statsEntries)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[11.5px] text-text-3">
                          {fmtCount(m.rowGroups)} × {fmtCount(m.leafColumns)} ={' '}
                          {fmtCount(m.entriesPredicted)}
                          {!m.gridIsExact && <span className="text-rose-400"> ✗</span>}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytes(m.dataBytes)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {m.footerBytes === null ? '—' : fmtBytes(m.footerBytes)}
                        </td>
                        <td
                          className="py-3 pr-4 font-mono text-[12px]"
                          style={{ color: significant ? '#FB7185' : trackColor }}
                        >
                          {m.metadataShare === null ? 'unavailable' : fmtShare(m.metadataShare)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {m.footerBytesPerEntry === null
                            ? '—'
                            : `${m.footerBytesPerEntry.toFixed(0)} B`}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {coarsest && finest && reference && wideSameGroups && (
              <div className="mt-4 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  the grid is a product
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  Holding columns fixed and cutting the row group from{' '}
                  {fmtCount(COARSEST.rowGroupSize)} to {fmtCount(FINEST.rowGroupSize)} rows takes the
                  entry count from {fmtCount(coarsest.statsEntries)} to{' '}
                  {fmtCount(finest.statsEntries)} — {fmtFactor(entriesByGroups)}.{' '}
                  Holding the row group fixed at {fmtCount(REFERENCE.rowGroupSize)} and going from{' '}
                  {reference.leafColumns} columns to {wideSameGroups.leafColumns} takes it from{' '}
                  {fmtCount(reference.statsEntries)} to {fmtCount(wideSameGroups.statsEntries)} —{' '}
                  {fmtFactor(entriesByColumns)}. Do both and you multiply, which is the arithmetic to
                  carry into a review: a 200-column table at 8k-row groups has as many statistics
                  entries as a 4-column table at 160-row groups, and nobody would propose the second
                  one.
                </p>
              </div>
            )}

            {heavy && heavy.metadataShare !== null && reference && reference.metadataShare !== null && (
              <div className="mt-3 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  where “not free” stops being rhetorical
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  The reference file’s footer is <strong>{fmtShare(reference.metadataShare)}</strong>{' '}
                  of it — genuinely a rounding error, and the reason this claim is usually waved away.
                  The {HEAVY.label} file’s footer is{' '}
                  <strong>{fmtShare(heavy.metadataShare)}</strong>:{' '}
                  {fmtBytes(heavy.footerBytes ?? 0)} of metadata against{' '}
                  {fmtBytes(heavy.dataBytes)} of data. Nothing exotic happened. The values compress
                  well, so the data side is small, and the entry grid is{' '}
                  {fmtCount(heavy.rowGroups)} × {fmtCount(heavy.leafColumns)} ={' '}
                  {fmtCount(heavy.statsEntries)} entries that each cost what they cost regardless.
                  Both roads to this corner are ones people are already on: streaming ingest that
                  lands small files, and wide event tables full of enum columns. And it is paid twice
                  — once in storage, and once on every read, because the planner parses the whole
                  footer before it can skip a single byte of data.
                </p>
              </div>
            )}

            {longkey && reference && longkey.footerBytesPerEntry !== null && reference.footerBytesPerEntry !== null && (
              <div className="mt-3 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  the other driver: what one entry costs
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  The last row has <strong>half</strong> the columns of the reference file and the
                  same {fmtCount(longkey.rowGroups)} row groups — so a count-only model predicts a
                  smaller footer per entry. It is{' '}
                  <strong>{longkey.footerBytesPerEntry.toFixed(0)} B/entry</strong> against{' '}
                  {reference.footerBytesPerEntry.toFixed(0)} B, because a statistics entry stores the
                  actual minimum and maximum <em>values</em> and this key is {LONG_KEY_CHARS}{' '}
                  characters wide. Averaged over the file that is{' '}
                  {(longkey.statsValueChars / longkey.statsEntries).toFixed(0)} characters of quoted
                  value per entry against{' '}
                  {(reference.statsValueChars / reference.statsEntries).toFixed(0)}. The design
                  consequence is concrete and rarely stated: a long string sort key does not only cost
                  you comparison work, it inflates every chunk entry in every file, and truncated
                  statistics — the writer giving up and marking the bound inexact — is the escape hatch
                  that then costs you pruning precision instead.
                </p>
              </div>
            )}
          </section>

          {/* -------------------------- the refusal ----------------------------- */}
          <section>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              the reader refusing malformed input
            </p>
            <p className="mt-1 max-w-2xl text-body-sm text-text-3">
              Four copies of the reference file, each with real bytes changed, handed back to the
              engine. The <span className="font-mono text-[11.5px]">error</span> column is the
              engine’s own text. The last row is the one to read twice.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {['mutation', 'what it breaks', 'outcome', 'the engine’s message'].map((h) => (
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
                  {probes.map((p) => (
                    <tr key={p.kind} className="border-b border-line/60 align-top">
                      <td className="py-3 pr-4">
                        <p className="font-mono text-[12px] text-text-1">{p.label}</p>
                        <p className="mt-1 max-w-md text-body-sm text-text-3">{p.why}</p>
                      </td>
                      <td className="py-3 pr-4 max-w-[14rem] text-body-sm text-text-3">{p.breaks}</td>
                      <td className="py-3 pr-4 font-mono text-[11.5px]">
                        {!p.ran ? (
                          <span className="text-amber-400">not observed</span>
                        ) : p.refused ? (
                          <span style={{ color: trackColor }}>refused</span>
                        ) : (
                          <span className="text-rose-400">
                            accepted
                            {p.rowsReturned !== null && <> · {fmtCount(p.rowsReturned)} rows</>}
                            {p.answerMatchedOriginal === false && <> · WRONG answer</>}
                            {p.answerMatchedOriginal === true && <> · answer unchanged</>}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4 max-w-[20rem] font-mono text-[10.5px] text-text-2">
                        {p.ran ? (p.error ?? '— no error raised —') : p.unavailableReason}
                      </td>
                    </tr>
                  ))}
                  {probes.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-4 font-mono text-[11px] text-text-3">
                        no corruption probes have run
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {flip && (
              <div
                className={cn(
                  'mt-4 flex items-start gap-2 rounded-md border px-4 py-3',
                  silentCorruption ? 'border-rose-400/40' : 'border-line',
                )}
              >
                <FileWarning
                  size={14}
                  className={cn('mt-0.5 shrink-0', silentCorruption ? 'text-rose-400' : 'text-text-3')}
                />
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                    the failure mode that does not raise an error
                  </p>
                  {!flip.ran ? (
                    <p className="mt-2 text-body-sm text-text-2">
                      This observation was <strong>not made</strong> in this build:{' '}
                      {flip.unavailableReason}. Nothing is being simulated in its place — the claim
                      that value corruption is silent is not evidenced here, only stated.
                    </p>
                  ) : silentCorruption ? (
                    <p className="mt-2 text-body-sm text-text-2">
                      One byte was flipped at offset {fmtCount(flip.byteOffset ?? 0)} — a byte the
                      footer itself identified as belonging to{' '}
                      <span className="font-mono text-[11.5px]">{CHECKSUM_COLUMN}</span> in one row
                      group. The footer still parsed. The schema was intact. The row count came back
                      as {fmtCount(flip.rowsReturned ?? 0)}, exactly right. And the aggregate over{' '}
                      <span className="font-mono text-[11.5px]">{CHECKSUM_COLUMN}</span>{' '}
                      <strong>changed</strong>. No error, no warning, a plausible number in a report.
                      Page CRCs are optional in Parquet and this writer does not emit them, so there
                      was nothing to check the value against. The asymmetry is worth stating out loud
                      in a design review: the format protects its <em>structure</em> and not its{' '}
                      <em>values</em>, so integrity for values has to come from somewhere else —
                      object-store checksums, a writer configured to emit page CRCs, or a reconciliation
                      count you actually look at.
                    </p>
                  ) : flip.refused ? (
                    <p className="mt-2 text-body-sm text-text-2">
                      This build <strong>refused</strong> the flipped byte, which is better than the
                      lab predicted — page checksums are being emitted or verified here. The engine
                      said: <span className="font-mono text-[10.5px]">{flip.error}</span>. Do not
                      generalise it: CRCs are optional in the format, so another writer’s files carry
                      no such protection.
                    </p>
                  ) : (
                    <p className="mt-2 text-body-sm text-text-2">
                      The flip was accepted and the answer did not change, so this run does{' '}
                      <strong>not</strong> demonstrate silent corruption — the byte probably landed
                      somewhere this query never decodes. That is recorded in the anomalies panel
                      rather than presented as a result.
                    </p>
                  )}
                </div>
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
                  {anomalies.map((a) => (
                    <li key={`${a.where}-${a.what.slice(0, 24)}`} className="text-body-sm text-text-3">
                      <span className="font-mono text-[11.5px] text-text-2">{a.where}</span>
                      <br />
                      {a.what}
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
                how to redo this on your own file
              </p>
              <p className="mt-2 font-mono text-[11px] text-text-2">
                SELECT footer_size, file_size_bytes, num_row_groups FROM
                parquet_file_metadata(&apos;yours.parquet&apos;);
              </p>
              <p className="mt-1 font-mono text-[11px] text-text-2">
                SELECT count(*) AS entries, count(DISTINCT row_group_id) AS groups, count(DISTINCT
                path_in_schema) AS cols FROM parquet_metadata(&apos;yours.parquet&apos;);
              </p>
              <p className="mt-2 text-body-sm text-text-3">
                Divide footer by file size and you have your own metadata share; divide footer by
                entries and you have your own cost per entry. The same fixture SQL and the same
                measurement functions run against native DuckDB in{' '}
                <span className="font-mono text-[11.5px]">tests/c3-labs.test.ts</span>, which asserts
                the relationships in bands — except the entry grid, which is asserted exactly, because
                it is the format rather than a measurement.
              </p>
            </div>
          </section>
        </div>
      )}
    </DuckLabShell>
  )
}

/** One-line summary of a level, for the walk table's right-hand column. */
function levelSummary(level: number, w: AnatomyWalk): string {
  const leaves = w.schema.filter((s) => s.isLeaf)
  switch (level) {
    case 0:
      return `${fmtCount(w.file.numRows)} rows · ${fmtCount(w.file.numRowGroups)} row groups · v${
        w.file.formatVersion ?? '?'
      } · footer ${w.file.footerBytes === null ? 'unavailable' : fmtBytes(w.file.footerBytes)}`
    case 1:
      return `${leaves.length} leaves: ${leaves.map((l) => `${l.name} ${l.parquetType}`).join(', ')}`
    case 2: {
      const rows = w.rowGroups[0]?.rows ?? 0
      return `${fmtCount(w.rowGroups.length)} groups × ${fmtCount(rows)} rows`
    }
    case 3:
      return `${fmtCount(w.rowGroups.length * leaves.length)} chunk entries, each with min/max/nulls`
    case 4: {
      const dict = w.chunks.find((c) => c.dictionaryPageBytes !== null)
      return dict
        ? `offsets only — ${dict.column}'s dictionary page is ${fmtBytes(dict.dictionaryPageBytes!)}`
        : 'offsets only — no dictionary page in this row group'
    }
    default:
      return ''
  }
}
