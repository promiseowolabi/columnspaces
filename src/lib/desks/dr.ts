/**
 * dr.ts — `dr-desk` (L500). What is the RPO and the RTO, and what does
 * "restore" even mean when the table is a manifest tree?
 *
 * The single most common error at this desk: time travel offered as the backup
 * story. Time travel is a wonderful feature and it is not a backup, because it
 * lives in the SAME metadata tree it would have to recover from. An RPO that
 * rests on it has ONE failure domain where the plan claimed two — and the
 * failure mode that takes out a metadata tree (a bad commit, a broken catalog
 * migration, a deletion with the wrong prefix, an expiry job with the wrong
 * retention) is exactly the failure mode you were buying a second domain for.
 *
 * Objectives here are durations, because that is what an RPO and an RTO are.
 * Everything that COSTS is a count: manifest entries to re-register, bytes to
 * copy, copies held, drills completed. The RTO is derived from those counts
 * divided by throughput rates the CALLER measured on their own system — which
 * is the honest form, because an RTO asserted without a measured restore rate
 * is a wish with a unit attached.
 *
 * Three checks fail on omission no matter how good the two numbers are:
 * `metadata_path` (the recovery path for the metadata tree itself),
 * `cross_region` (a copy in a genuinely independent domain), and `tested` —
 * a DR plan that has never been tested is not a plan, it is a document.
 */

import { bandAround, fail, fmtBytes, fmtCount, inBand, pass } from './kit'
import type { Check, DeskReport } from './kit'

/** Objectives are quoted in whole minutes, so their bands are generous by design. */
export const RPO_TOLERANCE_PCT = 20
export const RTO_TOLERANCE_PCT = 25

/** Minutes in a day. Used to turn a per-day ingest count into bytes at risk. */
export const MINUTES_PER_DAY = 1440

/* --------------------------------- input --------------------------------- */

export interface DrInput {
  /** Minutes between table commits. The floor on any RPO. */
  commitIntervalMinutes: number
  /** Minutes between replications of metadata and data to the second domain. */
  replicationIntervalMinutes: number
  /** Bytes landed per day. Turns an RPO in minutes into bytes at risk — a count. */
  ingestBytesPerDay: number

  /* ---- what a restore actually has to do, in counts ---- */
  /** Manifest entries in the table. Every one is re-read or re-registered on recovery. */
  manifestEntries: number
  /** Entries the catalog can re-register per minute, MEASURED on your system. */
  entriesRestoredPerMinute: number
  /** Bytes the copy path moves per minute, MEASURED. */
  bytesCopiedPerMinute: number
  /** Bytes that must be re-materialised. Zero when only metadata was lost. */
  bytesToRestore: number
  /** Fixed overhead: detection, paging, the decision to fail over, the cutover itself. */
  coordinationMinutes: number

  /* ---- failure domains ---- */
  /** Copies held in another region. A count. */
  crossRegionCopies: number
  /** Do those copies have their own catalog, or do they point at the same metadata tree? */
  copiesHaveIndependentCatalog: boolean
  /** Is the RPO argument resting on time travel or the snapshot expiry window? */
  reliesOnTimeTravel: boolean
  /** Is metadata exported OUTSIDE the live tree, to a store that cannot be taken with it? */
  metadataExportedIndependently: boolean

  /* ---- evidence ---- */
  /** Restore drills actually completed. A count, and zero is a real answer. */
  drillsCompleted: number
  /** Did any drill exercise METADATA loss, rather than only region loss? */
  drillCoveredMetadataLoss: boolean
  /** Manifest entries the last drill actually restored. Compared against the real table. */
  drillEntriesRestored: number
}

/* --------------------------------- output --------------------------------- */

export interface DrOutput {
  /** Replication interval plus the in-flight commit you also lose. */
  rpoMinutes: number
  /** The same window expressed as commits — the unit the table actually moves in. */
  rpoCommits: number
  /** Bytes unrecoverable at the RPO. The count that makes the RPO arguable. */
  bytesAtRisk: number
  /** Minutes to re-register the manifest tree. Usually the dominant term. */
  metadataRestoreMinutes: number
  /** Minutes to move bytes back. Zero when the data plane survived. */
  dataRestoreMinutes: number
  rtoMinutes: number
  /** Share of the RTO that is metadata rather than data. */
  metadataShareOfRto: number
  /** Independent domains the METADATA exists in. 1 is the number people believe is 2. */
  metadataDomains: number
  /** Independent domains the DATA exists in. */
  dataDomains: number
  /**
   * True when the RPO rests on the same metadata tree it would recover from.
   * The stated RPO is then not wrong so much as inapplicable to the failure
   * that matters.
   */
  singleMetadataDomain: boolean
  /** Fraction of the real table a drill has actually restored. */
  drillCoverage: number
}

const safe = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

const posDiv = (v: number, floor = 1): number => (Number.isFinite(v) && v > 0 ? v : floor)

