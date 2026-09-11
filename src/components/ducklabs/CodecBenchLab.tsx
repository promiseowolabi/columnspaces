/**
 * CodecBenchLab — predict six compression ratios, then be judged by the footer.
 *
 * The claim under test is that a column's ratio follows from its cardinality, its
 * ordering and its range, and not from which codec is switched on. The lab is
 * built so that claim can lose: the reader commits to a bucket for each column
 * BEFORE anything runs, and their prediction is scored against a number read out
 * of the file's own metadata.
 *
 * Two design decisions carry the pedagogy:
 *
 *   · One column per Parquet file. A wide file would let a reader read a
 *     whole-file ratio and credit it to "Parquet" — the exact habit C1 exists to
 *     break. Six files means every number belongs to one column's properties.
 *
 *   · A measured ratio stays hidden until that row has a prediction, and only
 *     predictions made before the run are scored. Committing first is the skill;
 *     making it structural beats grading a click.
 *
 * The fixture contains one result that contradicts what a competent engineer
 * would predict — the monotone timestamp barely compresses, because DuckDB's
 * writer emits PLAIN for TIMESTAMP and has no delta encoding to offer. That is
 * surfaced as the lab's headline finding rather than quietly dropped, because a
 * lab that only ever confirms the author is a demo.
 */

import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, Play, Table2, Target } from 'lucide-react'
import { DuckLabShell, type DuckTask } from '@/components/ducklabs/shell'
import { fmtBytes, fmtFactor } from '@/lib/duckdb/bill'
import {
  BUCKETS,
  CODEC_COLUMNS,
  CODEC_ROWS,
  bucketLabel,
  bucketOf,
  fmtBytesPerValue,
  loadCodecFixtures,
  measureAll,
  type BucketId,
  type CodecMeasurement,
} from '@/lib/duckdb/codecs'
import { cn } from '@/lib/utils'

type Predictions = Partial<Record<string, BucketId>>
type Results = Record<string, CodecMeasurement>

