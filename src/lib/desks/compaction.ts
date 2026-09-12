/**
 * compaction.ts — `compaction-desk` (L400). Read amp against write amp, both stated.
 *
 * The RUM trade with the numbers filled in. Compaction does not reduce cost; it
 * MOVES cost from the read path to the write path, and the deliverable is both
 * numbers plus the write rate they were chosen for:
 *
 *   write amp  =  1 + base bytes ÷ delta bytes at the trigger
 *   read amp   =  data term  +  metadata term
 *                 (live + unmerged delta)     (footers × files opened)
 *
 * Both are itemised because both are routinely quoted with a term missing. A
 * read-amp figure with no metadata term omits the footers, which is the entire
 * cost at small file sizes; a write-amp figure with no derivation is a round
 * number, and a policy with no write-amp figure AT ALL is an unbounded
 * background bill — the rewriting continues for as long as the table exists.
 *
 * Say write amplification as a bill rather than a ratio. "2.11×" sounds like a
 * ratio; "every ingested byte is written 2.11 times, forever" is what it is.
 *
 * Storage has THREE components and a policy is only stable if all three are
 * bounded: live, tombstoned-but-still-present, and retained superseded files.
 * The third is unbounded when there is no expiry window — which is why
 * `expiry_stated` fails an omission outright, and why this model never returns
 * Infinity for it: it projects against a caller-supplied horizon and sets
 * `storageBounded: false`, because a number you can read is more useful than a
 * symbol you cannot.
 *
 * `cost_counted` enforces the course's thesis directly: every cost term must be
 * a COUNT. Bytes rewritten per day, percent of table per day, files created
 * against files merged, requests added. A policy quoted in wall-clock ("two
 * hours of compaction nightly") is graded as a failure, because hours do not
 * transfer between machines and bytes do.
 *
 * NO PRICES. The pricing shape is a name; the rate is the caller's.
 */

import { GIB, KIB, MIB, bandAround, fail, fmtBytes, fmtCount, inBand, pass, pct, round2, toGiB } from './kit'
import type { Amplification, Band, Check, DeskReport } from './kit'

export interface CompactionInput {
  /** Live base bytes in the table. */
  baseBytes: number
  /**
   * Fraction of the base a single compaction actually rewrites. 1.0 is a
   * full-table rewrite, which is what C5's browser lab does and where the
   * course's "write amp ≈ base ÷ delta at the trigger" comes from. A levelled
   * policy that only rewrites the files overlapping the delta is far lower, and
   * the difference between the two IS the policy — so it is an explicit input
   * rather than a hidden assumption.
   */
  compactionScopeFraction: number
  /** Delta bytes accumulated before a compaction fires. THE trigger. */
  triggerDeltaBytes: number
  /** Configured output file size for a compaction. */
  targetFileBytes: number
  /** Logical change per day: inserts, updates and deletes as written. */
  dailyLogicalChangeBytes: number
  /** Fraction of base bytes currently tombstoned but not yet rewritten away. */
  tombstoneFraction: number
  /** Retention for superseded files. null = no expiry policy, i.e. unbounded. */
  expiryWindowDays: number | null
  /** Horizon to project unbounded storage against, so the number stays finite. */
  projectionHorizonDays: number
  /** Footer bytes per file a reader opens to plan. */
  footerBytes: number
  /** Files a single read opens. */
  filesReadPerQuery: number
  /** Bytes of live data the answer actually needed. The denominator. */
  answerBytes: number
}

export interface CompactionOutput {
  amplification: Amplification
  /** Data term of read amp: 1 + average unmerged delta ÷ base. */
  readDataTerm: number
  /** Metadata term of read amp: footers ÷ answer bytes. Small until it is not. */
  readMetadataTerm: number
  compactionsPerDay: number
  bytesRewrittenPerDay: number
  /** Rewritten bytes as a share of the table, per day. A count, as a ratio. */
  rewriteShareOfTablePerDay: number
  /** Files produced by compaction per day. */
  filesWrittenPerDay: number
  /** Requests added per day: files written plus footers opened. All counts. */
  requestsAddedPerDay: number
  liveBytes: number
  tombstonedBytes: number
  retainedSupersededBytes: number
  totalStorageBytes: number
  /** total ÷ live. What you pay to store for the policy you chose. */
  storageMultiple: number
  /** False when there is no expiry window: the third component has no bound. */
  storageBounded: boolean
  /** Engineer-months to build and then operate this policy. A count, per the course. */
  engineerMonthsPerYear: number
}