/** Pure reference model. No clock read, no randomness, no rates baked in. */
export function computeDr(input: DrInput): DrOutput {
  const commit = safe(input.commitIntervalMinutes)
  const replication = safe(input.replicationIntervalMinutes)

  /*
   * You lose the replication window AND the commit in flight when the primary
   * goes: the last replicated snapshot is up to one interval old, and anything
   * written since the last commit was never in a snapshot at all.
   */
  const rpoMinutes = replication + commit
  const rpoCommits = commit > 0 ? Math.ceil(rpoMinutes / commit) : 0
  const bytesAtRisk = (safe(input.ingestBytesPerDay) * rpoMinutes) / MINUTES_PER_DAY

  const metadataRestoreMinutes = safe(input.manifestEntries) / posDiv(input.entriesRestoredPerMinute)
  const dataRestoreMinutes = safe(input.bytesToRestore) / posDiv(input.bytesCopiedPerMinute)
  const rtoMinutes = safe(input.coordinationMinutes) + metadataRestoreMinutes + dataRestoreMinutes

  const independentCopies = safe(input.crossRegionCopies) > 0
  const dataDomains = 1 + (independentCopies ? 1 : 0)
  const metadataDomains =
    1 +
    (input.metadataExportedIndependently ? 1 : 0) +
    (independentCopies && input.copiesHaveIndependentCatalog ? 1 : 0)

  return {
    rpoMinutes,
    rpoCommits,
    bytesAtRisk,
    metadataRestoreMinutes,
    dataRestoreMinutes,
    rtoMinutes,
    metadataShareOfRto: rtoMinutes > 0 ? metadataRestoreMinutes / rtoMinutes : 0,
    metadataDomains,
    dataDomains,
    singleMetadataDomain: metadataDomains < 2,
    drillCoverage: safe(input.manifestEntries) > 0 ? safe(input.drillEntriesRestored) / safe(input.manifestEntries) : 0,
  }
}

/* -------------------------------- grading -------------------------------- */

export interface DrSubmission {
  input: DrInput
  /** The RPO the plan promises, in minutes. */
  claimedRpoMinutes: number
  /** The RTO the plan promises, in minutes. */
  claimedRtoMinutes: number
  /**
   * Does the plan describe how the METADATA tree is recovered, as opposed to
   * how the files are? null means the section is not there.
   */
  metadataRecoveryPath: string | null
}

