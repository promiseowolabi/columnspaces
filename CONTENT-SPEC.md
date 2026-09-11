# CONTENT-SPEC — how a columnspaces lesson is written

Authoring contract for `src/data/lessons/<trackId>/<slug>.ts`. Read this plus
one reference lesson (`c0/bytes-scanned-is-the-bill.ts`) before writing
anything.

Forked from vectorspace's spec, which was itself forked from latentspace's. The
block system, the diagram rules and the quiz rules carry over unchanged — a
lesson file drops into the same platform SPA. The deltas specific to this course
are §5 (vendor blocks and the VAST rule), §6 (two audiences, two voices) and §7
(what the desks, rooms and labs actually grade).

## 1. File shape

```ts
import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c2.l3',                    // `${trackId}.l${index}` — the progress store key
  slug: 'zone-maps-and-the-skip', // MUST equal the filename minus .ts
  trackId: 'c2',
  index: 3,                       // 1-based position in the track
  title: 'Zone Maps and the Skip',
  minutes: 15,                    // honest reading estimate, 9–24
  hook: 'One sentence that makes the lesson unskippable.',
  exercise: 'lab+quiz',
  artifact: 'layout-design',      // optional: which artifact this feeds
  takeaway: {
    number: '0 false negatives',
    claim: 'Skipping a block that held a match is a correctness bug; reading one that did not is only a bill.',
  },
  blocks: [ /* … */ ],
}

export default lesson
```

`takeaway` is **required and enforced**. `tests/registry.test.ts` asserts every
lesson has one and that `number` contains a digit. This is the course's central
discipline made machine-checkable: every lesson hands the reader one figure they
can carry into a meeting. **If you cannot name it, the lesson is not finished.**

Register the lesson in `src/data/lessons/index.ts` (import + the
`LESSONS_BY_TRACK` array). A track whose array is shorter than its `lessons`
count in `src/lib/tracks.ts` renders the remainder as stubs; `npm run report`
prints the gap. **Never exceed the declared count** — a test fails if you do.

Only the block types in `src/data/lessons/types.ts` exist. No new fields, no
`any`, no imports beyond `../types` (type-only).

