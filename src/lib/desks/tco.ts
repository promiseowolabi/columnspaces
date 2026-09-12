/**
 * tco.ts — `tco-desk` (L500). Managed warehouse, engine-on-your-own-storage,
 * or an appliance-class platform, over a 36-month horizon, with labour costed.
 *
 * NO PRICES. Not one. Every quantity in this model is a COUNT:
 *
 *   storage   byte-months
 *   compute   instance-hours or credits, as a count
 *   labour    engineer-months
 *   egress    bytes moved
 *
 * The caller supplies a RateCard of their own multipliers and the model reports
 * totals in the caller's own units. This is not fastidiousness: a course that
 * hardcodes a list price is wrong within two quarters and, because the number
 * still looks authoritative, wrong in a way nobody notices. The deliverable is
 * the model, and the rates are the reader's to own.
 *
 * Every build-or-buy memo in this industry is lost on the same line item: the
 * engineer. Infrastructure is quoted precisely and labour is quoted as "we'll
 * absorb it", so at a 36-month horizon — where labour is routinely HALF the
 * total of a self-operated platform — self-hosting wins on the slide and loses
 * on the invoice. A one-off build amortises. An on-call rotation does not.
 *
 * Four omissions this desk refuses to let pass, each of which flatters exactly
 * one of the three options:
 *
 *   ongoing_ops   an ops term of zero flatters the self-operated option
 *   migration     an uncosted migration flatters whichever option you move TO
 *   exit_costed   an uncosted exit flatters the option with the deepest lock-in
 *   honest_answer a recommendation the learner's OWN arithmetic contradicts
 *
 * `honest_answer` grades whether the recommendation survives the arithmetic. It
 * has no opinion about WHICH option is right — pick the more expensive one all
 * day, but name the non-cost reason, or the arithmetic was decoration.
 */

import { bandAround, fail, fmtBytes, inBand, pass } from './kit'
import type { Check, DeskReport } from './kit'

/** The three shapes the desk compares. */
export type Option = 'managed' | 'engine' | 'appliance'

export const OPTIONS: readonly Option[] = ['managed', 'engine', 'appliance'] as const

/** Totals within this band of the cheapest option are a tie, not a contradiction. */
export const TIE_PCT = 5

/** Tolerance on the learner's own total. */
export const TCO_TOLERANCE_PCT = 10

/** The horizon at which labour stops looking like a rounding error. */
export const DEFAULT_HORIZON_MONTHS = 36

/**
 * The caller's own multipliers. NOT prices — weights, in whatever unit the
 * caller's finance function actually uses. Supplying all four is the point:
 * the ratio between `perEngineerMonth` and the platform rates is what decides
 * every build-or-buy argument, and it varies by geography and company more
 * than any infrastructure rate does.
 */
export interface RateCard {
  /** Weight of holding one byte for one month. */
  perByteMonth: number
  /** Weight of one compute unit: one instance-hour, or one credit. A count either way. */
  perComputeUnit: number
  /** Weight of one fully loaded engineer-month. */
  perEngineerMonth: number
  /** Weight of moving one byte out. Zero is a claim, not a default. */
  perEgressByte: number
}

/** Counts for one option. All counts; no rates, no clocks. */
export interface OptionCounts {
  /** Bytes held in month 1. */
  storageBytes: number
  /** Fractional growth in bytes held, per month. */
  storageGrowthPerMonth: number
  /** Compute units consumed in month 1 — instance-hours or credits. */
  computeUnitsPerMonth: number
  /** Fractional growth in compute units per month. */
  computeGrowthPerMonth: number
  /** One-off engineer-months to reach production on this option. */
  oneOffEngineerMonths: number
  /**
   * Ongoing operations as a fraction of an FTE. Rarely zero even for a managed
   * service — someone still owns the schema, the upgrade and the page.
   */
  ongoingOpsFte: number
  /** Engineer-months to migrate INTO this option from where you are. */
  migrationEngineerMonths: number
  /** Months of running the outgoing platform in parallel during cutover. A count of months. */
  migrationParallelMonths: number
  /** Engineer-months to leave this option again. */
  exitEngineerMonths: number
  /** Bytes that must be moved out to leave. */
  exitEgressBytes: number
  /** Months of parallel running during that exit. */
  exitParallelMonths: number
}

export interface TcoInput {
  horizonMonths: number
  rates: RateCard
  options: Record<Option, OptionCounts>
}

export interface TcoLine {
  option: Option
  /* ---- counts ---- */
  byteMonths: number
  computeUnits: number
  oneOffEngineerMonths: number
  ongoingEngineerMonths: number
  totalEngineerMonths: number
  migrationEngineerMonths: number
  exitEngineerMonths: number
  exitEgressBytes: number
  /* ---- counts × the caller's own rates ---- */
  platformWeight: number
  labourWeight: number
  migrationWeight: number
  /** Quoted separately: exit is the leverage number, not part of the run. */
  exitWeight: number
  /** platform + labour + migration over the horizon. */
  total: number
  /** Share of `total` that is people rather than machines. */
  labourShare: number
}

