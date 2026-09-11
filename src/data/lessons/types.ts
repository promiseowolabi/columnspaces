/**
 * Columnspaces lesson content model.
 *
 * Forked from tablespace's model. The block system, diagram rules and quiz
 * rules are unchanged — a lesson file drops into the same platform SPA. Four
 * deltas, all of them forced by this course having two halves:
 *
 *   1. `TrackId` covers the engine half (c0–c7) AND the architecture half
 *      (a1, a2).
 *   2. `takeaway` is REQUIRED. Inherited from vectorspace: every lesson hands
 *      the reader one number they can carry into a meeting. Enforced by
 *      tests/lessons.test.ts. If you cannot name it, the lesson is not
 *      finished.
 *   3. `vendor` blocks exist, and every vendor-specific claim must live in one
 *      (the rot rule — PLAN.md §"the formula" #11). This is what makes a
 *      course that deep-dives a product we cannot run honest: the claim is
 *      dated, sourced, and quarantined in one file rather than smeared through
 *      the prose.
 *   4. `desk` and `room` blocks send the reader into the architecture
 *      machinery — a numeric lab graded in bands, or an adversary who attacks
 *      the numbers they submitted.
 *
 * Only the block types here exist. No new fields, no `any`, no imports beyond
 * types.
 */

import type { QuizQuestion } from '@/components/QuizBlock'
import type { CodeTab } from '@/components/CodeBlock'

/**
 * Track ids. `c*` is the engine half (build it, measure it), `a*` is the
 * architecture half (design it, defend it).
 */
export type TrackId = 'c0' | 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6' | 'c7' | 'a1' | 'a2'

/** The simulator routes (sim/playground scope). */
export type SimId = 'warehouse'

/** Level bands, borrowed from the vectorspace audience model. */
export type Level = 200 | 300 | 400 | 500

/** Desk ids — fixed. A lesson may only promise what the desk actually grades. */
export type DeskId =
  | 'scan-desk'
  | 'layout-desk'
  | 'ingest-desk'
  | 'tenancy-desk'
  | 'compaction-desk'
  | 'capacity-desk'
  | 'tco-desk'
  | 'dr-desk'

/** Design Review rooms — fixed. */
export type RoomId = 'the-cfo' | 'the-principal' | 'the-steward' | 'the-consumer' | 'the-vendor'

/** The four artifacts a learner finishes the course holding. */
export type ArtifactId = 'layout-design' | 'scan-budget' | 'platform-runbook' | 'platform-memo'

/** Exercise type shown as the lesson's chip. */
export type ExerciseKind =
  | 'quiz'
  | 'sim'
  | 'code'
  | 'read'
  | 'quiz+sim'
  | 'read+quiz'
  | 'desk+quiz'
  | 'lab+quiz'
  | 'room'

/* ------------------------------ blocks ------------------------------ */

/**
 * `prose` — markdown-lite rendered by the lesson engine:
 *   `## H2` / `### H3`, paragraphs (blank-line separated),
 *   `- ` bullet lists, `1. ` ordered lists, GitHub-style pipe tables,
 *   inline **bold**, *em*, `code`, [label](https://url).
 */
export interface ProseBlock {
  type: 'prose'
  md: string
}

export interface CodeBlockData {
  type: 'code'
  filename?: string
  /** Compare tabs (SQL | Python | Rust …) — defaults to single `code`/`lang`. */
  tabs?: CodeTab[]
  code?: string
  lang?: string
  highlightLines?: number[]
  /** Annotation chips under the header, e.g. `no decode` · `2% of bytes`. */
  chips?: string[]
}

export type CalloutVariant = 'analogy' | 'info' | 'warning' | 'segfault' | 'isomorphism'

export interface CalloutBlock {
  type: 'callout'
  variant: CalloutVariant
  title?: string
  md: string
}

/** Step-through SVG diagram. */
export interface DiagramNode {
  id: string
  /** Grid coords on a 100×H viewBox canvas. */
  x: number
  y: number
  w?: number
  h?: number
  label: string
  sub?: string
  /** hex color override; defaults to track color for active, line for idle */
  color?: string
}

export interface DiagramEdge {
  from: string
  to: string
  label?: string
}

export interface DiagramStep {
  caption: string
  /** node ids highlighted in this step */
  active?: string[]
  /** edge keys `${from}->${to}` highlighted in this step */
  edges?: string[]
}

export interface DiagramBlock {
  type: 'diagram'
  /** mono figure caption, e.g. `fig 1 — the scan bill` */
  caption: string
  nodes: DiagramNode[]
  edges?: DiagramEdge[]
  steps: DiagramStep[]
  /** viewBox height in arbitrary units (width fixed 100). default 60 */
  height?: number
}

