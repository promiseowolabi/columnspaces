/**
 * policy.ts — the compaction policy the C5 browser lab designs, as arithmetic.
 *
 * ── What this models, and what it does not ─────────────────────────────────
 * A merge-on-read table under a stream of commits. Every commit lands a file;
 * updates and deletes land a delete vector beside it; a compaction policy
 * decides when that pile is folded back into the base files and how large the
 * base files are allowed to get. The output is four counts — read amplification,
 * write amplification, storage held, files live — and nothing else. No clock.
 *
 * It is a MODEL. It does not read Parquet, it does not run a merge, and there is
 * no data. What it does have is the mechanism: a file per commit, a delete
 * position per deleted row, a footer per file the reader must open, and a rewrite
 * whose size is the open file plus everything that has accumulated since the last
 * one. The two file-level constants — `FOOTER_BYTES` and `DELETE_POS_BYTES` —
 * are imported from the Warehouse engine rather than re-chosen here, so a reader
 * who compares this lab's read amplification to the Warehouse's is comparing
 * numbers built from the same figures.
 *
 * ── The structural claim ──────────────────────────────────────────────────
 * Read amplification and write amplification move in OPPOSITE directions along
 * both dials, and the lab is only worth building because that is a theorem about
 * the model rather than a sentence in the copy:
 *
 *   · Compacting more often (a lower trigger) folds the delta pile away sooner,
 *     so a reader opens fewer files and reads fewer superseded rows — and every
 *     one of those compactions rewrites the open base file again.
 *   · A larger target file size means fewer, bigger base files, so fewer footers
 *     per scan — and every compaction now rewrites a bigger open file, so the
 *     same logical bytes are written more times before they finally settle.
 *
 * There is no policy that is best on both. The graded task therefore pairs a
 * read-amp CEILING with a write-amp BUDGET, so passing requires finding the
 * region where both hold rather than expressing a preference — the same
 * structural-tradeoff shape `@/lib/layout/mix` uses for the layout designer.
 *
 * ── Determinism ───────────────────────────────────────────────────────────
 * The commit sequence comes from the seeded xorshift in `desks/kit` and is built
 * ONCE per workload, then priced against every policy. So any difference between
 * two policies is caused by the policy: same commits, same rows, same order. No
 * `Math.random`, no dates, no wall-clock anywhere beneath this file.
 */

import { Rng } from '@/lib/desks/kit'
import { DELETE_POS_BYTES, FOOTER_BYTES } from '@/lib/warehouse/engine'

/**
 * Re-exported so the lab UI can quote the two file-level constants it is priced
 * with, without importing the engine itself. They are the engine's figures: a
 * Parquet footer read per file opened, and one position per deleted row in a
 * merge-on-read delete vector.
 */
export { DELETE_POS_BYTES, FOOTER_BYTES }

/** Stored bytes per row. A constant of the fixture, so bills are hand-checkable. */
export const ROW_BYTES = 64

/** Commits in a run. Each one is an append, an update or a delete. */
export const COMMITS = 240

/**
 * How many commits a superseded file is retained for before expiry reclaims it.
 * Time travel is not free: a compaction that rewrites 40 MiB does not release the
 * old 40 MiB until the snapshot that references it falls out of the window.
 */
export const RETENTION_COMMITS = 24

/* ------------------------------ the workload ----------------------------- */

export type OpKind = 'append' | 'update' | 'delete'

export interface Commit {
  index: number
  kind: OpKind
  /** Rows written by this commit (new or new versions). */
  rowsWritten: number
  /** Rows this commit tombstones. */
  rowsDeleted: number
}

export interface WorkloadSpec {
  id: string
  label: string
  /** Rows in the table before the run starts. */
  baseRows: number
  /** Mean rows per write commit. */
  meanCommitRows: number
  /** Spread of the commit size, as a fraction of the mean. */
  commitSpread: number
  /** Share of commits that are updates, and that are deletes. The rest append. */
  updateShare: number
  deleteShare: number
  seed: number
  why: string
}

