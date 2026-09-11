//! vectorized.rs — forge lab 03 · THE ONLY FILE YOU EDIT
//!
//! Mission: stop paying per row. Lab 01 made the column small, lab 02 made
//! most of it unread — this lab makes the rows that *are* read cost less by
//! processing them a batch at a time, and then makes some of them cost
//! nothing at all by never decoding them.
//!
//! ══════════════════════════ WHAT A BATCH IS ══════════════════════════
//!
//! A slice. There is no `Batch` struct in this lab, because a batch is not
//! a thing — it is a length. One column, `&[Option<i64>]`, a few thousand
//! values at a time, and every operator in this file consumes and produces
//! *columns of a batch* rather than rows.
//!
//! Row-at-a-time execution pays its overhead once per tuple: a virtual
//! call, a bounds check, a null check, a branch. Batch-at-a-time amortises
//! all of it over the batch and leaves loops the compiler can actually
//! vectorize. You are not asked to measure that here — this course does not
//! grade clocks — you are asked to build the shape that makes it possible,
//! and the shape is the selection vector.
//!
//! ═════════════════════ THE SELECTION VECTOR ══════════════════════════
//!
//! A filter that copies surviving values into a new array has paid for the
//! filter twice: once to test, once to move. A selection vector is the
//! alternative: a list of the POSITIONS still alive.
//!
//! ```text
//!   values   [ 7,  3, NULL,  9,  4 ]
//!   > 3      Sel [0, 3, 4]          <- no values copied
//!   < 9      Sel [0, 4]             <- composed against the same values
//!   gather   [ 7, 4 ]               <- copied ONCE, at the end
//! ```
//!
//! Pinned invariants, and the grading leans on all four:
//!
//! ```text
//!   1. a Sel is STRICTLY INCREASING       (row order survives; gather is a
//!                                          single forward pass)
//!   2. every position is < the batch len  (it indexes this batch, no other)
//!   3. filter's output ⊆ filter's input   (a filter narrows; it never
//!                                          resurrects a row an earlier
//!                                          predicate already killed)
//!   4. an empty Sel means NOTHING SURVIVED — it does not mean "all rows".
//!      An empty selection is the single most common source of a wrong
//!      aggregate: a phantom group appears because "no rows" was read as
//!      "no filter".
//! ```
//!
//! Late materialization falls out of 1–3: the aggregate consumes values by
//! POSITION, so a query that filters two columns and sums a third never
//! assembles a row at all. `gather` exists for the one place you do need
//! contiguous values, and if you find yourself calling it between two
//! filters, you have materialized for nothing.
//!
//! ════════════════ EXECUTE ON COMPRESSED — THE POINT ══════════════════
//!
//! Two encodings from lab 01 arrive here (minimal versions of them are
//! defined in this file — this crate does not depend on that one):
//!
//! ```text
//!   RLE          (value, count)*      a run of a constant
//!   dictionary   entries[] + codes[]  a small distinct-value table and one
//!                                     code per row
//! ```
//!
//! and each admits a fast path that answers the query WITHOUT expanding:
//!
//! ```text
//!   sum of a run   value × count        one multiply, not `count` adds
//!   count of a run count                the run length, already written down
//!   filter a dict  evaluate the predicate ONCE PER DISTINCT VALUE, then the
//!                  per-row work is an integer table lookup on the code
//! ```
//!
//! That second one is why `dict_code_mask` and `dict_filter` are separate
//! functions rather than one: the mask has `entries.len()` elements, so the
//! type signature itself records that the predicate was evaluated once per
//! distinct value and never once per row. Cost is a count, and here the
//! count is visible in the API.
//!
//! **The fast path is graded as an EQUIVALENCE, not as an optimisation.**
//! For every column, every predicate and every selection:
//!
//! ```text
//!   compressed path   ==   decode, then run the scalar path
//! ```
//!
//! Identical results. Not close, not faster-and-roughly-equal: identical.
//! A fast path that disagrees with the reference is not a slower-but-safer
//! trade-off, it is a wrong answer arriving sooner, and the harness treats
//! it as the correctness bug it is.
//!
//! One consequence worth knowing before you debug it: some graded columns
//! declare BILLIONS of rows in a handful of runs (`(Some(7),
//! 4_000_000_000)` is a legal run). The harness does not expand those
//! either — it computes what they must sum to with arithmetic. If your
//! `run_agg` loops `count` times, nothing is wrong with your answer and
//! your test will not finish. That is the asymptotic difference the whole
//! section is about, stated as a shape rather than as a stopwatch.
//!
//! ═══════════════════════════ NULLS AND SUMS ══════════════════════════
//!
//! NULL is not comparable (lab 02's three-valued logic, unchanged and
//! GIVEN below as `row_matches`). In an aggregate:
//!
//! ```text
//!   count   every selected row, nulls included   (COUNT(*))
//!   nulls   the selected rows that are NULL
//!   sum     over non-null values only; 0 when there are none
//!   min/max over non-null values only; None together when there are none
//!   a NULL group KEY is a group, exactly as SQL's GROUP BY treats it
//! ```
//!
//! `sum` is `i128` on purpose. A run of four billion sevens sums to
//! 28,000,000,000 — and a batch of `i64::MAX`s overflows an `i64`
//! accumulator on row two. Overflow in an aggregate is a silent wrong
//! number, which this course ranks with a false negative.
//!
//! ═══════════════════════════ THE WASM RULES ══════════════════════════
//!
//! BTreeMap/BTreeSet, never HashMap: std's HashMap seeds itself from OS
//! randomness that does not exist on `wasm32-unknown-unknown`. It is also
//! why the group table's output order is pinned — a BTreeMap gives you a
//! deterministic order for free, and determinism is what makes the browser
//! and the terminal agree.

