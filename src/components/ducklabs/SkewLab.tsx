/**
 * SkewLab — the C6 duck lab, and the one that retires a number people quote in
 * capacity reviews.
 *
 * The claim under test is "average partition size tells you nothing; the maximum
 * is the runtime". The lab is built so the first half of that sentence is not an
 * opinion but an identity: the mean is rows ÷ partitions, both constants of the
 * fixture, so it is IDENTICAL across all five distributions — printed as the same
 * digits five times, on purpose. Nothing about the data can move it. The maximum
 * moves by a factor of thirteen over the same five rows.
 *
 * Three design decisions carry the pedagogy:
 *
 *   · The five levels share one table, one row count and one total byte count.
 *     Keys are fixed width, and the payload width varies per row independently of
 *     the key, so no difference on screen can be attributed to the strings.
 *   · Empty partitions stay in the frame. The profile is a LEFT JOIN over
 *     `range(32)`, because an average over the partitions that received work
 *     improves as skew worsens — the idle workers drop out of the denominator.
 *     That is the exact error the lab is about, so it cannot be allowed to happen
 *     inside the lab's own arithmetic.
 *   · The fix is measured with its bill attached. Salting cuts the busiest
 *     partition, and it replicates the other side of the join once per
 *     sub-partition, and it needs a statistics pass to know which keys to salt.
 *     A lab that showed only the first of those three would be selling something.
 *
 * What is real: the distribution, the partition assignment (`hash(key) % 32`,
 * evaluated by DuckDB) and every count. What is modelled: the shuffle. Nothing
 * here moves a byte between processes, and the panel at the bottom says so and
 * names what a real exchange adds.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Play, ShieldCheck, Split, Table2 } from 'lucide-react'
import { DuckLabShell, type DuckTask } from '@/components/ducklabs/shell'
import { fmtBytes } from '@/lib/duckdb/bill'
import { fmtCount } from '@/lib/duckdb/pruning'
import {
  HEAVY_SHARE,
  HOT_KEY,
  SALT_BUCKETS,
  SKEW_KEYS,
  SKEW_LEVELS,
  SKEW_PARTITIONS,
  SKEW_ROWS,
  bytesConserved,
  fmtRatio,
  fmtShare,
  hashPartitionExpr,
  keyColumn,
  loadSkewFixture,
  maxRises,
  meanIsFlat,
  measureAllSkew,
  skewFixtureSql,
  type SkewGrid,
  type SkewMeasurement,
} from '@/lib/duckdb/skew'
import { cn } from '@/lib/utils'

/** The control (uniform) and the worst level, named once so the copy cannot drift. */
const CONTROL = SKEW_LEVELS[0]
const WORST = SKEW_LEVELS[SKEW_LEVELS.length - 1]

/** Graded thresholds. Bands, because they are cost claims — see the panel below. */
const CONTROL_CEILING = 1.5
const WORST_FLOOR = 8
const SALT_IMPROVEMENT = 3
const SALT_CEILING = 4

