//! shuffle.rs — forge lab 06 · THE ONLY FILE YOU EDIT
//!
//! Mission: join two tables that do not live on the same machine, and be
//! able to say — in bytes, before you run it — what that cost.
//!
//! Labs 01–05 were about one machine: bytes read, bytes decoded, bytes
//! rewritten. Every one of those bills was paid inside a process. Now the
//! table is spread over `workers` machines and the join key does not agree
//! with the partitioning. Matching rows are on different machines, so
//! something has to move, and **bytes moved is the bill**. It is orders of
//! magnitude more expensive per byte than anything in labs 01–05, and it is
//! the one cost that no codec, no zone map and no vectorised kernel can
//! reduce, because it is not about how you read — it is about where the
//! rows are.
//!
//! ═══════════════════════ TWO STRATEGIES, ONE SUM ══════════════════════
//!
//! ```text
//!   BROADCAST     send the whole small side to every worker; the big side
//!                 never moves.
//!                 bytes = small_side_rows × ROW_BYTES × workers
//!
//!   PARTITION     hash both sides by the join key so that every row with
//!                 key k lands on the same worker.
//!                 bytes = (left_rows + right_rows) × ROW_BYTES
//! ```
//!
//! That is the whole decision, and it is arithmetic, not taste. A 1 000-row
//! dimension table against a billion-row fact table over 4 workers:
//! broadcast moves 64 KB, partitioning moves 16 GB. The same dimension
//! table over 4 096 workers: broadcast moves 64 MB, partitioning still
//! moves 16 GB — broadcast still wins. Grow the dimension table to 100 M
//! rows and it flips. `broadcast_choice` grades the decision against the
//! arithmetic on cases that flip BOTH WAYS, so a habit cannot pass it.
//!
//! ══════════════════════ WHY HASHING IS NOT ENOUGH ═════════════════════
//!
//! Hash partitioning distributes **keys** evenly. It does not distribute
//! **rows** evenly, and rows are what the work is made of. One value that
//! holds 40 % of the rows — a null-ish sentinel, an anonymous user id, the
//! default tenant — hashes to exactly one partition and takes 40 % of the
//! table with it. Sixteen workers, and one of them is doing nearly half the
//! job.
//!
//! **The largest partition is the runtime.** Not the average, not the
//! total: the largest. A job over 16 workers where 15 finish in a second
//! and one runs for a minute takes a minute. The mean tells you nothing —
//! it is the number that made you think you had scaled. This is why
//! `skew_bounded` bounds the MAXIMUM partition and why plain hashing is
//! GUARANTEED to fail it: the harness proves, for every skewed case it
//! grades you on, that a plain hash router blows the bound, and reports a
//! HARNESS BUG against itself if any case is soft enough to pass without
//! heavy-hitter detection.
//!
//! The fix is salting. A key that is too big for one partition gets split
//! across `s` buckets — and then, so that matching rows still meet, the
//! OTHER side's rows for that key must be REPLICATED to all `s` of them:
//!
//! ```text
//!   key 7: 1800 left rows, 3 right rows, s = 4
//!     left  rows  → round-robin over 4 buckets   450 each
//!     right rows  → copied into ALL 4 buckets     3 × 4 = 12 copies
//!   every (left, right) pair still meets exactly once — in one bucket.
//! ```
//!
//! Split the wrong side and you replicate 1800 rows instead of 3. Replicate
//! BOTH sides and every pair is produced `s` times and the join is simply
//! wrong. Salt every key to every partition and the skew is perfect and you
//! have shipped the whole table `partitions` times over.
//!
//! ═════════════════════ THE TWO BILLS PULL APART ═══════════════════════
//!
//! ```text
//!   bytes_shuffled   ROW_BYTES × row-copies routed, ÷ (both sides once)
//!                    ≤ 1.10 × the reference plan over the plan set,
//!                    ≤ 1.12 × on any single plan
//!   skew_bounded     max over partitions of (left rows + right rows)
//!                    ≤ partition_bound(total, partitions)  — no exceptions
//! ```
//!
//! Salting is the only knob, and the two checks turn it in opposite
//! directions. These are measured, not rhetorical — they are what the two
//! degenerate policies actually score:
//!
//! ```text
//!   never salt              bytes 1.00×  pass      skew  6.4× bound  FAIL
//!   salt every heavy key    skew  1.4× mean pass   bytes 1.24×  band FAIL
//!     across all partitions
//! ```
//!
//! Neither degenerate policy passes both, so **passing both means you found
//! a policy rather than a preference**: salt the keys that need it, by the
//! fewest buckets that gets them under the bound, splitting the side that
//! is actually big and replicating the side that is not. That sentence is
//! the artifact of this lab. Write the rule down before you write the code,
//! then check that the numbers the harness prints are the numbers your rule
//! predicted.
//!
//! Cost here is a COUNT of bytes, never a clock — same as every lab since
//! 01. A count means the same thing on your laptop, in CI, in the browser,
//! and on the cluster you are actually sizing.
//!
//! ═══════════════════════════ THE SCOPE ═══════════════════════════════
//!
//! One shape is out of scope, and the harness knows it: a key that is heavy
//! on BOTH sides. Splitting one side replicates the other into every bucket,
//! so no bucket can get below `min(left(k), right(k))` — the only bounded
//! plan is a GRID (s×t buckets, s·t copies), which this lab does not ask
//! for. So `skew_bounded` grades hand-built cases where every heavy key's
//! smaller side fits inside one average partition, and `storm` enforces the
//! bound only on the plans where it can PROVE it is reachable. Correctness
//! is enforced everywhere, on every plan, with no allowance at all.
//!
//! ══════════════════════════ THE INVARIANTS ═══════════════════════════
//!
//! ```text
//!   1. The join output is a MULTISET and it is exact. Duplicate keys on
//!      both sides produce every pair, once each. A key on only one side
//!      produces nothing. Empty inputs produce nothing. No pair may be
//!      dropped, and no pair may be produced twice.
//!   2. Every routed row is a row that was in the input. You may copy rows;
//!      you may not invent or edit them.
//!   3. Same inputs, same plan. Routing is pure — a plan you cannot predict
//!      is a plan nobody can size a cluster from.
//! ```
//!
//! Invariant 1 is an absolute with zero tolerance, and it is checked inside
//! the cost checks too: bytes and skew are only ever graded on a shuffle
//! that still produces the right answer.
//!
//! ─────────────────────────────────────────────────────────────────────
//! One wasm rule, carried from lab 01: BTreeMap/BTreeSet, never HashMap.
//! std's HashMap seeds itself from OS randomness that does not exist on
//! `wasm32-unknown-unknown`.

