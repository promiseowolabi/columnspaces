/**
 * engine.ts — the model columnar engine.
 *
 * It runs a trace against a described layout and reports counts. It is a MODEL,
 * not an engine: there is no data, no reader, no duckdb import anywhere in this
 * file. That is a hard rule for two reasons. The pedagogical one is that a
 * model you can read in one sitting teaches *why* a layout prunes, whereas a
 * real engine teaches only *that* it did. The mechanical one is that duckdb is
 * ~33 MB of wasm behind a JS wrapper, and a single static import from a route
 * chunk would drag it into first paint — which `tests/bundle.test.ts` fails the
 * build over, deliberately.
 *
 * EVERY metric is a count: bytes, row groups, files, rows. Never wall-clock.
 * A count means the same thing on a laptop and in CI, so a run is replayable,
 * a lesson can quote it, and the reader's run can be diffed against the
 * reference layout below. A millisecond could do none of those things.
 *
 * The model, end to end, for one scan:
 *
 *   1. PARTITION PRUNING — a predicate on the partition column selects a
 *      contiguous window of partitions. Everything else is untouched.
 *   2. ROW-GROUP PRUNING — inside each surviving partition, min/max statistics
 *      on the SORT key skip row groups. How well that works depends on
 *      clustering, which is the one knob that decays on its own in production.
 *   3. PROJECTION — only the requested columns are read, at their ENCODED
 *      width. This is usually the biggest single lever and the least discussed.
 *   4. METADATA — every candidate file's footer is read to prune it at all.
 *      This is why a small-file storm costs money even when it scans no data.
 *   5. EXCHANGE — a shuffled query moves its scanned bytes across buckets; the
 *      busiest bucket, not the mean, is what the job waits on.
 */

import { ceilDiv, clamp } from '@/lib/desks/kit'
import {
  COLUMNS,
  COLUMN_IDS,
  ROW_WIDTH,
  TABLE_ROWS,
  column,
  partitionKey,
  partitionRows,
  type ColumnId,
  type PartitionKeyId,
} from './table'
import type { Predicate, Query, Trace } from './trace'

/* ------------------------------ encodings ------------------------------ */

export type EncodingId = 'plain' | 'dict' | 'rle' | 'delta' | 'bitpack' | 'zstd'

export interface EncodingSpec {
  id: EncodingId
  label: string
  line: string
}

export const ENCODINGS: EncodingSpec[] = [
  { id: 'plain', label: 'plain', line: 'Values as they are. The honest baseline; never a mistake, rarely a win.' },
  {
    id: 'dict',
    label: 'dictionary',
    line: 'Values → small codes. Enormous on low-cardinality columns, a net loss when nearly every value is distinct.',
  },
  {
    id: 'rle',
    label: 'run-length',
    line: 'Runs of equal values. Only pays when the column is the sort key and the data is actually clustered — on shuffled data it EXPANDS.',
  },
  {
    id: 'delta',
    label: 'delta',
    line: 'Differences between neighbours. Excellent on a sorted timestamp, a no-op on a string.',
  },
  {
    id: 'bitpack',
    label: 'bit-packing',
    line: 'Integers in the fewest bits their range needs. Cheap and mechanical; useless on floats and strings.',
  },
  {
    /* Strictly this is a CODEC applied after an encoding, not an encoding — real
     * Parquet does both. The model collapses them into one choice per column
     * because the alternative is two knobs whose interaction it would have to
     * fake. It is here because without it the widest column in the table has no
     * available win, and a model where the dominant column is inert would teach
     * the opposite of the truth. */
    id: 'zstd',
    label: 'block compression',
    line: 'General-purpose compression over the encoded pages. The only lever that touches a wide, nearly-unique text column — and the reason a 2x table ratio can hide an 8x win on one column.',
  },
]

/* -------------------------------- layout ------------------------------- */

export interface Layout {
  partitionKey: PartitionKeyId
  /** The column the files are physically ordered by. A table has exactly one. */
  sortKey: ColumnId | 'none'
  /**
   * How well physical order actually matches the sort key: 1 = every row group
   * covers a tight, disjoint slice of the sort key; 0 = every row group spans
   * the whole domain, so statistics prune nothing. Real tables live between,
   * and drift downward — an upstream change to write order is the single most
   * common cause of an overnight scan-bill increase.
   */
  clustering: number
  /** Rows per row group — the granularity min/max statistics can prune at. */
  rowGroupRows: number
  /** Rows per file — sets how many footers a query has to open. */
  fileRows: number
  encodings: Record<ColumnId, EncodingId>
  /**
   * Write commits between compactions; 0 = never compact. Only the ingest trace
   * emits write commits, so this knob is inert on the other three — which is
   * itself worth seeing.
   */
  compactEvery: number
}

