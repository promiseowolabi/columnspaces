//! merge_on_read.rs — forge lab 05 · THE ONLY FILE YOU EDIT
//!
//! Mission: make an immutable, sorted, statistics-annotated base table
//! accept change — without breaking a single read, and without paying for
//! it twice.
//!
//! Labs 01–04 all assumed the bytes stop moving. That assumption is what
//! made everything work: a codec can only compress a block it can see all
//! of, a zone map is only sound because the block underneath it never
//! changes, a projection is only cheap because the column chunk sits at a
//! fixed offset. Now one row updates. You cannot edit it in place — it
//! lives inside a compressed run inside a block whose min/max would have to
//! be revised, inside a file something else may be reading right now.
//!
//! Every column store answers the same way: **accept the change somewhere
//! cheap, and reconcile on the way out.** That is a delta store plus a
//! merge on the read path. The cost you just deferred is *read
//! amplification*, and it grows with the delta until compaction pays it
//! down — by rewriting rows, which is *write amplification*.
//!
//! ═══════════════════════ THE SHAPE OF THE STORE ══════════════════════
//!
//! Four levels, newest first. A point read walks them newest → oldest and
//! stops at the first level that has an opinion about the key:
//!
//! ```text
//!   memtable      BTreeMap<Key, Entry>   the newest level; one probe
//!   runs[n-1]     newest flushed run     ascending, unique keys
//!   ...
//!   runs[0]       oldest flushed run
//!   base          Vec<BaseRow>           ascending, unique, NO tombstones
//! ```
//!
//! `ingest` (GIVEN) stages one entry per mutation and flushes the memtable
//! into a new run every `FLUSH_ROWS` distinct keys. `compact` (GIVEN) folds
//! everything into a new base. You decide *when* compaction happens; that
//! decision is the artifact this lab is really about.
//!
//! ═══════════════════════ RECENCY IS STRUCTURAL ═══════════════════════
//!
//! Newest wins, and "newest" is a position, not a comparison: the memtable
//! beats every run, `runs[i]` beats `runs[j]` for `i > j`, and any delta
//! entry beats the base. Every entry also carries the `seq` it was written
//! at, and the harness checks the `seq` you return, not only the value —
//! because a merge that returns the *right value from the wrong version*
//! passes every eyeball test and is still wrong the moment two versions of
//! a key happen to share a value.
//!
//! A tombstone is `Entry { value: None, .. }`: a positive assertion that
//! the key is gone, which must beat an older version in an older level.
//! `None` in a delta entry means "deleted"; a key with no entry anywhere
//! and no base row means "never existed". Both read as `None` from
//! `read`, and neither may appear in a merged output.
//!
//! ═════════════════════════ COST IS A COUNT ═══════════════════════════
//!
//! Two numbers, both counts, never clocks:
//!
//! ```text
//!   read amplification  = levels probed per read
//!                       ÷ 1 (what a perfectly compacted base needs)
//!   write amplification = rows rewritten by compaction
//!                       ÷ rows ingested
//! ```
//!
//! The harness charges read amplification STRUCTURALLY — `read_probes`
//! below is its cost model, and it counts the levels your policy left
//! standing, not the instructions your loop executed. You cannot write your
//! way out of it with a clever probe; you can only compact. Symmetrically,
//! write amplification is charged from the rows `compact` produces, which
//! the harness re-derives from `Store::base` itself.
//!
//! ══════════════════ THE TWO BANDS PULL OPPOSITE WAYS ═════════════════
//!
//! ```text
//!   read_amp_bounded    average levels probed per read   ≤ 6.0
//!   write_amp_budget    rows rewritten ÷ rows ingested   ≤ 5.0
//! ```
//!
//! Graded on the SAME seeded workload — one table, two bills. And the two
//! degenerate policies each fail exactly one of them:
//!
//! ```text
//!   never compact           read_amp  ~34.0   FAIL      write_amp 0.0  pass
//!   compact on every write  read_amp    1.x   pass      write_amp ~780 FAIL
//! ```
//!
//! So neither band can be satisfied by taste. The arithmetic that connects
//! them, which is the whole lesson:
//!
//! ```text
//!   write amplification ≈ base_rows ÷ delta_rows_at_the_trigger
//!   read amplification  ≈ 1 (base) + 1 (non-empty memtable) + runs
//! ```
//!
//! Compacting when the delta is 1/3 of the base costs ~3× write
//! amplification and leaves ~4 levels standing. Compacting at 1/32 costs
//! ~32× and leaves ~1. It is one knob, turned in opposite directions by two
//! bills. **Passing both bands means you found a policy rather than a
//! preference** — and a policy, unlike a preference, is a thing you can
//! hand to somebody else and have them operate.
//!
//! What the bands cannot be gamed with: a policy that keeps costs down by
//! losing data fails `read_your_writes`, `delete_semantics` and `storm`
//! first, and those are absolutes with zero tolerance. Cost is only ever
//! graded on a store that is still correct.
//!
//! ══════════════════════════ THE INVARIANTS ═══════════════════════════
//!
//! Three lines, and they are the lab:
//!
//! ```text
//!   1. read(store, k) immediately after write(store, k, v) returns v.
//!      Always. Whatever level it landed on, whatever flush or compaction
//!      the write triggered on its way in.
//!   2. merge_all(store) is strictly ascending by key, has at most one row
//!      per key, and contains a row for k iff read(store, k) is Some.
//!   3. compact(store) changes no answer — only the cost of getting it.
//! ```
//!
//! One wasm rule, carried from lab 01: BTreeMap/BTreeSet, never HashMap.
//! std's HashMap seeds itself from OS randomness that does not exist on
//! `wasm32-unknown-unknown`.

