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

import type { LucideIcon } from 'lucide-react'
import { Warehouse } from 'lucide-react'
import type { Lesson, SimId, TrackId } from './types'

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

export const LESSONS_BY_TRACK: Record<TrackId, Lesson[]> = {
  c0: [c0l1, c0l2, c0l3, c0l4, c0l5],
  c1: [c1l1, c1l2, c1l3, c1l4, c1l5],
  c2: [c2l1, c2l2, c2l3, c2l4, c2l5, c2l6],
  c3: [c3l1, c3l2, c3l3, c3l4, c3l5],
  c4: [c4l1, c4l2, c4l3, c4l4, c4l5],
  c5: [c5l1, c5l2, c5l3, c5l4, c5l5],
  c6: [c6l1, c6l2, c6l3, c6l4, c6l5],
  c7: [c7l1, c7l2, c7l3, c7l4],
  a1: [],
  a2: [],
}

export const TRACK_IDS: TrackId[] = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'a1', 'a2']

/** All lessons in curriculum order. */
export const ALL_LESSONS: Lesson[] = TRACK_IDS.flatMap((id) => LESSONS_BY_TRACK[id])

export const TOTAL_LESSON_COUNT = ALL_LESSONS.length

/** Canonical ids in curriculum order — for next-recommended selectors. */
export const ORDERED_LESSON_IDS: string[] = ALL_LESSONS.map((l) => l.id)

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

/** Route helper — canonical lesson URL. */
export const lessonPath = (l: Lesson) => `/lesson/${l.id}`

/** Every takeaway, in curriculum order. This list is the real syllabus. */
export function takeaways(): { id: string; title: string; number: string; claim: string }[] {
  return ALL_LESSONS.map((l) => ({
    id: l.id,
    title: l.title,
    number: l.takeaway.number,
    claim: l.takeaway.claim,
  }))
}

/* ---------------------- track extras ---------------------- */

export interface TrackExtras {
  pitch: string
  outcomes: string[]
  requires: string
  sideNote: string
}