use std::collections::BTreeMap;

/* ------------------------------ the shapes --------------------------- */

/// A selection vector: strictly increasing positions within one batch.
/// `Vec<u32>` and not `Vec<bool>` deliberately — a bitmap costs one bit per
/// row whether or not the row survived, and a selective predicate is the
/// common case.
pub type Sel = Vec<u32>;

/// One run of a run-length-encoded column: a value (NULL is a value) and
/// the number of consecutive rows holding it. `count == 0` is legal and
/// holds no rows.
pub type Run = (Option<i64>, u32);

/// A dictionary-encoded column: the distinct values, and one code per row
/// indexing them. `codes.len()` is the row count; `entries.len()` is the
/// number of distinct values, and the gap between those two numbers is the
/// entire reason this encoding exists.
///
/// Every code is a valid index into `entries` — the harness only ever
/// builds well-formed dictionaries, so you are decoding, not validating.
/// (Lab 04 is where input stops being trustworthy.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dict {
    pub entries: Vec<Option<i64>>,
    pub codes: Vec<u32>,
}

/// The eight predicate shapes, unchanged from lab 02 except that a batch
/// operator is handed one column at a time, so there is no column id here.
/// `Between` is inclusive on both bounds; `hi < lo` contradicts itself and
/// matches nothing, anywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pred {
    /// `v >= k`
    Ge(i64),
    /// `v > k`
    Gt(i64),
    /// `v <= k`
    Le(i64),
    /// `v < k`
    Lt(i64),
    /// `v == k`
    Eq(i64),
    /// `lo <= v <= hi`
    Between(i64, i64),
    /// `v IS NULL`
    IsNull,
    /// `v IS NOT NULL`
    IsNotNull,
}

/// An aggregate over some set of rows. Pinned semantics, because every
/// check in this lab compares one of these against another one:
///
/// ```text
///   count  rows aggregated, nulls included   (COUNT(*))
///   nulls  how many of them were NULL
///   sum    over the non-null values; 0 when there are none
///   min    smallest non-null value, None when there is none
///   max    largest non-null value, None when there is none
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Agg {
    pub count: u64,
    pub nulls: u64,
    pub sum: i128,
    pub min: Option<i64>,
    pub max: Option<i64>,
}