/**
 * Three write rates. The reference workload is the middle one; the other two
 * exist so the reader can watch the whole tradeoff shift under them rather than
 * believing the frontier is a property of the policy alone.
 */
export const WORKLOADS: WorkloadSpec[] = [
  {
    id: 'trickle',
    label: 'trickle · 5-minute batches',
    baseRows: 2_000_000,
    meanCommitRows: 2_000,
    commitSpread: 0.4,
    updateShare: 0.2,
    deleteShare: 0.08,
    seed: 0x51ce_0001,
    why: 'Small, frequent commits: the small-file storm in its purest form. The bytes are trivial and the file count is not.',
  },
  {
    id: 'steady',
    label: 'steady · hourly loads',
    baseRows: 2_000_000,
    meanCommitRows: 24_000,
    commitSpread: 0.5,
    updateShare: 0.25,
    deleteShare: 0.1,
    seed: 0x51ce_0002,
    why: 'The reference workload. Commits large enough to be real files, updates frequent enough that delete vectors matter.',
  },
  {
    id: 'flood',
    label: 'flood · CDC stream with restatements',
    baseRows: 2_000_000,
    meanCommitRows: 60_000,
    commitSpread: 0.6,
    updateShare: 0.45,
    deleteShare: 0.15,
    seed: 0x51ce_0003,
    why: 'Update-heavy: nearly half of every commit supersedes rows that are already there, so the pile grows faster than the table does.',
  },
]

export const REFERENCE_WORKLOAD = 'steady'

export const workloadSpec = (id: string): WorkloadSpec => {
  const w = WORKLOADS.find((x) => x.id === id)
  if (!w) throw new Error(`no workload ${id}`)
  return w
}

/**
 * Build the commit sequence. Pure function of the spec, memoised, and built
 * independently of any policy — the whole point is that every policy is priced
 * against the identical stream.
 */
const sequenceCache = new Map<string, Commit[]>()

export function commitSequence(spec: WorkloadSpec): Commit[] {
  const hit = sequenceCache.get(spec.id)
  if (hit) return hit

  const rng = new Rng(spec.seed)
  const out: Commit[] = []
  for (let i = 0; i < COMMITS; i++) {
    const roll = rng.uniform(0, 1)
    const kind: OpKind =
      roll < spec.deleteShare
        ? 'delete'
        : roll < spec.deleteShare + spec.updateShare
          ? 'update'
          : 'append'
    const jitter = 1 + (rng.uniform(0, 1) * 2 - 1) * spec.commitSpread
    const rows = Math.max(1, Math.round(spec.meanCommitRows * jitter))
    out.push({
      index: i,
      kind,
      rowsWritten: kind === 'delete' ? 0 : rows,
      /* An update supersedes as many rows as it writes; a delete tombstones
       * without writing anything. */
      rowsDeleted: kind === 'append' ? 0 : rows,
    })
  }
  sequenceCache.set(spec.id, out)
  return out
}

/* -------------------------------- the policy ----------------------------- */

export interface Policy {
  /** Compact once this many uncompacted files (data + delete vectors) are live. */
  triggerFiles: number
  /** Rows a sealed base file holds. The compactor seals at this size. */
  targetFileRows: number
}

export const TRIGGER_CHOICES: number[] = [2, 4, 8, 16, 32, 64]

/**
 * Rows a sealed base file holds. Two and a half orders of magnitude, because
 * both ends are traps: 16Ki rows is a 1 MiB file and a footer per megabyte,
 * 4Mi rows is a 256 MiB file that has to be rewritten in full every time the
 * compactor touches it.
 */
export const TARGET_CHOICES: number[] = [16_384, 65_536, 262_144, 1_048_576, 4_194_304]