export default function SkewLab({ trackColor }: { trackColor: string }) {
  const [status, setStatus] = useState<string>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [grid, setGrid] = useState<SkewGrid>({})
  /** Which level the per-partition profile is drawn for. Switching costs no re-run. */
  const [shown, setShown] = useState<string>(WORST.id)
  const [routing, setRouting] = useState<'hash' | 'salted'>('hash')

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await loadSkewFixture((s) => setStatus(s))
      setGrid(await measureAllSkew((s) => setStatus(s)))
      setStatus('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('failed')
    } finally {
      setBusy(false)
    }
  }, [])

  const measured = Object.keys(grid).length === SKEW_LEVELS.length
  const rows = useMemo(
    () => SKEW_LEVELS.map((l) => ({ level: l, m: grid[l.id] })),
    [grid],
  )

  const control = grid[CONTROL.id]
  const worst = grid[WORST.id]
  const shownM = grid[shown]
  const shownStats = shownM ? shownM[routing] : undefined

  const anomalies = useMemo(
    () => Object.values(grid).filter((m) => m.anomaly !== null),
    [grid],
  )

  const flat = useMemo(() => (measured ? meanIsFlat(grid) : false), [grid, measured])
  const rises = useMemo(() => (measured ? maxRises(grid) : false), [grid, measured])
  const conserved = useMemo(() => (measured ? bytesConserved(grid) : false), [grid, measured])

  const saltCut =
    !!worst && worst.salted.rowSkew > 0
      ? worst.hash.rowSkew / worst.salted.rowSkew
      : 0

  const tasks: DuckTask[] = useMemo(
    () => [
      {
        id: 'run',
        label: `Generate ${fmtCount(SKEW_ROWS)} rows and measure all ${SKEW_PARTITIONS} partitions under all ${SKEW_LEVELS.length} distributions`,
        done: measured,
        hint: 'Press run. One table, one key column per distribution, and a per-partition row and byte count read straight out of the data.',
      },
      {
        id: 'mean-flat',
        label: 'Observe the mean partition size come out IDENTICAL under every distribution',
        done: flat,
        hint: `It is ${fmtCount(SKEW_ROWS)} ÷ ${SKEW_PARTITIONS} and nothing else. A statistic that cannot respond to the data is not telling you about the data.`,
      },
      {
        id: 'max-rises',
        label: `Observe the busiest partition rise monotonically and pass ${WORST_FLOOR}× the mean at ${WORST.label}`,
        done: rises && !!worst && worst.hash.rowSkew >= WORST_FLOOR,
        hint: 'Same mean, same total bytes, same partition count. Only the distribution moved, and the maximum moved with it.',
      },
      {
        id: 'floor',
        label: `Observe the uniform control sitting under ${CONTROL_CEILING}× — the floor a hash partitioning cannot go below`,
        done: !!control && control.hash.rowSkew <= CONTROL_CEILING && control.hash.rowSkew >= 1,
        hint: 'Even with a perfectly flat key distribution the maximum exceeds the mean, because 4,096 keys do not divide evenly into 32 buckets. Skew is never exactly 1.00×.',
      },
      {
        id: 'salt',
        label: `Observe salting the heavy hitter cut the maximum by at least ${SALT_IMPROVEMENT}× and land under ${SALT_CEILING}×`,
        done:
          !!worst &&
          saltCut >= SALT_IMPROVEMENT &&
          worst.salted.rowSkew <= SALT_CEILING &&
          worst.salted.rowSkew > 1,
        hint: `Switch the profile below to the salted routing. The hot key is split across ${SALT_BUCKETS} sub-partitions, which bounds its contribution at its share ÷ ${SALT_BUCKETS} — it does not remove it.`,
      },
      {
        id: 'conserved',
        label: 'Observe 0 rows and 0 bytes invented or lost by either routing, in every distribution',
        done: conserved,
        hint: 'Re-partitioning moves work; it must not change the answer. This is the one number here that is correctness rather than cost.',
      },
      {
        id: 'salt-cost',
        label: 'Observe what the fix costs on the other side of the join',
        done: !!worst && worst.dimRowsSalted > worst.dimRows && worst.heavyKeys > 0,
        hint: `Every salted key needs its dimension row in all ${SALT_BUCKETS} sub-partitions, or the salted rows find no match. The lab counts the expanded build side rather than asserting it is cheap.`,
      },
    ],
    [measured, flat, rises, conserved, control, worst, saltCut],
  )

  return (
    <DuckLabShell labId="skew-lab" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        This runs <strong>DuckDB</strong> in this tab over {fmtCount(SKEW_ROWS)} rows and{' '}
        {fmtCount(SKEW_KEYS)} join keys, drawn five times into five shapes: uniform, a Zipf-ish
        tail, and one key holding 5%, 20% and 45% of the table. Each shape is hash-partitioned{' '}
        {SKEW_PARTITIONS} ways with{' '}
        <span className="font-mono text-[11.5px]">{hashPartitionExpr('join_key')}</span>, and every
        row and byte count below is a SQL aggregate over the actual values.
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
            · <strong>The partition sizes are measured; the shuffle is modelled.</strong> Nothing
            here moves a byte between processes. This computes where every row WOULD go and how much
            each destination WOULD hold, which is the part of a shuffle that layout and keys decide.
            A real exchange adds three things it cannot show: <strong>network transfer</strong> of
            the partitioned bytes, <strong>spilling</strong> when one partition outgrows a worker’s
            memory — the point at which a 15× partition stops costing 15× and starts costing
            whatever the disk costs — and <strong>work stealing or adaptive re-partitioning</strong>,
            where a planner that notices the skew at runtime splits the offending partition itself.
          </li>
          <li>
            · Bytes are the <strong>logical width of the values</strong> —{' '}
            <span className="font-mono text-[11.5px]">octet_length(key) + octet_length(payload) + 8</span>{' '}
            — not on-the-wire encoded bytes. Ratios between partitions are what transfer; the
            absolute totals are a fixture, not a benchmark.
          </li>
          <li>
            · The <strong>mean is total ÷ {SKEW_PARTITIONS}</strong>, always, including partitions
            that received nothing. An average over the partitions that got work would improve as
            skew got worse, which is the mistake this lab is about.
          </li>
          <li>
            · Anything that comes out against the story above is printed in the anomalies panel
            rather than dropped.
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
        {measured && (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-[11px]"
            style={{ color: conserved ? trackColor : '#FB7185' }}
          >
            <ShieldCheck size={12} />
            {conserved
              ? '0 rows and 0 bytes invented or lost'
              : 'the partitioning did not conserve the table'}
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
              Most likely the engine download was blocked. The arithmetic still works on paper: a key
              holding fraction <em>f</em> of the rows puts <em>f</em> of the table on one worker,
              so the busiest partition is <em>f</em> × {SKEW_PARTITIONS} times the mean the moment{' '}
              <em>f</em> exceeds 1/{SKEW_PARTITIONS}.
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
          {/* -------------------- the mean against the maximum -------------------- */}
          <section>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
              the mean against the maximum
            </p>
            <p className="mt-1 max-w-2xl text-body-sm text-text-3">
              Five distributions, one table, {fmtCount(SKEW_ROWS)} rows and{' '}
              {SKEW_PARTITIONS} partitions in every row. Read the mean column downwards first.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    {[
                      'distribution',
                      'busiest key',
                      'mean rows/partition',
                      'max rows',
                      'max ÷ mean',
                      'max bytes',
                      'bytes max ÷ mean',
                      'salted max ÷ mean',
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
                  {rows.map(({ level, m }) => {
                    if (!m) return null
                    const hot = m.topKeys[0]
                    const bad = m.hash.rowSkew >= 2
                    return (
                      <tr key={level.id} className="border-b border-line/60 align-top">
                        <td className="py-3 pr-4">
                          <p className="font-mono text-[12px] text-text-1">{level.label}</p>
                          <p className="mt-1 max-w-sm text-body-sm text-text-3">{level.why}</p>
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {hot ? (
                            <>
                              {hot.key}
                              <span className="block text-[10px] text-text-3">
                                {fmtShare(hot.share)} of the table
                              </span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtCount(m.hash.meanRows)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-1">
                          {fmtCount(m.hash.maxRows)}
                          <span className="block text-[10px] text-text-3">
                            partition {m.hash.busiestPartition}
                          </span>
                        </td>
                        <td
                          className="py-3 pr-4 font-mono text-[12px]"
                          style={{ color: bad ? '#FB7185' : trackColor }}
                        >
                          {fmtRatio(m.hash.rowSkew)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtBytes(m.hash.maxBytes)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px] text-text-2">
                          {fmtRatio(m.hash.byteSkew)}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[12px]" style={{ color: trackColor }}>
                          {fmtRatio(m.salted.rowSkew)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {control && worst && (
              <div className="mt-4 rounded-md border border-line px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  the claim under test
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  The mean is <strong>{fmtCount(control.hash.meanRows)}</strong> rows in every row of
                  that table, because it is {fmtCount(SKEW_ROWS)} ÷ {SKEW_PARTITIONS} and neither
                  number knows anything about the keys. Over the same five rows the busiest partition
                  goes from {fmtCount(control.hash.maxRows)} rows to{' '}
                  <strong>{fmtCount(worst.hash.maxRows)}</strong> —{' '}
                  {fmtRatio(worst.hash.maxRows / Math.max(control.hash.maxRows, 1))} — and the last
                  worker is holding {fmtRatio(worst.hash.rowSkew)} the mean. Thirty-one workers
                  finish and wait. A capacity model built on the mean reports the same number for
                  both rows, and a dashboard plotting average partition size shows a flat line
                  through the incident.
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  The arithmetic is worth carrying out of here, because it is one multiplication: a
                  key holding fraction <em>f</em> of the rows lands entirely on one partition, so the
                  busiest partition is at least <em>f</em> × {SKEW_PARTITIONS} times the mean. The
                  fair share is 1/{SKEW_PARTITIONS} = {fmtShare(HEAVY_SHARE)}. Above that, one key
                  sets the runtime and adding workers makes it <em>worse</em> — the mean falls, the
                  maximum does not move, and the ratio you are being judged on gets uglier.
                </p>
              </div>
            )}
          </section>

          {/* ------------------------ the per-partition profile ------------------- */}
          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                  every partition, including the empty ones
                </p>
                <p className="mt-1 max-w-2xl text-body-sm text-text-3">
                  All {SKEW_PARTITIONS} destinations, in id order. The dashed line is the mean. The
                  bar that clears it is the job.
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {SKEW_LEVELS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setShown(l.id)}
                    aria-pressed={shown === l.id}
                    className={cn(
                      'rounded-sm border px-2 py-0.5 font-mono text-[10.5px] transition-colors',
                      shown === l.id
                        ? 'border-accent/60 bg-accent/10 text-accent'
                        : 'border-line text-text-3 hover:border-text-3 hover:text-text-2',
                    )}
                  >
                    {l.label}
                  </button>
                ))}
                {(['hash', 'salted'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRouting(r)}
                    aria-pressed={routing === r}
                    className={cn(
                      'rounded-sm border px-2 py-0.5 font-mono text-[10.5px] transition-colors',
                      routing === r
                        ? 'border-accent/60 bg-accent/10 text-accent'
                        : 'border-line text-text-3 hover:border-text-3 hover:text-text-2',
                    )}
                  >
                    {r === 'hash' ? 'hash(key) % 32' : `salted ×${SALT_BUCKETS}`}
                  </button>
                ))}
              </div>
            </div>

            {shownStats && (
              <>
                <div className="mt-3 flex h-40 items-end gap-[3px] border-b border-l border-line pl-1">
                  {shownStats.profile.map((p) => {
                    const h = (p.rows / Math.max(shownStats.maxRows, 1)) * 100
                    const over = p.rows > shownStats.meanRows
                    return (
                      <div
                        key={p.pid}
                        title={`partition ${p.pid}: ${fmtCount(p.rows)} rows, ${fmtBytes(p.bytes)}`}
                        className="flex-1 rounded-t-sm"
                        style={{
                          height: `${Math.max(h, 1)}%`,
                          backgroundColor: over ? '#FB7185' : trackColor,
                          opacity: over ? 0.85 : 0.5,
                        }}
                      />
                    )
                  })}
                </div>
                <div className="relative">
                  <p className="mt-2 font-mono text-[10.5px] text-text-3">
                    mean {fmtCount(shownStats.meanRows)} rows ·{' '}
                    {shownStats.profile.filter((p) => p.rows > shownStats.meanRows).length} partitions
                    above it · busiest {fmtCount(shownStats.maxRows)} (
                    {fmtRatio(shownStats.rowSkew)}) · quietest {fmtCount(shownStats.minRows)} ·{' '}
                    {shownStats.partitionsEmpty} empty
                  </p>
                </div>
              </>
            )}
          </section>

          {/* ------------------------------- the fix ------------------------------ */}
          {worst && (
            <section>
              <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
                <Split size={12} /> the fix, and its bill
              </p>
              <p className="mt-1 max-w-2xl text-body-sm text-text-3">
                Keys above the fair-share line are found in the data —{' '}
                <span className="font-mono text-[11.5px]">
                  HAVING count(*) &gt; {fmtCount(Math.floor(SKEW_ROWS * HEAVY_SHARE))}
                </span>{' '}
                — and their rows are spread across {SALT_BUCKETS} adjacent partitions by a per-row
                salt. Everything else stays where the hash put it.
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Panel label={`${WORST.label} · hash(key) % ${SKEW_PARTITIONS}`}>
                  <Line k="busiest partition" v={`${fmtCount(worst.hash.maxRows)} rows`} />
                  <Line k="max ÷ mean" v={fmtRatio(worst.hash.rowSkew)} bad />
                  <Line k="quietest partition" v={`${fmtCount(worst.hash.minRows)} rows`} />
                  <Line k="build side" v={`${fmtCount(worst.dimRows)} rows`} />
                </Panel>
                <Panel label={`${WORST.label} · salted ×${SALT_BUCKETS}`}>
                  <Line k="busiest partition" v={`${fmtCount(worst.salted.maxRows)} rows`} />
                  <Line k="max ÷ mean" v={fmtRatio(worst.salted.rowSkew)} good />
                  <Line k="quietest partition" v={`${fmtCount(worst.salted.minRows)} rows`} />
                  <Line
                    k="build side"
                    v={`${fmtCount(worst.dimRowsSalted)} rows (${fmtRatio(worst.dimReplication)})`}
                  />
                </Panel>
              </div>

              <div className="mt-3 rounded-md border border-line px-4 py-3">
                <p className="text-body-sm text-text-2">
                  Salting took the busiest partition from {fmtRatio(worst.hash.rowSkew)} to{' '}
                  {fmtRatio(worst.salted.rowSkew)} the mean — a {fmtRatio(saltCut)} improvement — and
                  it did not reach 1.00×, which is the honest part. Splitting a key that holds{' '}
                  {fmtShare(worst.topKeys[0]?.share ?? 0)} of the table {SALT_BUCKETS} ways bounds its
                  contribution at {fmtShare((worst.topKeys[0]?.share ?? 0) / SALT_BUCKETS)} per
                  sub-partition, and those sub-partitions still carry their ordinary traffic on top.
                  More salt buckets push it lower; the limit is not the arithmetic, it is the bill
                  beside it.
                </p>
                <p className="mt-2 text-body-sm text-text-2">
                  That bill has three lines and only one of them is bytes.{' '}
                  <strong>The build side is replicated:</strong> {worst.heavyKeys} salted key
                  {worst.heavyKeys === 1 ? '' : 's'} needs its row in all {SALT_BUCKETS}
                  {' '}sub-partitions, taking the build side from {fmtCount(worst.dimRows)} to{' '}
                  {fmtCount(worst.dimRowsSalted)} rows — measured here by materialising the expansion
                  rather than by multiplying it out in prose. <strong>The salt needs statistics:</strong>{' '}
                  a pass over the key column to find out which keys are heavy, which is a count you
                  now owe on every run because yesterday’s hot key is not necessarily today’s.{' '}
                  <strong>And the plan is now key-specific</strong> — it is correct only while the
                  heavy set it was built for is still the heavy set.
                </p>
              </div>
            </section>
          )}

          {/* ---------------------------- the invariant --------------------------- */}
          <section>
            <div className="rounded-md border border-line bg-surface-2/50 px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                the invariant — {conserved ? '0' : 'NOT 0'} rows and bytes invented or lost
              </p>
              <p className="mt-2 text-body-sm text-text-2">
                Every routing above is checked against the table it partitioned: the sum of the{' '}
                {SKEW_PARTITIONS} partition row counts must equal{' '}
                {worst ? fmtCount(worst.tableRows) : fmtCount(SKEW_ROWS)}, and the sum of the
                partition byte counts must equal the table’s byte total to the byte
                {worst ? ` (${fmtBytes(worst.tableBytes)})` : ''}. Both are counted twice, once with
                a partitioning and once without.{' '}
                {conserved
                  ? 'They agree in every level, under both routings.'
                  : 'They do not agree, which is reported as a bug below rather than smoothed.'}
              </p>
              <p className="mt-2 text-body-sm text-text-2">
                That asymmetry is the point, and it is the same one the whole course turns on.{' '}
                <strong>Skew is a cost claim, so it is graded in bands</strong> — {WORST_FLOOR}× at
                the top level, under {CONTROL_CEILING}× at the control, a factor of{' '}
                {SALT_IMPROVEMENT} from the salt. Those numbers depend on the hash function, the
                partition count and the seed, and a band is the honest way to state them.{' '}
                <strong>Conservation is a correctness claim, so it is graded as an absolute:</strong>{' '}
                exactly 0. A re-partitioning that loses a row has not made the job faster, it has
                made the answer wrong — and salting is precisely the kind of change that can do it,
                which is why the build-side replication above is measured rather than assumed.
              </p>
            </div>
          </section>

          {/* ---------------------------- anomalies ------------------------------- */}
          {anomalies.length > 0 && (
            <section>
              <div className="rounded-md border border-amber-400/40 px-4 py-3">
                <p className="font-mono text-[11px] uppercase tracking-wide text-amber-400">
                  {anomalies.length} result{anomalies.length === 1 ? '' : 's'} that came out against
                  the expected story
                </p>
                <ul className="mt-2 space-y-1.5">
                  {anomalies.map((m: SkewMeasurement) => (
                    <li key={m.levelId} className="text-body-sm text-text-3">
                      <span className="font-mono text-[11.5px] text-text-2">{m.levelId}</span>
                      <br />
                      {m.anomaly}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* --------------------------- reproduction ----------------------------- */}
          <section>
            <div className="rounded-md border border-line px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
                the fixture, in full
              </p>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-text-3">
                {skewFixtureSql().trim()}
              </pre>
              <p className="mt-2 text-body-sm text-text-3">
                The heavy hitter is <span className="font-mono text-[11.5px]">{HOT_KEY}</span>, and
                the key column for the worst level is{' '}
                <span className="font-mono text-[11.5px]">{keyColumn(WORST)}</span>. The same DDL and
                the same measurement functions run against native DuckDB in{' '}
                <span className="font-mono text-[11.5px]">tests/skew-lab.test.ts</span>, which
                asserts the mean is flat and the maximum rises as bands, and asserts row and byte
                conservation as absolutes.
              </p>
            </div>
          </section>
        </div>
      )}
    </DuckLabShell>
  )
}

/* ------------------------------- fragments ------------------------------ */

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-line px-4 py-3">
      <p className="font-mono text-[10.5px] uppercase tracking-wide text-text-3">{label}</p>
      <div className="mt-2 space-y-1">{children}</div>
    </div>
  )
}

function Line({ k, v, bad, good }: { k: string; v: string; bad?: boolean; good?: boolean }) {
  return (
    <p className="flex items-baseline justify-between gap-3 font-mono text-[11.5px]">
      <span className="text-text-3">{k}</span>
      <span className={cn(bad && 'text-rose-400', good && 'text-accent', !bad && !good && 'text-text-1')}>
        {v}
      </span>
    </p>
  )
}