/**
 * The reference layout: what a competent engineer would ship for the dashboard
 * workload, and the thing the reader's choices are diffed against.
 *
 * It is deliberately GOOD BUT NOT OPTIMAL. A reference the reader cannot match
 * teaches helplessness; one they cannot beat teaches nothing. Clustering sits
 * at 0.9 (real tables are not perfectly ordered), the wide payload column is
 * left plain, and two low-cardinality columns are left un-dictionaried. Each of
 * those is a real win the reader can find.
 */
export const REFERENCE_LAYOUT: Layout = {
  partitionKey: 'day',
  sortKey: 'tenant_id',
  clustering: 0.9,
  rowGroupRows: 131_072,
  fileRows: 1_048_576,
  encodings: {
    ts: 'delta',
    tenant_id: 'dict',
    region: 'plain',
    event_type: 'plain',
    user_id: 'plain',
    device: 'plain',
    amount: 'plain',
    payload: 'plain',
  },
  compactEvery: 8,
}

export const cloneLayout = (l: Layout): Layout => ({ ...l, encodings: { ...l.encodings } })

/* ------------------------------ constants ------------------------------ */

/**
 * Bytes of footer + column index read per file opened. A Parquet footer for a
 * table this wide is a few tens of kilobytes; 24 KiB is the model's figure.
 * It is the constant that makes the small-file storm visible: 10,000 tiny
 * files cost ~234 MiB of metadata before a single value is decoded.
 */
export const FOOTER_BYTES = 24 * 1024

/** Bytes per deleted row position in a merge-on-read delete file. */
export const DELETE_POS_BYTES = 8

/**
 * Buckets in the model exchange. A fixed 32 stands in for "the parallelism you
 * have": the point of the skew metric is the ratio of the busiest bucket to the
 * mean, and that ratio is what changes with the data, not with this number.
 */
export const SHUFFLE_BUCKETS = 32

/** Caps on modelled encoding wins. See `encodingFactor`. */
const DICT_CAP = 16
const RLE_CAP = 32
const DELTA_CAP = 8
const BITPACK_CAP = 8
const ZSTD_CAP = 6

/* ------------------------------ compression ---------------------------- */

const log2ceil = (n: number): number => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))))

/**
 * Stored bytes = uncompressed bytes ÷ factor.
 *
 * Every branch below is a *mechanism*, not a fudge factor, and the losses are
 * modelled as carefully as the wins: an encoding that cannot help must be
 * allowed to hurt, or the page would teach that ticking every box is free.
 * Caps exist because dictionary pages, run headers and page metadata are not
 * free, and an uncapped ratio would promise compression nobody ships.
 */