/**
 * Where the lab opens: compact every 8 files into 1Mi-row (64 MiB) files. It is a
 * conventional, defensible-sounding default that reads beautifully and misses the
 * write budget by roughly 2×, so the reader starts OUTSIDE the solution region.
 * An opener that already satisfied the graded task would grade nothing.
 */
export const OPENING_POLICY: Policy = { triggerFiles: 8, targetFileRows: 1_048_576 }

/**
 * The target size at and above which the compaction trigger still governs the
 * read bill. Below it, stranded tombstones dominate and the trigger loses its
 * grip — which is the interaction the lab asks the reader to name, and the reason
 * the test suite asserts trigger-axis opposition from here upwards rather than
 * everywhere.
 */
export const REFERENCE_TARGET_ROWS = 262_144

export const policyKey = (p: Policy): string => `${p.triggerFiles}|${p.targetFileRows}`

/** Every policy the reader can express: 6 × 5 = 30. */
export const POLICY_GRID: Policy[] = TRIGGER_CHOICES.flatMap((triggerFiles) =>
  TARGET_CHOICES.map((targetFileRows) => ({ triggerFiles, targetFileRows })),
)

/* ------------------------------- the report ------------------------------ */

export interface PolicyReport {
  policy: Policy
  workloadId: string

  /* --- the two amplifications, which is what the lab is for --- */
  /**
   * Bytes a reader must scan to see the current table ÷ bytes of live data the
   * answer needs, accumulated over a read after EVERY commit. 1.0 means every
   * byte read was a byte wanted.
   */
  readAmplification: number
  /** Bytes written to storage ÷ bytes of logical change. 1.0 means nothing was rewritten. */
  writeAmplification: number

  /* --- the two counts that keep the amplifications honest --- */
  /** Live bytes + tombstoned bytes still present + retained superseded files. */
  storageHeldBytes: number
  /** Files a planner has to consider at the end of the run. */
  filesLive: number

  /* --- the terms, so every ratio above can be re-derived on screen --- */
  liveRows: number
  liveBytes: number
  /** Rows physically on storage at the end: base + open + delta, dead included. */
  physicalRows: number
  /** Rows physically present in base files, sealed and open, including tombstoned ones. */
  baseRows: number
  /** Rows sitting in uncompacted commit files. */
  deltaRows: number
  /** Rows physically present but tombstoned — read, then discarded. */
  deadRows: number
  /**
   * Tombstoned rows inside sealed files, which this compactor never rewrites.
   * They are read and discarded on every scan for the rest of the run, and no
   * trigger setting reaches them — which is the cost of having sealed a file
   * smaller than the restatements that follow it.
   */
  deadStranded: number
  /** Delete positions a reader must load to know what to discard. */
  deletePositions: number
  sealedFiles: number
  deltaFiles: number
  deleteFiles: number
  /** Data bytes the reads touched over the run, excluding metadata. */
  bytesScannedData: number
  /** Footer + delete-vector bytes the reads touched. The small-file tax. */
  bytesScannedMetadata: number
  /** Bytes the reads actually needed — live rows, at the same width. */
  bytesNeeded: number
  /** Reads priced. One after every commit. */
  reads: number
  /** Mean files a single read had to open. */
  meanFilesPerRead: number
  bytesIngested: number
  bytesRewritten: number
  compactions: number
  /** Superseded bytes still inside the retention window at the end of the run. */
  retainedBytes: number
  /**
   * Physical rows − tombstoned rows = live rows, checked after EVERY commit.
   * A cost model that loses a row has not found a cheaper plan, it has produced
   * a wrong answer, so this is an absolute rather than a band.
   */
  rowsConserved: boolean
}

