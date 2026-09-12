/**
 * ScanArithmeticLab — the C0 browser lab.
 *
 * C0.L1 states the bill as `projection × pruning × frequency` and then makes one
 * claim about it that the reader is expected to carry for the rest of the
 * course: **the weakest factor dominates.** This lab is where that stops being a
 * sentence. Three dials, one product, and the product written out as three
 * divisions the reader can redo on paper.
 *
 * The teaching is structural rather than stated, three ways:
 *
 *   1. THE FACTOR AT 1× IS ALWAYS THE FACTOR WITH THE MOST HEADROOM. That is a
 *      property of the model — `mostHeadroom` is computed as `max ÷ current` per
 *      axis, and the test suite sweeps all 48 configurations to check that
 *      whenever any factor sits at 1×, that axis is the one with the most
 *      multiplier still available. So "fix the 1× factor first" is something the
 *      reader can verify rather than advice they have to take.
 *   2. THE GRADED PICK ASKS FOR THE 1× FACTOR, TWICE, ON TWO DIFFERENT AXES.
 *      Naming it once is luck. Naming a second one means the reader had to put a
 *      different factor back to 1× and notice that which factor is starved is a
 *      property of THEIR choices, not of the workload.
 *   3. THE TARGET IS PAIRED WITH A FRESHNESS CEILING, so the frequency lever —
 *      the one every team pulls, because it is the only one on a dashboard —
 *      cannot answer the whole lab. Exactly two of the 48 configurations satisfy
 *      both, and the configuration that minimises bytes per day is not one of
 *      them: it misses the ceiling by 4×.
 *
 * All arithmetic lives in `@/lib/scan/arithmetic`. Every number is a COUNT —
 * bytes, blocks, runs per day — and every run is deterministic: the sample
 * workload comes from the seeded xorshift in `desks/kit`, and there is no
 * wall-clock and no `Math.random` anywhere beneath this file.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Clock, Columns3, Filter, Target, TrendingDown, X } from 'lucide-react'
/* LabShell comes from the registry module, which will import this component back
 * once the orchestrator wires it. The cycle is safe because both sides only
 * touch each other at RENDER time (hoisted function declarations), never during
 * module initialisation — and `LabTask` is imported as a type, so it contributes
 * no runtime edge at all. */
import { LabShell } from '@/components/browserlabs'
import type { LabTask } from '@/components/browserlabs/shared'
import { fmtBytes, fmtCount, pct } from '@/lib/desks/kit'
import {
  BASELINE_RUNS_PER_DAY,
  BLOCKS,
  CHOICE_GRID,
  COLUMN_COUNT,
  FACTOR_ATTACKS,
  FACTOR_IDS,
  FACTOR_LABEL,
  FREQUENCIES,
  OPENING_CHOICE,
  OTHER_BYTES,
  OTHER_COLUMNS,
  PROJECTIONS,
  PRUNINGS,
  ROWS,
  ROWS_PER_BLOCK,
  ROW_BYTES,
  SCHEMA,
  TARGETS,
  axisChanged,
  bestWithAxisAtOne,
  cheapestChoice,
  choiceKey,
  factorValue,
  frequency,
  projection,
  pruning,
  sampleWorkload,
  scanBill,
  solvingChoices,
  stepGain,
  weakestHistogram,
  type FactorId,
  type ScanChoice,
} from '@/lib/scan/arithmetic'
import { cn } from '@/lib/utils'

/** A multiplier reads better as 14.3× than as 14.285714×. */
const fmtFactor = (v: number): string =>
  v >= 1000 ? `${Math.round(v).toLocaleString('en-US')}×` : v >= 100 ? `${v.toFixed(0)}×` : `${v.toFixed(2)}×`

