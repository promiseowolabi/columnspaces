/**
 * ingest.ts — `ingest-desk` (L400). Freshness against file count, priced.
 *
 * C5.L4's arithmetic, made gradeable. Four numbers and a named loser:
 *
 *   p99 staleness  ≈  batch interval + commit time  (+ conversion lag, if the
 *                     write buffer is not on the read path)
 *   files/day      =  commits/day × partitions written × writers
 *   average file   =  daily ingest ÷ files/day
 *   merge rate     ≥  creation rate × headroom, or the backlog is UNBOUNDED
 *
 * Three things this file insists on:
 *
 *   THE MEAN FLATTERS THE DESIGN. Mean staleness is interval ÷ 2 + commit; p99
 *   is interval + commit. Quoting the mean halves the number you are actually
 *   promising, so the model computes both and grades the p99.
 *
 *   A DEFICIT ACCUMULATES RATHER THAN SATURATING. If files are created faster
 *   than they are merged, no cluster size fixes it — the backlog is not a queue
 *   that fills up, it is an integral. So `compaction_keeps_up` grades a RATE
 *   against a RATE with headroom, never "we run compaction nightly".
 *
 *   FRESHNESS IS THE ONE LEGITIMATE CLOCK HERE, AND IT IS NOT A COST. Staleness
 *   is the requirement, so it is measured in seconds. Every COST term in this
 *   file is a count: files created, files merged, compaction passes, bytes
 *   rewritten. Wall-clock never appears on the cost side.
 *
 * NO PRICES. Counts out; the caller multiplies.
 */

import { GB, MB, bandAround, fail, fmtBytes, fmtCount, inBand, pass, round2 } from './kit'
import type { Band, Check, DeskReport } from './kit'

export const SECONDS_PER_DAY = 86_400

/**
 * Inputs a merge pass combines. Eight is the value that reproduces C5.L4's
 * published ladder: 8.7 MB and 87 MB both reach a 512 MB target in two passes,
 * and a 260 MB average reaches it in one.
 */
export const DEFAULT_MERGE_FANOUT = 8

/** Compaction sized to parity is not sized: any spike restarts the accumulation. */
export const REQUIRED_HEADROOM = 1.2

export type Tradeoff = 'freshness' | 'file-count'

export interface IngestInput {
  /** Seconds between commits. The one input variable you can change today. */
  batchIntervalSeconds: number
  /** Time to commit a batch and make it visible. Varies under load; use p99. */
  commitSeconds: number
  /**
   * Seconds until buffered rows become visible to readers. Irrelevant when the
   * buffer is on the read path, and DOMINANT when it is not — this is the term
   * that turns a claimed 10-minute SLA into 20 minutes plus a run.
   */
  conversionLagSeconds: number
  bufferOnReadPath: boolean
  dailyIngestBytes: number
  /** Partitions each commit lands in. Multiplies the file count directly. */
  partitionsWrittenPerBatch: number
  /** Concurrent writers. Also multiplies the file count directly. */
  writers: number
  /** Configured target file size. */
  targetFileBytes: number
  /** Sustained merge capacity, as a COUNT of files per hour. */
  mergeRateFilesPerHour: number
  mergeFanout?: number
}

export interface IngestOutput {
  commitsPerDay: number
  filesPerDay: number
  /** Files per hour created. The rate that must be matched. */
  creationRateFilesPerHour: number
  averageFileBytes: number
  meanStalenessSeconds: number
  /** interval + commit (+ conversion lag if the buffer is off the read path). */
  p99StalenessSeconds: number
  /** The term that dominates when the buffer is not queryable. */
  conversionLagApplied: number
  /** Merge passes to climb from the achieved average to the target. */
  compactionPasses: number
  /** 1 + passes: every ingested byte written this many times, forever. */
  writeAmplification: number
  bytesRewrittenPerDay: number
  /** mergeRate ÷ creationRate. Below 1.0 the backlog is unbounded. */
  headroomRatio: number
  /** Files per day of deficit. Zero when merge keeps up. */
  backlogGrowthFilesPerDay: number
  /**
   * Bytes per partition per day. A target file size above this is unreachable
   * in one pass, which is what makes a target a wish.
   */
  bytesPerPartitionPerDay: number
  targetReachable: boolean
}