export function encodingFactor(id: ColumnId, encoding: EncodingId, layout: Layout): number {
  const c = column(id)
  const pk = partitionKey(layout.partitionKey)
  const bits = c.width * 8
  const isSortKey = layout.sortKey === id
  const isPartitionColumn = pk.column === id
  const numeric = c.kind === 'int' || c.kind === 'float' || c.kind === 'ts'

  switch (encoding) {
    case 'plain':
      return 1

    case 'dict': {
      /* A dictionary replaces each value with a code. Distinct values have to
       * be stored once, so the win collapses as cardinality approaches the row
       * count — and then inverts, because you are paying for both. */
      if (c.cardinality > 65_536) return 0.95
      return Math.min(DICT_CAP, bits / log2ceil(c.cardinality))
    }

    case 'rle': {
      /* Run length is the whole story, and run length comes from ORDER. The
       * partition column is constant inside a partition, so RLE is near-total
       * there; the sort key gets runs in proportion to clustering; anything
       * else gets runs of one and pays a length header per value. */
      const perGroup = layout.rowGroupRows
      const distinctInGroup = Math.min(c.cardinality, perGroup)
      const sortedRun = perGroup / Math.max(1, distinctInGroup)
      let run = 1
      if (isPartitionColumn) run = perGroup
      else if (isSortKey) run = 1 + (sortedRun - 1) * layout.clustering
      if (run < 2) return 0.9 /* expansion: a run header for every single value */
      return Math.min(RLE_CAP, run * (c.width / (c.width + 4)))
    }

    case 'delta': {
      /* Differences are small only if neighbours are close. A sorted timestamp
       * is the textbook case; a string has no arithmetic, so this is a no-op
       * that the model refuses to reward. */
      if (!numeric) return 1
      const ordered = isSortKey || isPartitionColumn || c.kind === 'ts'
      if (!ordered) return 1
      const strength = isSortKey || isPartitionColumn ? layout.clustering : 0.6
      const deltaBits = Math.max(2, log2ceil(c.cardinality) * (1 - 0.75 * strength))
      return Math.min(DELTA_CAP, bits / deltaBits)
    }

    case 'bitpack': {
      /* Only integral domains have a bit width worth exploiting. Floats and
       * strings get nothing, and saying so is part of the lesson. */
      if (c.kind !== 'int' && c.kind !== 'ts') return 1
      return Math.min(BITPACK_CAP, bits / log2ceil(c.cardinality))
    }

    case 'zstd': {
      /* Modelled from what the data looks like to a generic compressor:
       * repeated text compresses well, a float column is close to noise, and
       * order helps because neighbouring values share prefixes. These are the
       * conventional ballparks (text ~3x, sorted integers ~2x, floats ~1.2x),
       * stated as a model rather than measured — nothing here is a benchmark. */
      const base = c.kind === 'string' ? 3 : c.kind === 'float' ? 1.2 : 2
      const orderBonus = isSortKey || isPartitionColumn ? 1 + 0.5 * layout.clustering : 1
      /* A near-unique column still compresses; a low-cardinality one compresses
       * more, but a dictionary would have beaten this — the model must not make
       * the lazy choice look as good as the informed one. */
      const repetition = c.cardinality <= 1_000 ? 1.4 : 1
      return Math.min(ZSTD_CAP, base * orderBonus * repetition)
    }
  }
}

export interface ColumnCost {
  id: ColumnId
  encoding: EncodingId
  /** Uncompressed bytes for the whole column. */
  logicalBytes: number
  /** Bytes actually on storage. */
  storedBytes: number
  /** logicalBytes ÷ storedBytes. Below 1 means the encoding made it worse. */
  ratio: number
  /** Stored bytes per row — the number that prices a projection. */
  bytesPerRow: number
}

export function columnCosts(layout: Layout): ColumnCost[] {
  return COLUMNS.map((c) => {
    const factor = encodingFactor(c.id, layout.encodings[c.id], layout)
    const logicalBytes = c.width * TABLE_ROWS
    const storedBytes = logicalBytes / factor
    return {
      id: c.id,
      encoding: layout.encodings[c.id],
      logicalBytes,
      storedBytes,
      ratio: factor,
      bytesPerRow: c.width / factor,
    }
  })
}

/* -------------------------------- report ------------------------------- */

/**
 * The seven headline counts, and nothing else. This interface is the promise
 * the page and the lessons make; adding a wall-clock field here would break
 * the course's central claim, so it is typed shut on purpose.
 */
export interface Metrics {
  bytesScanned: number
  rowGroupsRead: number
  rowGroupsPruned: number
  /** Row groups skipped ÷ row groups the trace could have read. */
  pruningRatio: number
  /** Whole-table uncompressed bytes ÷ stored bytes. */
  compressionRatio: number
  filesTouched: number
  bytesShuffled: number
}

export const METRIC_KEYS: (keyof Metrics)[] = [
  'bytesScanned',
  'rowGroupsRead',
  'rowGroupsPruned',
  'pruningRatio',
  'compressionRatio',
  'filesTouched',
  'bytesShuffled',
]

/** Metrics where a LOWER number is the better answer. */
export const LOWER_IS_BETTER: Record<keyof Metrics, boolean> = {
  bytesScanned: true,
  rowGroupsRead: true,
  rowGroupsPruned: false,
  pruningRatio: false,
  compressionRatio: false,
  filesTouched: true,
  bytesShuffled: true,
}

export interface QueryCost {
  id: number
  kind: Query['kind']
  label: string
  bytesScanned: number
  rowsRead: number
  rowGroupsRead: number
  rowGroupsPruned: number
  filesTouched: number
  bytesShuffled: number
  /** Bytes read ÷ bytes the answer actually needed. 1.0 is perfect. */
  readAmplification: number
}