export interface TcoOutput {
  horizonMonths: number
  lines: Record<Option, TcoLine>
  /** Cheapest by total over the horizon. */
  cheapest: Option
  /** Cheapest-first, deterministic on ties by OPTIONS order. */
  ranking: Option[]
  /** Options whose totals are within TIE_PCT of the cheapest — genuinely undecided by cost. */
  tied: Option[]
}

const safe = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

const rate = (v: number): number => (Number.isFinite(v) && v >= 0 ? v : 0)

/** Sum of a quantity growing geometrically over months 1..H. Finite for any rate. */
function geometricSum(month1: number, growthPerMonth: number, months: number): number {
  const base = safe(month1)
  const g = Number.isFinite(growthPerMonth) ? Math.max(-0.99, growthPerMonth) : 0
  const h = Math.max(0, Math.round(months))
  if (base === 0 || h === 0) return 0
  if (Math.abs(g) < 1e-12) return base * h
  return (base * (Math.pow(1 + g, h) - 1)) / g
}

export function computeLine(option: Option, counts: OptionCounts, input: TcoInput): TcoLine {
  const h = Math.max(1, Math.round(safe(input.horizonMonths) || DEFAULT_HORIZON_MONTHS))
  const rates = input.rates

  const byteMonths = geometricSum(counts.storageBytes, counts.storageGrowthPerMonth, h)
  const computeUnits = geometricSum(counts.computeUnitsPerMonth, counts.computeGrowthPerMonth, h)

  const oneOffEngineerMonths = safe(counts.oneOffEngineerMonths)
  const ongoingEngineerMonths = safe(counts.ongoingOpsFte) * h
  const totalEngineerMonths = oneOffEngineerMonths + ongoingEngineerMonths

  const platformWeight = byteMonths * rate(rates.perByteMonth) + computeUnits * rate(rates.perComputeUnit)
  const labourWeight = totalEngineerMonths * rate(rates.perEngineerMonth)

  /* A parallel-run month costs one month of the platform at its month-1 shape. */
  const monthlyPlatform =
    safe(counts.storageBytes) * rate(rates.perByteMonth) + safe(counts.computeUnitsPerMonth) * rate(rates.perComputeUnit)

  const migrationEngineerMonths = safe(counts.migrationEngineerMonths)
  const migrationWeight =
    migrationEngineerMonths * rate(rates.perEngineerMonth) + safe(counts.migrationParallelMonths) * monthlyPlatform

  const exitEngineerMonths = safe(counts.exitEngineerMonths)
  const exitEgressBytes = safe(counts.exitEgressBytes)
  const exitWeight =
    exitEngineerMonths * rate(rates.perEngineerMonth) +
    exitEgressBytes * rate(rates.perEgressByte) +
    safe(counts.exitParallelMonths) * monthlyPlatform

  const total = platformWeight + labourWeight + migrationWeight
  return {
    option,
    byteMonths,
    computeUnits,
    oneOffEngineerMonths,
    ongoingEngineerMonths,
    totalEngineerMonths,
    migrationEngineerMonths,
    exitEngineerMonths,
    exitEgressBytes,
    platformWeight,
    labourWeight,
    migrationWeight,
    exitWeight,
    total,
    labourShare: total > 0 ? (labourWeight + migrationEngineerMonths * rate(rates.perEngineerMonth)) / total : 0,
  }
}

export function computeTco(input: TcoInput): TcoOutput {
  const horizonMonths = Math.max(1, Math.round(safe(input.horizonMonths) || DEFAULT_HORIZON_MONTHS))
  const lines = {
    managed: computeLine('managed', input.options.managed, input),
    engine: computeLine('engine', input.options.engine, input),
    appliance: computeLine('appliance', input.options.appliance, input),
  } as Record<Option, TcoLine>

  const ranking = [...OPTIONS].sort(
    (a, b) => lines[a].total - lines[b].total || OPTIONS.indexOf(a) - OPTIONS.indexOf(b),
  )
  const cheapest = ranking[0]
  const band = bandAround(lines[cheapest].total, TIE_PCT)
  const tied = ranking.filter((o) => inBand(lines[o].total, band))

  return { horizonMonths, lines, cheapest, ranking, tied }
}

/**
 * What it costs to leave, itemised. This is the only real leverage in a renewal
 * conversation: a vendor's pricing power is bounded by your switching cost, so
 * the count computed here is the cap on any increase they can make stick.
 * Compute it BEFORE the renewal, not during.
 */