use std::collections::BTreeMap;

/// The join key. Rows match when their keys are equal.
pub type Key = u64;

/// One row: the join key and a payload. Fixed width, so bytes moved is a
/// row count times a constant — which is what makes the bill countable
/// instead of measurable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Row {
    pub key: Key,
    pub payload: i64,
}

/// One output row of the inner join: the key and both payloads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct JoinRow {
    pub key: Key,
    pub left: i64,
    pub right: i64,
}

/// The result of a shuffle: for each partition, the left rows and the right
/// rows that were routed to it. `left.len() == right.len() == partitions`.
///
/// This is the wire. Its total length is the bill (`bytes_moved`), its
/// longest partition is the runtime (`partition_loads`), and it is the only
/// thing `local_join` gets to see.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Shuffled {
    pub left: Vec<Vec<Row>>,
    pub right: Vec<Vec<Row>>,
}

impl Shuffled {
    /// GIVEN. `partitions` empty buckets per side.
    pub fn new(partitions: usize) -> Shuffled {
        Shuffled { left: vec![Vec::new(); partitions], right: vec![Vec::new(); partitions] }
    }

    /// GIVEN. How many partitions this shuffle was built for.
    pub fn partitions(&self) -> usize {
        self.left.len()
    }
}

/// The statistics a planner gets to see before it moves anything: how big
/// each side is, and how many workers there are. Row counts, not row
/// contents — this is what a catalog or a sample can actually tell you.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stats {
    pub left_rows: u64,
    pub right_rows: u64,
    pub workers: u64,
}