impl Agg {
    /// GIVEN. The empty aggregate: no rows, no nulls, sum 0, no min or max.
    /// Note that this is NOT the same value as the aggregate of a group
    /// that exists and holds only nulls (`count > 0`), which is why an
    /// empty selection must not create a group at all.
    #[allow(dead_code)] // yours to call; the harness builds its own expectations
    pub fn zero() -> Agg {
        Agg::default()
    }

    /// GIVEN. Fold one value in — the scalar path, and the definition of
    /// the null semantics above. Your batched code may call this; your
    /// compressed code must not need to, once per row.
    #[allow(dead_code)]
    pub fn add(&mut self, value: Option<i64>) {
        self.count += 1;
        match value {
            None => self.nulls += 1,
            Some(v) => {
                self.sum += v as i128;
                self.min = Some(self.min.map_or(v, |m| if v < m { v } else { m }));
                self.max = Some(self.max.map_or(v, |m| if v > m { v } else { m }));
            }
        }
    }

    /// GIVEN. Combine two aggregates over DISJOINT row sets. This is the
    /// operation that makes batching possible at all: a partial aggregate
    /// per batch, merged at the end, with the same answer as one pass over
    /// everything. (It is also why a distributed GROUP BY works — see
    /// lab 06, where the merge crosses a network.)
    #[allow(dead_code)]
    pub fn merge(&mut self, other: &Agg) {
        self.count += other.count;
        self.nulls += other.nulls;
        self.sum += other.sum;
        if let Some(o) = other.min {
            self.min = Some(self.min.map_or(o, |m| if o < m { o } else { m }));
        }
        if let Some(o) = other.max {
            self.max = Some(self.max.map_or(o, |m| if o > m { o } else { m }));
        }
    }
}

/// The hash aggregate's state, accumulated across every batch of the query.
/// A BTreeMap rather than a HashMap for the wasm reason above — and the
/// ordered iteration is a bonus, not the point: a real engine's hash table
/// is unordered and sorts (or does not) at the end.
///
/// A group key of `None` is the NULL group, and SQL puts it first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GroupTable {
    pub groups: BTreeMap<Option<i64>, Agg>,
}

impl GroupTable {
    /// GIVEN.
    pub fn new() -> GroupTable {
        GroupTable { groups: BTreeMap::new() }
    }

    /// GIVEN. The result, in ascending key order with the NULL group first.
    /// `Option`'s own ordering already puts `None` before every `Some`, so
    /// this is one line and it is deterministic.
    pub fn finish(&self) -> Vec<(Option<i64>, Agg)> {
        self.groups.iter().map(|(k, a)| (*k, *a)).collect()
    }

    /// GIVEN. Groups discovered so far — a count, and the number a real
    /// engine watches to decide whether the hash table still fits in cache.
    pub fn len(&self) -> usize {
        self.groups.len()
    }

    /// GIVEN.
    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }
}

/// GIVEN. Row-level three-valued logic — you wrote this in lab 02, and it
/// is handed to you here so the semantics are pinned and this lab is about
/// the batch rather than the logic.
///
/// A NULL matches `IS NULL` and nothing else: every comparison against NULL
/// is UNKNOWN, and UNKNOWN is not a match.
#[allow(dead_code)] // the harness has its own copy; this one is for your operators
pub fn row_matches(value: Option<i64>, pred: &Pred) -> bool {
    let v = match value {
        None => return matches!(pred, Pred::IsNull),
        Some(v) => v,
    };
    match pred {
        Pred::Ge(k) => v >= *k,
        Pred::Gt(k) => v > *k,
        Pred::Le(k) => v <= *k,
        Pred::Lt(k) => v < *k,
        Pred::Eq(k) => v == *k,
        Pred::Between(lo, hi) => v >= *lo && v <= *hi,
        Pred::IsNull => false,
        Pred::IsNotNull => true,
    }
}