export function exitBreakdown(line: TcoLine, rates: RateCard): Record<string, number> {
  return {
    labourWeight: line.exitEngineerMonths * rate(rates.perEngineerMonth),
    egressWeight: line.exitEgressBytes * rate(rates.perEgressByte),
    /* Whatever is left of exitWeight is the parallel run. */
    parallelWeight: Math.max(
      0,
      line.exitWeight - line.exitEngineerMonths * rate(rates.perEngineerMonth) - line.exitEgressBytes * rate(rates.perEgressByte),
    ),
  }
}

/* -------------------------------- grading -------------------------------- */

export interface TcoSubmission {
  input: TcoInput
  /** The option the memo recommends. */
  recommendation: Option
  /** The learner's own horizon total for that option, in their own units. */
  claimedTotal: number
  /** Did the memo carry an ongoing operations term? */
  statedOngoingOps: boolean
  /** Did the memo cost the migration in? */
  statedMigration: boolean
  /** Did the memo cost the exit? */
  statedExit: boolean
  /**
   * The non-cost reason for recommending a more expensive option: residency,
   * control, latency, a skills position. null means "the memo argued on cost".
   * A stated reason is accepted at face value here — the desk grades whether
   * the recommendation survives the arithmetic, never which option it is.
   */
  nonCostJustification: string | null
}