export function gradeDr(sub: DrSubmission): DeskReport {
  const out = computeDr(sub.input)
  const checks: Check[] = []

  /* 1. rpo — the window, and the bytes inside it. */
  const rpoBand = bandAround(out.rpoMinutes, RPO_TOLERANCE_PCT)
  checks.push(
    inBand(sub.claimedRpoMinutes, rpoBand)
      ? pass(
          'rpo',
          'RPO within tolerance',
          `${out.rpoMinutes.toFixed(0)} min = ${sub.input.replicationIntervalMinutes} replication + ${sub.input.commitIntervalMinutes} in-flight commit; ${out.rpoCommits} commits and ${fmtBytes(out.bytesAtRisk)} at risk`,
        )
      : fail(
          'rpo',
          'RPO within tolerance',
          `claimed ${sub.claimedRpoMinutes.toFixed(0)} min, reference ${out.rpoMinutes.toFixed(0)} (band ${rpoBand.lo.toFixed(0)}–${rpoBand.hi.toFixed(0)}). The window is the replication interval PLUS the commit in flight: the last replicated snapshot is up to one interval old, and rows written since the last commit were never in a snapshot at all. That is ${out.rpoCommits} commits and ${fmtBytes(out.bytesAtRisk)} of data.`,
        ),
  )

  /* 2. rto — derived from counts and the caller's own measured restore rates. */
  const rtoBand = bandAround(out.rtoMinutes, RTO_TOLERANCE_PCT)
  checks.push(
    inBand(sub.claimedRtoMinutes, rtoBand)
      ? pass(
          'rto',
          'RTO within tolerance',
          `${out.rtoMinutes.toFixed(0)} min: ${sub.input.coordinationMinutes} coordination + ${out.metadataRestoreMinutes.toFixed(0)} for ${fmtCount(sub.input.manifestEntries)} manifest entries + ${out.dataRestoreMinutes.toFixed(0)} for ${fmtBytes(sub.input.bytesToRestore)} — metadata is ${(out.metadataShareOfRto * 100).toFixed(0)}% of it`,
        )
      : fail(
          'rto',
          'RTO within tolerance',
          `claimed ${sub.claimedRtoMinutes.toFixed(0)} min, reference ${out.rtoMinutes.toFixed(0)} (band ${rtoBand.lo.toFixed(0)}–${rtoBand.hi.toFixed(0)}). An RTO is a COUNT divided by a measured rate: ${fmtCount(sub.input.manifestEntries)} manifest entries at ${fmtCount(sub.input.entriesRestoredPerMinute)}/min is ${out.metadataRestoreMinutes.toFixed(0)} min on its own — ${(out.metadataShareOfRto * 100).toFixed(0)}% of the reference — and the file count, not the byte count, is what sets it.`,
        ),
  )

  /* 3. metadata_path — the failure-domain check, and the reason this desk exists. */
  if (out.singleMetadataDomain) {
    checks.push(
      fail(
        'metadata_path',
        'metadata recovery path independent',
        `the metadata tree exists in ${out.metadataDomains} independent domain. ${
          sub.input.reliesOnTimeTravel
            ? 'This plan rests on time travel, which lives in the same metadata tree it would have to recover from'
            : 'Nothing exports the manifest tree outside itself'
        }: a bad commit, a catalog migration, a deletion with the wrong prefix or an expiry job with the wrong retention takes the recovery path out along with the table. You believed you had 2 domains and you have 1. Export manifests to a store that cannot be taken with the tree, or give the replica its own catalog.`,
      ),
    )
  } else if (sub.input.reliesOnTimeTravel && !sub.input.metadataExportedIndependently) {
    checks.push(
      fail(
        'metadata_path',
        'metadata recovery path independent',
        `the RPO rests on time travel, and time travel is not backup: it is a read of the same manifest tree the incident destroyed. The cross-region copy gives the DATA a second domain, but the metadata still has one recovery path. State how the manifest tree itself is rebuilt.`,
      ),
    )
  } else if (!sub.metadataRecoveryPath || sub.metadataRecoveryPath.trim().length === 0) {
    checks.push(
      fail(
        'metadata_path',
        'metadata recovery path independent',
        `metadata recovery path not stated. The plan describes how files come back and not how the TABLE comes back — and a restore of ${fmtCount(sub.input.manifestEntries)} files with no manifest tree to name them is a bucket, not a table. Metadata is ${(out.metadataShareOfRto * 100).toFixed(0)}% of the reference RTO, so this is also the largest term you have left unwritten.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'metadata_path',
        'metadata recovery path independent',
        `metadata in ${out.metadataDomains} independent domains, data in ${out.dataDomains}; recovery path stated: "${sub.metadataRecoveryPath.trim()}"`,
      ),
    )
  }

  /* 4. tested — a plan never tested is a document. */
  if (safe(sub.input.drillsCompleted) === 0) {
    checks.push(
      fail(
        'tested',
        'restore tested',
        `0 restore drills completed. An untested DR plan is not a plan, it is a document: the RPO and the RTO above are both derived from rates nobody has observed under failure, and every first restore discovers at least one credential, quota or ordering dependency that no design review finds. The count that makes this check pass is 1.`,
      ),
    )
  } else if (!sub.input.drillCoveredMetadataLoss) {
    checks.push(
      fail(
        'tested',
        'restore tested',
        `${fmtCount(sub.input.drillsCompleted)} drills completed, none exercising METADATA loss. Failing over to a healthy replica tests the network; it does not test rebuilding a manifest tree, which is the ${(out.metadataShareOfRto * 100).toFixed(0)}% of the RTO you have never run. Drill the failure you are actually exposed to.`,
      ),
    )
  } else if (out.drillCoverage < 0.1) {
    checks.push(
      fail(
        'tested',
        'restore tested',
        `drills restored ${fmtCount(sub.input.drillEntriesRestored)} of ${fmtCount(sub.input.manifestEntries)} manifest entries (${(out.drillCoverage * 100).toFixed(1)}%). A drill on a toy table measures the procedure and not the rate, and the RTO is a count divided by a rate — so this evidence supports the runbook and not the number.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'tested',
        'restore tested',
        `${fmtCount(sub.input.drillsCompleted)} drills including metadata loss, covering ${(out.drillCoverage * 100).toFixed(0)}% of the manifest entries`,
      ),
    )
  }

  /* 5. cross_region — a copy is only a copy if it is in another failure domain. */
  if (safe(sub.input.crossRegionCopies) === 0) {
    checks.push(
      fail(
        'cross_region',
        'independent regional copy',
        `0 cross-region copies. Object storage durability is not availability and it is not a second failure domain: it protects against media loss, not against the region, the account or the operator action that deleted the prefix. ${fmtBytes(out.bytesAtRisk)} is at risk at the stated RPO and the whole table is at risk at the one you have not stated.`,
      ),
    )
  } else if (!sub.input.copiesHaveIndependentCatalog) {
    checks.push(
      fail(
        'cross_region',
        'independent regional copy',
        `${fmtCount(sub.input.crossRegionCopies)} cross-region copies, all pointing at the same catalog. The files are in two regions and the table is in one: lose the catalog and the second copy is an unnamed pile of Parquet. Give the replica its own catalog, or the copy buys durability without buying recoverability.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'cross_region',
        'independent regional copy',
        `${fmtCount(sub.input.crossRegionCopies)} cross-region copies with their own catalog: ${out.dataDomains} data domains, ${out.metadataDomains} metadata domains`,
      ),
    )
  }

  return { desk: 'dr-desk', version: 1, checks }
}
