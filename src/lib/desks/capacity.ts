/**
 * capacity.ts — `capacity-desk` (L500). What does this platform need over the
 * horizon, and what breaks FIRST?
 *
 * The desk exists because capacity plans are written against one curve —
 * bytes — and platforms saturate on five. Storage grows with DATA. Metadata
 * grows with FILE COUNT, and those are different curves driven by different
 * knobs: halving the commit interval doubles files at constant data (C5.L4),
 * so the catalog can be the first ceiling to bind on a table whose byte growth
 * looks entirely comfortable. That is the course's claim, and this model is
 * built to DEMONSTRATE it rather than to assume it: swap the inputs and the
 * first limit moves to compute, network or ingest, because each component has
 * its own demand curve and its own ceiling.
 *
 * Everything here is a COUNT — bytes, files, manifest entries, instance-hours
 * per hour, bytes per day. No prices, no wall-clock budgets. The caller
 * multiplies counts by their own rates; a model with a rate baked in is wrong
 * within two quarters and, worse, silently wrong.
 *
 * The two discipline traps this desk grades:
 *
 *   1. `first_limit` — a plan that names the wrong saturating component has
 *      sized the wrong thing. Graded against what the model computes, not
 *      against a memorised answer.
 *   2. `headroom` — a projection with no growth term is a snapshot wearing a
 *      plan's clothes. It fails even when today's numbers are perfect, because
 *      the whole deliverable is the months remaining before a ceiling binds.
 */

import { bandAround, fail, fmtBytes, fmtCount, inBand, pass } from './kit'
import type { Band, Check, DeskReport } from './kit'

/** Days per average month. A count, used to turn per-day rates into per-month ones. */
export const DAYS_PER_MONTH = 30.437

/** Sizing tolerance. A projection inside this band is "within tolerance", not "correct". */
export const CAPACITY_TOLERANCE_PCT = 15

/** Headroom is quoted in whole months, so its band is absolute rather than proportional. */
export const HEADROOM_BAND_MONTHS = 2

/** The five things that saturate. Order is the tie-break order, and it is stable. */
export type Component = 'storage' | 'compute' | 'catalog' | 'network' | 'ingest'

export const COMPONENTS: readonly Component[] = ['storage', 'compute', 'catalog', 'network', 'ingest'] as const

/* --------------------------------- input --------------------------------- */

export interface CapacityInput {
  /** Planning horizon. 24 months is the desk's default question. */
  horizonMonths: number

  /* ---- data plane: grows with bytes ---- */
  /** Live bytes today, excluding retained snapshots. */
  liveBytes: number
  /** Fractional data growth per month. 0.06 is 6%/month, which doubles inside a year. */
  dataGrowthPerMonth: number
  /**
   * Retained snapshots and orphans as a multiple of live size. C3 measures 1.4x
   * for a seven-day retention window; a plan that quotes live bytes as its
   * storage requirement is short by this factor.
   */
  snapshotRetentionMultiplier: number
  /** Bytes the storage tier is provisioned or budgeted for. */
  storageCeilingBytes: number

  /* ---- file count: grows with COMMITS, not with bytes (C2/C5) ---- */
  /** Commits per day. The one free variable that moves file count at constant data. */
  commitsPerDay: number
  /** Partitions touched by an average commit. */
  partitionsPerCommit: number
  /** Concurrent writers. */
  writers: number
  /** Target file size after compaction. Steady-state file count is bytes ÷ this. */
  targetFileBytes: number
  /** Files compaction can merge away per day. C5.L4: a deficit does not saturate, it accumulates. */
  mergeFilesPerDay: number
  /** Manifest entries the catalog can plan within budget. The catalog's ceiling is a COUNT. */
  catalogEntryCeiling: number

  /* ---- compute: instance-hours per hour of peak, a count ---- */
  peakQueriesPerHour: number
  /** Fractional query-volume growth per month. Usually not the same as data growth. */
  queryGrowthPerMonth: number
  /** Instance-hours consumed by one average query. */
  instanceHoursPerQuery: number
  /** Instance-hours available per wall-hour at peak. The compute ceiling, as a count. */
  instanceHourCeilingPerHour: number

  /* ---- network: bytes moved per day ---- */
  /** Bytes scanned by one average query today. Grows with data unless pruning improves. */
  bytesScannedPerQuery: number
  /** Bytes per day the read path can move. */
  networkBytesPerDayCeiling: number

  /* ---- ingest: bytes landed per day ---- */
  ingestBytesPerDay: number
  ingestBytesPerDayCeiling: number
}

/* --------------------------------- output --------------------------------- */

