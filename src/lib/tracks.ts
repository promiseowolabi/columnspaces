/**
 * Shared curriculum metadata — columnspaces (columnar databases, from an
 * encoded block to a platform decision). Same TrackMeta/SimMeta contract the
 * platform components consume.
 *
 * Two halves, deliberately visible in the registry:
 *   c0–c7  the engine half   — build it, measure it. Forge + DuckDB labs.
 *   a1–a2  the architecture half — design it, defend it. Desks + rooms.
 */

import type { LucideIcon } from 'lucide-react'
import {
  Boxes,
  Columns3,
  FileStack,
  Gauge,
  Layers,
  Network,
  Pencil,
  Scissors,
  ServerCog,
  ShieldCheck,
  Warehouse,
  Workflow,
} from 'lucide-react'
import type { Level, TrackId } from '@/data/lessons/types'

export interface TrackMeta {
  code: string
  /** `capstone` is not a content track — it has no lessons of its own. */
  id: TrackId | 'capstone'
  name: string
  color: string
  glyph: LucideIcon
  promise: string
  lessons: number
  exercises: number
  hours: number
  /** Which half this track belongs to. */
  half: 'engine' | 'architecture'
  /** Audience level the track is pitched at. */
  level: Level
}

export const TRACKS: TrackMeta[] = [
  {
    code: 'C0',
    id: 'c0',
    name: 'The Scan Contract',
    color: '#A3E635',
    glyph: Gauge,
    promise:
      'Bytes scanned is the only honest metric — and on a consumption bill it is also the only one finance can see.',
    lessons: 5,
    exercises: 5,
    hours: 2,
    half: 'engine',
    level: 200,
  },
  {
    code: 'C1',
    id: 'c1',
    name: 'Encodings',
    color: '#3EF2A4',
    glyph: Columns3,
    promise:
      'Dictionary, RLE, bit-packing, frame-of-reference: how a column becomes small, and how an engine computes without unpacking it.',
    lessons: 5,
    exercises: 5,
    hours: 3,
    half: 'engine',
    level: 300,
  },
  {
    code: 'C2',
    id: 'c2',
    name: 'Layout & Pruning',
    color: '#22D3EE',
    glyph: Scissors,
    promise:
      'Row groups, zone maps, sort keys versus partition keys — the difference between reading a table and skipping it.',
    lessons: 6,
    exercises: 6,
    hours: 3,
    half: 'engine',
    level: 300,
  },
  {
    code: 'C3',
    id: 'c3',
    name: 'Table Formats',
    color: '#5CA8FF',
    glyph: FileStack,
    promise:
      'Parquet to the byte, Iceberg to the manifest: what a table actually is when it is a tree of files on object storage.',
    lessons: 5,
    exercises: 5,
    hours: 3,
    half: 'engine',
    level: 300,
  },
  {
    code: 'C4',
    id: 'c4',
    name: 'Vectorized Execution',
    color: '#A78BFA',
    glyph: Layers,
    promise:
      'Batches, selection vectors, late materialization: why column-at-a-time is a different machine, not a faster loop.',
    lessons: 5,
    exercises: 5,
    hours: 3,
    half: 'engine',
    level: 400,
  },
  {
    code: 'C5',
    id: 'c5',
    name: 'The Write Path',
    color: '#FB923C',
    glyph: Pencil,
    promise:
      'Column stores hate updates. Write buffers, delta stores, merge-on-read versus copy-on-write — and the arithmetic that picks one.',
    lessons: 5,
    exercises: 5,
    hours: 3,
    half: 'engine',
    level: 400,
  },
  {
    code: 'C6',
    id: 'c6',
    name: 'Distributed Analytics',
    color: '#FB7185',
    glyph: Network,
    promise:
      'Shuffle is the bill. Broadcast versus partitioned joins, skew, and what shared-nothing, shared-disk and shared-everything each cost you.',
    lessons: 5,
    exercises: 5,
    hours: 3,
    half: 'engine',
    level: 400,
  },
  {
    code: 'C7',
    id: 'c7',
    name: 'Beyond Flat Columns',
    color: '#E879F9',
    glyph: Boxes,
    promise:
      'Nested data shredded into columns, schema evolution on disk, Arrow as the boundary, and vectors living in a table.',
    lessons: 4,
    exercises: 4,
    hours: 2,
    half: 'engine',
    level: 400,
  },
  {
    code: 'A1',
    id: 'a1',
    name: 'Solution Architecture',
    color: '#FBBF24',
    glyph: Workflow,
    promise:
      'From a requirement to a defensible design: the layout document, the sizing model, tenancy, ingest topology, migration, build-or-buy.',
    lessons: 7,
    exercises: 7,
    hours: 4,
    half: 'architecture',
    level: 500,
  },
  {
    code: 'A2',
    id: 'a2',
    name: 'Platform Engineering',
    color: '#F97316',
    glyph: ServerCog,
    promise:
      'Running it for other people: the catalog as control plane, schema contracts, compaction automation, query SLOs, capacity, chargeback, DR.',
    lessons: 7,
    exercises: 7,
    hours: 4,
    half: 'architecture',
    level: 500,
  },
]

export const CAPSTONE: TrackMeta = {
  code: 'C*',
  id: 'capstone',
  name: 'Capstone: The Platform Decision',
  color: '#FDE047',
  glyph: ShieldCheck,
  promise:
    'Your own measurements — compression, pruning, shuffle, cost — recomputed into one platform recommendation, defended in all five rooms.',
  lessons: 0,
  exercises: 0,
  hours: 0,
  half: 'architecture',
  level: 500,
}

export const TOTAL_TRACK_LESSONS = TRACKS.reduce((n, t) => n + t.lessons, 0)

export function getTrack(id: string): TrackMeta | undefined {
  return TRACKS.find((t) => t.id === id)
}

export const ENGINE_TRACKS = TRACKS.filter((t) => t.half === 'engine')
export const ARCHITECTURE_TRACKS = TRACKS.filter((t) => t.half === 'architecture')

/** Ranks, awarded across the two halves. */
export const RANKS = ['READER', 'ENCODER', 'PLANNER', 'ARCHITECT', 'PLATFORM'] as const
export type Rank = (typeof RANKS)[number]

export interface SimMeta {
  id: string
  name: string
  hook: string
  icon: LucideIcon
  trackId: string
  usedIn: string
  difficulty: 1 | 2 | 3
}

/** Simulators, in showcase order. */
export const SIMS: SimMeta[] = [
  {
    id: 'warehouse',
    name: 'The Warehouse',
    hook: 'One columnar platform, assembled from your own labs, under a query trace that bills you for every byte.',
    icon: Warehouse,
    trackId: 'c0',
    usedIn: 'C0.L5',
    difficulty: 2,
  },
]

/** Ordered lesson ids across tracks for next-lesson selectors. */
export const ORDERED_LESSON_IDS: string[] = TRACKS.flatMap((t) =>
  Array.from({ length: t.lessons }, (_, i) => `${t.id}.l${i + 1}`),
)

/** TRACKS never contains the capstone, so its ids are always real TrackIds. */
export const CONTENT_TRACK_IDS = TRACKS.map((t) => t.id as TrackId)