/**
 * write amp = 1 + (base × scope) ÷ delta-at-trigger. Every ingested byte is
 * written this many times, forever. At scope 1.0 this is the course's
 * "base ÷ delta at the trigger" exactly; below 1.0 it is the levelled form.
 */
export function writeAmplification(baseBytes: number, triggerDeltaBytes: number, scopeFraction = 1): number {
  if (triggerDeltaBytes <= 0) throw new Error('writeAmplification: triggerDeltaBytes must be positive')
  const scope = Math.max(0, Math.min(1, scopeFraction))
  return 1 + (baseBytes * scope) / triggerDeltaBytes
}

export function modelCompaction(input: CompactionInput): CompactionOutput {
  const {
    baseBytes,
    compactionScopeFraction,
    triggerDeltaBytes,
    targetFileBytes,
    dailyLogicalChangeBytes,
    tombstoneFraction,
    expiryWindowDays,
    projectionHorizonDays,
    footerBytes,
    filesReadPerQuery,
    answerBytes,
  } = input

  if (baseBytes <= 0) throw new Error('modelCompaction: baseBytes must be positive')
  if (triggerDeltaBytes <= 0) throw new Error('modelCompaction: triggerDeltaBytes must be positive')
  if (targetFileBytes <= 0) throw new Error('modelCompaction: targetFileBytes must be positive')
  if (answerBytes <= 0) throw new Error('modelCompaction: answerBytes must be positive')
  if (projectionHorizonDays <= 0) throw new Error('modelCompaction: projectionHorizonDays must be positive')

  const scope = Math.max(0, Math.min(1, compactionScopeFraction))
  const write = writeAmplification(baseBytes, triggerDeltaBytes, scope)

  /*
   * Read amp is measured over reads spread across the whole trigger cycle, not
   * at one moment: measuring the end state grades where the last compaction
   * happened to fall. Averaged over the cycle the unmerged delta is half the
   * trigger, so the data term is 1 + trigger/(2 · base).
   */
  const readDataTerm = 1 + triggerDeltaBytes / (2 * baseBytes)
  const metadataBytes = filesReadPerQuery * footerBytes
  const readMetadataTerm = metadataBytes / answerBytes
  const read = readDataTerm + readMetadataTerm

  const compactionsPerDay = dailyLogicalChangeBytes / triggerDeltaBytes
  const bytesRewrittenPerDay = compactionsPerDay * baseBytes * scope
  const filesWrittenPerDay = Math.ceil(bytesRewrittenPerDay / targetFileBytes)
  /* Inputs a compaction must GET: the base files it rewrites plus the delta
   * files it merges in. Distinct from the PUTs above, and both are requests. */
  const filesReadByCompactionPerDay = filesWrittenPerDay + Math.ceil(dailyLogicalChangeBytes / targetFileBytes)
  const requestsAddedPerDay = filesWrittenPerDay + filesReadByCompactionPerDay

  const liveBytes = baseBytes
  const tombstonedBytes = baseBytes * Math.max(0, Math.min(1, tombstoneFraction))
  const retentionDays = expiryWindowDays === null ? projectionHorizonDays : Math.max(0, expiryWindowDays)
  const retainedSupersededBytes = bytesRewrittenPerDay * retentionDays
  const totalStorageBytes = liveBytes + tombstonedBytes + retainedSupersededBytes

  return {
    amplification: {
      read,
      write,
      metadata: readMetadataTerm,
    },
    readDataTerm,
    readMetadataTerm,
    compactionsPerDay,
    bytesRewrittenPerDay,
    rewriteShareOfTablePerDay: bytesRewrittenPerDay / baseBytes,
    filesWrittenPerDay,
    requestsAddedPerDay,
    liveBytes,
    tombstonedBytes,
    retainedSupersededBytes,
    totalStorageBytes,
    storageMultiple: totalStorageBytes / liveBytes,
    storageBounded: expiryWindowDays !== null,
    /*
     * Labour, counted the way the TCO desk counts it: a background job with a
     * trigger, an alarm and a backlog slope is roughly a quarter of an
     * engineer-month a year to own once built, plus more when it has no expiry
     * policy and someone must reason about storage growth by hand.
     */
    engineerMonthsPerYear: expiryWindowDays === null ? 0.75 : 0.25,
  }
}

