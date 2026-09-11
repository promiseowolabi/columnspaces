/**
 * DuckDB lab metadata — the empirical labs (PLAN.md "DuckDB-wasm labs").
 * Component implementations live in src/components/ducklabs/.
 *
 * Every one of these exists to let a reader falsify a claim the lesson made.
 * If a lab cannot fail, it is a demo, not a lab.
 */

import type { TrackId } from '@/data/lessons/types'

export interface DuckLabMeta {
  id: string
  title: string
  trackId: TrackId
  hook: string
  /** The claim the reader is checking. Stated so it could come out false. */
  claim: string
}

export const DUCK_LABS: DuckLabMeta[] = [
  {
    id: 'scan-bill',
    title: 'The Scan Bill',
    trackId: 'c0',
    hook: 'Run one query over row-shaped and column-shaped copies of the same data, and read the bytes each one actually touched.',
    claim: 'A three-of-forty-columns query reads a small single-digit percentage of a column store and effectively all of a row store.',
  },
  {
    id: 'codec-bench',
    title: 'The Codec Bench',
    trackId: 'c1',
    hook: 'Predict a column\'s compression ratio from its statistics, then let a real engine tell you how close you were.',
    claim: 'Ratio is predictable from cardinality, ordering and range — not from the codec\'s reputation.',
  },
  {
    id: 'pruning-lab',
    title: 'The Pruning Lab',
    trackId: 'c2',
    hook: 'Change the sort key and the row-group size; watch how many row groups the engine can skip unread.',
    claim: 'Pruning follows physical clustering, and a sort key that does not match the predicate prunes nothing.',
  },
  {
    id: 'parquet-anatomy',
    title: 'Parquet Anatomy',
    trackId: 'c3',
    hook: 'Open a real footer: row groups, column chunks, page statistics — then corrupt one byte and watch the reader refuse.',
    claim: 'Everything a scan needs to skip work is in the metadata, and metadata is not free.',
  },
  {
    id: 'snapshot-lab',
    title: 'The Snapshot Lab',
    trackId: 'c3',
    hook: 'Update three rows, then look at what the commit actually rewrote and what time travel is now keeping alive.',
    claim: 'A three-row update in a copy-on-write table rewrites whole files, and the old ones stay until expiry.',
  },
  {
    id: 'skew-lab',
    title: 'The Skew Lab',
    trackId: 'c6',
    hook: 'Build a join on a deliberately skewed key and find the one partition that owns the wall clock.',
    claim: 'Average partition size tells you nothing; the maximum is the runtime.',
  },
]

export function duckLabMeta(id: string): DuckLabMeta | undefined {
  return DUCK_LABS.find((l) => l.id === id)
}
