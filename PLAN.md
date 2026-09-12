# COLUMNSPACES — build plan, design, and resume state

> Pre-build plan. Written 2026-09-11. Course #5 in the series, after
> kernelspace (the machine), byzantine (the network), tablespace (the data at
> rest) and vectorspace (the decision). This file is the single source of
> truth; once the build starts, keep the RESUME POINT at the bottom current
> (the tablespace/byzantine pattern).

## Mission

Take an engineer who has *used* a warehouse — Snowflake, BigQuery, ClickHouse,
Databricks, a Parquet lake — and make them someone who can **build the
columnar layer, measure it, and then architect a platform on it**. Two halves,
deliberately:

1. **The engine half (C0–C7).** Encodings, layout, pruning, table formats,
   vectorized execution, the write path, shuffle. Built, not described: Rust
   forge labs graded in the browser, plus DuckDB-wasm labs where the point is
   *measure it, do not believe me*.
2. **The architecture half (A1–A2).** The layer tablespace does not have:
   reference architectures, sizing models, tenancy, ingest topologies,
   governance, query SLOs, capacity, chargeback, DR, migration, build-or-buy.
   Graded by **desks** (numeric, tolerance bands) and **rooms** (adversaries
   who attack the numbers *you* submitted) — the vectorspace machinery, in the
   tablespace shell.

The deep-dive subject is **VAST DataBase**. We do not have a VAST cluster, and
pretending otherwise would be the one unforgivable thing a course like this can
do. So VAST is taught as a **named architecture against a hands-on proxy**:
DuckDB and ClickHouse are what you run, VAST is what you map onto — every claim
dated, sourced to VAST's own public documentation, and quarantined in a
`vendor` block (the vectorspace rot rule, §6).

Platform: **fork tablespace**. Same lesson engine, same block system, same
zero-dep wasm lab ABI (`kslab`, crate name kept verbatim), same pack pipeline,
same zero-server constraints, same progress store.

## Naming, domain, repo

- Course name: **columnspaces**. Directory
  `/home/promise/Work/public_learning/columnspaces`.
- Repo: `github.com/promiseowolabi/columnspaces` (personal account).
- **No `naigap` reference survives anywhere.** That domain is not ours. The 14
  files that carry it in the tablespace fork are enumerated in §10 and all of
  them are rewritten or deleted, not merely edited around.
- Deploy: **GitHub Pages project site** →
  `https://promiseowolabi.github.io/columnspaces/`. The shell already supports
  this: `vite.config.ts` reads `VITE_BASE`, and `main.tsx` passes
  `import.meta.env.BASE_URL` to the router `basename`. The workflow sets
  `VITE_BASE=/columnspaces/`; `public/CNAME` is deleted, not rewritten.
- Absolute URLs appear in exactly one place (`public/llms.txt`, which needs
  them to be useful to an agent). They are generated from a single constant, so
  moving to a real domain later is a one-line change.

## Why this subject

The series criterion: a physics layer professionals use daily but cannot reason
about, with no browser-native, build-it-yourself courseware.

- **Everyone is on a column store and almost nobody knows the layout.** The
  default analytics stack in 2026 is Parquet-shaped: object storage, an open
  table format, a vectorized engine. Engineers write SQL against it, are billed
  by bytes scanned, and tune by folklore — "add a partition", "cluster on
  customer_id" — without the arithmetic that says whether it will help.
- **The billing model makes the physics financial.** Consumption pricing means
  bytes-scanned is a line item on an invoice. A course that teaches pruning
  teaches cost control, which is why the architecture half is not a bolt-on.
- **Series gap.** tablespace T7 (`columnar-the-other-layout`,
  `vectorized-execution`, `how-the-optimizer-searches`, plus `labs/columnar`)
  is three lessons and one lab — an *appetiser* that establishes the NSM/DSM
  split and stops. Everything past "columns compress well" is unbuilt: real
  encodings, Parquet's actual footer, Iceberg's metadata tree, merge-on-read,
  shuffle, and the entire architecture layer. columnspaces is that course.
  **We deliberately re-derive nothing from T7; we cross-link to it.**