/**
 * Price one policy against one workload.
 *
 * The state is deliberately small enough to read in one sitting:
 *
 *   sealed[]        rows per sealed base file (at or above the target)
 *   openRows        rows in the base file still below the target
 *   deltaRows       rows in uncompacted commit files
 *   deadRows        rows physically present and tombstoned
 *
 * Read amplification is accumulated from a read after EVERY commit rather than
 * measured once at the end. Measuring the final state would grade the policy on
 * where its last compaction happened to fall, which is an artefact of the run
 * length; a table is read continuously, so the number that matters is the mean
 * over the run.
 *
 * The modelling assumption worth stating out loud: updates and deletes hit
 * RECENT rows, so their tombstones fall in the open file or the delta pile and a
 * compaction can purge them. A delete against cold data would force a rewrite of
 * a sealed file that this model does not attempt — which means the write
 * amplification here is a FLOOR, not a forecast. The lab prints that sentence.
 */
export function runPolicy(policy: Policy, spec: WorkloadSpec): PolicyReport {
  const commits = commitSequence(spec)

  /* Sealed base files are counted rather than listed: every one of them holds
   * exactly `targetFileRows`, so a count and a row total say everything the read
   * model asks about them. */
  let sealedFiles = 0
  let sealedRows = 0
  let remaining = spec.baseRows
  while (remaining >= policy.targetFileRows) {
    sealedFiles += 1
    sealedRows += policy.targetFileRows
    remaining -= policy.targetFileRows
  }
  let openRows = remaining

  let liveRows = spec.baseRows
  let deltaRows = 0
  let deltaFiles = 0
  /* Delete vectors split by whether a compaction can act on them. */
  let deleteFilesHot = 0
  let deleteFilesStranded = 0
  let hotPositions = 0
  let strandedPositions = 0
  /** Tombstoned rows inside the open file or the delta pile. A compaction purges these. */
  let deadHot = 0
  /**
   * Tombstoned rows inside a SEALED file. Purging one means rewriting a file the
   * compactor in this model never touches, so they stay — read and discarded on
   * every scan, for the rest of the run. This is the term that makes a small
   * target file size expensive in a way the trigger cannot fix.
   */
  let deadStranded = 0

  let rowsIngested = 0
  let rowsRewritten = 0
  let compactions = 0

  let scannedData = 0
  let scannedMetadata = 0
  let needed = 0
  let filesOpened = 0
  /** Set if the row accounting ever stops adding up. Reported, not swallowed. */
  let accountingBreak = false

  /** Superseded files: bytes, and the commit they were superseded at. */
  const superseded: Array<{ bytes: number; at: number }> = []

  for (const c of commits) {
    if (c.rowsWritten > 0) {
      /* One commit, one data file — however few rows it holds. That single line
       * is the small-file storm: the target size governs what the COMPACTOR
       * writes, and has no say over what a commit flushes. */
      deltaFiles += 1
      deltaRows += c.rowsWritten
      rowsIngested += c.rowsWritten
      if (c.kind === 'append') liveRows += c.rowsWritten
    }
    if (c.rowsDeleted > 0) {
      /* Where a tombstone lands decides whether it can ever be cleaned up.
       * Restatements arrive against recent rows, so they land in the hot region
       * while there is room in it; beyond that they fall on sealed files and
       * strand there. Nothing about that is a choice the policy gets to make —
       * it is the consequence of having sealed a small file. */
      const hotCapacity = Math.max(0, openRows + deltaRows - deadHot)
      const hit = Math.min(c.rowsDeleted, hotCapacity)
      const spill = c.rowsDeleted - hit
      if (hit > 0) {
        deadHot += hit
        hotPositions += hit
        deleteFilesHot += 1
      }
      if (spill > 0) {
        deadStranded += spill
        strandedPositions += spill
        deleteFilesStranded += 1
      }
      if (c.kind === 'delete') liveRows -= c.rowsDeleted
    }

    if (deltaFiles + deleteFilesHot >= policy.triggerFiles) {
      compactions += 1
      /* Everything uncompacted, plus the open base file, is merged. Tombstoned
       * rows in that set are dropped in the process — which is why they were
       * worth tracking separately from the stranded ones. */
      const physical = openRows + deltaRows
      const survivors = Math.max(0, physical - deadHot)
      superseded.push({ bytes: physical * ROW_BYTES, at: c.index })
      rowsRewritten += survivors

      let open = survivors
      while (open >= policy.targetFileRows) {
        sealedFiles += 1
        sealedRows += policy.targetFileRows
        open -= policy.targetFileRows
      }
      openRows = open
      deltaRows = 0
      deltaFiles = 0
      deleteFilesHot = 0
      hotPositions = 0
      deadHot = 0
    }

    /* The canonical read, priced after every commit: see the current state of the
     * table. It touches every data file, loads every delete vector, and opens
     * every footer to do it. */
    const files =
      sealedFiles + (openRows > 0 ? 1 : 0) + deltaFiles + deleteFilesHot + deleteFilesStranded
    const physicalRows = sealedRows + openRows + deltaRows
    /* The invariant, checked on every commit rather than at the end: every row
     * physically present is either live or tombstoned, and nothing is both or
     * neither. A cost model that quietly loses rows is not conservative, it is
     * wrong. */
    if (physicalRows - (deadHot + deadStranded) !== liveRows) accountingBreak = true
    scannedData += physicalRows * ROW_BYTES
    scannedMetadata += files * FOOTER_BYTES + (hotPositions + strandedPositions) * DELETE_POS_BYTES
    needed += Math.max(1, liveRows) * ROW_BYTES
    filesOpened += files
  }

  const lastCommit = COMMITS - 1
  const retainedBytes = superseded
    .filter((s) => lastCommit - s.at < RETENTION_COMMITS)
    .reduce((n, s) => n + s.bytes, 0)

  const baseRows = sealedRows + openRows
  const physicalRows = baseRows + deltaRows

  const openFiles = openRows > 0 ? 1 : 0
  const filesLive = sealedFiles + openFiles + deltaFiles + deleteFilesHot + deleteFilesStranded

  const liveBytes = Math.max(1, liveRows) * ROW_BYTES
  const bytesIngested = rowsIngested * ROW_BYTES
  const bytesRewritten = rowsRewritten * ROW_BYTES
  const storageHeldBytes = physicalRows * ROW_BYTES + retainedBytes

  return {
    policy,
    workloadId: spec.id,
    readAmplification: (scannedData + scannedMetadata) / needed,
    /* Guarded: a workload of pure deletes ingests nothing, and 0/0 on the page
     * would discredit every number beside it. */
    writeAmplification: bytesIngested > 0 ? (bytesIngested + bytesRewritten) / bytesIngested : 1,
    storageHeldBytes,
    filesLive,
    liveRows,
    liveBytes,
    physicalRows,
    baseRows,
    deltaRows,
    deadRows: deadHot + deadStranded,
    deadStranded,
    deletePositions: hotPositions + strandedPositions,
    sealedFiles,
    deltaFiles,
    deleteFiles: deleteFilesHot + deleteFilesStranded,
    bytesScannedData: scannedData,
    bytesScannedMetadata: scannedMetadata,
    bytesNeeded: needed,
    reads: commits.length,
    meanFilesPerRead: commits.length > 0 ? filesOpened / commits.length : 0,
    bytesIngested,
    bytesRewritten,
    compactions,
    retainedBytes,
    rowsConserved: !accountingBreak,
  }
}

