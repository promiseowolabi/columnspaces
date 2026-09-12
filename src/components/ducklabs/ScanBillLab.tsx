/**
 * ScanBillLab — the first duck lab, and the one that decides whether the whole
 * empirical tier was worth building.
 *
 * The reader has just been told, in C0.L1, that a three-of-many-columns query
 * reads a few percent of a column store and effectively all of a row store, and
 * that projection and pruning multiply. This lab hands them a real columnar
 * engine and real Parquet files and invites them to check it — including the case
 * where the claim comes out FALSE, which is the point: on the shuffled file,
 * pruning does nothing at all, because pruning was never a property of the
 * format.
 *
 * Tasks are graded on what the reader observes, not on what they click through.
 */

import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Play, Table2 } from 'lucide-react'
import { DuckLabShell, type DuckTask } from '@/components/ducklabs/shell'
import { chunks, computeBill, fmtBytes, fmtFactor, type Bill } from '@/lib/duckdb/bill'
import { FIXTURE_ROWS, loadFixtures } from '@/lib/duckdb/fixtures'
import { cn } from '@/lib/utils'

/** The dashboard query's three columns, and the predicate column. */
const DASHBOARD_COLUMNS = ['order_ts', 'region', 'net_revenue']
const PREDICATE_COLUMN = 'order_ts'

/** A seven-day window near the end of the generated two-year history. */
const WINDOW_MIN = '2025-12-25 00:00:00'

type Scenario = {
  id: string
  label: string
  file: string
  columns: string[]
  predicate: { column: string; min?: string; max?: string } | null
  note: string
}

const SCENARIOS: Scenario[] = [
  {
    id: 'everything',
    label: 'SELECT * , no predicate',
    file: 'clustered.parquet',
    columns: [],
    predicate: null,
    note: 'The baseline. Reading every column of every row group is what a row-oriented layout forces on you, because its unit of storage is the whole row.',
  },
  {
    id: 'projected',
    label: '3 columns, no predicate',
    file: 'clustered.parquet',
    columns: DASHBOARD_COLUMNS,
    predicate: null,
    note: 'Projection alone. Nothing about the data changed — only how many column chunks the scan has to open.',
  },
  {
    id: 'pruned',
    label: '3 columns + 7-day window, clustered',
    file: 'clustered.parquet',
    columns: DASHBOARD_COLUMNS,
    predicate: { column: PREDICATE_COLUMN, min: WINDOW_MIN },
    note: 'Projection and pruning together, on a file written in timestamp order. This is the number the lesson claims.',
  },
  {
    id: 'shuffled',
    label: '3 columns + 7-day window, shuffled',
    file: 'shuffled.parquet',
    columns: DASHBOARD_COLUMNS,
    predicate: { column: PREDICATE_COLUMN, min: WINDOW_MIN },
    note: 'The same rows, the same query, the same engine — written in a different order. If pruning were a feature of the format, this would match the row above.',
  },
  {
    id: 'finer',
    label: '3 columns + 7-day window, 10× more row groups',
    file: 'clustered-small.parquet',
    columns: DASHBOARD_COLUMNS,
    predicate: { column: PREDICATE_COLUMN, min: WINDOW_MIN },
    note: 'Clustered, with row groups a tenth the size. Finer pruning — and ten times the metadata to plan against. Both edges of the dial.',
  },
]

type Results = Record<string, Bill>