use std::collections::BTreeMap;

/// A row's identity. Sorted order in the base and in every run is ascending
/// by this.
pub type Key = u64;

/// A row of the immutable base: a key, a value, and the sequence number of
/// the write that produced it. The base holds NO tombstones — the type says
/// so, and compaction is what makes it true.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct BaseRow {
    pub key: Key,
    pub value: i64,
    pub seq: u64,
}

/// One delta entry: a version of a key. `value: None` is a TOMBSTONE — an
/// assertion that the key is deleted as of `seq`, which must beat every
/// older version of that key in an older level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub key: Key,
    pub value: Option<i64>,
    pub seq: u64,
}

/// What a point read resolves to: the visible value and the sequence number
/// of the write it came from. `None` from `read` means the key is not
/// visible — deleted, or never written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Version {
    pub value: i64,
    pub seq: u64,
}

/// A flushed delta run: entries ascending by key, at most one per key.
/// Immutable once flushed, exactly like the base — which is why a run can
/// be probed with a binary search and merged without being sorted again.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Run {
    pub entries: Vec<Entry>,
}

/// The store. Fields are public because the harness reads them: it measures
/// the SHAPE your policy leaves behind (how many runs, how many rows in the
/// base) rather than trusting a counter you maintain.
#[derive(Clone, Debug, Default)]
pub struct Store {
    /// Immutable, sorted, unique, tombstone-free. The thing every read
    /// falls through to.
    pub base: Vec<BaseRow>,
    /// Flushed runs, OLDEST FIRST. `runs[i]` beats `runs[j]` when `i > j`.
    pub runs: Vec<Run>,
    /// The newest level: the write buffer, indexed by key so that one
    /// probe answers for the whole thing however many rows it holds.
    pub memtable: BTreeMap<Key, Entry>,
    /// The sequence number the next mutation will be stamped with.
    pub next_seq: u64,
    /// GIVEN bookkeeping, for your policy to read and the harness to audit.
    pub flushes: u64,
    pub compactions: u64,
    /// Mutations ingested since the last compaction.
    pub since_compaction: u64,
}

/// GIVEN. Distinct keys the memtable holds before `ingest` flushes it into
/// a run. A flush is cheap — it writes the buffer once — so it is not what
/// write amplification measures. Compaction is.
pub const FLUSH_ROWS: usize = 64;

impl Store {
    /// GIVEN. A store over an existing base. The caller guarantees `base`
    /// is ascending by key and unique; `next_seq` continues after the
    /// newest sequence number in it.
    pub fn new(base: Vec<BaseRow>) -> Store {
        let next_seq = base.iter().map(|r| r.seq).max().map_or(0, |m| m + 1);
        Store { base, runs: Vec::new(), memtable: BTreeMap::new(), next_seq, flushes: 0, compactions: 0, since_compaction: 0 }
    }

    /// GIVEN. An empty table — no base, no delta.
    pub fn empty() -> Store {
        Store::new(Vec::new())
    }
}