/* ------------------------------- grading ------------------------------- */

/** The count terms a cost statement must contain. All counts, no clocks. */
export interface CostStatement {
  bytesRewrittenPerDay: number | null
  rewriteShareOfTablePerDay: number | null
  filesCreatedPerDay: number | null
  filesMergedPerDay: number | null
  requestsAddedPerDay: number | null
  /** The pricing shape, by name. The rate is yours, not this desk's. */
  pricingShapeNamed: string | null
  /**
   * True if the submission quoted its cost as wall-clock — "two hours nightly".
   * Graded as a failure: an hour does not transfer between machines.
   */
  quotedWallClock: boolean
}

export interface CompactionSubmission {
  input: CompactionInput
  /** Read amp claimed, as a ratio, with both terms below. */
  claimedReadAmp: number
  /** Ceiling the policy commits to. A caller-supplied count of ratio. */
  readAmpCeiling: number
  /** The budget. null = no budget, i.e. an unbounded background bill. */
  claimedWriteAmp: number | null
  /** Did they state what recovery looks like once the expiry window closes? */
  statedRecoveryAfterExpiry: boolean
  /** total ÷ live, as the learner computes it. */
  claimedStorageMultiple: number
  /** Whether stranded rows were named, if any exist. */
  statedStrandedRows: boolean
  cost: CostStatement
}

/**
 * Read amp is banded on its OVERHEAD (read − 1) rather than on the ratio, and
 * the difference matters: ±10% of 1.02× spans 0.92–1.12×, which would accept a
 * figure with six times the actual overhead. Banding the overhead grades the
 * thing the policy controls.
 */
export const READ_AMP_TOLERANCE_PCT = 25
export const WRITE_AMP_TOLERANCE_PCT = 20
export const STORAGE_TOLERANCE_PCT = 20