/// The two strategies. There is no third one, and there is no "it depends".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Send the small side to every worker; the big side stays put.
    Broadcast,
    /// Hash both sides by the join key so matching rows meet.
    Partitioned,
}

/// GIVEN. Bytes on the wire per row: an 8-byte key plus an 8-byte payload.
pub const ROW_BYTES: u64 = 16;

/// GIVEN. How many times the average partition's row count the LARGEST
/// partition is allowed to be. 3 is generous — it says "you may be 3× worse
/// than perfect balance" — and plain hashing still fails it by miles on a
/// skewed key. That is the point: skew is not a rounding error.
pub const SKEW_FACTOR: u64 = 3;

/// GIVEN — AND THIS IS THE COST MODEL for `skew_bounded`. The most rows
/// (left + right, routed copies included) any single partition may hold.
///
/// Perfect balance is `total / partitions`; the bound is `SKEW_FACTOR`
/// times that, rounded up. Note what it is measured over: the maximum, not
/// the mean. The mean is fixed by the input and tells you nothing about
/// whether the job finishes.
pub fn partition_bound(total_rows: u64, partitions: usize) -> u64 {
    if partitions == 0 {
        return 0;
    }
    let p = partitions as u64;
    let mean = total_rows / p + u64::from(total_rows % p != 0);
    (SKEW_FACTOR * mean).max(1)
}

/// GIVEN — AND THIS IS THE COST MODEL for `bytes_shuffled`. Bytes a
/// partitioned plan moves: both sides, once each. Every row crosses the
/// network exactly one time.
pub fn partition_bytes(stats: &Stats) -> u64 {
    (stats.left_rows + stats.right_rows) * ROW_BYTES
}

/// GIVEN. What a `Shuffled` actually cost: every routed row-copy, on both
/// sides, at `ROW_BYTES` each. Replication shows up here — that is the
/// whole reason salting is not free.
pub fn bytes_moved(shuffled: &Shuffled) -> u64 {
    let rows: usize = shuffled.left.iter().map(|b| b.len()).sum::<usize>()
        + shuffled.right.iter().map(|b| b.len()).sum::<usize>();
    rows as u64 * ROW_BYTES
}

/// GIVEN. Rows landed on each partition, both sides together. The largest
/// entry is the runtime of the job.
pub fn partition_loads(shuffled: &Shuffled) -> Vec<u64> {
    (0..shuffled.partitions())
        .map(|p| (shuffled.left[p].len() + shuffled.right[p].len()) as u64)
        .collect()
}