/// GIVEN. Delta rows outstanding: memtable entries plus every entry in
/// every run. This is the number your policy weighs against the base, and
/// it is the numerator of the "how full is the delta" question.
pub fn delta_rows(store: &Store) -> usize {
    store.memtable.len() + store.runs.iter().map(|r| r.entries.len()).sum::<usize>()
}

/// GIVEN. Flushed runs standing between a read and the base.
#[allow(dead_code)] // for your policy to consult; the harness reads store.runs
pub fn run_count(store: &Store) -> usize {
    store.runs.len()
}

/// GIVEN. Rows in the base.
#[allow(dead_code)] // for your policy to consult; the harness reads store.base
pub fn base_rows(store: &Store) -> usize {
    store.base.len()
}

/// GIVEN — AND THIS IS THE COST MODEL. The levels a correct point read
/// must consult: every flushed run (a run cannot be ruled out without
/// probing it), the base, and the memtable when it is non-empty. A
/// perfectly compacted store answers from the base alone: 1.
///
/// The harness charges this per read. Note what it does not depend on:
/// how your `read` is written. Read amplification is a property of the
/// layout your policy produces, which is why compacting is the only thing
/// that moves it.
pub fn read_probes(store: &Store) -> usize {
    store.runs.len() + 1 + usize::from(!store.memtable.is_empty())
}

/// GIVEN. Seal the memtable into a new newest run. Ascending and unique
/// come free: the memtable is a BTreeMap keyed by key.
pub fn flush(store: &mut Store) {
    if store.memtable.is_empty() {
        return;
    }
    let entries: Vec<Entry> = store.memtable.values().copied().collect();
    store.runs.push(Run { entries });
    store.memtable.clear();
    store.flushes += 1;
}

/// GIVEN. Compaction: fold the memtable and every run into a NEW base, and
/// forget the delta. It answers no question differently — it only changes
/// what the next read costs.
///
/// Note that it is built out of YOUR `merge_all`: the merge on the read
/// path and the merge that rewrites the table are the same merge, which is
/// how a real engine keeps them from disagreeing. Rows rewritten is the
/// length of what it produces, and that is the numerator of write
/// amplification.
pub fn compact(store: &mut Store) {
    let rows = merge_all(store);
    store.base = rows;
    store.runs.clear();
    store.memtable.clear();
    store.compactions += 1;
    store.since_compaction = 0;
}

/// GIVEN. The write path, end to end: stamp a sequence number, stage the
/// entry, flush when the buffer is full, then ask YOUR policy whether to
/// compact. Returns the `seq` the mutation was stamped with, so a caller
/// can assert that a read afterwards sees exactly this version.
pub fn ingest(store: &mut Store, key: Key, value: Option<i64>) -> u64 {
    let seq = store.next_seq;
    store.next_seq += 1;
    stage(store, key, value, seq);
    store.since_compaction += 1;
    if store.memtable.len() >= FLUSH_ROWS {
        flush(store);
    }
    if should_compact(store) {
        compact(store);
    }
    seq
}

/// GIVEN. Write a value.
pub fn write(store: &mut Store, key: Key, value: i64) -> u64 {
    ingest(store, key, Some(value))
}

/// GIVEN. Delete a key — which is a WRITE of a tombstone, not the absence
/// of one. Deleting a key that was never there is legal and leaves the key
/// invisible, exactly as before.
pub fn delete(store: &mut Store, key: Key) -> u64 {
    ingest(store, key, None)
}

/* ------------------------------ your work ---------------------------- */

/// TODO(you) 1/5 — stage one mutation in the newest level.
///
/// The entry must land in `store.memtable` under `key`, carrying `value`
/// (`None` for a tombstone) and `seq`. If the key is already in the
/// memtable, the newer version replaces it: `seq` is monotonic, so the
/// incoming entry is always the newer one — the older version is
/// unreachable the instant this one lands, and keeping it would be keeping
/// a version nothing can ever see.
///
/// This is the whole "accept the change somewhere cheap" half of
/// merge-on-read: no sort, no rewrite, no statistics revised. One insert.
pub fn stage(store: &mut Store, key: Key, value: Option<i64>, seq: u64) {
    let _ = (store, key, value, seq);
    todo!("insert an Entry carrying (key, value, seq) into store.memtable at key — replacing any entry already there, because seq only ever increases")
}