/** Memoised by policy and workload; the grid is swept several times per render. */
const reportCache = new Map<string, PolicyReport>()

export function policyReport(policy: Policy, workloadId: string = REFERENCE_WORKLOAD): PolicyReport {
  const key = `${workloadId}|${policyKey(policy)}`
  const hit = reportCache.get(key)
  if (hit) return hit
  const r = runPolicy(policy, workloadSpec(workloadId))
  reportCache.set(key, r)
  return r
}

export const policySweep = (workloadId: string = REFERENCE_WORKLOAD): PolicyReport[] =>
  POLICY_GRID.map((p) => policyReport(p, workloadId))

/* ------------------------------ the frontier ----------------------------- */

/**
 * The graded task: hold a read-amp ceiling and a write-amp budget at once.
 *
 * Both numbers are read off the swept grid rather than chosen by taste, and the
 * test suite asserts what makes them worth grading — that the region is
 * non-empty, that it is a small minority of the space, and that NEITHER
 * single-objective optimum is inside it. If a reader could satisfy this by
 * dragging one dial to its end, the task would be measuring a preference.
 *
 * 1.02× read means "no more than 2% of what you read was waste". 2.6× write
 * means "you may rewrite each ingested byte 1.6 times on average". Both are
 * strict, and at the reference workload four of the thirty policies hold both.
 */