/// GIVEN. The selection every query starts from: every position in the
/// batch, in order. A scan is a filter whose predicate is "yes".
pub fn all_rows(n: usize) -> Sel {
    (0..n as u32).collect()
}

/* ------------------------------ your work ---------------------------- */

/// TODO(you) 1/7 — the batched filter.
///
/// Test `pred` against the values at the positions in `input`, and return
/// the positions that survive. `input` is the rows still alive when this
/// operator runs: the first filter in a query gets `all_rows(values.len())`,
/// every later one gets the previous filter's output.
///
/// Requirements the harness checks directly:
///   * the output is a SUBSET of `input`, in the same (increasing) order;
///   * positions never move — position 4 of a batch is position 4 in every
///     selection over that batch, which is what lets two filters on two
///     different columns compose without either one copying a value;
///   * nothing survives ⇒ an EMPTY selection, which is not `all_rows`.
///
/// Do not materialize. There is no reason to copy a value to test it.
pub fn filter(values: &[Option<i64>], pred: &Pred, input: &Sel) -> Sel {
    let _ = (values, pred, input);
    todo!("for each position i in input, keep it when row_matches(values[i as usize], pred) — one pass, no allocation per row, output in input's order")
}

/// TODO(you) 2/7 — late materialization, and the only place a value is
/// copied.
///
/// Gather the values at `sel`'s positions into a contiguous vector, in
/// selection order. This is what a query does at the very END — to return
/// rows to a client, or to hand a column to an operator that cannot consume
/// positions. Calling it between two filters is the mistake this lab exists
/// to make visible: the copy is the cost you removed by having a `Sel` in
/// the first place.
pub fn gather(values: &[Option<i64>], sel: &Sel) -> Vec<Option<i64>> {
    let _ = (values, sel);
    todo!("map each position in sel to values[position], preserving order — sel is strictly increasing, so this is a forward pass")
}

/// TODO(you) 3/7 — the hash aggregate, one batch at a time.
///
/// For every position in `sel`, fold `vals[pos]` into the group named by
/// `keys[pos]`. `table` accumulates ACROSS BATCHES: a key that appears in
/// batch 0 and again in batch 7 is one group with one running aggregate,
/// and a key that appears in exactly one batch is still a group.
///
/// The three ways this goes wrong, all of them graded:
///   * an empty `sel` must add NOTHING — no group, not even an empty one.
///     A phantom group with `count == 0` is a row in someone's report that
///     does not exist;
///   * a NULL key is a group (SQL's GROUP BY does this), and it sorts
///     first;
///   * a NULL value still counts. `count` is COUNT(*) over the selected
///     rows of the group; `sum`, `min` and `max` ignore nulls. `Agg::add`
///     already does exactly this — use it.
///
/// `keys` and `vals` are two columns of the SAME batch, so a position
/// indexes both. That is late materialization in one sentence: the row
/// (key, value) is never assembled.
pub fn aggregate_batch(table: &mut GroupTable, keys: &[Option<i64>], vals: &[Option<i64>], sel: &Sel) {
    let _ = (table, keys, vals, sel);
    todo!("for each pos in sel: entry(keys[pos]).or_insert(Agg::zero()).add(vals[pos]) — no work at all when sel is empty")
}

/// TODO(you) 4/7 — the aggregate of ONE RUN, without expanding it.
///
/// A run is `count` consecutive rows all holding `value`. So:
///
/// ```text
///   count      count            (the run length; it is already written down)
///   nulls      count if the value is NULL, else 0
///   sum        value × count    ONE MULTIPLY — and in i128, because
///                               4_000_000_000 × 7 does not fit where you
///                               might expect, and i64::MAX × 2 certainly
///                               does not
///   min, max   value            a constant's smallest and largest value is
///                               itself — but only if the run holds a row
/// ```
///
/// `count == 0` holds NO rows: the aggregate of an empty run is
/// `Agg::zero()`, with no min and no max. Get that wrong and a run that
/// describes nothing contributes a min to the answer.
///
/// This function is a pure function of `(value, count)` — that is the
/// lesson. Nothing here is linear in the number of rows.
pub fn run_agg(value: Option<i64>, count: u32) -> Agg {
    let _ = (value, count);
    todo!("count == 0 → Agg::zero(); NULL → count rows, all null, sum 0, no min/max; Some(v) → sum = v as i128 * count as i128, min = max = Some(v)")
}

