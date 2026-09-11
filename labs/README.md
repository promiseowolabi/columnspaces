# columnspaces forge — local labs

Real Rust. Your machine. Zero servers.

Each lab is a small crate. You edit exactly one file (marked `TODO(you)`),
prove it with `cargo test`, compile it to WebAssembly, and drop the `.wasm`
onto the lab page — the site runs the **same checks** and records your
completion. No account, no upload of your code, nothing leaves your machine.

## The three lanes

**Lane A — your own machine (fastest if you have Rust)**

```sh
rustup target add wasm32-unknown-unknown   # one time
cd encodings
cargo test                                  # red → green
cargo build --release --target wasm32-unknown-unknown
# drop target/wasm32-unknown-unknown/release/encodings.wasm
# onto the lab page
```

Don't have Rust? `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
(Windows: https://rustup.rs)

**Lane B — VS Code Dev Containers (zero local setup)**

Open this folder in VS Code → "Reopen in Container". The image has the
toolchain and the wasm target preinstalled. Then the Lane A commands.

**Lane C — GitHub Codespaces (zero machine)**

Open the columnspaces repository in a Codespace — the repo's `.devcontainer`
gives you the same environment.

## The loop

1. **Read the brief** on the lab page.
2. **Edit the one file** with `TODO(you)` markers. Nothing else.
3. `cargo test` until every check is green. The terminal and the site run the
   identical suite — if it's green here, it's green there.
4. **Build the wasm** (`--release`, target `wasm32-unknown-unknown`).
5. **Drop the `.wasm` onto the lab page.** It runs in your browser, in a
   sandbox, against the same checks. All green → lab complete.

A `todo!()` left in your code makes the module trap — the site shows
"not implemented yet". That's a feature, not a bug.

## Labs

| # | lab | track | you build |
|---|-----|-------|-----------|
| 01 | `encodings/` | C1 | four codecs — dictionary, RLE, bit-packing, frame-of-reference — that round-trip byte-exact and never expand past their header bound |
| 02 | `zone-maps/` | C2 | block statistics and a pruning planner, graded on **zero false negatives** under every predicate shape |
| 03 | `vectorized/` | C4 | selection vectors, a batched filter and a hash aggregate — plus the execute-on-compressed path that must agree with decoding first |
| 04 | `parquet-reader/` | C3 | a footer parser and column-chunk reader over **KSPQ**, a Parquet-*shaped* teaching format the harness generates (not Parquet itself — the omissions are listed in the template): projection touches only the chunks you asked for, malformed input is refused |
| 05 | `merge-on-read/` | C5 | a delta store, a merge and a compaction policy, graded on read- and write-amplification bands |
| 06 | `shuffle/` | C6 | a partitioned hash join with skew handling: bytes moved in band, no partition allowed to run away with the job |

Labs build on each other like real life: lab 03's executor runs over the
encodings from 01 and the statistics from 02 — the templates say what to bring
forward.

## Two invariants worth naming before you start

**A false negative is a correctness bug; a false positive is only a bill.**
Lab 02's `no_false_negatives` check is the one that cannot be argued with. A
planner that skips a block containing a matching row returns wrong answers
silently, and silent wrong answers in an analytics platform become numbers in
somebody's report.

**Cost is a count, never a clock.** Every check that measures anything measures
bytes, files, requests or operations. A count means the same thing on your
laptop and in CI, which is why these labs are gradeable at all.

## How grading works (honesty box)

The checks live in `src/lib.rs` of each lab — read them, that's allowed. The
site trusts the module you drop; this is the honour system, like every problem
set you have ever done. Your portfolio artifact is the repo with your commit
history, not our database.

## Don't lose your work

**Your code → git.** On day one, inside the unzipped folder:

```sh
git init && git add -A && git commit -m "lab 01: template"
# then one commit per green check:
#   git commit -am "dict_roundtrip green"
```

That repo — with its commit history — IS your portfolio artifact.

**Your progress → JSON snapshot.** Everything the site tracks lives in your
browser's localStorage. Export a snapshot anytime from the **Progress page →
data ownership → Export**, and re-import it on any device.