export const TARGETS = {
  readAmpCeiling: 1.02,
  writeAmpBudget: 2.6,
}

export interface TargetCheck {
  readAmplification: number
  writeAmplification: number
  readOk: boolean
  writeOk: boolean
  ok: boolean
}

export function meetsTargets(
  policy: Policy,
  workloadId: string = REFERENCE_WORKLOAD,
): TargetCheck {
  const r = policyReport(policy, workloadId)
  const readOk = r.readAmplification <= TARGETS.readAmpCeiling
  const writeOk = r.writeAmplification <= TARGETS.writeAmpBudget
  return {
    readAmplification: r.readAmplification,
    writeAmplification: r.writeAmplification,
    readOk,
    writeOk,
    ok: readOk && writeOk,
  }
}

/** Every policy in the grid that satisfies both constraints. */
export const solvingPolicies = (workloadId: string = REFERENCE_WORKLOAD): Policy[] =>
  POLICY_GRID.filter((p) => meetsTargets(p, workloadId).ok)

/** The policy that minimises read amplification alone, ties broken by write amp. */
export function bestReadPolicy(workloadId: string = REFERENCE_WORKLOAD): Policy {
  return [...POLICY_GRID].sort((a, b) => {
    const ra = policyReport(a, workloadId)
    const rb = policyReport(b, workloadId)
    return ra.readAmplification - rb.readAmplification || ra.writeAmplification - rb.writeAmplification
  })[0]
}

/** The policy that minimises write amplification alone, ties broken by read amp. */
export function bestWritePolicy(workloadId: string = REFERENCE_WORKLOAD): Policy {
  return [...POLICY_GRID].sort((a, b) => {
    const ra = policyReport(a, workloadId)
    const rb = policyReport(b, workloadId)
    return ra.writeAmplification - rb.writeAmplification || ra.readAmplification - rb.readAmplification
  })[0]
}

/**
 * Target file sizes at which NO trigger setting in the grid holds the read
 * ceiling — the column of the space where the compaction trigger has lost its
 * grip on the read bill.
 *
 * The mechanism is `deadStranded`. A restatement that arrives against a row
 * already sealed into a base file cannot be purged by a compactor that only
 * merges the pile, so it is read and discarded on every scan for the rest of the
 * run. Seal small files and you seal them often, which strands tombstones faster
 * than any trigger can clean up. It is the answer to "why did compacting more
 * often not fix my read amplification", and the reader is asked to name it.
 */
export function strandedTargets(workloadId: string = REFERENCE_WORKLOAD): number[] {
  return TARGET_CHOICES.filter((targetFileRows) =>
    TRIGGER_CHOICES.every(
      (triggerFiles) =>
        policyReport({ triggerFiles, targetFileRows }, workloadId).readAmplification >
        TARGETS.readAmpCeiling,
    ),
  )
}

/** The single target the graded pick has in mind. Undefined if the space has none. */
export const strandedTarget = (workloadId: string = REFERENCE_WORKLOAD): number | undefined =>
  strandedTargets(workloadId)[0]