export default function ScanBillLab({ trackColor }: { trackColor: string }) {
  const [status, setStatus] = useState<string>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Results>({})

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await loadFixtures((s) => setStatus(s))
      setStatus('computing the bill from each file’s footer')
      const next: Results = {}
      for (const s of SCENARIOS) {
        /* An empty `columns` list means SELECT * — resolve it to every column in the file. */
        const cols = s.columns.length > 0 ? s.columns : await allColumns(s.file)
        next[s.id] = await computeBill({ path: s.file, columns: cols, predicate: s.predicate })
      }
      setResults(next)
      setStatus('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('failed')
    } finally {
      setBusy(false)
    }
  }, [])

  const everything = results.everything
  const projected = results.projected
  const pruned = results.pruned
  const shuffled = results.shuffled

  const tasks: DuckTask[] = useMemo(
    () => [
      {
        id: 'run',
        label: 'Build the fixtures and compute the bill for all five scenarios',
        done: Object.keys(results).length === SCENARIOS.length,
        hint: 'Press run. The engine downloads once, then generates 2M rows and writes three real Parquet files.',
      },
      {
        id: 'projection',
        label: 'Observe a projection factor of at least 5× from reading three columns instead of all of them',
        done: !!everything && !!projected && everything.wholeFileBytes / projected.projectedBytes >= 5,
        hint: 'Compare the first two rows: same file, same row groups, different number of column chunks opened.',
      },
      {
        id: 'pruning',
        label: 'Observe at least 90% of row groups pruned on the clustered file',
        done: !!pruned && pruned.pruningRatio >= 0.9,
        hint: 'A seven-day window against two years of history, on a file written in timestamp order.',
      },
      {
        id: 'shuffled',
        label: 'Observe that the SAME query prunes almost nothing on the shuffled file',
        done: !!shuffled && shuffled.pruningRatio <= 0.2,
        hint: 'This is the task that matters. If it surprises you, the lesson landed.',
      },
      {
        id: 'multiply',
        label: 'Confirm the two factors multiply: total ≈ projection × pruning',
        done:
          !!pruned &&
          Math.abs(pruned.totalFactor - pruned.projectionFactor * pruned.pruningFactor) /
            Math.max(pruned.totalFactor, 1) <
            0.02,
        hint: 'They act on different terms of the same product — bytes per row, and rows read.',
      },
    ],
    [results, everything, projected, pruned, shuffled],
  )

  return (
    <DuckLabShell labId="scan-bill" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        This runs <strong>DuckDB</strong> — a real columnar engine — inside this tab. It generates{' '}
        {FIXTURE_ROWS.toLocaleString('en-US')} rows, writes three genuine Parquet files, and then
        computes what each query must read from those files’ own footers: compressed column-chunk
        sizes, and the min/max statistics the planner itself consults.
      </p>

      <div className="mt-4 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">three honest caveats</p>
        <ul className="mt-2 space-y-1.5 text-body-sm text-text-3">
          <li>
            · The first run downloads the engine (~33 MB) from a CDN. Nothing about you is uploaded —
            code comes down, queries stay here.
          </li>
          <li>
            · The lesson works its example at 2 billion rows; this runs 500,000. The{' '}
            <em>ratios</em> transfer because ratios are scale-free. The absolute byte counts below are
            roughly a four-thousandth of the lesson’s.
          </li>
          <li>
            · <strong>Do not read a compression ratio off this fixture.</strong> Its revenue column is
            uniform random noise, which is close to the worst case for any codec — real revenue data
            has structure and compresses far better. That is why this lab reports projection and
            pruning, which the fixture represents honestly, and leaves compression to C1, where the
            columns are built to be realistic.
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
          {busy ? 'running' : Object.keys(results).length ? 'run again' : 'run the lab'}
        </button>
        <span className="font-mono text-[11px] text-text-3">{status}</span>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-rose-400/40 px-4 py-3">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-rose-400" />
          <div>
            <p className="font-mono text-[11px] uppercase text-rose-400">the lab failed</p>
            <p className="mt-1 text-body-sm text-text-2">{error}</p>
            <p className="mt-1 text-body-sm text-text-3">
              Most likely the engine download was blocked. The arithmetic in the lesson stands on its
              own — this lab exists to let you check it, not to gate it.
            </p>
          </div>
        </div>
      )}

      {Object.keys(results).length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                {['scenario', 'row groups read', 'pruned', 'bytes read', 'vs SELECT *'].map((h) => (
                  <th key={h} className="py-2 pr-4 font-mono text-[10px] uppercase tracking-wide text-text-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SCENARIOS.map((s) => {
                const b = results[s.id]
                if (!b) return null
                const read = s.id === 'everything' ? b.wholeFileBytes : b.prunedBytes
                const factor = everything ? everything.wholeFileBytes / Math.max(read, 1) : 1
                return (
                  <tr key={s.id} className="border-b border-line/60 align-top">
                    <td className="py-3 pr-4">
                      <p className="font-mono text-[12px] text-text-1">{s.label}</p>
                      <p className="mt-1 max-w-md text-body-sm text-text-3">{s.note}</p>
                    </td>
                    <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                      {b.rowGroupsRead}/{b.rowGroups}
                    </td>
                    <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                      {(b.pruningRatio * 100).toFixed(1)}%
                    </td>
                    <td className="py-3 pr-4 font-mono text-[12px] text-text-1">{fmtBytes(read)}</td>
                    <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: trackColor }}>
                      {s.id === 'everything' ? '—' : fmtFactor(factor)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {pruned && shuffled && (
            <div className="mt-5 rounded-md border border-line px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                the comparison that matters
              </p>
              <p className="mt-2 text-body-sm text-text-2">
                Same rows, same query, same engine, same format, same compression. The clustered file
                skips <strong>{(pruned.pruningRatio * 100).toFixed(1)}%</strong> of its row groups;
                the shuffled file skips <strong>{(shuffled.pruningRatio * 100).toFixed(1)}%</strong>,
                and reads <strong>{fmtFactor(shuffled.prunedBytes / Math.max(pruned.prunedBytes, 1))}</strong>{' '}
                more bytes to answer the identical question. Pruning is not a feature you enable. It
                is a property your physical layout either has or does not.
              </p>
            </div>
          )}
        </div>
      )}

      {Object.keys(results).length === 0 && !busy && (
        <div className="mt-6 flex items-center gap-2 rounded-md border border-dashed border-line px-4 py-6 text-text-3">
          <Table2 size={15} />
          <span className="font-mono text-[11px]">no results yet — run the lab</span>
        </div>
      )}
    </DuckLabShell>
  )
}

/** Every column name in a Parquet file, for the SELECT * baseline. */
async function allColumns(path: string): Promise<string[]> {
  const rows = await chunks(path)
  return [...new Set(rows.map((r) => r.path_in_schema))]
}
