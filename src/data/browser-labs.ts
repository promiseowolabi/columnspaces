/**
 * Browser labs — metadata for the in-page micro-labs.
 * The hands-on rung between reading a lesson and opening the forge: no
 * toolchain, graded deterministically in-page.
 *
 * Component implementations live in src/components/browserlabs/ and are
 * registered in src/components/browserlabs/index.tsx.
 */

import type { TrackId } from '@/data/lessons/types'

export interface BrowserLabMeta {
  id: string
  title: string
  trackId: TrackId
  hook: string
}

export const BROWSER_LABS: BrowserLabMeta[] = [
  {
    id: 'scan-arithmetic',
    title: 'Scan Arithmetic',
    trackId: 'c0',
    hook: 'Build the scan bill from a schema by hand: columns projected, blocks pruned, queries per day — and watch which factor actually moves it.',
  },
  {
    id: 'codec-chooser',
    title: 'The Codec Chooser',
    trackId: 'c1',
    hook: 'Given a column\'s cardinality, ordering and range, pick the encoding — then see what the bytes do.',
  },
  {
    id: 'layout-designer',
    title: 'The Layout Designer',
    trackId: 'c2',
    hook: 'Choose partition key, sort key and row-group size against a query mix; the pruning ratio is computed live and one query always loses.',
  },
  {
    id: 'footer-walk',
    title: 'The Footer Walk',
    trackId: 'c3',
    hook: 'Step through a Parquet footer level by level — file, row group, column chunk, page — and find the statistics a scan reads first.',
  },
  {
    id: 'batch-machine',
    title: 'The Batch Machine',
    trackId: 'c4',
    hook: 'Run a filter and an aggregate over batches with a selection vector, and count the per-tuple work you just stopped paying.',
  },
  {
    id: 'merge-policy',
    title: 'The Merge Policy',
    trackId: 'c5',
    hook: 'Set a compaction trigger and target size; watch read amplification and write amplification move in opposite directions.',
  },
  {
    id: 'shuffle-planner',
    title: 'The Shuffle Planner',
    trackId: 'c6',
    hook: 'Cost broadcast against partitioned for a join, then re-cost it when the key turns out to be skewed.',
  },
]

export function browserLabMeta(id: string): BrowserLabMeta | undefined {
  return BROWSER_LABS.find((l) => l.id === id)
}