export interface WarehouseDetail {
  /** Footer + delete-file bytes inside bytesScanned. The small-file tax. */
  metadataBytes: number
  /** Bytes rewritten by compaction — the write amplification a policy costs. */
  bytesRewritten: number
  /** Trace-wide bytesScanned ÷ bytes the answers needed. */
  readAmplification: number
  rowsRead: number
  totalRowGroups: number
  partitions: number
  /** Files not yet compacted at the end of the run. */
  smallFilesOpen: number
  deleteFilesOpen: number
  /** Bytes on the busiest exchange bucket. The bucket is the runtime. */
  shuffleMaxBytes: number
  shuffleMeanBytes: number
  /** shuffleMaxBytes ÷ shuffleMeanBytes. 1 = even; 0 = nothing shuffled. */
  shuffleSkew: number
  storedBytes: number
  logicalBytes: number
}

export interface WarehouseReport {
  mode: Trace['mode']
  seed: number
  metrics: Metrics
  detail: WarehouseDetail
  columns: ColumnCost[]
  queries: QueryCost[]
}

/* --------------------------------- run --------------------------------- */

/** Overlap of a normalised predicate with partition `p` of `count`, as a fraction of that partition. */
function partitionOverlap(pred: Predicate, p: number, count: number): number {
  const lo = p / count
  const hi = (p + 1) / count
  const overlap = Math.min(pred.hi, hi) - Math.max(pred.lo, lo)
  return clamp(overlap * count, 0, 1)
}

const findPredicate = (q: Query, col: ColumnId | null): Predicate | undefined =>
  col === null ? undefined : q.predicates.find((p) => p.column === col)

/**
 * Run a trace against a layout.
 *
 * Deterministic by construction: the only randomness in the Warehouse is in
 * the trace (seeded) and the partition row counts (seeded from TABLE_SEED), so
 * calling this twice with the same arguments returns identical counts. The
 * determinism test in `tests/warehouse.test.ts` exists to keep it that way,
 * because the reference diff is meaningless the moment it stops holding.
 */