- **VAST is a genuinely different point in the design space** — shared-
  everything rather than shared-nothing MPP, NVMe over fabric, a persistent-
  memory write buffer ahead of columnar conversion — which makes it the ideal
  contrast subject for a course whose spine is "layout is a cost model".
  Teaching it against DuckDB and ClickHouse produces understanding that
  survives the next product cycle.

## The formula (inherited, do not re-litigate)

1. **Isomorphic teaching** — every idea mapped onto something the reader
   already owns (a zone map ≡ a covering index you never maintain; a dictionary
   column ≡ a foreign key to a lookup table, inlined; merge-on-read ≡ LSM
   compaction with a schema; a shuffle ≡ a GROUP BY that must cross a network;
   Iceberg's snapshot tree ≡ git for tables; VAST's SCM write buffer ≡ a WAL
   that also answers queries).
2. **Sims as truth machines** — bytes-scanned, pruning ratio, compression
   ratio, shuffle volume: made visible.
3. **Local-only labs, browser-graded** — the zero-dep wasm ABI
   (`ks_alloc`/`ks_free`/`ks_run`/`ks_invoke`, crate stays `kslab`);
   `cargo test` ≡ site checks; traps render as "not implemented yet".
4. **One file the student edits per lab** (`src/<name>.rs`); harness in
   `src/lib.rs`; deterministic xorshift rng; "bring your previous lab forward".
5. **A persistent world** — The Warehouse (below).
6. **Calibrated adversarial scenarios** — pruning collapse, small-file storms,
   skewed shuffles: thresholds proven against baselines, never guessed.
7. **A capstone that executes claims** — the platform decision recomputed from
   the student's own measurements.
8. **Agent-native tutoring** — `llms.txt`, per-lesson markdown export,
   `AGENTS.md` in every lab zip.
9. **Zero-server, local-first** — honour system, exportable progress, git as
   the backup.

New to this course, inherited from vectorspace rather than tablespace:

10. **Judgement is graded by adversaries, not by essays.** Desks take numbers;
    rooms attack the numbers you submitted, via pure predicates over a
    dossier. Deterministic, personal, diagnostic. If the objection trees ever
    read as a quiz in costume, the architecture half has failed.
11. **The rot rule.** No vendor-specific fact appears loose in prose — not a
    price, not a default, not a limit. It lives in a `vendor` block with the
    month it was *verified*, or it does not appear. **No prices, ever**, only
    pricing *shapes*.

## The two engines, and the honest framing