export const TRACK_EXTRAS: Record<TrackId, TrackExtras> = {
  c0: {
    pitch:
      'Analytics has exactly one physical cost and everything else is a consequence of it: how many bytes left storage to answer the question. This track makes that number computable before you run anything — and then makes you run it, in a real columnar engine, in this tab.',
    outcomes: [
      'Compute the scan bill for a query from a schema and a row count, before touching an engine.',
      'Explain why the page is the unit of I/O and what that does to a three-of-forty-columns query.',
      'Price the same scan on local NVMe, on a storage fabric, and on object storage — and say which term dominates.',
      'Read bytes scanned and rows scanned out of a real query profile instead of guessing from wall clock.',
    ],
    requires: 'base of the stack · you write SQL and have seen a query plan',
    sideNote: '// if you are billed by bytes scanned, this track is your invoice',
  },
  c1: {
    pitch:
      'A column is one type and one domain, and that is exactly what a codec eats. Dictionary, run-length, bit-packing, frame-of-reference — you will write all four, grade them on adversarial columns, and then learn the trick that makes compression pay three times: never decoding at all.',
    outcomes: [
      'Choose a codec from a column\'s cardinality, ordering and range — and predict its ratio before running it.',
      'Implement dictionary, RLE, bit-packing and frame-of-reference so they round-trip byte-exact.',
      'Explain execute-on-compressed: summing an RLE run, filtering on dictionary codes.',
      'Say where a compression ratio lies to you, and which ratio to quote instead.',
    ],
    requires: 'requires C0 · the scan contract',
    sideNote: '// lab 01 grades your codecs on all-null, all-distinct and zipf columns',
  },
  c2: {
    pitch:
      'Compression makes bytes smaller; layout makes them unread. Row groups, min/max statistics, bloom filters, sort keys versus partition keys — and the arithmetic that tells you whether your clustering will actually prune, or just reorganise the same scan.',
    outcomes: [
      'Design a layout from a query mix: what to partition on, what to sort on, and why they are different questions.',
      'Compute a pruning ratio and defend it as a promise rather than a hope.',
      'Explain why a false negative in pruning is a correctness bug and a false positive is only a cost.',
      'Recognise a small-file generator in a partition scheme before it ships.',
    ],
    requires: 'requires C1 · encodings',
    sideNote: '// zero false negatives. the one invariant lab 02 will not bend on',
  },
  c3: {
    pitch:
      'A modern table is a tree of immutable files plus metadata describing which of them count right now. This track opens the actual bytes: Parquet\'s footer, Iceberg\'s manifest tree, and how snapshot isolation works when the storage layer offers you almost no guarantees.',
    outcomes: [
      'Parse a Parquet footer and explain every level: file, row group, column chunk, page.',
      'Walk an Iceberg commit: metadata file, manifest list, manifests, and what atomicity rests on.',
      'Explain time travel, and what it costs to keep.',
      'State why compaction and snapshot expiry are mandatory operations, not optimisations.',
    ],
    requires: 'requires C2 · layout & pruning',
    sideNote: '// git for tables — and like git, the history is not free',
  },
  c4: {
    pitch:
      'Row-at-a-time execution spends most of its cycles on bookkeeping. Column-at-a-time is not a faster loop, it is a different machine: batches, selection vectors, late materialization, and operators that never assemble a tuple at all.',
    outcomes: [
      'Explain the per-tuple overhead a volcano iterator pays and what a batch amortises.',
      'Implement filter and hash aggregation over batches with selection vectors.',
      'Describe late materialization in terms of position lists, not rows.',
      'Say what SIMD and morsel parallelism each actually buy, and where they stop.',
    ],
    requires: 'requires C1 · encodings (execute-on-compressed)',
    sideNote: '// cross-link: tablespace T7.L2 for the volcano contrast',
  },
  c5: {
    pitch:
      'Everything columnar is optimised for reading, which makes writing the interesting problem. Write buffers, delta stores, merge-on-read versus copy-on-write, small-file amplification — and the freshness/cost curve you will be asked to sit on.',
    outcomes: [
      'Explain why one row update can rewrite a whole row group, and compute the amplification.',
      'Choose merge-on-read or copy-on-write from a read/write ratio and a freshness requirement.',
      'Bound read amplification with a compaction policy, and cost the policy.',
      'Diagnose a small-file storm from a file-size histogram.',
    ],
    requires: 'requires C3 · table formats',
    sideNote: '// the track where VAST\'s architecture stops being a footnote',
  },
  c6: {
    pitch:
      'One machine can only be so wide. The moment a query spans nodes, the dominant cost stops being bytes read and becomes bytes moved — and the architecture that decides how much moves is the one you are buying when you choose a platform.',
    outcomes: [
      'Compute shuffle volume for a join and choose broadcast versus partitioned on the numbers.',
      'Diagnose skew from per-partition byte counts and name the mitigation.',
      'Contrast shared-nothing, shared-disk and shared-everything by what each does on node loss and rescale.',
      'Say what disaggregation buys, what it costs, and which workloads notice.',
    ],
    requires: 'requires C4 · vectorized execution',
    sideNote: '// "the network is the new disk" is a claim you can cost',
  },
  c7: {
    pitch:
      'Real data is not a flat table. Nested structures get shredded into columns, schemas change under you, Arrow decides what crossing a process boundary costs, and vectors now want to live in the same table as everything else.',
    outcomes: [
      'Shred a nested record into columns with definition and repetition levels.',
      'Explain what a schema change does on disk, and which changes are free.',
      'Say why Arrow made zero-copy interchange the default boundary.',
      'Place vectors in a columnar table honestly — including what it does to pruning.',
    ],
    requires: 'requires C3 · table formats',
    sideNote: '// cross-links: tablespace T6, vectorspace L3A',
  },
  a1: {
    pitch:
      'Nobody is asking you to write the codec. They are asking whether the design will hold, what it will cost, and what breaks first. This track turns everything you measured in the engine half into artifacts an architect signs: a layout design, a scan budget, a sizing model, a build-or-buy memo.',
    outcomes: [
      'Turn a requirement set into a reference architecture with the tradeoffs named out loud.',
      'Produce a layout design document that states its pruning promise and its failure mode.',
      'Size a platform — storage, compute, ingest, metadata — with every term itemised.',
      'Answer build-or-buy with arithmetic, including the labour, and state the caveat first.',
    ],
    requires: 'requires C0–C3 · you can compute a scan bill and read a layout',
    sideNote: '// graded by desks and by adversaries, not by essays',
  },
  a2: {
    pitch:
      'A platform is what happens after the design is approved: other people\'s queries, other people\'s schemas, someone\'s 3am. The catalog as a control plane, schema changes as contracts, compaction as automation, and a query SLO you can actually defend.',
    outcomes: [
      'Treat the catalog as the control plane and say what breaks when it is the single point of failure.',
      'Publish a schema contract, and version it without breaking consumers.',
      'Automate compaction, expiry and lifecycle with bounded read amplification and a costed budget.',
      'Define a query SLO, alert on quality rather than errors, and write the runbook you would want at 3am.',
      'State an RPO and RTO for a table that is a manifest tree, and test the restore.',
    ],
    requires: 'requires A1 · you have a design to operate',
    sideNote: '// the on-call surface is part of the architecture',
  },
}

/* ---------------------- sim metadata ---------------------- */

export interface SimInfo {
  id: SimId
  name: string
  hook: string
  icon: LucideIcon
  trackId: TrackId
}

export const SIM_INFO: Record<SimId, SimInfo> = {
  warehouse: {
    id: 'warehouse',
    name: 'The Warehouse',
    hook: 'One columnar platform, assembled from your own labs, under a query trace that bills you for every byte.',
    icon: Warehouse,
    trackId: 'c0',
  },
}

/** Sims exercised by a given track's lessons (deduped, curriculum order). */
export function simsForTrack(trackId: string): { sim: SimInfo; lesson: Lesson }[] {
  const out: { sim: SimInfo; lesson: Lesson }[] = []
  const seen = new Set<SimId>()
  for (const l of lessonsForTrack(trackId)) {
    if (l.simId && !seen.has(l.simId)) {
      seen.add(l.simId)
      out.push({ sim: SIM_INFO[l.simId], lesson: l })
    }
  }
  return out
}

export type { Lesson, ContentBlock } from './types'