export function runTrace(trace: Trace, layout: Layout): WarehouseReport {
  const pk = partitionKey(layout.partitionKey)
  const rows = partitionRows(layout.partitionKey)
  const partitions = rows.length
  const groups = rows.map((r) => Math.max(1, ceilDiv(r, layout.rowGroupRows)))
  const totalRowGroups = groups.reduce((a, b) => a + b, 0)
  const groupsPerFile = Math.max(1, Math.round(layout.fileRows / layout.rowGroupRows))
  const filesIn = groups.map((g) => Math.max(1, ceilDiv(g, groupsPerFile)))

  const columns = columnCosts(layout)
  const perRow: Record<ColumnId, number> = COLUMN_IDS.reduce(
    (acc, id) => {
      acc[id] = columns.find((c) => c.id === id)?.bytesPerRow ?? column(id).width
      return acc
    },
    {} as Record<ColumnId, number>,
  )
  const wholeRowStored = COLUMN_IDS.reduce((n, id) => n + perRow[id], 0)

  const sortKey = layout.sortKey === 'none' ? null : layout.sortKey
  const sortIsPartition = sortKey !== null && sortKey === pk.column

  /* Merge-on-read state. Small files and delete files accumulate on the newest
   * partition and every later read pays for them, which is the whole mechanism
   * behind "ingest got faster and queries got slower". */
  let smallFiles = 0
  let smallFileRows = 0
  let deleteFiles = 0
  let deletedRows = 0
  let writeCommits = 0
  let bytesRewritten = 0

  const buckets = new Array<number>(SHUFFLE_BUCKETS).fill(0)

  let bytesScanned = 0
  let metadataBytes = 0
  let rowGroupsRead = 0
  let rowGroupsPruned = 0
  let filesTouched = 0
  let bytesShuffled = 0
  let rowsRead = 0
  let bytesNeeded = 0
  const queries: QueryCost[] = []

  for (const q of trace.queries) {
    if (q.kind !== 'scan') {
      writeCommits += 1
      if (q.kind === 'append' || q.kind === 'update') {
        /* A commit smaller than the target file size still produces a file.
         * That is the small-file storm in one line. */
        smallFiles += Math.max(1, ceilDiv(q.rowsWritten, layout.fileRows))
        smallFileRows += q.rowsWritten
      }
      if (q.kind === 'delete' || q.kind === 'update') {
        deleteFiles += 1
        deletedRows += q.rowsWritten
      }
      if (layout.compactEvery > 0 && writeCommits % layout.compactEvery === 0) {
        /* Compaction is not free: it rewrites the pending rows and re-applies
         * the deletes. Counting those bytes is what stops "compact constantly"
         * from looking like a free lunch. */
        bytesRewritten += (smallFileRows + deletedRows) * wholeRowStored
        smallFiles = 0
        smallFileRows = 0
        deleteFiles = 0
        deletedRows = 0
      }
      queries.push({
        id: q.id,
        kind: q.kind,
        label: q.label,
        bytesScanned: 0,
        rowsRead: 0,
        rowGroupsRead: 0,
        rowGroupsPruned: 0,
        filesTouched: 0,
        bytesShuffled: 0,
        readAmplification: 0,
      })
      continue
    }

    const bytesPerRow = q.columns.reduce((n, c) => n + perRow[c], 0)

    /* 1. partition pruning */
    const pPred = findPredicate(q, pk.column)
    let first = 0
    let last = partitions
    if (pPred) {
      first = clamp(Math.floor(pPred.lo * partitions), 0, partitions - 1)
      last = clamp(Math.ceil(pPred.hi * partitions), first + 1, partitions)
    }

    /* 2. row-group pruning inside the surviving partitions */
    const sPred = sortKey ? findPredicate(q, sortKey) : undefined
    let qGroupsRead = 0
    let qRows = 0
    let qFiles = 0
    for (let p = first; p < last; p++) {
      const g = groups[p]
      qFiles += filesIn[p]

      let frac = 1
      if (sPred) {
        /* When the sort key IS the partition column, the interior partitions
         * are fully covered by the predicate and only the two boundary ones can
         * prune — which is why sorting by the partition column buys so much
         * less than people expect. */
        const wLocal = sortIsPartition ? partitionOverlap(sPred, p, partitions) : sPred.hi - sPred.lo
        if (wLocal < 1) {
          /* A row group is read if its min/max range intersects the predicate.
           * Clustered groups cover 1/g of the domain each; shuffled groups
           * cover all of it, so every group intersects and nothing prunes. */
          const statSpan = layout.clustering * (1 / g) + (1 - layout.clustering)
          frac = clamp(wLocal + statSpan, 1 / g, 1)
        }
      }
      const gr = clamp(Math.ceil(g * frac), 1, g)
      qGroupsRead += gr
      qRows += Math.min(rows[p], gr * layout.rowGroupRows)
    }

    /* 4. metadata: uncompacted files land on the newest partition, so a read
     * that touches it also opens every one of them, plus the delete files. */
    const touchesNewest = last >= partitions
    if (touchesNewest) qFiles += smallFiles + deleteFiles
    const qMetadata = qFiles * FOOTER_BYTES + (touchesNewest ? deletedRows * DELETE_POS_BYTES : 0)

    /* 3. projection */
    const qData = qRows * bytesPerRow
    const qBytes = qData + qMetadata

    /* The bytes the answer actually needed: rows that truly match, at the same
     * projected width. Predicate widths multiply — independence is an
     * assumption, and a generous one, so read amplification here is a floor. */
    const selectivity = q.predicates.reduce((s, p) => s * clamp(p.hi - p.lo, 0, 1), 1)
    const qNeeded = Math.max(1, TABLE_ROWS * selectivity) * bytesPerRow

    /* 5. exchange */
    let qShuffled = 0
    if (q.shuffle) {
      qShuffled = qData
      /* One key is hot; the rest split what is left. The hot bucket is chosen
       * from the key NAME so it is the same bucket on every query in the run —
       * a hot key is persistent, not resampled per query. */
      const hot = q.shuffle.key.charCodeAt(0) % SHUFFLE_BUCKETS
      const hotShare = clamp(q.shuffle.hotShare, 1 / SHUFFLE_BUCKETS, 1)
      const rest = (1 - hotShare) / Math.max(1, SHUFFLE_BUCKETS - 1)
      for (let b = 0; b < SHUFFLE_BUCKETS; b++) {
        buckets[b] += qShuffled * (b === hot ? hotShare : rest)
      }
    }

    bytesScanned += qBytes
    metadataBytes += qMetadata
    rowGroupsRead += qGroupsRead
    rowGroupsPruned += totalRowGroups - qGroupsRead
    filesTouched += qFiles
    bytesShuffled += qShuffled
    rowsRead += qRows
    bytesNeeded += qNeeded

    queries.push({
      id: q.id,
      kind: q.kind,
      label: q.label,
      bytesScanned: qBytes,
      rowsRead: qRows,
      rowGroupsRead: qGroupsRead,
      rowGroupsPruned: totalRowGroups - qGroupsRead,
      filesTouched: qFiles,
      bytesShuffled: qShuffled,
      readAmplification: qNeeded > 0 ? qBytes / qNeeded : 0,
    })
  }

  const considered = rowGroupsRead + rowGroupsPruned
  const logicalBytes = ROW_WIDTH * TABLE_ROWS
  const storedBytes = columns.reduce((n, c) => n + c.storedBytes, 0)

  const shuffleMaxBytes = buckets.reduce((a, b) => Math.max(a, b), 0)
  const shuffleMeanBytes = bytesShuffled / SHUFFLE_BUCKETS

  return {
    mode: trace.mode,
    seed: trace.seed,
    metrics: {
      bytesScanned,
      rowGroupsRead,
      rowGroupsPruned,
      /* Guarded: a trace of pure writes reads no groups at all, and 0/0 would
       * put NaN on the page — a metric that is never NaN is a contract here. */
      pruningRatio: considered > 0 ? rowGroupsPruned / considered : 0,
      compressionRatio: storedBytes > 0 ? logicalBytes / storedBytes : 1,
      filesTouched,
      bytesShuffled,
    },
    detail: {
      metadataBytes,
      bytesRewritten,
      readAmplification: bytesNeeded > 0 ? bytesScanned / bytesNeeded : 0,
      rowsRead,
      totalRowGroups,
      partitions,
      smallFilesOpen: smallFiles,
      deleteFilesOpen: deleteFiles,
      shuffleMaxBytes,
      shuffleMeanBytes,
      /* 0, not NaN and not 1: "nothing was shuffled" is a different statement
       * from "the shuffle was perfectly even". */
      shuffleSkew: shuffleMeanBytes > 0 ? shuffleMaxBytes / shuffleMeanBytes : 0,
      storedBytes,
      logicalBytes,
    },
    columns,
    queries,
  }
}