/** Passes to climb a size gap at a given fanout. Zero when already at target. */
export function compactionPasses(averageFileBytes: number, targetFileBytes: number, fanout: number): number {
  if (averageFileBytes <= 0 || targetFileBytes <= averageFileBytes) return 0
  const f = Math.max(2, fanout)
  return Math.max(1, Math.ceil(Math.log(targetFileBytes / averageFileBytes) / Math.log(f)))
}

export function modelIngest(input: IngestInput): IngestOutput {
  const {
    batchIntervalSeconds,
    commitSeconds,
    conversionLagSeconds,
    bufferOnReadPath,
    dailyIngestBytes,
    partitionsWrittenPerBatch,
    writers,
    targetFileBytes,
    mergeRateFilesPerHour,
    mergeFanout = DEFAULT_MERGE_FANOUT,
  } = input

  if (batchIntervalSeconds <= 0) throw new Error('modelIngest: batchIntervalSeconds must be positive')
  if (dailyIngestBytes <= 0) throw new Error('modelIngest: dailyIngestBytes must be positive')
  if (partitionsWrittenPerBatch < 1 || writers < 1) throw new Error('modelIngest: partitions and writers must be >= 1')
  if (targetFileBytes <= 0) throw new Error('modelIngest: targetFileBytes must be positive')

  const commitsPerDay = SECONDS_PER_DAY / batchIntervalSeconds
  const filesPerDay = commitsPerDay * partitionsWrittenPerBatch * writers
  const averageFileBytes = dailyIngestBytes / filesPerDay

  const conversionLagApplied = bufferOnReadPath ? 0 : Math.max(0, conversionLagSeconds)
  const meanStalenessSeconds = batchIntervalSeconds / 2 + commitSeconds + conversionLagApplied
  const p99StalenessSeconds = 0.99 * batchIntervalSeconds + commitSeconds + conversionLagApplied

  const passes = compactionPasses(averageFileBytes, targetFileBytes, mergeFanout)
  const writeAmplification = 1 + passes
  const bytesRewrittenPerDay = dailyIngestBytes * passes

  const creationRateFilesPerHour = filesPerDay / 24
  const headroomRatio = creationRateFilesPerHour > 0 ? mergeRateFilesPerHour / creationRateFilesPerHour : Infinity
  const deficitPerHour = Math.max(0, creationRateFilesPerHour - mergeRateFilesPerHour)

  const bytesPerPartitionPerDay = dailyIngestBytes / partitionsWrittenPerBatch

  return {
    commitsPerDay,
    filesPerDay,
    creationRateFilesPerHour,
    averageFileBytes,
    meanStalenessSeconds,
    p99StalenessSeconds,
    conversionLagApplied,
    compactionPasses: passes,
    writeAmplification,
    bytesRewrittenPerDay,
    /* Finite by construction: a zero creation rate is impossible here because
     * dailyIngestBytes and the multipliers are all validated positive. */
    headroomRatio: Number.isFinite(headroomRatio) ? headroomRatio : 0,
    backlogGrowthFilesPerDay: deficitPerHour * 24,
    bytesPerPartitionPerDay,
    targetReachable: bytesPerPartitionPerDay >= targetFileBytes,
  }
}

/* ------------------------------- grading ------------------------------- */

export interface IngestSubmission {
  input: IngestInput
  /** The p99 the runbook promises, in seconds. The mean will not do. */
  claimedP99StalenessSeconds: number
  /** The average file size the scheme will actually achieve, beside the target. */
  claimedAverageFileBytes: number
  /** Which side they gave up. null = not stated, which is the failure. */
  statedTradeoff: Tradeoff | null
  /** By how much: the freshness not promised, or the file count accepted. */
  statedTradeoffMagnitude: string | null
  /** The write-amplification budget the tradeoff consumes. null = not stated. */
  statedWriteAmpBudget: number | null
}

export const STALENESS_TOLERANCE_PCT = 20
export const FILE_SIZE_TOLERANCE_PCT = 25
export const WRITE_AMP_TOLERANCE_PCT = 25

