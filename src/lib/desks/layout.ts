/**
 * layout.ts — `layout-desk` (L300). One physical order, priced against a mix.
 *
 * A table has exactly ONE physical order. Every layout therefore privileges
 * some predicates and starves others, and the deliverable is not a partition
 * key — it is a partition key plus the named class it abandons.
 *
 * The arithmetic is C2's, unchanged:
 *
 *   pruning ratio  ≈  1 − d × (f × N + 1) ÷ N
 *
 * where N is the row groups the class COULD have read, f is its selectivity
 * and d is clustering depth — 1.0 when the sort key holds perfectly, higher
 * when an upstream loader stops writing in key order. The `+1` is the boundary
 * row group: a range predicate always straddles one extra group, which is why
 * ratios asymptote below 1.0 and why a 99.9% promise on a small candidate set
 * is arithmetically impossible rather than merely optimistic.
 *
 * The downside of a promise is 1 ÷ (1 − r), so 99.5% commits you to a 200×
 * exposure if physical order stops holding. That is why a ratio never travels
 * alone.
 *
 * Two checks here are NOT bands:
 *
 *   `worst_query_stated` is a discipline check. Naming a starved class is the
 *   deliverable; a design with a perfect pruning number and no named loser
 *   fails, and it fails harder if it names the wrong class.
 *
 *   `no_false_negatives` is an ABSOLUTE. A layout may change your bill and
 *   must never change your answer. Every skip is a proof. A promised ratio
 *   above what the candidate set can prove requires skipping blocks that could
 *   contain matches, and a mechanism maintained beside mutable data can go
 *   stale into a wrong answer. Neither gets a tolerance band.
 *
 * NO PRICES. Bytes and file counts only; the caller multiplies.
 */

import { GB, MIB, bandAround, ceilDiv, clamp, fail, fmtBytes, fmtCount, inBand, pass, pct } from './kit'
import type { Band, Check, DeskReport } from './kit'

/** Files are eight row groups throughout C2, so the footer tax is 1/8 per group. */
export const ROW_GROUPS_PER_FILE = 8

/**
 * How the promised skip is proved. The distinction that matters is not the
 * data structure, it is whether the statistic is guaranteed to be at least as
 * conservative as the data it describes.
 */
export type PruningMechanism =
  | 'min-max-in-footer'
  | 'zone-map-in-manifest'
  | 'bloom-filter-in-footer'
  | 'external-index'
  | 'cached-statistics'

/** Mechanisms that can disagree with the data they describe, and how. */
export const MECHANISM_RISK: Record<PruningMechanism, string> = {
  'min-max-in-footer': '',
  'zone-map-in-manifest': '',
  'bloom-filter-in-footer': '',
  'external-index':
    'an external index is maintained beside the data rather than with it, so a write that lands without an index update makes a skip unprovable',
  'cached-statistics':
    'cached statistics can be stale by construction, so a skip decided from them is a guess with a good hit rate rather than a proof',
}

export interface LayoutQueryClass {
  id: string
  /** Row groups this class could have read — the candidate set, N. */
  candidateRowGroups: number
  /** Fraction of rows the predicate matches, f. A needle class is ~1e-7. */
  selectivity: number
  /** Bytes of the columns this class projects, per row group. */
  projectedBytesPerRowGroup: number
  /** Share of the daily query mix. Used only to rank, never to average away a class. */
  shareOfMix: number
}

export interface LayoutDesign {
  partitionKey: string
  sortKey: string
  /** Rows per row group. 128Ki is the conventional default. */
  rowGroupRows: number
  /**
   * Clustering depth for the sort key, d. 1.0 is perfectly clustered. This is
   * the assumption the whole design rests on, and the thing to monitor.
   */
  clusteringDepth: number
  /** Partitions the ingest actually writes into per day. */
  partitionsWrittenPerDay: number
  /** Configured target file size. */
  targetFileBytes: number
  /** Daily ingest into this table. */
  dailyIngestBytes: number
  mechanism: PruningMechanism
}

