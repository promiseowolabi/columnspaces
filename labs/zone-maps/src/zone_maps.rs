//! zone_maps.rs — forge lab 02 · THE ONLY FILE YOU EDIT
//!
//! Mission: read fewer blocks without ever returning a wrong answer. You
//! build the cheapest index in databases — min, max and null count per
//! block — and then the planner that decides, per block, whether the bytes
//! are worth fetching at all.
//!
//! Lab 01 made the column small. This lab makes most of it *unread*, which
//! is the larger win: a codec saves you a fraction of the bytes, a skip
//! saves you all of them.
//!
//! ═════════════════════════ THE ASYMMETRY ═════════════════════════════
//!
//! Pruning has exactly two ways to be wrong, and they are not comparable:
//!
//! ```text
//!   false POSITIVE   read a block that held no match   → a bill
//!   false NEGATIVE   skip a block that held a match    → a silent wrong answer
//! ```
//!
//! No error, no warning: a plausible number in a report somebody makes a
//! decision on. So the rule this whole lab reduces to is:
//!
//!   **skip a block only when the statistics PROVE it cannot match.
//!     Every other case — inconclusive statistics, no statistics at all, a
//!     column the metadata never recorded — you read it.**
//!
//! That is why `no_false_negatives` is graded pass/fail with zero
//! tolerance, and why the pruning ratio is graded in a BAND: being
//! conservative is correct but expensive, being aggressive is cheap and
//! wrong. One is a tuning problem, the other is an incident. The band
//! exists so that `fn might_read(..) -> bool { true }` — which has zero
//! false negatives — does not pass the lab.
//!
//! ═════════════════════ THE BLOCK, AS IT SITS ON DISK ═════════════════
//!
//! A `Block` is one run-length-encoded column per table column — lab 01's
//! `Rle` shape, arriving here as `(value, count)` pairs. Statistics are
//! computed from the encoded form: you never expand a block to summarise
//! it, which is exactly why a zone map costs nothing to maintain.
//!
//! A run with `count == 0` holds NO rows. It contributes nothing to `min`,
//! nothing to `max` and nothing to `null_count` — statistics describe rows,
//! not metadata.
//!
//! ════════════════════════ THREE-VALUED LOGIC ═════════════════════════
//!
//! NULL is not a small value and not a large one: it is not comparable.
//! `NULL > 5` is UNKNOWN, and UNKNOWN is not a match. So:
//!
//! ```text
//!   x > 5        never matches a NULL row
//!   IS NULL      matches ONLY null rows — consult null_count, not the range
//!   IS NOT NULL  matches every non-null row
//! ```
//!
//! A block of nothing but nulls therefore has no meaningful `min` or `max`
//! (both `None`) — and that is a PROOF that no comparison can match, so
//! comparisons prune it. It is emphatically *not* a proof about `IS NULL`,
//! which that same block satisfies on every row. A planner that starts with
//! `if stats.min.is_none() { return false }` has just silently dropped
//! every null row in the table.
//!
//! ══════════════════════ THE PINNED DECISION TABLE ════════════════════
//!
//! With `Stats { min, max, null_count }` for the predicate's column and
//! `row_count` for the block, a block is PROVABLY IMPOSSIBLE when:
//!
//! ```text
//!   x >= k            max <  k
//!   x >  k            max <= k
//!   x <= k            min >  k
//!   x <  k            min >= k
//!   x == k            k < min || k > max
//!   lo <= x <= hi     hi < lo  (the predicate contradicts itself)
//!                     || max < lo || min > hi
//!   IS NULL           null_count == 0
//!   IS NOT NULL       null_count == row_count
//! ```
//!
//! and additionally, for all five comparison shapes and `Between`:
//! `min`/`max` are `None`, i.e. the block holds no non-null value at all.
//!
//! Everything not in that table is read. In particular:
//!
//! ```text
//!   stats[col] is None       the writer recorded nothing → READ
//!   col >= stats.len()       the metadata cannot even speak to it → READ
//! ```
//!
//! An empty block (`row_count == 0`) needs no special case: `null_count` is
//! 0, `min`/`max` are `None`, and every row of the table above already
//! proves it impossible.
//!
//! ══════════════════════════ THE INVARIANT ════════════════════════════
//!
//! One line, and it is the whole lab. For every block and every predicate:
//!
//! ```text
//!   if any row in the block satisfies row_matches(row, pred)
//!   then might_read(meta_of_that_block, pred) == true
//! ```
//!
//! `row_matches` is in this file precisely so you can test that yourself
//! before the harness does: expand a block, ask `row_matches` about every
//! value, and compare the answer to `might_read`. The harness does exactly
//! this over 1500 predicate/layout combinations.
//!
//! ═══════════════════════════ COST IS A COUNT ═════════════════════════
//!
//! Blocks read, rows read. Never a clock. A count means the same thing on
//! your laptop, in CI and in the browser — which is what makes the pruning
//! band gradeable at all. If you catch yourself reasoning about speed,
//! compute the count instead.
//!
//! One wasm rule, carried from lab 01: BTreeMap/BTreeSet, never HashMap.
//! std's HashMap seeds itself from OS randomness that does not exist on
//! `wasm32-unknown-unknown`.