/**
 * Is the tradeoff real along this axis? Returns the pair of monotone directions
 * observed when one dial is swept and the other is held.
 *
 * Exposed rather than kept private because the claim "they move in opposite
 * directions" is the lab's whole justification, and a claim that important
 * should be checkable by the test suite over the entire space rather than
 * demonstrated at one point.
 */
export interface AxisTrend {
  /** Read amp at each step of the swept dial, in the dial's own order. */
  read: number[]
  write: number[]
  readMonotone: 'up' | 'down' | 'flat' | 'mixed'
  writeMonotone: 'up' | 'down' | 'flat' | 'mixed'
  opposed: boolean
}

const trendOf = (xs: number[]): AxisTrend['readMonotone'] => {
  const eps = 1e-12
  let up = false
  let down = false
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] > xs[i - 1] + eps) up = true
    else if (xs[i] < xs[i - 1] - eps) down = true
  }
  if (up && down) return 'mixed'
  if (up) return 'up'
  if (down) return 'down'
  return 'flat'
}

/** Sweep the trigger with the target held. */
export function triggerAxis(
  targetFileRows: number,
  workloadId: string = REFERENCE_WORKLOAD,
): AxisTrend {
  const reports = TRIGGER_CHOICES.map((triggerFiles) =>
    policyReport({ triggerFiles, targetFileRows }, workloadId),
  )
  const read = reports.map((r) => r.readAmplification)
  const write = reports.map((r) => r.writeAmplification)
  const readMonotone = trendOf(read)
  const writeMonotone = trendOf(write)
  return {
    read,
    write,
    readMonotone,
    writeMonotone,
    opposed:
      (readMonotone === 'up' && writeMonotone === 'down') ||
      (readMonotone === 'down' && writeMonotone === 'up'),
  }
}

/** Sweep the target with the trigger held. */
export function targetAxis(
  triggerFiles: number,
  workloadId: string = REFERENCE_WORKLOAD,
): AxisTrend {
  const reports = TARGET_CHOICES.map((targetFileRows) =>
    policyReport({ triggerFiles, targetFileRows }, workloadId),
  )
  const read = reports.map((r) => r.readAmplification)
  const write = reports.map((r) => r.writeAmplification)
  const readMonotone = trendOf(read)
  const writeMonotone = trendOf(write)
  return {
    read,
    write,
    readMonotone,
    writeMonotone,
    opposed:
      (readMonotone === 'up' && writeMonotone === 'down') ||
      (readMonotone === 'down' && writeMonotone === 'up'),
  }
}

/**
 * Rank correlation between the two amplifications across the whole grid.
 * Negative means the space itself trades one for the other; a value near zero
 * would mean the lab was teaching a tradeoff that its own model does not have.
 */
export function amplificationCorrelation(workloadId: string = REFERENCE_WORKLOAD): number {
  const reports = policySweep(workloadId)
  const rank = (xs: number[]): number[] => {
    const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
    const out = new Array<number>(xs.length)
    order.forEach(([, i], r) => {
      out[i] = r
    })
    return out
  }
  const rr = rank(reports.map((r) => r.readAmplification))
  const rw = rank(reports.map((r) => r.writeAmplification))
  const n = rr.length
  const mean = (n - 1) / 2
  let num = 0
  let dr = 0
  let dw = 0
  for (let i = 0; i < n; i++) {
    num += (rr[i] - mean) * (rw[i] - mean)
    dr += (rr[i] - mean) ** 2
    dw += (rw[i] - mean) ** 2
  }
  return dr > 0 && dw > 0 ? num / Math.sqrt(dr * dw) : 0
}

/* -------------------------------- formatting ----------------------------- */

export const fmtAmp = (r: number): string => `${r.toFixed(2)}×`

export const fmtRows = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)}Mi` : n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)}Ki` : `${n}`