export interface LayoutClassResult {
  id: string
  /** 1 − d × (f × N + 1) ÷ N, clamped to [0, 1]. */
  pruningRatio: number
  /**
   * The best ratio any correct planner could achieve on this class: d = 1,
   * matching groups plus the boundary group. A promise above this needs a skip
   * that is not a proof.
   */
  maxProvableRatio: number
  rowGroupsRead: number
  filesTouched: number
  bytesRead: number
  /** 1 ÷ (1 − r): the multiplier you have promised if order stops holding. */
  exposureMultiplier: number
}

export interface LayoutOutput {
  perClass: LayoutClassResult[]
  /** Best-served class — the one the design was chosen for. */
  bestClassId: string
  /** Worst-served class — the one that must be named. */
  worstClassId: string
  /** C2.L5's ceiling: daily ingest ÷ target file size. */
  partitionCeiling: number
  /** True when the partition scheme can still reach the target file size. */
  partitionSchemeFits: boolean
  /** Average bytes per file the scheme actually achieves. */
  achievedFileBytes: number
  /** The mix-weighted ratio. Reported, never graded: it hides the starved class. */
  weightedPruningRatio: number
}

/** C2's pruning model. Pure arithmetic, no fitted constants. */
export function pruningRatio(candidateRowGroups: number, selectivity: number, clusteringDepth: number): number {
  const n = Math.max(1, candidateRowGroups)
  const f = clamp(selectivity, 0, 1)
  const d = Math.max(1, clusteringDepth)
  return clamp(1 - (d * (f * n + 1)) / n, 0, 1)
}

/** The ceiling on any correct planner: d = 1. Above it, a skip is not a proof. */
export function maxProvableRatio(candidateRowGroups: number, selectivity: number): number {
  return pruningRatio(candidateRowGroups, selectivity, 1)
}

export function modelLayout(classes: LayoutQueryClass[], design: LayoutDesign): LayoutOutput {
  if (classes.length === 0) throw new Error('modelLayout: at least one query class is required')
  if (design.targetFileBytes <= 0) throw new Error('modelLayout: targetFileBytes must be positive')
  if (design.partitionsWrittenPerDay <= 0) throw new Error('modelLayout: partitionsWrittenPerDay must be positive')

  const perClass: LayoutClassResult[] = classes.map((c) => {
    const r = pruningRatio(c.candidateRowGroups, c.selectivity, design.clusteringDepth)
    const rowGroupsRead = Math.min(c.candidateRowGroups, Math.ceil(c.candidateRowGroups * (1 - r)))
    return {
      id: c.id,
      pruningRatio: r,
      maxProvableRatio: maxProvableRatio(c.candidateRowGroups, c.selectivity),
      rowGroupsRead,
      filesTouched: ceilDiv(rowGroupsRead, ROW_GROUPS_PER_FILE),
      bytesRead: rowGroupsRead * c.projectedBytesPerRowGroup,
      /* Cap the exposure at the candidate set: you cannot lose more than all of it. */
      exposureMultiplier: r >= 1 ? c.candidateRowGroups : Math.min(c.candidateRowGroups, 1 / (1 - r)),
    }
  })

  const best = perClass.reduce((a, b) => (b.pruningRatio > a.pruningRatio ? b : a), perClass[0])
  const worst = perClass.reduce((a, b) => (b.bytesRead > a.bytesRead ? b : a), perClass[0])

  const partitionCeiling = design.dailyIngestBytes / design.targetFileBytes
  const achievedFileBytes = design.dailyIngestBytes / design.partitionsWrittenPerDay
  const totalShare = classes.reduce((s, c) => s + c.shareOfMix, 0) || 1

  return {
    perClass,
    bestClassId: best.id,
    worstClassId: worst.id,
    partitionCeiling,
    partitionSchemeFits: design.partitionsWrittenPerDay <= partitionCeiling,
    achievedFileBytes,
    weightedPruningRatio: classes.reduce(
      (s, c, i) => s + (c.shareOfMix / totalShare) * perClass[i].pruningRatio,
      0,
    ),
  }
}

/* ------------------------------- grading ------------------------------- */