/// One run of a run-length-encoded column: a value (NULL is a value) and
/// the number of consecutive rows holding it. `count == 0` is legal and
/// holds no rows.
pub type Run = (Option<i64>, u32);

/// Which column a predicate is about. Blocks are column-major, so this is
/// an index into `Block::columns`.
pub type ColumnId = usize;

/// A block of a table, as it sits on disk: one run-length-encoded column
/// per table column. Every column in a block expands to the same number of
/// rows. Pinned shape — the harness builds these.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub columns: Vec<Vec<Run>>,
}

/// The zone map for one column of one block: a min, a max, and a count of
/// nulls. Three numbers, and they are the entire mechanism behind most of
/// the cost difference between a well-laid-out table and a bad one.
///
/// `min` and `max` are `None` together, and only when the column holds no
/// non-null value in this block (all nulls, or no rows at all). They are
/// *not* a place to record "I do not know" — that is `BlockMeta::stats`
/// holding `None`, which is a different claim with a different consequence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stats {
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub null_count: u32,
}

/// Everything the planner is allowed to know about a block before deciding
/// to fetch it: how many rows it holds, and per column either statistics or
/// `None` for "the writer recorded none".
///
/// `None` is the case people get wrong. It is not "empty" and not
/// "unmatched" — it is *no information*, and no information proves nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockMeta {
    pub row_count: u32,
    pub stats: Vec<Option<Stats>>,
}

/// The eight predicate shapes the planner must handle. `Between` is
/// inclusive on both bounds, and `hi < lo` is a predicate that contradicts
/// itself — it matches nothing, anywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Predicate {
    /// `col >= k`
    Ge(ColumnId, i64),
    /// `col > k`
    Gt(ColumnId, i64),
    /// `col <= k`
    Le(ColumnId, i64),
    /// `col < k`
    Lt(ColumnId, i64),
    /// `col == k`
    Eq(ColumnId, i64),
    /// `lo <= col <= hi`
    Between(ColumnId, i64, i64),
    /// `col IS NULL`
    IsNull(ColumnId),
    /// `col IS NOT NULL`
    IsNotNull(ColumnId),
}

impl Predicate {
    /// GIVEN. The column this predicate is about — and therefore the ONLY
    /// column whose statistics can say anything about it. A planner that
    /// consults each column's own statistics in turn will prune blocks that
    /// contain matching rows, because `col 1`'s range has no authority over
    /// a predicate on `col 0`.
    pub fn column(&self) -> ColumnId {
        match self {
            Predicate::Ge(c, _)
            | Predicate::Gt(c, _)
            | Predicate::Le(c, _)
            | Predicate::Lt(c, _)
            | Predicate::Eq(c, _)
            | Predicate::Between(c, _, _)
            | Predicate::IsNull(c)
            | Predicate::IsNotNull(c) => *c,
        }
    }
}

/// The output of the planner: one decision per block, in block order.
/// `read[i] == true` means "fetch block i"; `false` means "the statistics
/// prove block i cannot contain a match, so its bytes are never requested".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub read: Vec<bool>,
}

impl Plan {
    /// GIVEN. Blocks whose bytes are fetched — the number on the invoice.
    pub fn blocks_read(&self) -> usize {
        self.read.iter().filter(|&&r| r).count()
    }

    /// GIVEN. Blocks never touched: the whole point of the exercise.
    #[allow(dead_code)] // yours to report; the harness counts reads instead
    pub fn blocks_skipped(&self) -> usize {
        self.read.iter().filter(|&&r| !r).count()
    }

    /// GIVEN. Rows the query has to look at, which is the count that scales
    /// with the bill. A count, not a clock.
    pub fn rows_read(&self, metas: &[BlockMeta]) -> u64 {
        self.read
            .iter()
            .zip(metas)
            .filter(|(r, _)| **r)
            .map(|(_, m)| m.row_count as u64)
            .sum()
    }
}