**DuckDB (via duckdb-wasm) is the hands-on engine.** It is a real columnar
engine that runs in the tab, speaks Arrow, and reads Parquet — so a lesson can
say "run this and read the number" instead of "trust me". Constraints accepted:
it is a multi-megabyte lazily-loaded chunk (route-level lazy only; first-paint
JS must stay at tablespace's ~60kB), Parquet fixtures must be downsampled hard
(the trace discipline), and we target the non-threaded bundle because GitHub
Pages cannot set cross-origin-isolation headers.

**ClickHouse is the distributed contrast**, taught from documentation and
architecture rather than run in-page: MergeTree, sparse primary indexes,
shared-nothing sharding. It exists in the course to keep DuckDB's
single-process simplicity from being mistaken for the general case.

**VAST DataBase is the deep-dive subject, taught as isomorphism.** Every VAST
lesson has the same shape: *here is the mechanism you just built and measured;
here is what VAST does instead; here is the physics that explains the
difference; here is what it means for your architecture.* Mappings the course
is built on (each to be confirmed against the sources in §11 before it ships):

| what you build / measure | VAST's answer | where |
|---|---|---|
| Parquet row groups + zone maps on local flash | tabular data on a shared all-flash namespace reached over NVMe-oF | C0, C2 |
| dictionary / RLE / FOR codecs you write | VAST's columnar chunk encoding | C1 |
| delta store + merge-on-read | writes landing in persistent memory, then converting to columnar chunks | C5 |
| Iceberg copy-on-write's row-group rewrite penalty | fine-grained update path | C5 |
| ClickHouse shard-owns-a-slice | DASE: storage and all metadata shared by every compute node | C6 |
| Arrow as the interchange boundary | the Python SDK / Arrow-facing query path | C7 |
| your own sizing and TCO desks | what disaggregation does to a capacity plan | A1, A2 |

Two rules keep this honest: **we never claim a measured VAST benchmark result**
(we have no cluster; any number is theirs, cited, and labelled as theirs), and
**we never rank products** — we name mechanisms and price them.

## Curriculum map — C0–C7 + A1–A2 + capstone (54 lessons)

Audience entry: writes SQL, has seen a query plan, has been surprised by a
warehouse bill. tablespace is a recommended sibling, not a prerequisite.

### The engine half

- **C0 The Scan Contract (5).** Bytes-scanned as the only honest metric; NSM vs
  DSM arithmetic (cross-link tablespace T7.L1, do not re-derive); the
  disaggregated cost model — local NVMe vs NVMe-oF vs object storage, and what
  each does to a scan; why "the network is the new disk" is a claim you can
  cost; the first DuckDB-wasm measurement.
- **C1 Encodings (5).** Dictionary, RLE, bit-packing, frame-of-reference/delta,
  FSST for strings; null representation; execute-on-compressed; choosing a
  codec from a column's statistics; where compression ratio lies to you.
- **C2 Layout & Pruning (6).** Row groups and column chunks; min/max zone maps;
  bloom filters; sort keys vs partition keys (the most expensive confusion in
  the field); clustering depth; the pruning-ratio metric; why a high-cardinality
  partition column is a small-file generator.
- **C3 Table Formats (5).** Parquet on disk, byte by byte, including the footer;
  ORC in contrast; Iceberg's metadata tree and snapshot isolation over object
  storage; Delta's log; compaction and expiry as *mandatory* operations.
- **C4 Vectorized Execution (5).** Column-at-a-time vs tuple-at-a-time (cross-
  link T7.L2); selection vectors and late materialization; hash aggregation on
  batches; SIMD and what the compiler will and will not do for you; morsel
  parallelism.
- **C5 The Write Path (5).** Why column stores hate updates; write buffers;
  delta stores; merge-on-read vs copy-on-write and the arithmetic that picks
  one; small-file amplification; the freshness/cost curve. **The VAST-densest
  track.**
- **C6 Distributed Analytics (5).** Shuffle as the fundamental cost; broadcast
  vs partitioned joins; skew; shared-nothing vs shared-disk vs
  shared-everything; what disaggregation buys and what it costs; elasticity.
- **C7 Semi-structured & Vectors (4).** Nested/JSON shredding; schema
  evolution's on-disk truth; Arrow as the boundary object; vectors living in a
  columnar table (cross-link tablespace T6 and vectorspace).

### The architecture half

- **A1 Solution Architecture (7).** From requirements to a reference
  architecture; the data-layout design document; the sizing model; multi-
  tenancy in a warehouse; ingest topologies (batch, CDC, streaming) and their
  freshness budgets; migration and coexistence; build-or-buy computed.
- **A2 Platform Engineering (7).** The catalog as the control plane; schema
  evolution as a contract with consumers; automating compaction/lifecycle;
  observability and the query SLO; capacity planning and chargeback; DR,
  time travel, and what backup means when the table is a manifest tree; day-2
  runbooks and the on-call surface.

### Capstone

**The Platform Decision.** The student's own measurements — their compression
ratios, their pruning ratios, their shuffle volumes, their desk submissions —
are recomputed into one platform recommendation and defended in every room.
Graded on whether the recommendation survives the measurements, not on which
recommendation it is. Includes an explicit "where would VAST change this
answer, and what would you need to test on a real cluster to confirm it"
section, because that is the honest ending for a course taught without one.

## Lab arc

### Forge labs (Rust → wasm, invariant-graded)

| # | slug | student builds | graded on |
|---|------|----------------|-----------|
| 01 | `encodings` | dictionary + RLE + bit-packing codecs | byte-exact round-trip on adversarial columns (all-null, all-distinct, single-value, zipf); compression ratio in a band; no codec ever expands past a bound |
| 02 | `zone-maps` | block statistics + a pruning planner | **zero false negatives, ever** (skipping a block that held a match is a correctness bug); pruning ratio in a band vs reference; correctness under NULLs and open-ended predicates |
| 03 | `vectorized` | selection vectors, filter, hash aggregate over batches | results identical to a scalar reference over 2000 seeded batches; execute-on-compressed path agrees with the decoded path; batch-boundary edge cases |
| 04 | `parquet-reader` | footer parse + column-chunk reader | reads a fixture written by real Parquet; rejects malformed footers instead of guessing; projection reads only the chunks it needs (counted, not timed) |
| 05 | `merge-on-read` | delta store + merge + compaction policy | read-your-writes; merge output ordered and duplicate-free; write-amplification and read-amplification within bands under seeded update storms |
| 06 | `shuffle` | partitioned hash join + skew handling | join results match reference; bytes-shuffled within band; a deliberately skewed key does not exceed a per-partition bound |

Conventions carried verbatim from tablespace: harness-side determinism (seeded
xorshift, `BTreeMap` models — never `HashMap` on wasm), one student-edited
file with `todo!()` bodies, `tests/<edit>_tests.rs` mirroring the checks,
solutions in gitignored `labs/_solutions/`, `pack-labs.py` ships templates
only, check ids matching `src/data/labs.ts` verbatim, red/green gate per lab.

### DuckDB-wasm labs (empirical, in-page)

| lab | track | you do |
|---|---|---|
| `scan-bill` | C0 | run the same query over row-shaped and column-shaped fixtures; read actual bytes and rows scanned; find where the layouts cross |
| `codec-bench` | C1 | encode real columns; compare your predicted ratio against DuckDB's actual |
| `pruning-lab` | C2 | change sort key and row-group size; watch row groups pruned move; hit the point where more partitions make it worse |
| `parquet-anatomy` | C3 | inspect a real footer and per-chunk statistics; corrupt one and watch the reader refuse |
| `snapshot-lab` | C3 | time-travel a table; see what a rewrite actually rewrote |
| `skew-lab` | C6 | build a skewed join and find the partition that ruins the wall clock |

### Browser labs (TypeScript, conceptual + desks)

`layout-designer` (C2), `merge-policy` (C5), plus the A1/A2 desks below.

### Desks (numeric, tolerance bands) — the architecture half

| desk | level | decision |
|---|---|---|
| `scan-desk` | 300 | What will this workload scan per day, and what does that cost in the pricing shape you are on? |
| `layout-desk` | 300 | Which sort/partition/cluster design, and what pruning ratio do you promise? |
| `ingest-desk` | 400 | Which ingest topology meets the freshness requirement without a small-file problem? |
| `tenancy-desk` | 400 | How do N tenants share tables, compute and a catalog without breaking isolation or cost attribution? |
| `compaction-desk` | 400 | What compaction and expiry policy keeps read amplification bounded, and what does it cost to run? |
| `capacity-desk` | 500 | What does this platform need over 24 months, and what breaks first? |
| `tco-desk` | 500 | Managed warehouse vs engine-on-your-own-storage vs an appliance-class platform, three years, labour costed. |
| `dr-desk` | 500 | What is the RPO/RTO, and what does "restore" mean when the table is a manifest tree? |

Graded in **bands** against reference models, never against a magic number:
a sizing model is not correct, it is within tolerance and honestly caveated.
Cost is always a **count** (bytes, files, partitions, engineer-months) — never
wall-clock. **No prices hardcoded anywhere**; rates are caller-supplied.

### Rooms (adversarial review) — five, full objection trees

| room | adversary | attacks |
|---|---|---|
| `the-cfo` | finance | the bytes-scanned bill, the growth term, the utilisation |
| `the-principal` | hostile staff engineer | your layout choice, your pruning claim, your benchmark method |
| `the-steward` | data governance / protection | retention, erasure, lineage, residency, audit evidence |
| `the-consumer` | analytics/ML lead who depends on you | freshness, schema stability, query SLO, the on-call story |
| `the-vendor` | account executive | lock-in, exit cost, the proof-of-concept you are about to run |

Every objection is a pure predicate over the dossier. The test that they work:
change one number in your dossier and a different objection must appear.
`the-vendor` carries the VAST-specific pressure — including the objection that
matters most here: *"you have never run this on our hardware; what exactly
would your POC measure?"* A student who can answer that has learned the real
lesson of a course taught without a cluster.

## The persistent world — The Warehouse

`Engine.tsx` → `Warehouse.tsx`. One columnar platform assembled cumulatively
from the student's own artifacts, driven by a deterministic query trace:

- Visible metrics: **bytes scanned, pruning ratio, compression ratio, files
  touched, bytes shuffled** — every one a count, replayable, diffable against
  the reference.
- Trace modes (all local, all licensed, all downsampled to a few hundred KB of
  JSONL in `public/traces/`): a **dashboard** workload (narrow, repetitive,
  prunable), an **ad-hoc analyst** workload (wide, unpredictable, the pruning
  killer), an **ingest+update** stream (the merge-on-read adversary), and a
  **skewed join** workload.
- Divergence between the student's engine and the reference is visualised
  per-block, the tablespace Engine pattern.

## Drills — Column Week

`/drills`, the tablespace incident-card pattern: static telemetry, graded
WRONG/CORRECT, no wasm needed.

1. **Pruning collapse** — a dashboard query's scan bill triples overnight.
   Diagnose from partition statistics: an upstream change made the sort key
   non-clustered. Name the fix *and* what it costs to apply.
2. **Small-file storm** — streaming ingest at one-minute batches; metadata
   overhead now dominates. Read the file-size histogram; pick the intervention.
3. **The skewed shuffle** — one partition holds 40% of the rows; the p99 is a
   single worker. Find it from per-partition byte counts.
4. **The silent schema change** — a nullable column added upstream; a consumer
   started reading zeros instead of failing. Trace it through the metadata.
5. **The disaggregation surprise** — a workload that was fine on local NVMe
   degrades over the fabric. Reason about where the bytes are and which
   operator became network-bound. *(The VAST-adjacent drill: the physics is
   real and reasonable without a cluster.)*

## Execution phases

1. **Fork + rebrand.** Copy tablespace → columnspaces (done); strip every
   `naigap` reference (§10); swap registries (`tracks.ts` C0–C7 + A1–A2,
   `labs.ts` empty, lessons skeleton, `browser-labs.ts`, `drills.ts`,
   progress counts); `Engine.tsx` → `Warehouse.tsx` stub; add `desks/` and
   `rooms.ts` from the vectorspace pattern plus `DeskPage`/`RoomPage` routes;
   de-tablespace strings (CommandPalette, badges, footer, Home, index.html);
   GitHub Pages project-site deploy workflow. **Gate: `npm run build` clean,
   `npm run lint` clean, zero `naigap` hits, zero `tablespace` hits outside
   deliberate cross-links.**
2. **The spine.** `CONTENT-SPEC.md` (the authoring contract — tablespace has
   none; vectorspace does, and the architecture half needs it); C0 lessons;
   the DuckDB-wasm harness + `scan-bill`; forge lab 01 `encodings`; The
   Warehouse v0 with the dashboard trace.
3. **Engine half, part 1.** C1–C2 lessons; forge labs 02–03; `codec-bench`,
   `pruning-lab`; drills 1–2.
4. **Engine half, part 2.** C3–C4 lessons; forge lab 04; `parquet-anatomy`,
   `snapshot-lab`.
5. **The write path and the network.** C5–C7 lessons; forge labs 05–06;
   `skew-lab`; drills 3–5. VAST vendor blocks verified against §11 in one pass.
6. **Architecture half.** Desk reference models first (they are testable
   without any UI), then A1–A2 lessons against them, then the five rooms, then
   the capstone. This order is deliberate: a lesson may only promise what a
   desk actually grades.
7. **Pack, verify, ship.** `pack-labs.py` all zips (templates only — verify!);
   headless ABI verify every lab; `llms.txt` + per-lesson markdown export
   regenerated; e2e route check; deploy to Pages.

## Honest risks (named now, not discovered later)

- **The VAST half is documentation-based.** We have no cluster. Mitigation:
  every VAST claim in a dated `vendor` block with a source URL; mechanisms
  described, never benchmarked by us; the capstone explicitly asks what a POC
  would measure. The risk we accept: some product-specific detail will be stale
  within a year. The mitigation is that the *mechanism* teaching survives it,
  and the refresh queue is machine-printed.
- **duckdb-wasm bundle weight.** It can undo tablespace's first-paint work.
  Mitigation: route-level lazy, never imported from a lesson registry module,
  and a build-size assertion in the verify script.
- **Parquet fixtures are binary artifacts in git.** Mitigation: generated by a
  checked-in script, kept to tens of KB, regenerable.
- **Desk bands are self-consistent by construction.** Inherited limitation
  from vectorspace: they are calibrated against the reference models, not
  against real learners producing correct-but-different reasoning. Document it;
  do not pretend otherwise.
- **Two audiences in one course.** The engine half wants a systems programmer;
  the architecture half wants an architect. Mitigation: the halves are
  navigable independently, the A tracks state which C lessons they assume, and
  the capstone is the only place both are required.
- **Scope.** 54 lessons, 6 forge labs, 6 DuckDB labs, 8 desks, 5 rooms, 5
  drills, one sim. Larger than tablespace. Phases 2–7 are independently
  shippable; the course is useful at the end of phase 3.
- **No `bun` and no `wasm32` std on this machine.** npm replaces bun (scripts
  updated); native `cargo test` is the red/green gate until the wasm target is
  installed. Installing it needs rustup or a system package — **ask before
  touching the system toolchain.**

## Verified local toolchain facts (2026-09-11)

- `node` v25.2.1 + `npm` via mise; **no `bun`** — all scripts and docs use npm.
- `cargo`/`rustc` 1.98.1 (Arch system rust), `wasm32-unknown-unknown` std
  **not installed**; no `rustup` on PATH.
- `python3` present (`scripts/pack-labs.py` runs).
- `gh` CLI present (2.100.0) — remote creation possible on request.
- `git` present. The fork has **no remote yet**; target
  `github.com/promiseowolabi/columnspaces`, default branch to match the
  workflow trigger (tablespace uses `master`).

## §10 — the de-naigap checklist

Files in the fork that carried `naigap` (14, 59 hits) and their disposition:

| file | action |
|---|---|
| `public/CNAME` | **deleted** (excluded from the fork) |
| `.github/workflows/deploy.yml` | rewritten for a project site (`VITE_BASE`), comment removed |
| `public/llms.txt` | regenerated from the new base URL constant |
| `public/lessons-md/*.md` | **deleted** (excluded); regenerated by the export script |
| `scripts/export-lessons-md.ts` | base URL becomes a constant, no domain literal |
| `labs/AGENTS.md` | rewritten for columnspaces, GitHub Pages URL |
| `labs/README.md`, `README.md`, `SUBMISSIONS.md`, `EXPANSION.md` | rewritten |
| `PLAN.md` | this file |

Verification: `grep -ri naigap .` returns nothing, and it is a phase-1 gate.

## §11 — VAST sources (to verify every vendor block against)

Primary, public, first-party:

- VAST Database Overview — `support.vastdata.com/hc/en-us/articles/11910669291548-VAST-Database-Overview`
- VAST DataBase Architecture white paper (PDF, `assets.ctfassets.net/…/WP-VAST-DataBase-Architecture_VAST-Data.pdf`)
- VAST Data Vector Database white paper (PDF, 06/25 v1.0)
- "DataBase Feature: Transactional & Analytical Support" — `vastdata.com/features/transactional-and-analytical-support`
- DASE explainers — `vastdata.com/blog/the-future-of-hpc-storage-is-dase`,
  `vastdata.com/blog/vasts-datastore-and-the-case-for-true-shared-everything-architecture`,
  `vastdata.com/platform/how-it-works`
- The VAST AI Operating System white paper — `vastdata.com/whitepaper`
- SDK/API docs for the Python client and the Arrow-facing query path

Locally available first-party material (already on disk, to be mined for
accuracy, **not** republished):

- `~/Work/vast/vast-ai-operating-system.pdf`
- `~/Work/vast/cosmos-labs/` — `lab3/vastdb_manager.py` and
  `lab2/vast_database_manager.py` show real `vastdb` SDK usage

Comparison sources: DuckDB docs (storage, Parquet, performance guides),
ClickHouse docs (MergeTree, sparse primary index), Apache Parquet and Iceberg
specs, and the papers the lessons teach to — C-Store (VLDB '05), MonetDB/X100
(CIDR '05), Abadi et al. on column-store architecture, Dremel (VLDB '10) for
nested shredding, and the Iceberg/Delta design papers.

## RESUME POINT

**THE COURSE IS COMPLETE (2026-09-12).** 54/54 lessons, all machinery built, 622
tests, CI green, deployed at `https://promiseowolabi.github.io/columnspaces/`.

Built in five waves, each verified before the next: phase 1 (fork, registries,
contracts), phase 2 (the spine — CONTENT-SPEC, the duckdb tier, C0, forge lab 01,
the Warehouse), wave A (C2 + zone-maps), wave B (C3/C4 + two forge labs), wave C
(C5/C6/C7 + the last two forge labs), wave D (8 desk models + the room encounter),
and the final wave (A1/A2, the capstone, the last three browser labs, a
publication audit).

### What the build kept catching, and why that is the point

Every wave produced at least one finding that changed the content rather than
merely passing a gate, which is the only evidence that the machinery is real:

- **The SQL was wrong.** `hash()` returns UBIGINT and `array_extract` needs
  BIGINT — the fixture generator would have failed on first run in a browser.
- **The lesson overstated compression.** Measuring showed 1.4× on the fixture's
  three projected columns because synthetic random revenue is near the worst
  case, so C0.L1 was corrected and the lab now tells the reader not to read a
  ratio off it.
- **A writer does not do what a format defines.** DuckDB emits `PLAIN` for
  `TIMESTAMP`, so a monotone timestamp compresses ~1.1× where frame-of-reference
  arithmetic predicts ~3×. C1.L1 now sets the reader up to expect the lab to beat
  the lesson on that column, and a test pins the writer behaviour.
- **`labs.ts` overclaimed.** Lab 04 reads a Parquet-*shaped* teaching format, not
  Parquet; the copy said "a genuine Parquet footer".
- **Value corruption is silent.** Truncating a file is refused with the engine's
  own error; flipping one byte inside a chunk returns 131,072 rows and a wrong
  aggregate, because page CRCs are optional. C3.L2 is built on that asymmetry.
- **Two desk models were wrong.** Compaction needed an explicit scope fraction
  (it reported ~18× where C5 measures 2.11×), and read-amp had to be banded on
  the overhead rather than the ratio.
- **Registering all 54 lessons broke the bundle budget** — reading a list of
  titles downloaded 1352 kB of prose. Fixed by a generated metadata manifest
  (39 kB), and the test was rewritten so the cosmetic fix is impossible.
- **A publication blocker, invisible in dev.** Root-absolute public paths ship
  verbatim, so every forge-lab download 404'd under the `/columnspaces/` base
  while all six zips sat correctly on disk. `dev` serves from `/`, so it worked
  locally. Fixed with `src/lib/asset.ts` and pinned by test.
- **Generated-and-committed files rot silently.** C1's markdown 404'd in
  production because the export was never re-run. Now `npm run export` runs
  inside `verify` and in CI, with freshness guards for both the agent surface and
  the manifest.

### The two gaps that were worth closing, and what closing them found

**Desk submission forms.** The eight models were graded by 115 tests before a
learner could submit to them, which was the widest gap between what the
architecture half claimed and what it did. Now: a per-desk field registry
(prose labels, entry units, and for the discipline terms the check id that fails
on a blank), a form that assembles the model's nested submission from flat
inputs, the report rendered check by check in the model's own diagnostic words,
persistence in the existing snapshot, and an explicit action to copy a passing
result into the dossier — so the rooms attack numbers the learner actually
produced, which is the arc the architecture half is built on. 172 new tests,
including registry coverage in both directions so a model change cannot create
an unfillable form.

**Real browser verification, which is the one that paid.** Six DuckDB labs rest
on duckdb-wasm instantiating from a CDN through a blob worker, and no test had
ever executed that path — they all mock the client against native DuckDB. Driving
it in Chromium found **two bugs that made labs fail for every reader while 794
tests stayed green**:

1. `scan-bill` died with an out-of-memory on first run. The engine was fine; the
   fixture was not. duckdb-wasm reports a ~3.1 GiB limit that covers the buffer
   manager but not the in-memory virtual filesystem, and building two 2M-row
   relations reached 1.8 GiB before a file was written. Fixed by making both
   relations views so each COPY streams, sorting an 8-byte row index instead of
   360-byte rows (late materialization — the subject of C4.L3), dropping to
   500,000 rows, and vector-aligning the row-group sizes, because asking for
   2,500 silently yielded 4,096 and made the "10× finer" file only 5× finer.
2. `parquet-anatomy` died with a binder error. duckdb-wasm 1.32.0 embeds DuckDB
   1.4.3, whose `parquet_schema()` has no `column_id`; the unit suite runs 1.5.5
   natively, so the query was valid there and invalid in every reader's browser.
   No test referenced it, so it had never executed anywhere.

Because the fixture changed scale, the numbers three C0 lessons quoted were no
longer what a reader would see. They now quote the browser-measured values —
**19× projection, 96% pruned, 1,103× total, 64× more bytes shuffled** — verified
first-hand by `npm run e2e`, which prints them.

`.github/workflows/browser.yml` runs this weekly, on demand, and on any change to
the duckdb layer, driving all six labs. It is deliberately outside the deploy
gate: blocking a deploy on somebody else's CDN is the wrong trade, but leaving
the path unverified is worse.

### Known limitations (documented, not hidden)

- **No VAST cluster.** Every VAST claim is a dated, sourced `vendor` block
  describing a mechanism; no performance figure in this course was measured by
  us. The capstone's final deliverable is a proof-of-concept plan, and the vendor
  room's severity-3 objection grades whether the reader can name one.
- **Deep links answer HTTP 404** (correct page in the body) — GitHub Pages has no
  SPA rewrite. `llms.txt` points agents at `/lessons-md/`, which returns 200. The
  only fix is hash routing, which trades correct status codes for uglier URLs and
  would invalidate the published lesson URLs.
- **No DOM unit-test environment.** Components are covered by typecheck, lint,
  pure unit tests and SSR smoke renders; interaction coverage comes from the
  browser e2e instead, which asserts strictly on `scan-bill` and two desk forms
  and asserts only "ran and advanced" for the other five labs.
- **Desk bands are self-consistent by construction** — calibrated against the
  reference models, not against real learners producing correct-but-different
  reasoning. Inherited from vectorspace, and still true.

### If the series continues

The obvious next pieces, in order: desk submission forms (the largest remaining
gap between what is graded and what a learner can submit), a DOM test
environment so the labs' interactions are covered, and the leaderboard pattern
from tablespace applied to forge lab 06's skew bound — a public board for the
best `bytes_shuffled` on a fixed skewed plan would be the natural competitive
surface for this subject.
