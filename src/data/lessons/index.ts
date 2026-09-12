/**
 * Lesson registry — columnspaces content source of truth.
 *
 * Engine half:       c0 (The Scan Contract), c1 (Encodings), c2 (Layout &
 *                    Pruning), c3 (Table Formats), c4 (Vectorized Execution),
 *                    c5 (The Write Path), c6 (Distributed Analytics),
 *                    c7 (Beyond Flat Columns).
 * Architecture half: a1 (Solution Architecture), a2 (Platform Engineering).
 *
 * Authored lessons are imported below. A track whose array is shorter than its
 * `lessons` count in src/lib/tracks.ts renders the remainder as stubs — that is
 * the intended build-in-public state, and `npm run report` prints the gap.
 */

import type { Lesson, TrackId } from './types'
import { ORDERED_LESSON_IDS } from './manifest'

// C0 — The Scan Contract
import c0l1 from './c0/bytes-scanned-is-the-bill'
import c0l2 from './c0/the-unit-is-never-a-value'
import c0l3 from './c0/three-places-bytes-live'
import c0l4 from './c0/pruning-is-not-a-feature'
import c0l5 from './c0/the-scan-budget'

// C1 — Encodings
import c1l1 from './c1/a-column-is-a-domain'
import c1l2 from './c1/dictionary-and-run-length'
import c1l3 from './c1/bit-packing-and-frame-of-reference'
import c1l4 from './c1/nulls-strings-and-the-floor'
import c1l5 from './c1/compute-without-decoding'

// C2 — Layout & Pruning
import c2l1 from './c2/row-groups-and-statistics'
import c2l2 from './c2/sort-keys-versus-partition-keys'
import c2l3 from './c2/clustering-depth'
import c2l4 from './c2/bloom-filters-and-exact-answers'
import c2l5 from './c2/the-small-file-problem'
import c2l6 from './c2/the-pruning-promise'

// C3 — Table Formats
import c3l1 from './c3/parquet-to-the-byte'
import c3l2 from './c3/what-the-footer-cannot-tell-you'
import c3l3 from './c3/a-table-is-a-tree-of-files'
import c3l4 from './c3/copy-on-write-and-time-travel'
import c3l5 from './c3/compaction-is-not-optional'

// C4 — Vectorized Execution
import c4l1 from './c4/a-different-machine-not-a-faster-loop'
import c4l2 from './c4/selection-vectors'
import c4l3 from './c4/late-materialization'
import c4l4 from './c4/hash-aggregation-on-batches'
import c4l5 from './c4/simd-morsels-and-the-limits'

// C5 — The Write Path
import c5l1 from './c5/why-column-stores-hate-updates'
import c5l2 from './c5/write-buffers-and-delta-stores'
import c5l3 from './c5/merge-on-read-versus-copy-on-write'
import c5l4 from './c5/small-files-and-the-freshness-curve'
import c5l5 from './c5/the-update-path-decision'

// C6 — Distributed Analytics
import c6l1 from './c6/shuffle-is-the-bill'
import c6l2 from './c6/broadcast-or-partition'
import c6l3 from './c6/skew-is-the-runtime'
import c6l4 from './c6/shared-nothing-disk-everything'
import c6l5 from './c6/elasticity-and-what-it-costs'

// C7 — Beyond Flat Columns
import c7l1 from './c7/shredding-nested-data'
import c7l2 from './c7/json-and-the-schema-you-did-not-declare'
import c7l3 from './c7/schema-evolution-on-disk'
import c7l4 from './c7/arrow-and-vectors-in-a-table'

// A1 — Solution Architecture
import a1l1 from './a1/from-requirements-to-a-reference-architecture'
import a1l2 from './a1/the-layout-design-document'
import a1l3 from './a1/the-sizing-model'
import a1l4 from './a1/multi-tenancy-in-a-warehouse'
import a1l5 from './a1/ingest-topologies'
import a1l6 from './a1/migration-and-coexistence'
import a1l7 from './a1/build-or-buy-computed'

// A2 — Platform Engineering
import a2l1 from './a2/the-catalog-is-the-control-plane'
import a2l2 from './a2/schema-as-a-contract'
import a2l3 from './a2/automating-compaction-and-lifecycle'
import a2l4 from './a2/observability-and-the-query-slo'
import a2l5 from './a2/capacity-and-chargeback'
import a2l6 from './a2/dr-time-travel-and-what-restore-means'
import a2l7 from './a2/the-runbook-and-the-on-call-surface'

export const LESSONS_BY_TRACK: Record<TrackId, Lesson[]> = {
  c0: [c0l1, c0l2, c0l3, c0l4, c0l5],
  c1: [c1l1, c1l2, c1l3, c1l4, c1l5],
  c2: [c2l1, c2l2, c2l3, c2l4, c2l5, c2l6],
  c3: [c3l1, c3l2, c3l3, c3l4, c3l5],
  c4: [c4l1, c4l2, c4l3, c4l4, c4l5],
  c5: [c5l1, c5l2, c5l3, c5l4, c5l5],
  c6: [c6l1, c6l2, c6l3, c6l4, c6l5],
  c7: [c7l1, c7l2, c7l3, c7l4],
  a1: [a1l1, a1l2, a1l3, a1l4, a1l5, a1l6, a1l7],
  a2: [a2l1, a2l2, a2l3, a2l4, a2l5, a2l6, a2l7],
}

export const TRACK_IDS: TrackId[] = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'a1', 'a2']

/** All lessons in curriculum order. */
export const ALL_LESSONS: Lesson[] = TRACK_IDS.flatMap((id) => LESSONS_BY_TRACK[id])

const byIdMap = new Map<string, Lesson>()
for (const l of ALL_LESSONS) {
  byIdMap.set(l.id, l)
  byIdMap.set(l.slug, l)
}

/** Resolve a lesson by canonical id (`c2.l1`) or slug (`bytes-scanned-is-the-bill`). */
export function lessonById(idOrSlug: string | undefined): Lesson | undefined {
  if (!idOrSlug) return undefined
  return byIdMap.get(idOrSlug)
}

export function lessonsForTrack(trackId: string): Lesson[] {
  return LESSONS_BY_TRACK[trackId as TrackId] ?? []
}

/** Next lesson in curriculum order — crosses track boundaries. */
export function nextLesson(lesson: Lesson): Lesson | undefined {
  const i = ORDERED_LESSON_IDS.indexOf(lesson.id)
  return i >= 0 ? lessonById(ORDERED_LESSON_IDS[i + 1]) : undefined
}

/** Previous lesson in curriculum order — crosses track boundaries. */
export function prevLesson(lesson: Lesson): Lesson | undefined {
  const i = ORDERED_LESSON_IDS.indexOf(lesson.id)
  return i > 0 ? lessonById(ORDERED_LESSON_IDS[i - 1]) : undefined
}

/* ---------------------- light re-exports ---------------------- */

/*
 * Metadata and track prose live in modules that do NOT import the corpus, so a
 * list page costs kilobytes. They are re-exported here for callers that already
 * hold a full Lesson.
 */
export * from './manifest'
export * from './track-extras'
export type { Lesson, ContentBlock } from './types'