/// GIVEN. Rows a run-length-encoded column holds: the sum of the counts.
/// The row count is implicit in RLE, which is why it is worth having one
/// function that computes it.
#[allow(dead_code)] // your code calls this; the harness counts rows itself
pub fn rows_in(runs: &[Run]) -> u32 {
    runs.iter().map(|(_, count)| *count).sum()
}

/* ------------------------------ your work ---------------------------- */

/// TODO(you) 1/5 — the zone map for one run-length-encoded column.
///
/// `min` and `max` are over the NON-NULL values only, and are `None`
/// together when there is no non-null value in the block. `null_count` is
/// the number of null ROWS, so a null run of count 40 contributes 40 — and
/// a run of count 0 contributes nothing at all, whatever its value.
///
/// This is the cheap part of the mechanism: one pass over the runs, no
/// expansion, no allocation. `min` over the first value instead of the
/// smallest is the classic bug, and it is a false negative generator — the
/// planner will happily prove a block impossible using a bound that was
/// never a bound.
pub fn column_stats(runs: &[Run]) -> Stats {
    let _ = runs;
    todo!("one pass over the runs: skip count == 0; None adds its count to null_count; Some(v) widens min and max (which start as None, not as 0 and not as i64::MAX)")
}

/// TODO(you) 2/5 — the metadata a writer records for one block: its row
/// count, plus statistics for every column.
///
/// Every column in a block expands to the same number of rows, so
/// `row_count` is `rows_in` of any one of them (0 for a block with no
/// columns). Record `Some(stats)` for every column — you computed them, so
/// you know them. `None` is reserved for "the writer recorded nothing",
/// which is a claim about the metadata and not about the data.
pub fn block_meta(block: &Block) -> BlockMeta {
    let _ = block;
    todo!("row_count from the first column's runs; stats: one Some(column_stats(runs)) per column, in column order")
}

/// TODO(you) 3/5 — does a single row satisfy the predicate? The row-level
/// semantics the planner must never contradict.
///
/// Three-valued logic, and it is short: a NULL value matches `IS NULL` and
/// nothing else. Every comparison against NULL is UNKNOWN, and UNKNOWN is
/// not a match. A non-null value matches `IS NOT NULL` and whichever
/// comparison holds. `Between(_, lo, hi)` is `lo <= v && v <= hi`, so
/// `hi < lo` matches nothing without needing a special case.
///
/// This function is the definition the grading is written against; get it
/// right and you can test `might_read` against it yourself.
pub fn row_matches(value: Option<i64>, pred: &Predicate) -> bool {
    let _ = (value, pred);
    todo!("None matches IsNull only; Some(v) matches IsNotNull and the arithmetic of the shape — never a comparison against a null")
}

/// TODO(you) 4/5 — the decision, for one block. `true` means read it.
///
/// Answer only from `meta`: `stats[pred.column()]` and `row_count`. Return
/// `false` if and only if the pinned decision table in the module header
/// proves the block impossible. When in doubt — no entry for the column, no
/// statistics recorded, a shape the statistics cannot speak to — return
/// `true` and pay the bill.
///
/// The two failure modes to keep in view while writing this:
///   * a blanket `if stats.min.is_none() { return false }` drops every null
///     row in the table, because `IS NULL` is satisfied by exactly those
///     blocks whose min and max are absent;
///   * consulting a column other than `pred.column()` prunes on a range
///     that has no authority over the question, which is a false negative
///     the moment two columns are laid out differently — and a table has
///     exactly ONE physical order, so they always are.
pub fn might_read(meta: &BlockMeta, pred: &Predicate) -> bool {
    let _ = (meta, pred);
    todo!("look up stats[pred.column()] — a missing entry or a None means READ; IsNull consults null_count, IsNotNull compares null_count against row_count, every other shape needs min and max present and then a range overlap test")
}

/// TODO(you) 5/5 — the planner: one decision per block, in block order.
///
/// `read.len()` must equal `metas.len()`; a planner that returns a shorter
/// vector has not decided about the blocks it left off, and "undecided"
/// resolves to "unread". Keep this consistent with `might_read` — the
/// harness checks that they agree, because two answers to the same question
/// is how a fast path and a correct path drift apart.
pub fn plan(metas: &[BlockMeta], pred: &Predicate) -> Plan {
    let _ = (metas, pred);
    todo!("one might_read(meta, pred) per meta, in metas order, collected into a Plan")
}
