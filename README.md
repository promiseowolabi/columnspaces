# columnspaces

**Your warehouse bill is a physics readout. Learn to read it, then learn to
design against it.**

A columnar-database course in two halves. The **engine half** makes you build
and measure the columnar layer — encodings, pruning, table formats, vectorized
execution, the write path, shuffle. The **architecture half** makes you design
a platform on it and defend the design to people whose job is to find the
number you did not model.

The deep-dive subject is **VAST DataBase**. There is no VAST cluster here and
the course never pretends otherwise: you run DuckDB and read ClickHouse, and
VAST is taught as a named architecture you map onto what you just measured —
every claim dated, sourced to VAST's own public documentation, and quarantined
in a vendor block.

## What is in it

- **54 lessons** across 10 tracks (C0 The Scan Contract → C7 Beyond Flat
  Columns, then A1 Solution Architecture and A2 Platform Engineering)
- **6 Rust forge labs** compiled to wasm and graded in-browser by the same
  checks `cargo test` runs — encodings that must round-trip byte-exact, a
  pruning planner that may never produce a false negative, a merge-on-read
  store graded on read and write amplification bands
- **6 DuckDB-wasm labs** — a real columnar engine in the tab, there so you can
  falsify the course's own numbers instead of trusting them
- **7 browser labs** — the conceptual rungs, no toolchain
- **8 desks** — numeric decisions (scan budget, layout, ingest, tenancy,
  compaction, capacity, TCO, DR) graded in tolerance bands, because a sizing
  model is not "correct", it is within tolerance and honestly caveated
- **5 Design Review rooms** — a CFO, a hostile principal, a governance officer,
  an internal customer and a vendor account exec attack the numbers *you*
  submitted. Objections are pure predicates over your dossier, so the room is
  deterministic and personal
- **The Warehouse** — one columnar platform assembled from your own artifacts
  under deterministic query traces, measured in counts, never wall-clock
- **Column Week** — five incident drills: pruning collapse, small-file storm,
  skewed shuffle, silent schema change, disaggregation surprise
- Zero servers, zero accounts: progress lives in localStorage, exportable as
  JSON

Course #5 in the series, after kernelspace (the machine), byzantine (the
network), tablespace (the data at rest) and vectorspace (the decision). It
forks tablespace's platform and cross-links to it rather than re-deriving it.

## Curriculum

| Half | Track | Name | Lessons |
|---|---|---|---|
| engine | C0 | The Scan Contract | 5 |
| engine | C1 | Encodings | 5 |
| engine | C2 | Layout & Pruning | 6 |
| engine | C3 | Table Formats | 5 |
| engine | C4 | Vectorized Execution | 5 |
| engine | C5 | The Write Path | 5 |
| engine | C6 | Distributed Analytics | 5 |
| engine | C7 | Beyond Flat Columns | 4 |
| architecture | A1 | Solution Architecture | 7 |
| architecture | A2 | Platform Engineering | 7 |
| architecture | C* | Capstone: The Platform Decision | — |

Ranks: `READER → ENCODER → PLANNER → ARCHITECT → PLATFORM`.

See `PLAN.md` for the full design, the honest risks and the resume state.

## Develop

Requires Node.js 20+ (this repo uses npm, not bun).

```sh
npm install
npm run dev         # vite dev server on :3000
npm run build       # tsc -b && vite build
npm run lint
npm run test
npm run verify      # lint + build + test
```

Routes:

| route | what it shows |
|---|---|
| `/curriculum` | 10 tracks across two halves, authored lessons and stubs |
| `/lesson/<id>` | a lesson, all fourteen block types rendered |
| `/labs` | the forge — six Rust labs and their checks |
| `/warehouse` | the persistent world and the counts it measures |
| `/drills` | Column Week incident cards |
| `/desks`, `/desk/<id>` | the eight numeric desks |
| `/rooms`, `/room/<id>` | the five adversaries and their objection trees |
| `/progress` | progress, export/import |

Labs are a Cargo workspace under `labs/` (student templates; reference
solutions live in the gitignored `labs/_solutions/`). Pack the downloadable
zips with:

```sh
python3 scripts/pack-labs.py
```