const secs = (s: number): string => (s >= 60 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(1)} s`)

export function gradeIngest(sub: IngestSubmission): DeskReport {
  const checks: Check[] = []
  const out = modelIngest(sub.input)
  const i = sub.input

  /* ---- freshness_sla: p99, banded, with the conversion-lag trap called out ---- */
  const p99Band: Band = bandAround(out.p99StalenessSeconds, STALENESS_TOLERANCE_PCT)
  const quotedTheMean = inBand(sub.claimedP99StalenessSeconds, bandAround(out.meanStalenessSeconds, 10))
  checks.push(
    inBand(sub.claimedP99StalenessSeconds, p99Band)
      ? pass(
          'freshness_sla',
          'p99 staleness as interval + commit',
          `claimed ${secs(sub.claimedP99StalenessSeconds)} against reference ${secs(
            out.p99StalenessSeconds,
          )} = 0.99 × ${secs(i.batchIntervalSeconds)} interval + ${secs(i.commitSeconds)} commit${
            out.conversionLagApplied > 0 ? ` + ${secs(out.conversionLagApplied)} conversion lag` : ''
          }`,
        )
      : fail(
          'freshness_sla',
          'p99 staleness as interval + commit',
          `claimed ${secs(sub.claimedP99StalenessSeconds)}, reference ${secs(out.p99StalenessSeconds)} (band ${secs(
            p99Band.lo,
          )}–${secs(p99Band.hi)}). Itemise: 0.99 × interval ${secs(0.99 * i.batchIntervalSeconds)} + commit ${secs(
            i.commitSeconds,
          )}${
            out.conversionLagApplied > 0
              ? ` + conversion lag ${secs(
                  out.conversionLagApplied,
                )}, which applies because the write buffer is NOT on the read path and therefore dominates the interval you tuned`
              : ' (buffer is on the read path, so no conversion lag)'
          }.${
            quotedTheMean
              ? ` Your figure is the MEAN (${secs(
                  out.meanStalenessSeconds,
                )} = interval ÷ 2 + commit), which is roughly half the p99 and flatters the design; the SLA is what the unluckiest row experiences, not the average one.`
              : ''
          }`,
        ),
  )

  /* ---- file_size: target versus achieved, and whether the target is reachable ---- */
  const sizeIssues: string[] = []
  if (!inBand(sub.claimedAverageFileBytes, bandAround(out.averageFileBytes, FILE_SIZE_TOLERANCE_PCT))) {
    sizeIssues.push(
      `claimed average ${fmtBytes(sub.claimedAverageFileBytes)}, reference ${fmtBytes(
        out.averageFileBytes,
      )} = ${fmtBytes(i.dailyIngestBytes)}/day ÷ ${fmtCount(out.filesPerDay)} files/day, where files/day is ${fmtCount(
        out.commitsPerDay,
      )} commits × ${i.partitionsWrittenPerBatch} partitions × ${i.writers} writers — halving the interval doubles every one of those products`,
    )
  }
  if (!out.targetReachable) {
    sizeIssues.push(
      `the configured target of ${fmtBytes(i.targetFileBytes)} exceeds ${fmtBytes(
        out.bytesPerPartitionPerDay,
      )} of daily ingest per partition, so no commit schedule reaches it and the target is a wish rather than a setting; state the average you expect to achieve beside the target you configured`,
    )
  }
  checks.push(
    sizeIssues.length === 0
      ? pass(
          'file_size',
          'target checked against achievable',
          `target ${fmtBytes(i.targetFileBytes)}, achieved average ${fmtBytes(out.averageFileBytes)} across ${fmtCount(
            out.filesPerDay,
          )} files/day; ${out.compactionPasses} compaction pass(es) close the gap at ${round2(
            out.writeAmplification,
          )}× write amplification`,
        )
      : fail('file_size', 'target checked against achievable', sizeIssues.join('. ') + '.'),
  )

  /* ---- compaction_keeps_up: a rate against a rate, with headroom ---- */
  const keepsUp = out.headroomRatio >= REQUIRED_HEADROOM
  checks.push(
    keepsUp
      ? pass(
          'compaction_keeps_up',
          'merge rate ≥ creation rate × headroom',
          `${fmtCount(i.mergeRateFilesPerHour)} merged/hour against ${fmtCount(
            out.creationRateFilesPerHour,
          )} created/hour = ${round2(out.headroomRatio)}× headroom (≥ ${REQUIRED_HEADROOM}× required)`,
        )
      : fail(
          'compaction_keeps_up',
          'merge rate ≥ creation rate × headroom',
          `${fmtCount(i.mergeRateFilesPerHour)} merged/hour against ${fmtCount(
            out.creationRateFilesPerHour,
          )} created/hour is ${round2(out.headroomRatio)}× headroom, under the ${REQUIRED_HEADROOM}× required${
            out.backlogGrowthFilesPerDay > 0
              ? `, and at a deficit of ${fmtCount(
                  out.backlogGrowthFilesPerDay,
                )} files/day the backlog is UNBOUNDED — a deficit is not a queue that saturates, it accumulates, so no cluster size fixes it`
              : `; matching rates is necessary and insufficient, because at parity the deficit stops growing while any ingest spike restarts the accumulation`
          }. The cheap lever is the creation side: the interval is an input you can change today (${fmtCount(
            out.commitsPerDay,
          )} commits/day × ${i.partitionsWrittenPerBatch} partitions × ${
            i.writers
          } writers = ${fmtCount(out.filesPerDay)} files/day), while partitions and writers usually imply a migration. Alarm on the crossing of created-per-hour against merged-per-hour, not on the backlog level: the crossing happens weeks before the level is visible.`,
        ),
  )

  /* ---- tradeoff_stated: DISCIPLINE. Which side, by how much, at what write amp. ---- */
  const omitted: string[] = []
  if (sub.statedTradeoff === null) omitted.push('which side you gave up (freshness or file count)')
  if (sub.statedTradeoffMagnitude === null) omitted.push('by how much')
  if (sub.statedWriteAmpBudget === null) omitted.push('the write-amplification budget it consumes')

  if (omitted.length > 0 || sub.statedWriteAmpBudget === null) {
    checks.push(
      fail(
        'tradeoff_stated',
        'the side you gave up, quantified',
        `omitted: ${omitted.join('; ')}. Freshness, file size and compaction capacity are only JOINTLY achievable at some interval, and this desk grades whether you found it and said so. Here the reference numbers are: p99 ${secs(
          out.p99StalenessSeconds,
        )}, ${fmtCount(out.filesPerDay)} files/day averaging ${fmtBytes(out.averageFileBytes)}, ${
          out.compactionPasses
        } pass(es) rewriting ${fmtBytes(out.bytesRewrittenPerDay)}/day for ${fmtBytes(
          i.dailyIngestBytes,
        )} ingested — ${round2(
          out.writeAmplification,
        )}× write amplification.${
          sub.statedWriteAmpBudget === null
            ? ' A plan with no write-amp budget is an unbounded background bill: the rewriting is forever, for as long as the table exists.'
            : ''
        } A submission with a fresh SLA, a large target file size and no rate arithmetic fails here even when each individual number is plausible, because the omission is what makes it unfalsifiable.`,
      ),
    )
  } else {
    const budgetBand = bandAround(out.writeAmplification, WRITE_AMP_TOLERANCE_PCT)
    checks.push(
      inBand(sub.statedWriteAmpBudget, budgetBand)
        ? pass(
            'tradeoff_stated',
            'the side you gave up, quantified',
            `gave up ${sub.statedTradeoff} (${sub.statedTradeoffMagnitude}) at a stated ${round2(
              sub.statedWriteAmpBudget,
            )}× write-amp budget against a reference ${round2(out.writeAmplification)}×`,
          )
        : fail(
            'tradeoff_stated',
            'the side you gave up, quantified',
            `gave up ${sub.statedTradeoff} (${sub.statedTradeoffMagnitude}), but the stated write-amp budget of ${round2(
              sub.statedWriteAmpBudget,
            )}× is outside the band ${budgetBand.lo.toFixed(2)}–${budgetBand.hi.toFixed(2)}× implied by the design: ${
              out.compactionPasses
            } pass(es) from ${fmtBytes(out.averageFileBytes)} to ${fmtBytes(
              i.targetFileBytes,
            )} at fanout ${i.mergeFanout ?? DEFAULT_MERGE_FANOUT} rewrites ${fmtBytes(
              out.bytesRewrittenPerDay,
            )}/day for ${fmtBytes(i.dailyIngestBytes)} ingested, so 1 + ${out.compactionPasses} = ${round2(
              out.writeAmplification,
            )}×. Say it as a bill rather than a ratio: every ingested byte is written ${round2(
              out.writeAmplification,
            )} times.`,
          ),
    )
  }

  return { desk: 'ingest-desk', version: 1, checks }
}

/** C5.L4's five-minute recommendation, in this model's terms. */
export const INGEST_WORKED_EXAMPLE: IngestInput = {
  batchIntervalSeconds: 300,
  commitSeconds: 4,
  conversionLagSeconds: 1_200,
  bufferOnReadPath: true,
  dailyIngestBytes: 25 * GB,
  partitionsWrittenPerBatch: 6,
  writers: 4,
  targetFileBytes: 512 * MB,
  mergeRateFilesPerHour: 500,
}