export default function CodecBenchLab({ trackColor }: { trackColor: string }) {
  const [status, setStatus] = useState<string>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [predictions, setPredictions] = useState<Predictions>({})
  /** Snapshot of the predictions at the moment run was pressed. Only these score. */
  const [committed, setCommitted] = useState<Predictions>({})
  const [results, setResults] = useState<Results>({})

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    setCommitted({ ...predictions })
    try {
      await loadCodecFixtures((s) => setStatus(s))
      setResults(await measureAll((s) => setStatus(s)))
      setStatus('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('failed')
    } finally {
      setBusy(false)
    }
  }, [predictions])

  const measured = Object.keys(results).length === CODEC_COLUMNS.length
  const clustered = results['region-clustered']
  const shuffled = results['region-shuffled']
  const ts = results['order-ts']
  const basket = results['basket-size']
  const unique = results['customer-id']
  const noise = results['noise']

  /** Scored only where a prediction existed before the run. */
  const scored = CODEC_COLUMNS.filter((c) => committed[c.id] && results[c.id])
  const hits = scored.filter((c) => committed[c.id] === bucketOf(results[c.id].totalRatio))

  const tasks: DuckTask[] = useMemo(
    () => [
      {
        id: 'measure',
        label: 'Write all six single-column files and read each ratio out of its own footer',
        done: measured,
        hint: 'Commit a prediction for each column first — a measured ratio stays hidden until that row has one.',
      },
      {
        id: 'ordering',
        label:
          'Observe the same low-cardinality values compressing at least 5× better clustered than shuffled',
        done: !!clustered && !!shuffled && clustered.totalRatio / shuffled.totalRatio >= 5,
        hint: 'Identical multiset, identical writer, identical codec. Only the row order differs. This is the lesson.',
      },
      {
        id: 'timestamp',
        label:
          'Observe the monotone timestamp coming in under 1.5× — and find the reason in its encoding',
        done: !!ts && ts.totalRatio < 1.5,
        hint: 'Every property predicts a huge ratio. Read the encodings column to see why it does not happen.',
      },
      {
        id: 'range',
        label: 'Observe the narrow-range integer landing between 3× and 20×, where bit width predicts',
        done: !!basket && basket.totalRatio > 3 && basket.totalRatio < 20,
        hint: '20 distinct values need 5 bits; the stored type is 32. Do that division before you look.',
      },
      {
        id: 'floor',
        label: 'Observe both high-cardinality columns pinned to the 1× floor',
        done:
          !!unique &&
          !!noise &&
          unique.totalRatio < 1.15 &&
          unique.totalRatio > 0.85 &&
          noise.totalRatio < 1.15 &&
          noise.totalRatio > 0.85,
        hint: 'Hash output and full-precision doubles have nothing to find. No codec changes that.',
      },
      {
        id: 'codec-nil',
        label:
          'Observe that on the biggest ratio in the fixture, Snappy contributes nothing — the encoding did all of it',
        done: !!clustered && clustered.codecGain < 1.1 && clustered.encodingGain > 20,
        hint: 'Compare the encoding gain and the codec gain on the clustered row. One of them is ≤ 1.0×.',
      },
    ],
    [measured, clustered, shuffled, ts, basket, unique, noise],
  )

  return (
    <DuckLabShell labId="codec-bench" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        Six columns, each written to its <strong>own</strong> single-column Parquet file by{' '}
        <strong>DuckDB</strong>, running in this tab over {CODEC_ROWS.toLocaleString('en-US')} rows.
        One column per file means a ratio has exactly one cause you can name. Commit a bucket for
        each column before you run — the properties you need are in the table, and nothing else is
        relevant.
      </p>

      <div className="mt-4 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
          what these numbers are, and are not
        </p>
        <ul className="mt-2 space-y-1.5 text-body-sm text-text-3">
          <li>
            · These are <strong>Snappy-compressed Parquet files written by DuckDB’s writer, on
            synthetic data</strong>. Change the codec, the writer or the data and the numbers change.
            Nothing here is a benchmark of Parquet, of Snappy, or of your table.
          </li>
          <li>
            · The ratio is <span className="font-mono text-[11.5px]">plain ÷ stored</span>. The
            numerator is arithmetic over the values (count × width, or{' '}
            <span className="font-mono text-[11.5px]">4 + byte length</span> per string, which is
            Parquet’s PLAIN layout); the denominator is{' '}
            <span className="font-mono text-[11.5px]">total_compressed_size</span> from the file’s
            footer. <strong>Not</strong>{' '}
            <span className="font-mono text-[11.5px]">uncompressed ÷ compressed</span> — the footer’s
            “uncompressed” size is measured after encoding, so that fraction reports the codec alone
            and hides the encoding entirely. On the first row below it comes out under 1.0×, which
            would read as “Parquet made it bigger”.
          </li>
          <li>
            · The clustered-string ratio is the one number here that is <strong>not scale-free</strong>:
            run lengths grow with rows-per-distinct-value, so it is far larger at{' '}
            {CODEC_ROWS.toLocaleString('en-US')} rows than at forty thousand. Every other ratio in the
            table holds at any scale. Both facts are pinned by{' '}
            <span className="font-mono text-[11.5px]">tests/codec-bench.test.ts</span>, which also
            checks the plain-byte arithmetic against a real PLAIN-encoded file from the same writer.
          </li>
          <li>
            · <strong>Read row three before you generalise.</strong> The monotone timestamp has every
            property that should make it compress enormously and it does not, for a reason that is
            about the writer rather than the data. That is the finding this lab exists to hand you.
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
          {busy ? 'running' : measured ? 'run again' : 'run the bench'}
        </button>
        <span className="font-mono text-[11px] text-text-3">{status}</span>
        {!measured && !busy && (
          <span className="font-mono text-[11px] text-text-3">
            {Object.keys(predictions).length}/{CODEC_COLUMNS.length} predicted
          </span>
        )}
        {scored.length > 0 && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px]" style={{ color: trackColor }}>
            <Target size={12} />
            {hits.length}/{scored.length} predictions correct
          </span>
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-rose-400/40 px-4 py-3">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-rose-400" />
          <div>
            <p className="font-mono text-[11px] uppercase text-rose-400">the bench failed</p>
            <p className="mt-1 text-body-sm text-text-2">{error}</p>
            <p className="mt-1 text-body-sm text-text-3">
              Most likely the engine download was blocked. The reasoning still works on paper: count
              the distinct values, ask whether equal values are adjacent, and divide the bit width you
              need by the bit width you store.
            </p>
          </div>
        </div>
      )}

      <div className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              {['column', 'properties', 'your call', 'measured', 'encoding × codec', 'stored'].map((h) => (
                <th key={h} className="py-2 pr-4 font-mono text-[10px] uppercase tracking-wide text-text-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CODEC_COLUMNS.map((c) => {
              const r = results[c.id]
              const guess = predictions[c.id]
              const revealed = !!r && !!guess
              const actual = r ? bucketOf(r.totalRatio) : null
              const wasCommitted = !!committed[c.id]
              const correct = revealed && wasCommitted && guess === actual
              return (
                <tr key={c.id} className="border-b border-line/60 align-top">
                  <td className="py-3 pr-4">
                    <p className="font-mono text-[12px] text-text-1">{c.label}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-text-3">{c.type}</p>
                  </td>
                  <td className="max-w-[15rem] py-3 pr-4 text-body-sm text-text-3">
                    <p>{c.properties.cardinality}</p>
                    <p>{c.properties.ordering}</p>
                    <p>{c.properties.range}</p>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {BUCKETS.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => setPredictions((p) => ({ ...p, [c.id]: b.id }))}
                          aria-pressed={guess === b.id}
                          aria-label={`predict ${b.label} for ${c.label}`}
                          className={cn(
                            'rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors',
                            guess === b.id
                              ? 'border-accent/60 bg-accent/10 text-accent'
                              : 'border-line text-text-3 hover:border-text-3 hover:text-text-2',
                          )}
                        >
                          {b.label}
                        </button>
                      ))}
                    </div>
                    {revealed && !wasCommitted && (
                      <p className="mt-1 font-mono text-[10px] text-text-3">
                        predicted after the run — not scored
                      </p>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {!r ? (
                      <span className="font-mono text-[11px] text-text-3">—</span>
                    ) : !revealed ? (
                      <span className="font-mono text-[11px] text-text-3">predict to reveal</span>
                    ) : (
                      <>
                        <p className="font-mono text-[13px]" style={{ color: trackColor }}>
                          {fmtFactor(r.totalRatio)}
                        </p>
                        <p
                          className={cn(
                            'mt-0.5 font-mono text-[10px]',
                            !wasCommitted
                              ? 'text-text-3'
                              : correct
                                ? 'text-accent'
                                : 'text-amber-400',
                          )}
                        >
                          {!wasCommitted
                            ? bucketLabel(actual!)
                            : correct
                              ? 'hit'
                              : `miss — ${bucketLabel(actual!)}`}
                        </p>
                      </>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {revealed ? (
                      <>
                        <p className="font-mono text-[11.5px] text-text-2">
                          {fmtFactor(r.encodingGain)} × {r.codecGain.toFixed(2)}×
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-text-3">
                          {r.encodings.length > 0 ? r.encodings.join(' + ') : `${r.codec} only`}
                        </p>
                      </>
                    ) : (
                      <span className="font-mono text-[11px] text-text-3">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {revealed ? (
                      <>
                        <p className="font-mono text-[11.5px] text-text-1">{fmtBytes(r.storedBytes)}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-text-3">
                          {fmtBytesPerValue(r.bytesPerValue)}
                        </p>
                      </>
                    ) : (
                      <span className="font-mono text-[11px] text-text-3">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {!measured && !busy && (
        <div className="mt-6 flex items-center gap-2 rounded-md border border-dashed border-line px-4 py-6 text-text-3">
          <Table2 size={15} />
          <span className="font-mono text-[11px]">
            no measurements yet — commit your six predictions, then run
          </span>
        </div>
      )}

      {measured && (
        <div className="mt-6 space-y-4">
          {clustered && shuffled && (
            <div className="rounded-md border border-line px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                cardinality bought the dictionary; ordering bought the runs
              </p>
              <p className="mt-2 text-body-sm text-text-2">
                The first two rows hold the identical multiset of eight strings — same values, same
                counts, same writer, same codec, same row-group size. Sorted, the column stores{' '}
                <strong>{fmtBytes(clustered.storedBytes)}</strong> ({fmtFactor(clustered.totalRatio)}
                ). Shuffled, it stores <strong>{fmtBytes(shuffled.storedBytes)}</strong> (
                {fmtFactor(shuffled.totalRatio)}) — {fmtFactor(shuffled.storedBytes / clustered.storedBytes)}{' '}
                more bytes for the same information. Low cardinality is what makes the dictionary
                work, and that part you keep. Runs are what make it collapse, and runs are a property
                of the order you wrote the rows in — which a shuffle, a merge or a careless{' '}
                <span className="font-mono text-[11.5px]">INSERT</span> can take away without
                changing a single value.
              </p>
            </div>
          )}

          {ts && (
            <div className="rounded-md border border-amber-400/40 px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-amber-400">
                the finding this fixture does not hide
              </p>
              <p className="mt-2 text-body-sm text-text-2">
                The monotone timestamp measured <strong>{fmtFactor(ts.totalRatio)}</strong>. Sorted,
                all-distinct, successive values seconds apart, a range that needs far fewer than 64
                bits — every property says this should be one of the best columns in the table, and
                delta encoding would take it to a couple of bits per value. It does not happen, and
                the footer says why: the encoding is{' '}
                <span className="font-mono text-[11.5px]">
                  {ts.encodings.length > 0 ? ts.encodings.join(' + ') : 'PLAIN'}
                </span>
                . DuckDB’s Parquet writer does not emit{' '}
                <span className="font-mono text-[11.5px]">DELTA_BINARY_PACKED</span>, so no delta
                encoding is applied and the only thing left is Snappy hunting for repeats in a stream
                of eight-byte little-endian integers whose low bytes all differ. It finds the shared
                high-order bytes and little else. A different writer, given the identical column,
                would give you a different answer — so “timestamps compress well” is a claim about a
                writer, not about timestamps, and it is the kind of claim to check on your own stack
                before you put it in a capacity plan.
              </p>
            </div>
          )}

          {clustered && basket && noise && (
            <div className="rounded-md border border-line px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                what the codec actually contributed
              </p>
              <p className="mt-2 text-body-sm text-text-2">
                Split each ratio into the two stages and the argument settles itself. On the clustered
                string the encoding is worth {fmtFactor(clustered.encodingGain)} and Snappy is worth{' '}
                {clustered.codecGain.toFixed(2)}× — at or below 1.0×, because run-length encoding
                already reduced the column to {fmtBytes(clustered.storedBytes)} and framing a nearly
                empty page costs bytes. On the narrow-range integer, encoding is worth{' '}
                {fmtFactor(basket.encodingGain)} and the codec {basket.codecGain.toFixed(2)}×. On the
                random double, both are {noise.codecGain.toFixed(2)}×. In this fixture the codec never
                moves a column between buckets; cardinality, ordering and range decide all six. That
                is the claim at the top of this lab, and it is the reason the interesting lever is how
                you write the data, not which codec you name in the DDL.
              </p>
            </div>
          )}

          {scored.length > 0 && (
            <div className="rounded-md border border-line bg-surface-2/50 px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">your score</p>
              <p className="mt-2 text-body-sm text-text-2">
                {hits.length} of {scored.length} committed predictions landed in the right bucket
                {scored.length < CODEC_COLUMNS.length &&
                  ` (${CODEC_COLUMNS.length - scored.length} column${
                    CODEC_COLUMNS.length - scored.length === 1 ? '' : 's'
                  } had no prediction when you ran, so they are not scored)`}
                . The number to care about is not the score — it is whether you can now say, for a
                column in your own warehouse, which of cardinality, ordering or range is the one
                holding your ratio down. If a miss surprised you, that column is worth measuring on
                your own data before Thursday.
              </p>
            </div>
          )}

          <div className="rounded-md border border-line px-4 py-3">
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              why each column landed where it did
            </p>
            <ul className="mt-2 space-y-2.5">
              {CODEC_COLUMNS.map((c) => {
                const r = results[c.id]
                if (!r || !predictions[c.id]) return null
                return (
                  <li key={c.id} className="text-body-sm text-text-3">
                    <span className="font-mono text-[11.5px] text-text-2">
                      {c.label} — {fmtFactor(r.totalRatio)}
                    </span>
                    <br />
                    {c.why}
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </DuckLabShell>
  )
}