/// GIVEN. A 64-bit avalanche (splitmix64's finalizer). Deterministic on
/// every machine and in wasm, which `HashMap`'s hasher is not.
pub fn hash_key(key: Key) -> u64 {
    let mut z = key.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// GIVEN. The partition a `(key, salt)` bucket lands on, built on YOUR
/// `hash_partition`. Salt 0 is exactly `hash_partition(key, partitions)`,
/// and while `salt < partitions` the buckets of one key are distinct
/// partitions.
///
/// Both sides must agree about this, which is why it is one function: the
/// left row that went to bucket 2 and the right rows replicated into bucket
/// 2 have to arrive at the same worker.
pub fn salted_partition(key: Key, salt: usize, partitions: usize) -> usize {
    if partitions == 0 {
        return 0;
    }
    (hash_partition(key, partitions) + salt) % partitions
}

/// GIVEN. The local join, run independently on each partition: a hash
/// build on the right rows, a probe with the left rows, every matching pair
/// emitted once.
///
/// It can only ever see what you routed to it, so every guarantee about the
/// output is a guarantee about your routing. A pair that landed on two
/// partitions is emitted twice; a pair that was never co-located is never
/// emitted at all. Output order is unspecified — the graders compare
/// multisets.
pub fn local_join(shuffled: &Shuffled) -> Vec<JoinRow> {
    let mut out = Vec::new();
    for p in 0..shuffled.partitions() {
        let mut build: BTreeMap<Key, Vec<i64>> = BTreeMap::new();
        for r in &shuffled.right[p] {
            build.entry(r.key).or_default().push(r.payload);
        }
        for l in &shuffled.left[p] {
            if let Some(rs) = build.get(&l.key) {
                for r in rs {
                    out.push(JoinRow { key: l.key, left: l.payload, right: *r });
                }
            }
        }
    }
    out
}

/// GIVEN. The broadcast path: the small side is on every worker, so the
/// join is local everywhere and nothing has to be co-located. Correct by
/// construction — which is exactly why the interesting question about
/// broadcast is never "is it right", it is "what did it cost".
pub fn broadcast_join(left: &[Row], right: &[Row]) -> Vec<JoinRow> {
    let mut build: BTreeMap<Key, Vec<i64>> = BTreeMap::new();
    for r in right {
        build.entry(r.key).or_default().push(r.payload);
    }
    let mut out = Vec::new();
    for l in left {
        if let Some(rs) = build.get(&l.key) {
            for r in rs {
                out.push(JoinRow { key: l.key, left: l.payload, right: *r });
            }
        }
    }
    out
}

/// GIVEN. The whole query: plan from the statistics, then run the plan you
/// chose. Both paths must produce the same multiset — the strategy is a
/// cost decision, never a semantics decision.
pub fn execute(left: &[Row], right: &[Row], partitions: usize) -> Vec<JoinRow> {
    let stats = Stats {
        left_rows: left.len() as u64,
        right_rows: right.len() as u64,
        workers: partitions as u64,
    };
    match choose_plan(&stats) {
        Plan::Broadcast => broadcast_join(left, right),
        Plan::Partitioned => local_join(&shuffle(left, right, partitions)),
    }
}

/* ------------------------------ your work ---------------------------- */

/// TODO(you) 1/6 — the plain router: which partition does this key belong
/// to?
///
/// Use `hash_key`. Do NOT use `key % partitions`: real keys are strided and
/// aligned — ids allocated in blocks of 64, timestamps on the minute,
/// hashes of a prefix — and modulo of a strided key by a power of two
/// collapses the whole table into a handful of partitions. That is not a
/// skewed data problem, it is a skewed router, and `skew_bounded` includes
/// a case built out of multiples of 64 specifically to catch it.
///
/// `partitions` is never 0 in the graded cases; returning 0 for it is fine.
pub fn hash_partition(key: Key, partitions: usize) -> usize {
    let _ = (key, partitions);
    todo!("avalanche the key with hash_key, then take it modulo partitions — never the raw key modulo partitions")
}

/// TODO(you) 2/6 — the statistics that make skew visible: how many rows
/// carry each key.
///
/// A `BTreeMap` from key to row count, one entry per distinct key present,
/// no zero entries. This is the cheapest possible sketch of a
/// distribution and it is enough to find a heavy hitter: real planners get
/// this from a sample or a catalog, approximately. You get it exactly, so
/// there is no excuse for being surprised by the hot key.
pub fn key_counts(rows: &[Row]) -> BTreeMap<Key, u64> {
    let _ = rows;
    todo!("count rows per key into a BTreeMap — one entry per distinct key, counts only, no zeroes")
}

/// TODO(you) 3/6 — how many buckets does a key this big need?
///
/// The fewest `s` such that `count / s <= capacity`, and never fewer than
/// 1. In other words `ceil(count / capacity)`, with `capacity == 0` treated
/// as 1 so you cannot divide by zero.
///
/// "The fewest" is the policy, and it is the half of it that
/// `bytes_shuffled` grades: every extra bucket replicates the other side of
/// that key one more time. Splitting a key into 16 buckets when 2 would
/// have cleared the bound is not caution, it is 14 copies of the other side
/// that nobody asked for.
pub fn salts_for(count: u64, capacity: u64) -> usize {
    let _ = (count, capacity);
    todo!("ceil(count / capacity), at least 1, with capacity 0 treated as 1")
}

/// TODO(you) 4/6 — THE SHUFFLE. Route every row of both sides to
/// `partitions` buckets so that the local joins add up to the right answer,
/// no partition blows the bound, and you moved as little as you can.
///
/// Contract:
///   * the result has exactly `partitions` buckets on each side (start from
///     `Shuffled::new(partitions)`);
///   * every routed row is a row from the input, unmodified — copies are
///     allowed, inventions are not;
///   * for every left row `l` and right row `r` with `l.key == r.key`,
///     there is EXACTLY ONE partition holding both. Not zero — the pair
///     would be lost. Not two — the pair would be emitted twice.
///   * `max(partition_loads(&result)) <= partition_bound(total, partitions)`
///     where `total = left.len() + right.len()`;
///   * pure: same inputs, same output, every time.
///
/// The shape of the answer:
///   1. count both sides with `key_counts`, and compute the bound;
///   2. for each key, decide how many buckets it needs. A key whose two
///      sides together fit in a partition needs one — send both sides to
///      `salted_partition(key, 0, partitions)` and you are done;
///   3. for a key that does not fit, SPLIT THE BIGGER SIDE across `s`
///      buckets (round-robin over its rows keeps the split exact) and
///      REPLICATE THE SMALLER SIDE into all `s`. Splitting the small side
///      would replicate the big one, which is the same mistake as
///      broadcasting a fact table;
///   4. cap `s` at `partitions` — a bucket beyond that is a copy with
///      nowhere new to go.
///
/// Two traps worth naming before they cost you an hour.
///
/// **The bound is over EVERYTHING on the partition, not over one key.** The
/// rest of the table is still being routed, and the average partition
/// already carries `total / partitions` rows of it — and not in exactly
/// even helpings, because that is what hashing does. A hot bucket sized to
/// exactly the bound overflows the moment any other traffic shares its
/// partition, so size buckets against the room that is actually left. If
/// there are several heavy keys they are all competing for that same room,
/// and two of their buckets can land on the same partition; `salted_partition`
/// is a hash, so you do not get to place them.
///
/// **Never pay more in copies than the split buys back in balance.** Each
/// extra bucket costs `light` copies and takes only `heavy / s` rows off the
/// busiest partition. Past `heavy / light` buckets you are moving more bytes
/// than you are moving rows out of the way — and that is also how a key
/// that is heavy on both sides declines gracefully instead of shipping
/// itself `partitions` times over.
///
/// You never have to split both sides of the same key: in every case where
/// the bound is graded, at least one side of every key fits inside one
/// average partition. (Splitting both — a grid — is what a real engine does
/// when neither side fits, and it costs the product of the two salt counts.)
pub fn shuffle(left: &[Row], right: &[Row], partitions: usize) -> Shuffled {
    let _ = (left, right, partitions);
    todo!("route both sides into `partitions` buckets: co-locate each key, salt the keys that blow the bound by splitting the bigger side and replicating the smaller one")
}

/// TODO(you) 5/6 — what a broadcast would cost, in bytes.
///
/// The SMALL side goes to every worker; the big side does not move at all.
/// Two things this is graded on: that "small" is decided from the
/// statistics rather than assumed to be the right-hand table (a planner
/// that assumes the build side is small is a planner that has never met a
/// user's query), and that the number is multiplied by `workers` — the
/// whole reason broadcast has a limit is that its cost grows with the
/// cluster while partitioning's does not.
pub fn broadcast_bytes(stats: &Stats) -> u64 {
    let _ = stats;
    todo!("min(left_rows, right_rows) * ROW_BYTES * workers")
}

/// TODO(you) 6/6 — THE DECISION. Broadcast if and only if broadcasting
/// moves strictly fewer bytes than partitioning.
///
/// Compare `broadcast_bytes(stats)` with `partition_bytes(stats)`. Strictly
/// fewer: on a tie, partition — the plan whose cost does not grow with the
/// cluster is the one you want to be holding when somebody adds workers
/// next quarter.
///
/// `broadcast_choice` grades this against the arithmetic on cases that flip
/// both ways, including ties, both sides being the small one, and worker
/// counts from 1 to thousands. There is no answer to memorise; there is
/// only the sum. Keep it pure — a planner that is not a function of its
/// statistics is a planner you cannot reason about.
pub fn choose_plan(stats: &Stats) -> Plan {
    let _ = stats;
    todo!("Plan::Broadcast iff broadcast_bytes(stats) < partition_bytes(stats), else Plan::Partitioned")
}