export interface LayoutSubmission {
  classes: LayoutQueryClass[]
  design: LayoutDesign
  /** The ratio promised, per class id. Promising per table is itself the error. */
  promisedPruningRatio: Record<string, number>
  /** Files the design touches for its best-served class, as the learner counts them. */
  claimedFilesTouched: Record<string, number>
  /** The class the design starves. null = not named, which is a failure. */
  statedWorstClassId: string | null
  /** The ratio they admit that class gets. */
  statedWorstClassRatio: number | null
  /** What they will do about it — a second table, a secondary index, or "nothing, deliberately". */
  statedWorstClassResponse: string | null
  /** Are the statistics maintained in the same commit as the data they describe? */
  statisticsMaintainedWithData: boolean
  /** Ceiling on files a single query may touch. A count, caller-supplied. */
  filesTouchedCeiling: number
}

/** Ratios are graded in points of ratio, not percent-of-ratio: ±1.5 points. */
export const PRUNING_TOLERANCE_POINTS = 0.015

/** File counts are modelled, so a wide band. */
export const FILE_COUNT_TOLERANCE_PCT = 25

export function gradeLayout(sub: LayoutSubmission): DeskReport {
  const checks: Check[] = []
  const out = modelLayout(sub.classes, sub.design)
  const byId = new Map(out.perClass.map((r) => [r.id, r]))

  /* ---- prunes_target: banded, per class, in ratio points ---- */
  const promised = Object.keys(sub.promisedPruningRatio)
  const unpromised = out.perClass.filter((r) => sub.promisedPruningRatio[r.id] === undefined).map((r) => r.id)
  const wrongRatio = promised
    .filter((id) => byId.has(id))
    .filter((id) => {
      const ref = byId.get(id)!.pruningRatio
      const band: Band = { lo: ref - PRUNING_TOLERANCE_POINTS, hi: ref + PRUNING_TOLERANCE_POINTS }
      return !inBand(sub.promisedPruningRatio[id], band)
    })

  if (unpromised.length > 0) {
    checks.push(
      fail(
        'prunes_target',
        'promised ratio derived, per class',
        `no promised ratio for ${unpromised.join(', ')}. A pruning ratio is per query CLASS: "${pct(
          out.weightedPruningRatio,
        )} on this table" is a true sentence containing no information, because it is a weighted average over classes and the average is exactly what hides the class that gets nothing. Reference per class: ${out.perClass
          .map((r) => `${r.id} ${pct(r.pruningRatio)}`)
          .join(', ')}.`,
      ),
    )
  } else if (wrongRatio.length > 0) {
    checks.push(
      fail(
        'prunes_target',
        'promised ratio derived, per class',
        `${wrongRatio
          .map((id) => {
            const r = byId.get(id)!
            const c = sub.classes.find((x) => x.id === id)!
            return `${id}: promised ${pct(sub.promisedPruningRatio[id])}, reference ${pct(
              r.pruningRatio,
            )} from 1 − d(f·N + 1)/N = 1 − ${sub.design.clusteringDepth.toFixed(2)}(${c.selectivity.toExponential(
              1,
            )}·${fmtCount(c.candidateRowGroups)} + 1)/${fmtCount(c.candidateRowGroups)}`
          })
          .join('; ')}. The term most often dropped is the +1 boundary row group, which is why ratios asymptote below 1.0; the second is clustering depth d, which is 1.0 only while the loader writes in key order. Reading ${fmtBytes(
          byId.get(wrongRatio[0])!.bytesRead,
        )} at the reference ratio.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'prunes_target',
        'promised ratio derived, per class',
        `${promised.length} classes within ±${(PRUNING_TOLERANCE_POINTS * 100).toFixed(1)} points; best ${
          out.bestClassId
        } at ${pct(byId.get(out.bestClassId)!.pruningRatio)} reading ${fmtBytes(byId.get(out.bestClassId)!.bytesRead)}`,
      ),
    )
  }

  /* ---- file_count_sane: two numbers, partitions/day and files/query ---- */
  const fileIssues: string[] = []
  if (!out.partitionSchemeFits) {
    fileIssues.push(
      `${fmtCount(sub.design.partitionsWrittenPerDay)} partitions written per day against a ceiling of ${fmtCount(
        out.partitionCeiling,
      )} (daily ingest ${fmtBytes(sub.design.dailyIngestBytes)} ÷ target ${fmtBytes(
        sub.design.targetFileBytes,
      )}); the scheme averages ${fmtBytes(
        out.achievedFileBytes,
      )} per file, so the target is a wish and no compaction policy can fix a partition scheme that produces permanently small files`,
    )
  }
  const overCeiling = out.perClass.filter((r) => r.filesTouched > sub.filesTouchedCeiling)
  if (overCeiling.length > 0) {
    fileIssues.push(
      `${overCeiling
        .map((r) => `${r.id} touches ${fmtCount(r.filesTouched)} files`)
        .join(', ')} against a ceiling of ${fmtCount(
        sub.filesTouchedCeiling,
      )}; files touched is planning cost and it is invisible to a bytes-scanned dashboard, which is how it became 61% of query time`,
    )
  }
  const misCounted = out.perClass.filter((r) => {
    const claimed = sub.claimedFilesTouched[r.id]
    return claimed !== undefined && !inBand(claimed, bandAround(r.filesTouched, FILE_COUNT_TOLERANCE_PCT))
  })
  if (misCounted.length > 0) {
    fileIssues.push(
      misCounted
        .map(
          (r) =>
            `${r.id}: claimed ${fmtCount(sub.claimedFilesTouched[r.id])} files, reference ${fmtCount(
              r.filesTouched,
            )} = ceil(${fmtCount(r.rowGroupsRead)} row groups ÷ ${ROW_GROUPS_PER_FILE} per file)`,
        )
        .join('; '),
    )
  }

  checks.push(
    fileIssues.length === 0
      ? pass(
          'file_count_sane',
          'file arithmetic holds',
          `${fmtCount(sub.design.partitionsWrittenPerDay)} partitions/day under the ceiling of ${fmtCount(
            out.partitionCeiling,
          )}, averaging ${fmtBytes(out.achievedFileBytes)} per file; worst class touches ${fmtCount(
            byId.get(out.worstClassId)!.filesTouched,
          )} files`,
        )
      : fail('file_count_sane', 'file arithmetic holds', fileIssues.join('. ') + '.'),
  )

  /* ---- worst_query_stated: DISCIPLINE, and it must be the right class ---- */
  const worst = byId.get(out.worstClassId)!
  if (sub.statedWorstClassId === null) {
    checks.push(
      fail(
        'worst_query_stated',
        'starved class named, with a response',
        `no starved class named. A table has exactly one physical order, so this design necessarily abandons a class, and here it is ${
          out.worstClassId
        }: ${pct(worst.pruningRatio)} pruning, ${fmtCount(worst.filesTouched)} files, ${fmtBytes(
          worst.bytesRead,
        )} read against ${fmtBytes(
          byId.get(out.bestClassId)!.bytesRead,
        )} for the class you designed for. Omitting it fails this check even though your ratio for ${
          out.bestClassId
        } is defensible — a promise with no named loser is not a design document, it is a description of the happy path.`,
      ),
    )
  } else if (sub.statedWorstClassId !== out.worstClassId) {
    checks.push(
      fail(
        'worst_query_stated',
        'starved class named, with a response',
        `named ${sub.statedWorstClassId} as the starved class, but the reference model says ${
          out.worstClassId
        } is worse: ${fmtBytes(worst.bytesRead)} read at ${pct(worst.pruningRatio)} pruning against ${fmtBytes(
          byId.get(sub.statedWorstClassId)?.bytesRead ?? 0,
        )} for ${sub.statedWorstClassId}. Rank by bytes read rather than by ratio: a class with a poor ratio over a small candidate set is cheap, and a class with a good ratio over a huge one is not.`,
      ),
    )
  } else if (sub.statedWorstClassResponse === null || sub.statedWorstClassRatio === null) {
    const omitted =
      sub.statedWorstClassRatio === null ? 'the ratio that class actually gets' : 'your response to it'
    checks.push(
      fail(
        'worst_query_stated',
        'starved class named, with a response',
        `named ${out.worstClassId} but omitted ${omitted}. The caveat is three parts and this is two: the class, its number (${pct(
          worst.pruningRatio
        )}, ${fmtBytes(
          worst.bytesRead,
        )} read), and what happens to it — a second table, a secondary index, or "nothing, deliberately, and here is why that is acceptable". A named loser with no stated response is an acknowledgement, not a decision, and the reader cannot tell whether you weighed it or noticed it.`,
      ),
    )
  } else {
    checks.push(
      pass(
        'worst_query_stated',
        'starved class named, with a response',
        `${out.worstClassId} named at ${pct(sub.statedWorstClassRatio)} (reference ${pct(
          worst.pruningRatio,
        )}), response: ${sub.statedWorstClassResponse}`,
      ),
    )
  }

  /* ---- no_false_negatives: ABSOLUTE. No band, no tolerance. ---- */
  const overPromised = out.perClass.filter((r) => {
    const p = sub.promisedPruningRatio[r.id]
    return p !== undefined && p > r.maxProvableRatio
  })
  const mechanismRisk = MECHANISM_RISK[sub.design.mechanism]
  const unprovableMechanism = mechanismRisk !== '' || !sub.statisticsMaintainedWithData

  if (overPromised.length > 0) {
    const r = overPromised[0]
    checks.push(
      fail(
        'no_false_negatives',
        'every skip is a proof',
        `${overPromised
          .map(
            (x) =>
              `${x.id} promises ${pct(sub.promisedPruningRatio[x.id])} where the provable ceiling is ${pct(
                x.maxProvableRatio,
              )}`,
          )
          .join('; ')}. That ceiling is 1 − (f·N + 1)/N at perfect clustering: the matching row groups plus the one the range straddles. Delivering ${pct(
          sub.promisedPruningRatio[r.id],
        )} on ${fmtCount(
          sub.classes.find((c) => c.id === r.id)?.candidateRowGroups ?? 0,
        )} row groups requires skipping at least one group that could contain a match, which is a wrong answer rather than a cheaper one. Graded with zero tolerance while the ratio itself is graded in a band, because the layout is allowed to change your bill and never your answer.`,
      ),
    )
  } else if (unprovableMechanism) {
    checks.push(
      fail(
        'no_false_negatives',
        'every skip is a proof',
        `mechanism is ${sub.design.mechanism}${
          mechanismRisk !== '' ? ` and ${mechanismRisk}` : ''
        }${
          !sub.statisticsMaintainedWithData
            ? '; statistics are not written in the same commit as the data they describe, so there is a window in which a skip is decided from a statistic the data has already contradicted'
            : ''
        }. This is not a pruning design, it is a correctness risk with a good pruning number. State the mechanism and where its statistics come from: min-max in the footer and zone maps in the manifest are written with the data and are therefore proofs; a cache or an external index is not.`,
      ),
    )
  } else {
    const margins = out.perClass
      .filter((r) => sub.promisedPruningRatio[r.id] !== undefined)
      .map((r) => r.maxProvableRatio - sub.promisedPruningRatio[r.id])
    checks.push(
      pass(
        'no_false_negatives',
        'every skip is a proof',
        `${sub.design.mechanism}, written with the data; every promised ratio is at or under its provable ceiling${
          margins.length > 0 ? ` (tightest margin ${pct(Math.min(...margins))})` : ''
        }`,
      ),
    )
  }

  return { desk: 'layout-desk', version: 1, checks }
}

/** C2's conventional-and-competent design, and the mix it is priced against. */
export const LAYOUT_WORKED_CLASSES: LayoutQueryClass[] = [
  {
    id: 'dashboard',
    candidateRowGroups: 24_000,
    selectivity: 0.0002,
    projectedBytesPerRowGroup: 6 * MIB,
    shareOfMix: 0.7,
  },
  {
    id: 'rollup',
    candidateRowGroups: 24_000,
    selectivity: 0.02,
    projectedBytesPerRowGroup: 6 * MIB,
    shareOfMix: 0.2,
  },
  {
    id: 'needle',
    candidateRowGroups: 24_000,
    selectivity: 1e-7,
    projectedBytesPerRowGroup: 22 * MIB,
    shareOfMix: 0.1,
  },
]

export const LAYOUT_WORKED_DESIGN: LayoutDesign = {
  partitionKey: 'day(order_ts)',
  sortKey: 'tenant_id, order_ts',
  rowGroupRows: 128 * 1024,
  clusteringDepth: 1.0,
  partitionsWrittenPerDay: 6,
  targetFileBytes: 512 * 1_000_000,
  dailyIngestBytes: 25 * GB,
  mechanism: 'min-max-in-footer',
}