export function gradeCompaction(sub: CompactionSubmission): DeskReport {
  const checks: Check[] = []
  const out = modelCompaction(sub.input)
  const i = sub.input

  /* ---- read_amp_bounded: banded on the overhead, absolute against the ceiling ---- */
  const overheadBand: Band = bandAround(out.amplification.read - 1, READ_AMP_TOLERANCE_PCT)
  const readBand: Band = { lo: 1 + overheadBand.lo, hi: 1 + overheadBand.hi }
  const itemised = `data term ${out.readDataTerm.toFixed(4)} (1 + ${fmtBytes(
    i.triggerDeltaBytes,
  )} trigger ÷ 2 × ${fmtBytes(i.baseBytes)} base) + metadata term ${out.readMetadataTerm.toFixed(4)} (${fmtCount(
    i.filesReadPerQuery,
  )} files × ${fmtBytes(i.footerBytes)} footers ÷ ${fmtBytes(i.answerBytes)} the answer needed)`

  if (out.amplification.read > sub.readAmpCeiling) {
    checks.push(
      fail(
        'read_amp_bounded',
        'read amplification under its ceiling',
        `reference read amp is ${out.amplification.read.toFixed(3)}× against a committed ceiling of ${sub.readAmpCeiling.toFixed(
          3,
        )}×. Itemise: ${itemised}. ${
          out.readMetadataTerm > out.readDataTerm - 1
            ? 'The metadata term is the larger of the two here — footers, not data — so lowering the trigger will not help; the lever is fewer, larger files.'
            : 'The data term dominates, so the trigger is set too high: unmerged delta is what the reader pays for.'
        }`,
      ),
    )
  } else if (!inBand(sub.claimedReadAmp, readBand)) {
    checks.push(
      fail(
        'read_amp_bounded',
        'read amplification under its ceiling',
        `claimed ${sub.claimedReadAmp.toFixed(3)}×, reference ${out.amplification.read.toFixed(
          3,
        )}× (band ${readBand.lo.toFixed(3)}–${readBand.hi.toFixed(3)}). Itemise: ${itemised}. ${
          sub.claimedReadAmp < readBand.lo
            ? 'A figure below the reference almost always means the METADATA term was omitted: footers are counted as planning rather than reading, and they are read bytes like any other.'
            : 'A figure above the reference usually means the end state was measured instead of the whole cycle — grading where the last compaction fell rather than the average read.'
        } A ceiling with no measurement method is unfalsifiable, so state both terms and the point in the cycle you measured.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'read_amp_bounded',
        'read amplification under its ceiling',
        `${sub.claimedReadAmp.toFixed(3)}× claimed, reference ${out.amplification.read.toFixed(
          3,
        )}×, ceiling ${sub.readAmpCeiling.toFixed(3)}×; ${itemised}`,
      ),
    )
  }

  /* ---- write_amp_budget: no budget is an outright failure ---- */
  const writeBand: Band = bandAround(out.amplification.write, WRITE_AMP_TOLERANCE_PCT)
  if (sub.claimedWriteAmp === null) {
    checks.push(
      fail(
        'write_amp_budget',
        'write amplification budgeted',
        `no write-amplification budget stated, which makes this an unbounded background bill rather than a policy. The reference figure is ${round2(
          out.amplification.write,
        )}× from 1 + (base × scope) ÷ delta-at-trigger = 1 + (${fmtBytes(i.baseBytes)} × ${i.compactionScopeFraction.toFixed(
          2,
        )}) ÷ ${fmtBytes(
          i.triggerDeltaBytes,
        )}: ${fmtBytes(out.bytesRewrittenPerDay)} rewritten per day for ${fmtBytes(
          i.dailyLogicalChangeBytes,
        )} of logical change, across ${round2(
          out.compactionsPerDay,
        )} compactions a day. Say it as a bill, not a ratio: every ingested byte is written ${round2(
          out.amplification.write,
        )} times, forever, for as long as this table exists. The omission fails this check on its own, because a background job with no budget has no condition under which anyone would notice it growing.`,
      ),
    )
  } else if (!inBand(sub.claimedWriteAmp, writeBand)) {
    checks.push(
      fail(
        'write_amp_budget',
        'write amplification budgeted',
        `budgeted ${round2(sub.claimedWriteAmp)}×, reference ${round2(
          out.amplification.write,
        )}× (band ${writeBand.lo.toFixed(2)}–${writeBand.hi.toFixed(
          2,
        )}). Derivation: write amp = 1 + (base × scope) ÷ delta-at-trigger = 1 + (${fmtBytes(
          i.baseBytes,
        )} × ${i.compactionScopeFraction.toFixed(2)}) ÷ ${fmtBytes(
          i.triggerDeltaBytes,
        )} = ${round2(out.amplification.write)}×, i.e. ${fmtBytes(
          out.bytesRewrittenPerDay,
        )}/day rewritten against ${fmtBytes(i.dailyLogicalChangeBytes)}/day ingested. ${
          sub.claimedWriteAmp < writeBand.lo
            ? `A low figure usually comes from a model that never rewrites sealed files, or from assuming a narrower compaction scope than ${i.compactionScopeFraction.toFixed(
                2,
              )}: if that is your model, say so and leave headroom.`
            : 'A high figure usually double-counts the ingest write itself — the 1 in the formula is that write, so it is counted once.'
        }`,
      ),
    )
  } else {
    checks.push(
      pass(
        'write_amp_budget',
        'write amplification budgeted',
        `${round2(sub.claimedWriteAmp)}× budgeted against reference ${round2(
          out.amplification.write,
        )}× — every ingested byte written ${round2(out.amplification.write)} times, ${fmtBytes(
          out.bytesRewrittenPerDay,
        )}/day`,
      ),
    )
  }

  /* ---- expiry_stated: DISCIPLINE. A retention window is a risk decision. ---- */
  if (i.expiryWindowDays === null) {
    checks.push(
      fail(
        'expiry_stated',
        'expiry window stated as a risk decision',
        `no expiry window. Retained superseded files are the third storage component and without a window they have no bound: at this policy's rewrite rate of ${fmtBytes(
          out.bytesRewrittenPerDay,
        )}/day they reach ${fmtBytes(out.retainedSupersededBytes)} in ${fmtCount(
          i.projectionHorizonDays,
        )} days, taking the table to ${round2(out.storageMultiple)}× its live size of ${fmtBytes(
          out.liveBytes,
        )} — and continuing. The omission is the failure even where your read and write amp figures are exact: expiry is the only term in this policy that converts an amplification ratio into a storage total, so a policy without it is bounded in ratio and unbounded in bytes. State the window, the storage multiple it costs on this table's rewrite rate, and what recovery looks like once it closes.`,
      ),
    )
  } else if (!sub.statedRecoveryAfterExpiry) {
    checks.push(
      fail(
        'expiry_stated',
        'expiry window stated as a risk decision',
        `${fmtCount(
          i.expiryWindowDays,
        )}-day window stated, but not what recovery looks like after it closes. That is the risk half of the decision and the reason the window is a decision at all: past ${fmtCount(
          i.expiryWindowDays,
        )} days time travel cannot reconstruct the table, and time travel lives in the same metadata tree it would have to recover from — one failure domain where you believed you had two. The window costs ${fmtBytes(
          out.retainedSupersededBytes,
        )} of retained superseded files, ${round2(out.storageMultiple)}× live; say what the recovery path is beyond it.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'expiry_stated',
        'expiry window stated as a risk decision',
        `${fmtCount(i.expiryWindowDays)} days, costing ${fmtBytes(
          out.retainedSupersededBytes,
        )} retained (${round2(out.storageMultiple)}× live), with a recovery path stated beyond it`,
      ),
    )
  }

  /* ---- storage_stable: all three components bounded, multiple in band ---- */
  const storageBand: Band = bandAround(out.storageMultiple, STORAGE_TOLERANCE_PCT)
  const storageIssues: string[] = []
  if (!out.storageBounded) {
    storageIssues.push(
      `the retained-superseded component is unbounded with no expiry window, so only 2 of the 3 components have a bound (live ${fmtBytes(
        out.liveBytes,
      )}, tombstoned ${fmtBytes(out.tombstonedBytes)}, retained UNBOUNDED — projected ${fmtBytes(
        out.retainedSupersededBytes,
      )} at ${fmtCount(i.projectionHorizonDays)} days)`,
    )
  }
  if (!inBand(sub.claimedStorageMultiple, storageBand)) {
    storageIssues.push(
      `claimed ${round2(sub.claimedStorageMultiple)}× storage multiple, reference ${round2(
        out.storageMultiple,
      )}× (band ${storageBand.lo.toFixed(2)}–${storageBand.hi.toFixed(2)}×) = (live ${fmtBytes(
        out.liveBytes,
      )} + tombstoned ${fmtBytes(out.tombstonedBytes)} + retained ${fmtBytes(
        out.retainedSupersededBytes,
      )}) ÷ live; a figure of 1.0× counts only the live component, which is the one component that was never at risk`,
    )
  }
  if (i.tombstoneFraction > 0 && !sub.statedStrandedRows) {
    storageIssues.push(
      `${pct(i.tombstoneFraction)} of the base is tombstoned but still present (${fmtBytes(
        out.tombstonedBytes,
      )}) and no stranded rows were named; a delete that has not been compacted away is still stored and still read`,
    )
  }
  checks.push(
    storageIssues.length === 0
      ? pass(
          'storage_stable',
          'all three storage components bounded',
          `live ${fmtBytes(out.liveBytes)} + tombstoned ${fmtBytes(out.tombstonedBytes)} + retained ${fmtBytes(
            out.retainedSupersededBytes,
          )} = ${fmtBytes(out.totalStorageBytes)}, ${round2(out.storageMultiple)}× live, all bounded`,
        )
      : fail('storage_stable', 'all three storage components bounded', storageIssues.join('. ') + '.'),
  )

  /* ---- cost_counted: DISCIPLINE. Every term a COUNT, and no clocks. ---- */
  const c = sub.cost
  const missing: string[] = []
  if (c.bytesRewrittenPerDay === null) missing.push('bytes rewritten per day')
  if (c.rewriteShareOfTablePerDay === null) missing.push('that as a share of table size per day')
  if (c.filesCreatedPerDay === null) missing.push('file creation rate')
  if (c.filesMergedPerDay === null) missing.push('file merge rate')
  if (c.requestsAddedPerDay === null) missing.push('requests added')
  if (c.pricingShapeNamed === null) missing.push('the pricing shape it lands on')

  if (c.quotedWallClock) {
    checks.push(
      fail(
        'cost_counted',
        'every cost term is a count',
        `the cost is quoted in wall-clock. An hour of compaction means a different amount of work on every cluster size, so it cannot be diffed, replayed or held to a budget; a count can. Restate it as counts: ${fmtBytes(
          out.bytesRewrittenPerDay,
        )} rewritten per day, ${pct(
          out.rewriteShareOfTablePerDay,
        )} of the table per day, ${fmtCount(out.filesWrittenPerDay)} files written per day, ${fmtCount(
          out.requestsAddedPerDay,
        )} requests added per day, ${round2(
          out.engineerMonthsPerYear,
        )} engineer-months a year to own it. Then name the pricing shape and multiply by your own rate — this desk does not know your prices and should not.`,
      ),
    )
  } else if (missing.length > 0) {
    checks.push(
      fail(
        'cost_counted',
        'every cost term is a count',
        `omitted: ${missing.join('; ')}. Reference, all counts: ${fmtBytes(
          out.bytesRewrittenPerDay,
        )} rewritten per day, which is ${pct(out.rewriteShareOfTablePerDay)} of the ${fmtBytes(
          out.liveBytes,
        )} table every day; ${fmtCount(out.filesWrittenPerDay)} files written per day; ${fmtCount(
          out.requestsAddedPerDay,
        )} requests added per day; ${round2(
          out.engineerMonthsPerYear,
        )} engineer-months a year. ${
          c.pricingShapeNamed === null
            ? 'Without the pricing shape none of those counts is a bill: the same rewrite volume is the whole cost under per-byte-written and nearly free under a flat provisioned cluster you already run. '
            : ''
        }An omitted term makes the policy look cheaper than it is by exactly the amount of the term, which is why the check grades presence and not only accuracy.`,
      ),
    )
  } else {
    const rewriteOff = !inBand(
      c.bytesRewrittenPerDay ?? 0,
      bandAround(out.bytesRewrittenPerDay, WRITE_AMP_TOLERANCE_PCT),
    )
    checks.push(
      rewriteOff
        ? fail(
            'cost_counted',
            'every cost term is a count',
            `all terms present, but bytes rewritten per day is ${fmtBytes(
              c.bytesRewrittenPerDay ?? 0,
            )} against a reference ${fmtBytes(out.bytesRewrittenPerDay)} = ${round2(
              out.compactionsPerDay,
            )} compactions/day × ${fmtBytes(i.baseBytes)} base × ${i.compactionScopeFraction.toFixed(2)} scope. That is ${pct(
              out.rewriteShareOfTablePerDay,
            )} of the table per day, and it is the term the pricing shape (${c.pricingShapeNamed}) multiplies.`,
          )
        : pass(
            'cost_counted',
            'every cost term is a count',
            `${fmtBytes(out.bytesRewrittenPerDay)}/day rewritten (${pct(
              out.rewriteShareOfTablePerDay,
            )} of the table), ${fmtCount(out.filesWrittenPerDay)} files/day, ${fmtCount(
              out.requestsAddedPerDay,
            )} requests/day, ${round2(
              out.engineerMonthsPerYear,
            )} engineer-months/year, on ${c.pricingShapeNamed} — counts only, rate supplied by the caller`,
          ),
    )
  }

  return { desk: 'compaction-desk', version: 1, checks }
}

/**
 * A levelled policy on a real table, not the browser lab's toy. Read amp lands
 * near 1.02× — of which the metadata term is the larger half, which is the
 * result worth carrying: at a 40 GiB base with a 512 MiB trigger the unmerged
 * delta costs a reader almost nothing and the footers cost more.
 *
 * Set `compactionScopeFraction: 1` to recover C5's full-rewrite arithmetic,
 * where write amp collapses to base ÷ delta at the trigger.
 */
export const COMPACTION_WORKED_EXAMPLE: CompactionInput = {
  baseBytes: 40 * GIB,
  compactionScopeFraction: 0.03,
  triggerDeltaBytes: 512 * MIB,
  targetFileBytes: 128 * MIB,
  dailyLogicalChangeBytes: 2 * GIB,
  tombstoneFraction: 0.03,
  expiryWindowDays: 7,
  projectionHorizonDays: 90,
  footerBytes: 24 * KIB,
  filesReadPerQuery: 22,
  answerBytes: 32 * MIB,
}

/** For lessons that quote the storage total in GiB. */
export const workedStorageGiB = (): number => toGiB(modelCompaction(COMPACTION_WORKED_EXAMPLE).totalStorageBytes)