/* ------------------------------ comparison ----------------------------- */

export interface MetricDelta {
  key: keyof Metrics
  student: number
  reference: number
  /** student − reference. */
  delta: number
  /** Signed relative change, or 0 when the reference is 0. */
  relative: number
  /** True when the student's value is at least as good as the reference's. */
  better: boolean
}

/**
 * Run the same trace twice — once against the reader's layout, once against the
 * reference — and diff the counts. Both runs share the trace object, so any
 * divergence is attributable to the layout and nothing else. That is the entire
 * argument for the page: it is a controlled experiment, not a demo.
 */
export function compareToReference(
  trace: Trace,
  layout: Layout,
  reference: Layout = REFERENCE_LAYOUT,
): { student: WarehouseReport; reference: WarehouseReport; deltas: MetricDelta[] } {
  const s = runTrace(trace, layout)
  const r = runTrace(trace, reference)
  const deltas = METRIC_KEYS.map((key) => {
    const sv = s.metrics[key]
    const rv = r.metrics[key]
    const lower = LOWER_IS_BETTER[key]
    return {
      key,
      student: sv,
      reference: rv,
      delta: sv - rv,
      relative: rv !== 0 ? (sv - rv) / rv : 0,
      /* Ties count as a win: matching the reference means the reader
       * reconstructed the reasoning, which is the thing being taught. */
      better: lower ? sv <= rv : sv >= rv,
    }
  })
  return { student: s, reference: r, deltas }
}

/**
 * The completion condition for the dashboard trace: match or beat the reference
 * on the metric the workload is actually billed for. Pruning and compression
 * are means; bytes scanned is the end, and grading the end keeps the reader
 * from optimising a ratio that costs them bytes.
 */
export function beatsReference(trace: Trace, layout: Layout): boolean {
  const { student, reference } = compareToReference(trace, layout)
  return student.metrics.bytesScanned <= reference.metrics.bytesScanned
}