export interface StatChipData {
  value: string
  label: string
  /** plain-English tooltip */
  hint?: string
}

export interface StatlineBlock {
  type: 'statline'
  stats: StatChipData[]
}

export interface QuizBlockData {
  type: 'quiz'
  questions: QuizQuestion[]
}

export interface ExerciseBlock {
  type: 'exercise'
  simId: SimId
  /** Initial trace mode selected when opening this exercise. */
  machine?: string
  title: string
  /** guided tasks checklist (3–5 items) */
  tasks: string[]
  /** collapsed "what just happened" explanation */
  note?: string
}

/**
 * Isomorphism panel. Field names are historical (`os`/`llm` from kernelspace)
 * and kept so the renderer is shared across the series: read them as
 * "left side" and "right side".
 */
export interface IsomorphismPair {
  os: string
  osLine: string
  llm: string
  llmLine: string
}

export interface IsomorphismBlock {
  type: 'isomorphism'
  title?: string
  pairs: IsomorphismPair[]
}

export interface DeepdiveBlock {
  type: 'deepdive'
  title: string
  md: string
}

/** In-page interactive micro-lab — no toolchain, graded in-browser. */
export interface LabBlock {
  type: 'lab'
  /** key into the browser-lab registry (src/components/browserlabs) */
  lab: string
}

/**
 * A DuckDB-wasm lab: a real columnar engine in the tab. The point is always
 * "measure it, do not believe me" — these labs exist so no claim in this
 * course has to be taken on trust.
 */
export interface DuckLabBlock {
  type: 'ducklab'
  /** key into the duck-lab registry (src/components/ducklabs) */
  lab: string
}

/**
 * `vendor` — the rot rule made structural.
 *
 * No vendor-specific fact may appear loose in prose: not a default, not a
 * limit, not a feature, and NEVER a price. It lives here, with the month it
 * was verified and the source it was verified against, or it does not appear.
 *
 * `snapshot` is the month you CHECKED the claim, not the month you wrote the
 * lesson. If you did not check it, you may not write it as fact.
 */
export interface VendorBlock {
  type: 'vendor'
  /** Month verified, `YYYY-MM`. Rendered to the reader. */
  snapshot: string
  title: string
  md: string
  /** Systems named in this block, e.g. ['vast-db', 'duckdb']. */
  systems?: string[]
  /** Documentation URLs the claim was verified against. Required in practice. */
  sources?: string[]
}

/** Sends the reader into a numeric desk. */
export interface DeskBlock {
  type: 'desk'
  desk: DeskId
  brief: string
}

/** Sends the reader into a Design Review room. */
export interface RoomBlock {
  type: 'room'
  room: RoomId
  artifact: ArtifactId
  brief: string
}

export type ContentBlock =
  | ProseBlock
  | CodeBlockData
  | CalloutBlock
  | DiagramBlock
  | StatlineBlock
  | QuizBlockData
  | ExerciseBlock
  | IsomorphismBlock
  | DeepdiveBlock
  | LabBlock
  | DuckLabBlock
  | VendorBlock
  | DeskBlock
  | RoomBlock

/* ------------------------------ lesson ------------------------------ */

/**
 * The one number the reader carries out. REQUIRED and enforced: `number` must
 * contain a digit. This is the machine-checkable form of the course's central
 * discipline — every abstraction gets an arithmetic anchor.
 */
export interface Takeaway {
  /** e.g. `2% of bytes`, `~10×`, `40 files/row`. Must contain a digit. */
  number: string
  /** One sentence a reader could say out loud in a review. */
  claim: string
}

export interface Lesson {
  /** Canonical id used by the progress store: `c1.l3`. */
  id: string
  /** Human slug — also resolves at /lesson/:lessonId. */
  slug: string
  trackId: TrackId
  /** 1-based position within the track. */
  index: number
  title: string
  minutes: number
  /** One-line hook shown in lesson rows. */
  hook: string
  exercise: ExerciseKind
  /** Simulator id when the exercise is sim-backed. */
  simId?: SimId
  /** Which artifact this lesson feeds, if any. */
  artifact?: ArtifactId
  /** Exam lesson (amber chip, quiz-gated completion). */
  exam?: boolean
  takeaway: Takeaway
  blocks: ContentBlock[]
}

/** Heading extracted from blocks for the "ON THIS PAGE" rail. */
export interface LessonHeading {
  id: string
  text: string
  level: 2 | 3
}