export interface CapacityCurve {
  component: Component
  /** What the unit of this curve is, so a report never compares bytes to entries. */
  unit: string
  demandNow: number
  demandAtHorizon: number
  ceiling: number
  /** demandAtHorizon ÷ ceiling. Above 1 means it binds before the horizon. */
  utilisation: number
  /** First whole month at which demand reaches the ceiling; null when it never does. */
  saturationMonth: number | null
}

export interface CapacityOutput {
  /** C5.L4 arithmetic: commits × partitions × writers. */
  filesCreatedPerDay: number
  /** Creation minus merge. Positive means the file count grows without bound. */
  mergeDeficitPerDay: number
  /** Provisioned bytes needed at the horizon, snapshots included. */
  horizonBytes: number
  /** Manifest entries at the horizon, steady-state plus accumulated deficit. */
  horizonEntries: number
  /** Instance-hours per wall-hour needed at peak, at the horizon. */
  horizonInstanceHours: number
  curves: Record<Component, CapacityCurve>
  /** The component that reaches its ceiling first. */
  firstLimit: Component
  /** Months until the first ceiling binds. Capped at the horizon when nothing binds. */
  headroomMonths: number
  /** True when no ceiling binds inside the horizon. */
  clearThroughHorizon: boolean
}

/** Guard: keep a divisor strictly positive so no curve can emit NaN or Infinity. */
const posDiv = (v: number, floor = 1): number => (Number.isFinite(v) && v > 0 ? v : floor)

/** Guard: a growth factor that stays finite and non-negative for any submitted rate. */
const growth = (rate: number, months: number): number => {
  const r = Number.isFinite(rate) ? Math.max(-0.99, rate) : 0
  return Math.pow(1 + r, Math.max(0, months))
}

/** Non-negative, finite, or zero. Sweeps hand this model hostile inputs on purpose. */
const safe = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

function curve(
  component: Component,
  unit: string,
  ceilingRaw: number,
  demand: (month: number) => number,
  horizonMonths: number,
): CapacityCurve {
  const ceiling = posDiv(ceilingRaw)
  const demandNow = safe(demand(0))
  const demandAtHorizon = safe(demand(horizonMonths))
  let saturationMonth: number | null = null
  for (let m = 0; m <= horizonMonths; m++) {
    if (safe(demand(m)) >= ceiling) {
      saturationMonth = m
      break
    }
  }
  return {
    component,
    unit,
    demandNow,
    demandAtHorizon,
    ceiling,
    utilisation: demandAtHorizon / ceiling,
    saturationMonth,
  }
}

/**
 * The reference model. Pure: same input, same output, no clock, no randomness.
 *
 * Each component gets a demand curve in its OWN unit, because the point of the
 * desk is that these curves have different shapes:
 *
 *   storage   bytes            ∝ (1+data growth)^m
 *   catalog   manifest entries ∝ (1+data growth)^m  PLUS the accumulated
 *                              creation-versus-merge deficit, which is linear
 *                              in months and independent of bytes entirely
 *   compute   instance-hours   ∝ (1+query growth)^m
 *   network   bytes/day        ∝ (1+query growth)^m × (1+data growth)^m
 *   ingest    bytes/day        ∝ (1+data growth)^m
 *
 * The catalog term is the one that surprises people: with a merge deficit, it
 * grows on a curve that has nothing to do with how much data you hold.
 */
export function computeCapacity(input: CapacityInput): CapacityOutput {
  const horizonMonths = Math.max(1, Math.round(safe(input.horizonMonths) || 24))
  const liveBytes = safe(input.liveBytes)
  const retention = Math.max(1, Number.isFinite(input.snapshotRetentionMultiplier) ? input.snapshotRetentionMultiplier : 1)

  const filesCreatedPerDay = safe(input.commitsPerDay) * safe(input.partitionsPerCommit) * safe(input.writers)
  const mergeDeficitPerDay = Math.max(0, filesCreatedPerDay - safe(input.mergeFilesPerDay))

  const bytesAt = (m: number): number => liveBytes * growth(input.dataGrowthPerMonth, m)
  const steadyEntriesAt = (m: number): number => bytesAt(m) / posDiv(input.targetFileBytes)
  const entriesAt = (m: number): number => steadyEntriesAt(m) + mergeDeficitPerDay * DAYS_PER_MONTH * Math.max(0, m)

  const curves: Record<Component, CapacityCurve> = {
    storage: curve('storage', 'bytes', input.storageCeilingBytes, (m) => bytesAt(m) * retention, horizonMonths),
    compute: curve(
      'compute',
      'instance-hours per wall-hour',
      input.instanceHourCeilingPerHour,
      (m) => safe(input.peakQueriesPerHour) * growth(input.queryGrowthPerMonth, m) * safe(input.instanceHoursPerQuery),
      horizonMonths,
    ),
    catalog: curve('catalog', 'manifest entries', input.catalogEntryCeiling, entriesAt, horizonMonths),
    network: curve(
      'network',
      'bytes per day',
      input.networkBytesPerDayCeiling,
      (m) =>
        safe(input.peakQueriesPerHour) *
        growth(input.queryGrowthPerMonth, m) *
        24 *
        safe(input.bytesScannedPerQuery) *
        growth(input.dataGrowthPerMonth, m),
      horizonMonths,
    ),
    ingest: curve(
      'ingest',
      'bytes per day',
      input.ingestBytesPerDayCeiling,
      (m) => safe(input.ingestBytesPerDay) * growth(input.dataGrowthPerMonth, m),
      horizonMonths,
    ),
  }

  /*
   * Rank: earliest saturation wins; a component that never saturates ranks
   * behind every one that does; ties break on utilisation at the horizon and
   * then on COMPONENTS order, so the answer is deterministic for every input.
   */
  const rank = (c: Component): [number, number, number] => {
    const k = curves[c]
    return [k.saturationMonth ?? horizonMonths + 1, -k.utilisation, COMPONENTS.indexOf(c)]
  }
  const firstLimit = [...COMPONENTS].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
  })[0]

  const sat = curves[firstLimit].saturationMonth
  return {
    filesCreatedPerDay,
    mergeDeficitPerDay,
    horizonBytes: curves.storage.demandAtHorizon,
    horizonEntries: curves.catalog.demandAtHorizon,
    horizonInstanceHours: curves.compute.demandAtHorizon,
    curves,
    firstLimit,
    headroomMonths: sat ?? horizonMonths,
    clearThroughHorizon: sat === null,
  }
}