Regenerate the agent surface (per-lesson markdown + `llms.txt`):

```sh
npx tsx scripts/export-lessons-md.ts
```

Deploy: push to `main` → GitHub Actions → GitHub Pages at
`https://promiseowolabi.github.io/columnspaces/`. The workflow sets
`VITE_BASE=/columnspaces/`; `vite.config.ts` reads it and `main.tsx` hands
`import.meta.env.BASE_URL` to the router basename, so the same source works on
a project path, a user site or a custom domain without edits.

## Design notes worth knowing before contributing

**Cost is always a count.** Bytes, files, partitions, row groups,
engineer-months — never wall-clock. A count means the same thing on every
machine, which is what makes labs gradeable, desks bandable and traces
replayable.

**No prices are hardcoded, anywhere.** Pricing is captured as a *shape*
(`consumption-bytes` / `consumption-credits` / `instance` / `capacity` /
`appliance`), because the shape changes an architecture and the shape is
stable. Absolute numbers belong in the reader's own calculator, and any course
that hardcodes them is misleading within two quarters.

**Vendor claims are dated and quarantined.** Every vendor-specific fact lives
in a `vendor` block carrying the month it was *verified* and the documentation
it was verified against. Nothing about VAST — or DuckDB, or ClickHouse —
appears loose in prose.

**We never present a vendor's benchmark as ours.** There is no VAST cluster
behind this course. Mechanisms are taught; measurements are attributed. The
capstone's final question is what a proof-of-concept would have to measure, and
what result would change the recommendation.

**Every lesson carries a `takeaway`** — one number the reader can carry into a
meeting — and the test suite enforces it. Read them as a single list
(`takeaways()`); that list is the real syllabus.

**The rooms are the design bet.** If the objection trees ever read as a quiz in
costume, the architecture half loses its claim. The test for whether they work:
change one number in a dossier and a different objection must appear.

## Build state

`npm run report` is authoritative. Current:

- **C0 The Scan Contract is complete** — 5/5 lessons, ending in a scan budget
  handed to the scan desk.
- **The empirical tier works.** duckdb-wasm runs in the tab; the `scan-bill` lab
  measured 18.7× projection, 95% of row groups pruned, and the same query
  reading 39.8× more bytes once the rows were written in a different order.
  Those numbers are asserted against a real DuckDB engine in
  `tests/duckdb-sql.test.ts`, not quoted from memory.
- **Forge lab 01 `encodings` is gradeable end to end** — template red, solution
  green, wasm verified headless over the real ABI, zip ships templates only.
- **The Warehouse v0 runs** four deterministic traces against a layout you
  control, with a reference layout to diff against.
- **Machinery ahead of content, deliberately:** 5/5 rooms (21 objections), 5/5
  drills, 8/8 desk specs. Desk *reference models* are not built yet.
- **Outstanding: 49 lessons, 5 forge crates, 5 duck labs, 7 browser labs, 8 desk
  models.**
- **Verified:** `npm run verify` clean — lint, typecheck (including tests and
  scripts), production build, 100 tests.

See the RESUME POINT in `PLAN.md` for what is next and in what order.

### Known limitations

- **Deep links answer 404 (status only).** GitHub Pages has no SPA rewrite, so
  `/lesson/c0.l1` is served as `404.html` — the body is the full app and React
  Router renders the right page, but the HTTP status is 404. Browsers do not
  care; crawlers and strict HTTP clients do. `llms.txt` therefore points agents
  at `/lessons-md/*.md`, which return 200 and are cleaner to ingest. Moving to
  hash routing would fix the status at the cost of uglier URLs; it has not been
  judged worth it.
- **Desk reference models are specs, not implementations.** The eight desks
  publish their decision, submission shape and graded checks, and the A-track
  lessons are written against them, but the grading models are not built yet.
- **The rooms are a study surface until the dossier editor lands.** Every
  objection is visible with its outcomes; the predicates that decide which ones
  *fire* are implemented and tested, but there is no submission form yet.
- **DuckDB labs need network on first run.** The engine is fetched from jsDelivr
  rather than vendored, so the deploy stays small. The lessons' arithmetic stands
  without the labs; the labs exist to let you falsify it.