/// TODO(you) 2/5 — the merge on the read path, for one key.
///
/// Walk the levels NEWEST FIRST and stop at the first one that has an
/// opinion: the memtable, then `store.runs` in reverse (newest run first),
/// then the base. The first entry found is the visible version — and if it
/// is a tombstone (`value: None`), the answer is `None`, because a
/// tombstone is an opinion. Only when no level mentions the key at all is
/// the answer `None` for the other reason.
///
/// The two bugs this function is graded against:
///   * falling through to the base (or to an older run) when a newer level
///     already answered — a read that misses the newest version of a key
///     is a correctness bug that looks like a stale cache in production;
///   * treating a tombstone as "no opinion" and continuing to search — a
///     delete that resurrects the row it deleted.
///
/// Runs are ascending and unique, so a binary search per run is the natural
/// probe. It does not change your bill (see `read_probes`) but it is what
/// the real thing does.
pub fn read(store: &Store, key: Key) -> Option<Version> {
    let _ = (store, key);
    todo!("memtable, then runs newest-first, then base; the first level that mentions the key decides, and a tombstone decides None")
}

/// TODO(you) 3/5 — the full merged view: every visible row, once, in key
/// order.
///
/// Strictly ascending by key, at most one row per key, no tombstones, and
/// each row carrying the `seq` of the newest write that produced it. It
/// must agree with `read` on every key: a row is present here if and only
/// if `read` returns `Some` for that key, with the same value and seq.
///
/// `compact` is built on this, so this is also the function that rewrites
/// your table. The classic failures are all visible in the output:
/// emitting a key twice (base row plus delta entry, both kept), emitting a
/// tombstone as a row, emitting delta entries after base rows instead of
/// merging them into one ordered stream, or keeping the base's version of a
/// key the delta has superseded.
pub fn merge_all(store: &Store) -> Vec<BaseRow> {
    let _ = store;
    todo!("merge base + runs (oldest first) + memtable so that newer levels overwrite older ones, drop tombstones, and emit ascending unique BaseRows")
}

/// TODO(you) 4/5 — the same merge, restricted to the inclusive key range
/// `lo..=hi`.
///
/// Same guarantees: ascending, unique, tombstone-free, agreeing with
/// `read`. `lo > hi` is an empty range and yields nothing — a range that
/// contradicts itself matches nothing, anywhere. `lo == hi` yields at most
/// one row, and both bounds are INCLUSIVE.
///
/// A range scan is where a merge-on-read table earns or loses its living:
/// the delta entries inside the window have to be spliced into the base's
/// order without materialising the rest of the table.
pub fn scan_range(store: &Store, lo: Key, hi: Key) -> Vec<BaseRow> {
    let _ = (store, lo, hi);
    todo!("empty when lo > hi; otherwise merge_all restricted to keys k with lo <= k <= hi, both bounds inclusive")
}

/// TODO(you) 5/5 — THE POLICY. Called after every mutation (see `ingest`).
/// Return `true` to fold the whole delta into a new base right now.
///
/// You may read anything on the store; the useful ones are `base_rows`,
/// `delta_rows`, `run_count` and `store.since_compaction`. Keep it PURE —
/// same store, same answer — because a policy that depends on hidden state
/// is a policy nobody can predict the bill of.
///
/// The trade, in the only terms that are gradeable:
///
/// ```text
///   returns false always   the delta grows without bound
///                          → read_amp_bounded FAILS   (~34 levels probed)
///   returns true always    every mutation rewrites the base
///                          → write_amp_budget FAILS   (~780× the rows)
/// ```
///
/// Between those, one knob: how full the delta is allowed to get before you
/// pay to fold it in. Compaction rewrites roughly `base_rows` rows and buys
/// back roughly `delta_rows / FLUSH_ROWS` levels, so a trigger of the form
/// "the delta has reached a fraction of the base" costs about the reciprocal
/// of that fraction in write amplification and leaves about that fraction
/// of the base, divided by `FLUSH_ROWS`, in levels.
///
/// Write the fraction down, then defend it: `read_amp_bounded` and
/// `write_amp_budget` are graded on the same workload, so a number that
/// satisfies both is a policy and anything else is a preference.
pub fn should_compact(store: &Store) -> bool {
    let _ = store;
    todo!("compare delta_rows(store) against base_rows(store) — pick the fraction deliberately, and consider a safety valve on run_count for a base that is small or empty")
}