/* -------------------------------- grading -------------------------------- */

export interface CapacitySubmission {
  input: CapacityInput
  /** Provisioned bytes at the horizon, snapshots included. */
  claimedHorizonBytes: number
  /** Instance-hours per wall-hour at peak, at the horizon. */
  claimedPeakInstanceHours: number
  /** Manifest entries at the horizon. */
  claimedEntryCount: number
  /** Which component the learner says saturates first. */
  claimedFirstLimit: Component
  /** Months of headroom before the first ceiling binds. null means NOT STATED. */
  claimedHeadroomMonths: number | null
  /**
   * Did the plan carry a growth term at all? A projection with no growth term
   * is a snapshot, and this flag exists so that omission fails explicitly
   * rather than accidentally passing because today's numbers were right.
   */
  statedGrowth: boolean
}

const monthBand = (centre: number): Band => ({
  lo: centre - HEADROOM_BAND_MONTHS,
  hi: centre + HEADROOM_BAND_MONTHS,
})

export function gradeCapacity(sub: CapacitySubmission): DeskReport {
  const out = computeCapacity(sub.input)
  const checks: Check[] = []

  /* 1. storage_plan — bytes at the horizon, snapshots included. */
  const storageBand = bandAround(out.horizonBytes, CAPACITY_TOLERANCE_PCT)
  checks.push(
    inBand(sub.claimedHorizonBytes, storageBand)
      ? pass(
          'storage_plan',
          'storage projection within tolerance',
          `${fmtBytes(out.horizonBytes)} provisioned at month ${sub.input.horizonMonths} (${fmtBytes(out.curves.storage.demandNow)} today, retention multiplier ${sub.input.snapshotRetentionMultiplier}x)`,
        )
      : fail(
          'storage_plan',
          'storage projection within tolerance',
          `claimed ${fmtBytes(sub.claimedHorizonBytes)}, reference ${fmtBytes(out.horizonBytes)} (band ${fmtBytes(storageBand.lo)}–${fmtBytes(storageBand.hi)}). The projection is live bytes compounded at the growth rate and then multiplied by the retention multiplier — a plan that quotes live bytes alone is short by the snapshots it is still pinning.`,
        ),
  )

  /* 2. concurrency — instance-hours per wall-hour at peak. A count, never a clock. */
  const concurrencyBand = bandAround(out.horizonInstanceHours, CAPACITY_TOLERANCE_PCT)
  checks.push(
    inBand(sub.claimedPeakInstanceHours, concurrencyBand)
      ? pass(
          'concurrency',
          'peak concurrency within tolerance',
          `${out.horizonInstanceHours.toFixed(1)} instance-hours per wall-hour at peak against a ceiling of ${out.curves.compute.ceiling.toFixed(1)} (${(out.curves.compute.utilisation * 100).toFixed(0)}% utilised)`,
        )
      : fail(
          'concurrency',
          'peak concurrency within tolerance',
          `claimed ${sub.claimedPeakInstanceHours.toFixed(1)}, reference ${out.horizonInstanceHours.toFixed(1)} instance-hours per wall-hour (band ${concurrencyBand.lo.toFixed(1)}–${concurrencyBand.hi.toFixed(1)}). Peak concurrency is queries per peak hour, grown at the QUERY rate rather than the data rate, times instance-hours per query.`,
        ),
  )

  /* 3. metadata_scale — entries, which are driven by commits and not by bytes. */
  const entryBand = bandAround(out.horizonEntries, CAPACITY_TOLERANCE_PCT)
  checks.push(
    inBand(sub.claimedEntryCount, entryBand)
      ? pass(
          'metadata_scale',
          'metadata scale within tolerance',
          `${fmtCount(out.horizonEntries)} manifest entries at the horizon: ${fmtCount(out.filesCreatedPerDay)} created/day (commits × partitions × writers), merge deficit ${fmtCount(out.mergeDeficitPerDay)}/day`,
        )
      : fail(
          'metadata_scale',
          'metadata scale within tolerance',
          `claimed ${fmtCount(sub.claimedEntryCount)} entries, reference ${fmtCount(out.horizonEntries)} (band ${fmtCount(entryBand.lo)}–${fmtCount(entryBand.hi)}). Entries are steady-state bytes ÷ target file size PLUS the accumulated creation-versus-merge deficit: ${fmtCount(out.filesCreatedPerDay)} created/day against ${fmtCount(sub.input.mergeFilesPerDay)} merged/day for ${sub.input.horizonMonths} months. A deficit does not saturate, it accumulates.`,
        ),
  )

  /* 4. first_limit — the whole deliverable. Graded against the computed curves. */
  const ordered = [...COMPONENTS]
    .filter((c) => out.curves[c].saturationMonth !== null)
    .sort((a, b) => (out.curves[a].saturationMonth ?? 0) - (out.curves[b].saturationMonth ?? 0))
  const ledger = COMPONENTS.map(
    (c) =>
      `${c} ${(out.curves[c].utilisation * 100).toFixed(0)}% of ceiling at horizon${out.curves[c].saturationMonth !== null ? ` (binds month ${out.curves[c].saturationMonth})` : ''}`,
  ).join('; ')
  checks.push(
    sub.claimedFirstLimit === out.firstLimit
      ? pass(
          'first_limit',
          'first saturating component identified',
          `${out.firstLimit} binds first${out.clearThroughHorizon ? ' (nothing binds inside the horizon; ranked on utilisation)' : ` at month ${out.curves[out.firstLimit].saturationMonth}`}. ${ledger}`,
        )
      : fail(
          'first_limit',
          'first saturating component identified',
          `you named ${sub.claimedFirstLimit}; the model saturates ${out.firstLimit} first${out.clearThroughHorizon ? ' on utilisation, since nothing binds inside the horizon' : ` at month ${out.curves[out.firstLimit].saturationMonth}`}. ${ledger}. Storage grows with DATA and metadata grows with FILE COUNT — different curves, different knobs — so sizing the component that is not binding buys nothing at all${ordered.length > 1 ? `; the order here is ${ordered.join(' then ')}` : ''}.`,
        ),
  )

  /* 5. headroom — fails on OMISSION even when every number above is right. */
  const refHeadroom = out.headroomMonths
  const hb = monthBand(refHeadroom)
  if (!sub.statedGrowth) {
    checks.push(
      fail(
        'headroom',
        'growth and headroom stated',
        `no growth term stated. Every number above is a projection of a growth rate, so a plan without one is a snapshot of today wearing a plan's clothes: it cannot answer "how many months of headroom", which is the only question the desk asked. Reference headroom is ${refHeadroom} months against ${out.firstLimit}.`,
      ),
    )
  } else if (sub.claimedHeadroomMonths === null) {
    checks.push(
      fail(
        'headroom',
        'growth and headroom stated',
        `growth is modelled but headroom is not stated. A capacity plan whose output is a size rather than a DATE has no trigger to act on; the reference is ${refHeadroom} months before ${out.firstLimit} binds${out.clearThroughHorizon ? ' (nothing binds inside the horizon, so state that explicitly with the horizon as the bound)' : ''}.`,
      ),
    )
  } else {
    checks.push(
      inBand(sub.claimedHeadroomMonths, hb)
        ? pass(
            'headroom',
            'growth and headroom stated',
            `${sub.claimedHeadroomMonths} months claimed, reference ${refHeadroom} against ${out.firstLimit}${out.clearThroughHorizon ? ' (no ceiling binds inside the horizon)' : ''}`,
          )
        : fail(
            'headroom',
            'growth and headroom stated',
            `claimed ${sub.claimedHeadroomMonths} months of headroom, reference ${refHeadroom} (band ${hb.lo.toFixed(0)}–${hb.hi.toFixed(0)}) before ${out.firstLimit} binds. Headroom is the month at which the FIRST curve reaches its ceiling, not the average across components — the comfortable four do not lend capacity to the one that binds.`,
          ),
    )
  }

  return { desk: 'capacity-desk', version: 1, checks }
}