/// TODO(you) 5/7 — aggregate a run-length-encoded column on the encoded
/// form: one `run_agg` per run, merged.
///
/// The result must be IDENTICAL to decoding the column and folding every
/// value with `Agg::add`. That equivalence is the whole claim of
/// execute-on-compressed, and the harness checks it on columns whose
/// declared row count is in the billions — which it does not expand either,
/// because the expected answer is arithmetic.
pub fn rle_aggregate(runs: &[Run]) -> Agg {
    let _ = runs;
    todo!("fold: start from Agg::zero() and merge run_agg(value, count) for each run — runs.len() operations, not rows_in(runs)")
}

/// TODO(you) 6/7 — evaluate the predicate ONCE PER DISTINCT VALUE.
///
/// Return one boolean per dictionary entry: `mask[c]` is whether a row
/// whose code is `c` satisfies `pred`. `mask.len()` must equal
/// `entries.len()` — the harness checks that, because the length IS the
/// cost claim: a 4 000 000-row column with 12 distinct values evaluates the
/// predicate twelve times.
///
/// This is also the step that makes a dictionary filter a *code*
/// comparison. Once the mask exists, no row is ever compared against `k`
/// again; rows are compared against a table.
pub fn dict_code_mask(entries: &[Option<i64>], pred: &Pred) -> Vec<bool> {
    let _ = (entries, pred);
    todo!("one row_matches(entry, pred) per entry, in entry order — length exactly entries.len()")
}

/// TODO(you) 7a/7 — apply a code mask to a dictionary-encoded column.
///
/// For each position in `input`, keep it when `mask[codes[pos]]`. No
/// predicate evaluation happens here: the answer for every row was already
/// computed by `dict_code_mask`, and the per-row work is one table lookup.
///
/// The result must equal `filter(&decoded_values, pred, input)` exactly —
/// the same positions, in the same order. Same Sel, or it is a wrong
/// answer.
pub fn dict_filter(dict: &Dict, mask: &[bool], input: &Sel) -> Sel {
    let _ = (dict, mask, input);
    todo!("for each pos in input: keep when mask[dict.codes[pos] as usize] — a lookup per row, zero comparisons against the predicate's constant")
}

/// TODO(you) 7b/7 — aggregate a dictionary-encoded column at the selected
/// positions, without decoding it row by row.
///
/// Count how many selected rows carry each code, then combine
/// `run_agg(entries[c], count_of_c)` over the codes. One pass over the
/// selected codes to count, then `entries.len()` merges — and the values
/// themselves are touched once per DISTINCT value rather than once per row.
///
/// Must equal `Agg` folded over `gather(&decoded_values, sel)`. Note the
/// shape you have already written: a per-code count is a run length that
/// happens not to be contiguous, which is why `run_agg` is reusable here.
pub fn dict_aggregate(dict: &Dict, sel: &Sel) -> Agg {
    let _ = (dict, sel);
    todo!("tally counts per code over sel (a Vec<u64> of len entries.len() is fine), then merge run_agg(entries[c], tally[c]) for every code — Agg::zero() for an empty sel")
}

/* ---------------------------- small helpers -------------------------- */

/// GIVEN. Rows a run-length-encoded column holds: the sum of the counts, in
/// `u64` because a legal RLE column can describe more rows than a `u32`
/// counts. Your code may call it; the harness counts rows itself.
#[allow(dead_code)]
pub fn rows_in(runs: &[Run]) -> u64 {
    runs.iter().map(|(_, count)| *count as u64).sum()
}