**Escaping:** `md` strings are template literals. Inline code must be written as
`` \` `` — an unescaped backtick ends the string. `${` must be written `\${`.

## 2. Blocks

| block | fields | use it for |
|---|---|---|
| `prose` | `md` | the spine. Markdown-lite: `## H2`, `### H3`, blank-line paragraphs, `- ` and `1. ` lists, pipe tables, `**bold**`, `*em*`, `` `code` ``, `[label](url)` |
| `code` | `filename?`, `code`, `lang`, `tabs?`, `highlightLines?`, `chips?` | SQL, a Parquet layout, a sizing calculation, Rust only when it mirrors a forge lab's API |
| `callout` | `variant`, `title?`, `md` | `analogy` \| `info` \| `warning` \| `segfault` \| `isomorphism` |
| `diagram` | `caption`, `nodes`, `edges?`, `steps`, `height?` | a stepped SVG walkthrough. See §3 |
| `statline` | `stats: [{ value, label, hint }]` | 3–4 numbers that survive the lesson |
| `quiz` | `questions: [{ q, options, correct, explanation }]` | 2–3 questions. See §4 |
| `vendor` | `snapshot`, `title`, `md`, `systems?`, `sources?` | **every** vendor-specific claim. See §5 |
| `lab` | `lab` | in-page browser lab. Only ids in `src/data/browser-labs.ts` |
| `ducklab` | `lab` | a real columnar engine in the tab. Only ids in `src/data/duck-labs.ts` |
| `desk` | `desk`, `brief` | sends the reader into a numeric desk |
| `room` | `room`, `artifact`, `brief` | sends the reader into a Design Review room |
| `exercise` | `simId: 'warehouse'`, `machine?`, `title`, `tasks[]`, `note?` | sends the reader into The Warehouse |
| `isomorphism` | `title?`, `pairs[]` | side-by-side mapping onto something the reader already owns |
| `deepdive` | `title`, `md` | the closing "going deeper": real papers, real systems, by name |

Typical lesson: 4–7 `prose`, 1 `diagram`, 1 `statline`, 1–2 `callout`, 0–1
`vendor`, 0–1 lab/desk/room, exactly one `quiz` near the end, one `deepdive`
last.

Enforced by tests: **exactly one quiz per lesson**, the **first block is
`prose`**, every lab/desk/room id must be registered, and every quiz question
needs exactly one correct answer with an explanation over 40 characters.

## 3. Diagrams

`nodes` sit on a 100-wide × `height`-tall viewBox (`height` default 60; use
60–80). `x`/`y` is the top-left corner, `w`/`h` the box size. Keep boxes ≥ 10
wide and 8 tall.

Enforced by tests: **no two node boxes may overlap**, every box must stay inside
the canvas, every edge must reference real node ids, there must be **at least 3
steps**, and every step `caption` must exceed 40 characters — because the
captions are the narration, not labels. 4–7 steps is the working range.

## 4. Quizzes

Questions test transfer, not recall. Give a production or commercial situation
and make the reader reason. Four options, exactly one correct
(`correct: [index]`), and the three wrong options must be things a competent
engineer would actually propose. `explanation` says why the right answer is right
*and* why the tempting wrong one fails. Never "all of the above".

**At least one quiz per track must be a money or risk question** rather than a
purely technical one. In this subject the two are the same thing — bytes scanned
is a line item — and the reader's failure mode is not misunderstanding
dictionary encoding, it is being unable to defend a number.

Prefer wrong answers that are *real folklore*: "add more partitions", "the
engine handles pruning automatically", "compression will keep it low", "scale up
the cluster". Each of those is something someone says in a real meeting.

## 5. Vendor claims — the rot rule, and the VAST rule

**No vendor-specific fact may appear loose in prose.** Not a default, not a
limit, not a feature, and never a price. It lives in a `vendor` block.

```ts
{
  type: 'vendor',
  snapshot: '2026-09',            // month CHECKED, rendered to the reader
  title: 'How VAST DB handles the write path',
  systems: ['vast-db', 'duckdb'],
  sources: ['https://support.vastdata.com/hc/en-us/articles/…'],
  md: `…`,
}
```

Enforced by tests: `snapshot` matches `YYYY-MM`, at least one `https://` source
is present, and **no lesson may contain a price-like string** anywhere.

Rules:

1. `snapshot` is the month you **verified** the claim, not the month you wrote
   the lesson. If you did not check it, you may not write it as fact.
2. **Never state a price.** Vendors reprice, regions differ, commitments differ.
   Describe the pricing *shape* (`consumption-bytes` / `consumption-credits` /
   `instance` / `capacity` / `appliance`) and send the reader to their own
   calculator. Shape changes an architecture; numbers make a course stale.
3. Prefer durable architectural facts over version-specific features. "Storage
   and all system metadata are shared by every compute node" is durable. "Version
   X added feature Y" is perishable — say which version and expect to revisit.
4. **Name the mechanism, never rank the product.** "VAST describes writes landing
   in persistent memory and then converting to columnar chunks" is a fact.
   "VAST is the best platform for this" is marketing, and it will be wrong for
   someone's workload within a year.

### The VAST rule

This course deep-dives VAST DataBase and **there is no VAST cluster behind it.**
That constraint is a feature if handled honestly and a fraud if not:

- **Never present a VAST performance figure as measured by us or by the reader.**
  Where VAST publishes numbers, they are labelled as VAST's, on VAST's
  configuration, with the source linked.
- **Teach the mechanism, then the consequence.** Every VAST passage has the same
  shape: here is what you just built and measured → here is what VAST does
  instead → here is the physics that explains the difference → here is what it
  changes about your architecture.
- **End on falsifiability.** Where a VAST claim would change a design decision,
  say what a proof-of-concept would have to measure to confirm it. The vendor
  room grades exactly this, and `poc_undefined` is a severity-3 objection.
- Sources are listed in `PLAN.md` §11. Verify against those, not against memory.

The same discipline applies to DuckDB, ClickHouse, Snowflake, Iceberg and
everyone else. VAST just gets the most of it, because it is the subject.

## 6. Voice — two audiences, one register

**The engine half (C0–C7)** is written for someone who will build it. They want
the mechanism, the invariant and the byte count. Assume they will open the lab.

**The architecture half (A1–A2)** is written for someone who has to defend a
number in a room this week to someone with budget authority. Assume they will be
interrupted.

Shared rules:

- Second person, present tense. Direct. No "in this lesson we will".
- **Every abstraction gets an arithmetic anchor**: bytes, files, partitions,
  amplification factors, engineer-months. Show the multiplication.
- Numbers must be (a) arithmetic the reader can redo (`2B × 28 B ≈ 56 GB`),
  (b) a published figure with the source named, or (c) explicitly labelled an
  order-of-magnitude estimate. **Never invent a measured benchmark result.**
- **Cost is a count, never a clock.** Bytes, files, row groups, requests,
  engineer-months. A count means the same thing on every machine, which is what
  makes the labs gradeable and the traces replayable. If you find yourself
  writing "fast", write the count instead.
- **Teach the reader to state the caveat first.** The single most valuable
  professional habit in this course is naming the weakness of your own analysis
  before the room finds it. Model it explicitly — the reference lesson closes on
  it, and the rooms grade it.
- One `isomorphism` per lesson where it is honest: a zone map is a covering index
  you never maintain; a dictionary column is an inlined foreign key; merge-on-read
  is LSM compaction with a schema; an Iceberg snapshot tree is git for tables; a
  shuffle is a GROUP BY that has to cross a network.
- Reference other lessons as `C2.L3`, desks as `layout-desk`, rooms as
  `the-cfo`, forge labs as `lab 02`, duck labs by title.
- **Cross-link to siblings rather than re-deriving.** `→ tablespace T0.L2` for
  the random-versus-sequential cost model, `→ tablespace T7.L1` for the NSM/DSM
  comparison from the row store's side, `→ vectorspace L3A` for vector index
  choice. It is an invitation, not a prerequisite. **Never re-derive what a
  sibling course already teaches well.**
- No hype. The reader has been surprised by a warehouse bill and has a design
  review on Thursday.

**Anti-patterns:**

- "It depends" without immediately giving both numbers. "It depends on
  selectivity" is a non-answer; "below 1% the index wins, above 10% the scan
  does, and here is the crossover arithmetic" is the lesson.
- Praising columnar storage. The reader already chose it. Teach where it *loses*
  — the point lookup, the single-row update, the unpredicated ad-hoc scan.
- Passive constructions hiding an agent: "pruning is enabled" (by what? by your
  physical layout, and it can silently stop).
- A layout recommendation with no named loser. Every physical layout privileges
  some access patterns and starves others; say which.

## 7. What the machinery actually grades

A lesson may only promise what the machinery delivers. Check before you write.

- **Forge labs** (`src/data/labs.ts`): six labs, and the `checks` array is the
  contract. Check ids must match the harness `Check` ids in the crate's
  `src/lib.rs` **verbatim**. If a lesson says "graded on X", X must be a check.
- **Duck labs** (`src/data/duck-labs.ts`): each carries a `claim` the reader can
  *falsify*. If the lab cannot come out against the lesson, it is a demo, not a
  lab — do not pretend otherwise.
- **Browser labs** (`src/data/browser-labs.ts`): conceptual and arithmetic rungs,
  graded in-page.
- **Desks** (`src/lib/desks/index.ts`): eight, each with a fixed `decision`,
  `submits` and `checks`. Graded in **bands**, never against one value — a
  sizing model is not correct, it is within tolerance and honestly caveated. A
  lesson that opens a desk must have taught the arithmetic the desk grades.
- **Rooms** (`src/data/rooms.ts`): five adversaries, objections as pure
  predicates over the `Dossier`. **A lesson that sends the reader into a room
  must have given them the number that room asks for.** Read the `fires`
  predicates: if a lesson opens `the-cfo` without teaching the daily scan
  budget, the reader loses the room for a reason the course never covered.
- **The Warehouse** (`simId: 'warehouse'`): four trace modes — `dashboard`,
  `adhoc`, `ingest`, `skew`. Its metrics are bytes scanned, pruning ratio,
  compression ratio, files touched and bytes shuffled. Do not promise a metric
  it does not report.

## 8. Definition of done

- `npm run verify` clean: lint, `tsc -b`, production build, tests.
- The lesson has a `takeaway` whose `number` a reader could write on a napkin.
- Every vendor claim is in a `vendor` block with a verified `snapshot` and a
  source — or absent. No prices anywhere.
- Every number is redoable, sourced, or labelled an estimate. No invented
  benchmarks.
- Every promise about grading matches §7.
- The lesson names at least one thing the design is bad at.
- It contains at least one thing a senior engineer would not already know, and
  at least one sentence they could say out loud in a review.
- It reads in the estimated `minutes`.