export default function ScanArithmeticLab({ trackColor }: { trackColor: string }) {
  /* Every configuration the reader has priced, oldest first. Keeping the trail
   * rather than a pile of booleans means the latched tasks below are DERIVED
   * from what happened, not from an effect that fired at the right moment. */
  const [visited, setVisited] = useState<ScanChoice[]>([OPENING_CHOICE])
  const [pick, setPick] = useState<FactorId | null>(null)
  const [namedRight, setNamedRight] = useState<FactorId[]>([])

  const choice = visited[visited.length - 1]
  const bill = useMemo(() => scanBill(choice), [choice])
  const solving = useMemo(() => solvingChoices(), [])
  const cheapest = useMemo(() => cheapestChoice(), [])
  const cheapestBill = useMemo(() => scanBill(cheapest), [cheapest])
  const histogram = useMemo(() => weakestHistogram(), [])
  const workload = useMemo(() => sampleWorkload(), [])

  const choose = useCallback((patch: Partial<ScanChoice>) => {
    setVisited((prev) => [...prev, { ...prev[prev.length - 1], ...patch }])
    setPick(null)
  }, [])

  /* Graded against the configuration in front of the reader at the moment they
   * answer, and a correct answer is remembered per axis — so the second task can
   * ask for a different starved factor and mean it. */
  const nameIt = useCallback(
    (id: FactorId) => {
      setPick(id)
      if (id === bill.mostHeadroom) {
        setNamedRight((prev) => (prev.includes(id) ? prev : [...prev, id]))
      }
    },
    [bill.mostHeadroom],
  )

  /* Did the reader improve the axis that was at 1×, rather than the one they had
   * most recently improved? Derived from the trail: a move counts when the axis
   * it changed was the weakest axis in the configuration BEFORE the move. */
  const fixedTheWeakest = useMemo(() => {
    for (let i = 1; i < visited.length; i++) {
      const before = scanBill(visited[i - 1])
      const axis = axisChanged(visited[i - 1], visited[i])
      if (!axis) continue
      if (axis === before.mostHeadroom && factorValue(visited[i], axis) > factorValue(visited[i - 1], axis)) {
        return true
      }
    }
    return false
  }, [visited])

  /** And the contrast: an improvement to a factor that was NOT the starved one. */
  const improvedTheWrongOne = useMemo(() => {
    for (let i = 1; i < visited.length; i++) {
      const before = scanBill(visited[i - 1])
      const axis = axisChanged(visited[i - 1], visited[i])
      if (!axis) continue
      if (
        before.factorsAtOne.length > 0 &&
        axis !== before.mostHeadroom &&
        factorValue(visited[i], axis) > factorValue(visited[i - 1], axis)
      ) {
        return true
      }
    }
    return false
  }, [visited])

  const hitTarget = useMemo(() => visited.some((c) => scanBill(c).ok), [visited])
  const sawCheapest = useMemo(
    () => visited.some((c) => choiceKey(c) === choiceKey(cheapest)),
    [visited, cheapest],
  )

  const tasks: LabTask[] = useMemo(
    () => [
      {
        id: 'name-one',
        label: 'Name the factor that is currently 1× — the one with all its headroom untouched',
        done: namedRight.length >= 1,
        hint: 'Read the headroom column, not the bill. A factor at 1× has its whole multiplier still on the table.',
      },
      {
        id: 'fix-one',
        label: 'Improve THAT factor, rather than the one you improved last',
        done: fixedTheWeakest,
        hint: 'The product is a product: moving a factor from 1× to 20× multiplies the total by 20, and moving one from 14× to 25× multiplies it by 1.75.',
      },
      {
        id: 'wrong-lever',
        label: 'For the contrast: improve a factor that is NOT the 1× one, and read how little the total moved',
        done: improvedTheWrongOne,
        hint: 'This is the mistake C0.L1 names — teams optimise the factor they most recently read about and report a disappointing improvement.',
      },
      {
        id: 'name-two',
        label: 'Put a DIFFERENT factor back to 1× and name that one too',
        done: namedRight.length >= 2,
        hint: 'Which factor is starved is a property of your three choices, not of the workload. Prove it by moving it.',
      },
      {
        id: 'cheapest',
        label: 'Price the configuration with the smallest bill in the whole space, and read what it costs you',
        done: sawCheapest,
        hint: `${fmtFactor(cheapestBill.totalFactor)} in total — and the answer on the dashboard is up to ${cheapestBill.stalenessMinutes} minutes old, which is ${(cheapestBill.stalenessMinutes / TARGETS.stalenessMinutes).toFixed(0)}× the freshness ceiling.`,
      },
      {
        id: 'target',
        label: `Reach ${fmtFactor(TARGETS.totalFactor)} total reduction while keeping the answer no more than ${TARGETS.stalenessMinutes} minutes stale`,
        done: hitTarget,
        hint: `${solving.length} of the ${CHOICE_GRID.length} configurations do both. Under the ceiling, no factor may be left at 1×: the best you can reach with one at 1× is ${fmtFactor(Math.max(...FACTOR_IDS.map((a) => bestWithAxisAtOne(a, true))))}.`,
      },
    ],
    [
      namedRight.length,
      fixedTheWeakest,
      improvedTheWrongOne,
      sawCheapest,
      hitTarget,
      solving.length,
      cheapestBill,
    ],
  )

  return (
    <LabShell labId="scan-arithmetic" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        One table — <span className="font-mono text-[11.5px] text-text-1">orders</span>,{' '}
        {fmtCount(ROWS)} rows, {COLUMN_COUNT} columns, {ROW_BYTES} B per row — and one dashboard
        query. The bill is a <strong>product of three factors</strong>, and you set all three. Every
        number below is a count, and every factor is written as the division that produced it, so you
        can check the whole page on paper.
      </p>
      <p className="mt-2 text-body-sm text-text-3">
        Nothing here is timed and nothing here is a price. The output is bytes that had to leave
        storage, per pass and per day; what that costs depends on the storage regime, which is C0.L3’s
        subject rather than this lab’s.
      </p>

      {/* -------------------------------- schema ------------------------------ */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
          the schema, by width — {fmtCount(ROW_BYTES)} B per row
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SCHEMA.map((c) => (
            <span
              key={c.name}
              title={c.note}
              className={cn(
                'rounded-sm border px-2 py-0.5 font-mono text-[10.5px]',
                projection(choice.projection).columns === null ||
                  projection(choice.projection).columns?.includes(c.name)
                  ? 'text-text-1'
                  : 'border-line text-text-3',
              )}
              style={
                projection(choice.projection).columns === null ||
                projection(choice.projection).columns?.includes(c.name)
                  ? { borderColor: trackColor, backgroundColor: `${trackColor}1a` }
                  : undefined
              }
            >
              {c.name} {c.bytes}B
            </span>
          ))}
          <span className="rounded-sm border border-line px-2 py-0.5 font-mono text-[10.5px] text-text-3">
            + {OTHER_COLUMNS} more columns, {OTHER_BYTES} B
          </span>
        </div>
        <p className="mt-2 font-mono text-[10.5px] text-text-3">
          projected: {fmtCount(bill.columnsProjected)} of {COLUMN_COUNT} columns ·{' '}
          {bill.bytesPerRowProjected} B of {ROW_BYTES} B per row
        </p>
      </div>

      {/* --------------------------------- knobs ------------------------------ */}
      <div className="mt-5 space-y-3">
        <Knob
          icon={<Columns3 size={13} />}
          label="projection"
          note={`${FACTOR_ATTACKS.projection} · ${bill.bytesPerRowProjected} B of ${ROW_BYTES} B`}
        >
          {PROJECTIONS.map((p) => (
            <Chip
              key={p.id}
              active={choice.projection === p.id}
              color={trackColor}
              onClick={() => choose({ projection: p.id })}
            >
              {p.label} · {p.bytesPerRow}B
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<Filter size={13} />}
          label="pruning"
          note={`${FACTOR_ATTACKS.pruning} · ${fmtCount(bill.blocksRead)} of ${fmtCount(BLOCKS)} blocks read · ${fmtCount(ROWS_PER_BLOCK)} rows per block`}
        >
          {PRUNINGS.map((p) => (
            <Chip
              key={p.id}
              active={choice.pruning === p.id}
              color={trackColor}
              onClick={() => choose({ pruning: p.id })}
            >
              {p.label}
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<Clock size={13} />}
          label="frequency"
          note={`${FACTOR_ATTACKS.frequency} · ${fmtCount(bill.runsPerDay)} of ${fmtCount(BASELINE_RUNS_PER_DAY)} runs per day · answer up to ${bill.stalenessMinutes} min old`}
        >
          {FREQUENCIES.map((f) => (
            <Chip
              key={f.id}
              active={choice.frequency === f.id}
              color={trackColor}
              onClick={() => choose({ frequency: f.id })}
            >
              {f.label}
            </Chip>
          ))}
        </Knob>
      </div>

      <p className="mt-2 font-mono text-[10.5px] text-text-3">
        {projection(choice.projection).line} · {pruning(choice.pruning).line} ·{' '}
        {frequency(choice.frequency).line}
      </p>

      {/* ------------------------------- the product -------------------------- */}
      <div className="mt-6 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              {['factor', 'what it attacks', 'the division', 'multiplier', 'headroom left', 'one step buys'].map(
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
            {bill.factors.map((f) => {
              const starved = f.id === bill.mostHeadroom
              return (
                <tr
                  key={f.id}
                  className={cn('border-b border-line/60 align-top', starved && 'bg-rose-400/[0.06]')}
                >
                  <td className="py-2.5 pr-4 font-mono text-[12px] text-text-1">{f.label}</td>
                  <td className="py-2.5 pr-4 text-body-sm text-text-3">{FACTOR_ATTACKS[f.id]}</td>
                  <td className="py-2.5 pr-4 font-mono text-[11.5px] text-text-2">
                    {fmtCount(f.numerator)} ÷ {fmtCount(f.denominator)}
                    <span className="block text-[10px] text-text-3">{f.unit}</span>
                  </td>
                  <td
                    className="py-2.5 pr-4 font-mono text-[13px]"
                    style={{ color: f.atOne ? '#FB7185' : trackColor }}
                  >
                    {fmtFactor(f.value)}
                    {f.atOne && <span className="block text-[10px] uppercase">untouched</span>}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-[12px] text-text-2">
                    {fmtFactor(f.headroom)}
                    <span className="block text-[10px] text-text-3">best here is {fmtFactor(f.max)}</span>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-[12px] text-text-2">
                    {stepGain(choice, f.id) === 1 ? '— at the top' : `${fmtFactor(stepGain(choice, f.id))} on the total`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* -------------------------------- the bill ---------------------------- */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="the product"
          value={fmtFactor(bill.totalFactor)}
          sub={`${fmtFactor(bill.projectionFactor)} × ${fmtFactor(bill.pruningFactor)} × ${fmtFactor(bill.frequencyFactor)} — the three multipliers, multiplied`}
          color={trackColor}
        />
        <Metric
          label="bytes per pass"
          value={fmtBytes(bill.bytesPerPass)}
          sub={`${fmtCount(bill.rowsRead)} rows read × ${bill.bytesPerRowProjected} B projected`}
        />
        <Metric
          label="bytes per day"
          value={fmtBytes(bill.bytesPerDay)}
          sub={`× ${fmtCount(bill.runsPerDay)} runs — against ${fmtBytes(bill.baselineBytesPerDay)} for select * on every block, every minute`}
        />
        <Metric
          label="blocks skipped unread"
          value={pct(bill.prunedRatio)}
          sub={`${fmtCount(BLOCKS - bill.blocksRead)} of ${fmtCount(BLOCKS)} blocks never opened`}
        />
      </div>

      {/* ------------------------------ the 1× panel -------------------------- */}
      <div
        className={cn(
          'mt-5 rounded-md border px-4 py-3',
          bill.factorsAtOne.length > 0
            ? 'border-rose-400/40 bg-rose-400/[0.04]'
            : 'border-line bg-surface-2/50',
        )}
      >
        <p
          className={cn(
            'flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide',
            bill.factorsAtOne.length > 0 ? 'text-rose-400' : 'text-text-3',
          )}
        >
          <TrendingDown size={12} />
          {bill.factorsAtOne.length > 0
            ? `at 1×: ${bill.factorsAtOne.map((id) => FACTOR_LABEL[id]).join(', ')}`
            : 'every factor is above 1×'}
        </p>
        <p className="mt-2 text-body-sm text-text-2">
          The factor with the most multiplier still available is{' '}
          <strong>{FACTOR_LABEL[bill.mostHeadroom]}</strong>, at {fmtFactor(bill.factors.find((f) => f.id === bill.mostHeadroom)?.headroom ?? 1)}{' '}
          of headroom.{' '}
          {bill.factorsAtOne.length > 0
            ? 'It is also a factor sitting at exactly 1× — which is not a coincidence and is not a claim this page is making at you: it holds for all 48 configurations in this space, and the test suite sweeps every one of them.'
            : 'No factor is at 1× any more, so the remaining gains are ordinary rather than structural — this is the point where the next improvement gets hard, and where saying so is the professional move.'}
        </p>
      </div>

      {/* -------------------------------- the pick ---------------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="text-body-sm text-text-2">
          Which factor has the most headroom left in the configuration above?
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {FACTOR_IDS.map((id) => (
            <Chip key={id} active={pick === id} color={trackColor} onClick={() => nameIt(id)}>
              {FACTOR_LABEL[id]}
            </Chip>
          ))}
        </div>
        {pick !== null && (
          <p
            className={cn(
              'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
              pick === bill.mostHeadroom ? 'text-accent' : 'text-rose-400',
            )}
          >
            {pick === bill.mostHeadroom ? <Check size={12} /> : <X size={12} />}
            {pick === bill.mostHeadroom
              ? `correct — ${fmtFactor(bill.factors.find((f) => f.id === pick)?.headroom ?? 1)} of multiplier still on the table there`
              : `not ${FACTOR_LABEL[pick]} — it is already at ${fmtFactor(factorValue(choice, pick))}. Read the headroom column again.`}
          </p>
        )}
        <p className="mt-2 text-body-sm text-text-3">
          {namedRight.length >= 2
            ? 'Both named. Notice what that took: the starved factor moved because your choices moved. It is not a property of the workload.'
            : 'Answer for this configuration, then put a different factor back to 1× and answer again.'}
        </p>
      </div>

      {/* -------------------------------- targets ----------------------------- */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <Target size={12} /> the scan-bill task
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Gauge
            label={`total reduction ≥ ${fmtFactor(TARGETS.totalFactor)}`}
            value={fmtFactor(bill.totalFactor)}
            ok={bill.targetOk}
          />
          <Gauge
            label={`answer no more than ${TARGETS.stalenessMinutes} min stale`}
            value={`${bill.stalenessMinutes} min · ${fmtCount(bill.runsPerDay)} runs/day`}
            ok={bill.freshOk}
          />
        </div>
        <p className="mt-3 text-body-sm text-text-3">
          {bill.ok
            ? `Both held. Say the trade out loud, because that sentence is what a cost review is: you reached ${fmtFactor(bill.totalFactor)} without touching the frequency lever past a five-minute cache, which means the reduction came from the layout rather than from asking fewer questions.`
            : `${solving.length} of the ${CHOICE_GRID.length} configurations hold both. The frequency lever alone cannot do it — the cheapest bill in the space, ${choiceKey(cheapest)} at ${fmtFactor(cheapestBill.totalFactor)}, misses the freshness ceiling by ${(cheapestBill.stalenessMinutes / TARGETS.stalenessMinutes).toFixed(0)}×.`}
        </p>
      </div>

      {/* ------------------------------ the workload -------------------------- */}
      <div className="mt-5">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
          eight queries from the same table — and no single fix
        </p>
        <p className="mt-1 max-w-2xl text-body-sm text-text-3">
          A seeded sample of what this table is actually asked, priced by the same three factors.
          Weakest factor: {FACTOR_IDS.map((id) => `${FACTOR_LABEL[id]} ${histogram[id]}`).join(' · ')}.
          That spread is the reason this lab grades <em>identifying</em> the 1× factor rather than
          applying a recipe — the recipe is different per query, and the query mix is C2’s subject.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                {['query', 'projection', 'pruning', 'frequency', 'total', 'bytes / day', 'at 1×'].map((h) => (
                  <th
                    key={h}
                    className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wide text-text-3"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workload.map((q) => (
                <tr key={q.name} className="border-b border-line/60">
                  <td className="py-2 pr-3 font-mono text-[11.5px] text-text-2">{q.name}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-text-3">
                    {fmtFactor(q.bill.projectionFactor)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-text-3">
                    {fmtFactor(q.bill.pruningFactor)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-text-3">
                    {fmtFactor(q.bill.frequencyFactor)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-text-1">
                    {fmtFactor(q.bill.totalFactor)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-text-2">
                    {fmtBytes(q.bill.bytesPerDay)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[11px]">
                    {q.bill.factorsAtOne.length === 0 ? (
                      <span className="text-text-3">none</span>
                    ) : (
                      <span className="text-rose-400">
                        {q.bill.factorsAtOne.map((id) => FACTOR_LABEL[id]).join(', ')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* -------------------------------- honesty ----------------------------- */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <AlertTriangle size={12} /> what this lab is not
        </p>
        <ul className="mt-2 space-y-1.5 text-body-sm text-text-3">
          <li>
            <strong className="text-text-2">This is arithmetic, not a measurement.</strong> No engine
            ran. The three factors are yours to set, and the model multiplies them — it does not
            discover them. The <span className="font-mono text-[11px]">scan-bill</span> duck lab runs
            this same comparison on a real columnar engine at 1/1000 scale and reports what it
            measured; where its numbers differ from yours, its numbers are the ones that happened.
          </li>
          <li>
            <strong className="text-text-2">Compression is deliberately absent.</strong> It is a
            fourth independent factor and it is the one you cannot predict from a schema — it depends
            entirely on which columns survived the projection. C1 measures it, and the codec chooser
            prices it column by column. Multiplying a guessed compression ratio into this product
            would make the whole page unfalsifiable.
          </li>
          <li>
            <strong className="text-text-2">A byte count is not a bill and not a latency.</strong>{' '}
            What bytes cost depends on the storage regime — local NVMe, shared flash over a fabric,
            object storage — and on object storage the request COUNT can dominate the byte count
            entirely. C0.L3 prices all three regimes. This lab reports one number: bytes that had to
            leave storage.
          </li>
          <li>
            <strong className="text-text-2">The assumptions are load-bearing and stated.</strong>{' '}
            {ROW_BYTES} B is an average row width, so a wide free-text column pulls it around; the
            pruning ratios assume the predicate matches the physical order, which an upstream loader
            can silently break; and {fmtCount(ROWS_PER_BLOCK)} rows per block assumes every block is
            full. Naming those before the room finds them is the habit C0.L1 is actually teaching.
          </li>
        </ul>
      </div>

      <p className="mt-5 font-mono text-[10.5px] text-text-3">
        configuration {bill.key} · {visited.length} priced · {fmtCount(CHOICE_GRID.length)} in the
        space · {solving.length} satisfy both targets · counts only, no clock
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

function Metric({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub: string
  color?: string
}) {
  return (
    <div className="rounded-md border border-line px-3 py-2.5">
      <p className="font-mono text-[10px] uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-1 font-mono text-[15px]" style={{ color: color ?? undefined }}>
        {value}
      </p>
      <p className="mt-1 text-[10.5px] leading-snug text-text-3">{sub}</p>
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
        {ok ? (
          <Check size={11} className="text-accent" />
        ) : (
          <AlertTriangle size={11} className="text-rose-400" />
        )}
        {label}
      </p>
      <p className={cn('mt-1 font-mono text-[12px]', ok ? 'text-accent' : 'text-text-1')}>{value}</p>
    </div>
  )
}