export function gradeTco(sub: TcoSubmission): DeskReport {
  const out = computeTco(sub.input)
  const rec = out.lines[sub.recommendation]
  const best = out.lines[out.cheapest]
  const checks: Check[] = []

  /* 1. total — within tolerance of the reference for the option they chose. */
  const totalBand = bandAround(rec.total, TCO_TOLERANCE_PCT)
  checks.push(
    inBand(sub.claimedTotal, totalBand)
      ? pass(
          'total',
          'horizon total within tolerance',
          `${sub.recommendation}: ${rec.total.toFixed(0)} over ${out.horizonMonths} months (platform ${rec.platformWeight.toFixed(0)} + labour ${rec.labourWeight.toFixed(0)} + migration ${rec.migrationWeight.toFixed(0)}), all counts × your own rates`,
        )
      : fail(
          'total',
          'horizon total within tolerance',
          `claimed ${sub.claimedTotal.toFixed(0)}, reference ${rec.total.toFixed(0)} over ${out.horizonMonths} months (band ${totalBand.lo.toFixed(0)}–${totalBand.hi.toFixed(0)}). Itemise in counts: ${rec.byteMonths.toExponential(2)} byte-months, ${rec.computeUnits.toFixed(0)} compute units, ${rec.totalEngineerMonths.toFixed(1)} engineer-months (${rec.oneOffEngineerMonths.toFixed(1)} one-off + ${rec.ongoingEngineerMonths.toFixed(1)} ongoing), ${rec.migrationEngineerMonths.toFixed(1)} migration engineer-months.`,
        ),
  )

  /* 2. ongoing_ops — the term that decides it, and the one routinely dropped. */
  const opsFte = sub.input.options[sub.recommendation].ongoingOpsFte
  if (!sub.statedOngoingOps) {
    checks.push(
      fail(
        'ongoing_ops',
        'ongoing operations counted',
        `ongoing operations not counted, and labour is ${(rec.labourShare * 100).toFixed(0)}% of this total once it is. At ${out.horizonMonths} months a one-off build amortises and an on-call rotation does not: ${rec.ongoingEngineerMonths.toFixed(1)} engineer-months of it here. Dropping this term is precisely why self-operation wins on slides and loses on invoices.`,
      ),
    )
  } else if (!(safe(opsFte) > 0)) {
    checks.push(
      fail(
        'ongoing_ops',
        'ongoing operations counted',
        `ongoing operations is claimed as counted but the ops FTE for ${sub.recommendation} is ${opsFte}. No option runs itself — a managed service still needs someone owning schema, upgrades and the page — so a zero here is an omission dressed as a number, and it silently removes ${(out.horizonMonths / 12).toFixed(0)} years of engineer-months from the comparison.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'ongoing_ops',
        'ongoing operations counted',
        `${safe(opsFte).toFixed(2)} FTE × ${out.horizonMonths} months = ${rec.ongoingEngineerMonths.toFixed(1)} ongoing engineer-months; labour is ${(rec.labourShare * 100).toFixed(0)}% of the ${sub.recommendation} total`,
      ),
    )
  }

  /* 3. migration — the cost of getting there, which flatters whatever you chose. */
  const migMonths = sub.input.options[sub.recommendation].migrationEngineerMonths
  if (!sub.statedMigration) {
    checks.push(
      fail(
        'migration',
        'migration costed',
        `migration not costed. The move itself is ${safe(migMonths).toFixed(1)} engineer-months plus ${safe(sub.input.options[sub.recommendation].migrationParallelMonths).toFixed(0)} months of parallel running in this model — a real term that is charged entirely to the option you are recommending, so leaving it out flatters the change and understates the status quo.`,
      ),
    )
  } else if (!(safe(migMonths) > 0)) {
    checks.push(
      fail(
        'migration',
        'migration costed',
        `migration is claimed as costed but the migration engineer-months for ${sub.recommendation} is ${migMonths}. A zero asserts that the tables, the pipelines, the dashboards and the access model all move for free; if that is genuinely true, say why, because it is the single least believable line in a build-or-buy memo.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'migration',
        'migration costed',
        `${safe(migMonths).toFixed(1)} migration engineer-months plus parallel running, ${rec.migrationWeight.toFixed(0)} of the ${rec.total.toFixed(0)} total`,
      ),
    )
  }

  /* 4. exit_costed — your renewal leverage, computed before you need it. */
  const exitCounts = sub.input.options[sub.recommendation]
  const hasExit = safe(exitCounts.exitEngineerMonths) > 0 || safe(exitCounts.exitEgressBytes) > 0
  if (!sub.statedExit) {
    checks.push(
      fail(
        'exit_costed',
        'exit costed',
        `exit not costed. That count is both your risk if this decision is wrong and the CAP on any increase a vendor can make stick at renewal: ${safe(exitCounts.exitEngineerMonths).toFixed(1)} engineer-months and ${fmtBytes(safe(exitCounts.exitEgressBytes))} of egress here. It is the most useful figure in the memo and the one most often missing, because nobody wants to write it down on the day they sign.`,
      ),
    )
  } else if (!hasExit) {
    checks.push(
      fail(
        'exit_costed',
        'exit costed',
        `exit is claimed as costed but both exit terms for ${sub.recommendation} are zero: ${exitCounts.exitEngineerMonths} engineer-months, ${exitCounts.exitEgressBytes} bytes. An exit of zero claims the data is portable, the semantics are portable and the operational knowledge is portable — if you believe that, the number to write down is what makes it true, not zero.`,
      ),
    )
  } else {
    const bd = exitBreakdown(rec, sub.input.rates)
    checks.push(
      pass(
        'exit_costed',
        'exit costed',
        `${rec.exitWeight.toFixed(0)} to leave (labour ${bd.labourWeight.toFixed(0)}, egress ${bd.egressWeight.toFixed(0)} over ${fmtBytes(rec.exitEgressBytes)}, parallel run ${bd.parallelWeight.toFixed(0)}) — that count caps your renewal exposure`,
      ),
    )
  }

  /*
   * 5. honest_answer — does the recommendation survive the learner's OWN
   *    arithmetic? Not "is it the right option". If the recommendation is more
   *    expensive than the cheapest by more than a tie, the memo must name a
   *    non-cost reason; otherwise the numbers were decoration.
   */
  const supported = inBand(rec.total, bandAround(best.total, TIE_PCT)) || rec.total <= best.total
  const gap = rec.total - best.total
  const gapPct = best.total > 0 ? (gap / best.total) * 100 : 0
  if (supported) {
    checks.push(
      pass(
        'honest_answer',
        'recommendation survives the arithmetic',
        `${sub.recommendation} at ${rec.total.toFixed(0)} against the cheapest (${out.cheapest}) at ${best.total.toFixed(0)}${out.tied.length > 1 ? `; ${out.tied.join(' and ')} are within ${TIE_PCT}% and so undecided by cost` : ''}. Ranking: ${out.ranking.join(' < ')}.`,
      ),
    )
  } else if (sub.nonCostJustification && sub.nonCostJustification.trim().length > 0) {
    checks.push(
      pass(
        'honest_answer',
        'recommendation survives the arithmetic',
        `${sub.recommendation} costs ${gap.toFixed(0)} more (${gapPct.toFixed(0)}%) than ${out.cheapest}, and the memo names the non-cost reason: "${sub.nonCostJustification.trim()}". A more expensive option with a stated reason is a decision; without one it is an accident.`,
      ),
    )
  } else {
    checks.push(
      fail(
        'honest_answer',
        'recommendation survives the arithmetic',
        `you recommended ${sub.recommendation} at ${rec.total.toFixed(0)}, but YOUR OWN numbers make ${out.cheapest} cheaper by ${gap.toFixed(0)} (${gapPct.toFixed(0)}%) over ${out.horizonMonths} months — ${sub.recommendation} carries ${rec.totalEngineerMonths.toFixed(1)} engineer-months against ${best.totalEngineerMonths.toFixed(1)}, and labour is ${(rec.labourShare * 100).toFixed(0)}% of its total. Either recommend ${out.cheapest}, or state the non-cost reason (residency, control, latency, skills) explicitly; a recommendation contradicted by its own arithmetic makes the arithmetic decoration.`,
      ),
    )
  }

  return { desk: 'tco-desk', version: 1, checks }
}
