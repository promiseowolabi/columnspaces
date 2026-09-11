//! encodings.rs — forge lab 01 · THE ONLY FILE YOU EDIT
//!
//! Mission: make a column small without ever making it wrong. Four codecs,
//! one dispatcher, and a bound that forbids you from making things worse.
//! Everything after this lab reads these bytes: lab 02 puts statistics on
//! top of them, lab 03 executes over them without decoding, lab 04 reads
//! the standardised version of the same four ideas out of a Parquet file.
//!
//! A column is one type and one domain. Each codec exploits a different
//! shape of that domain:
//!
//! ```text
//!   Dict     few DISTINCT values          → value table + one index per row
//!   Rle      values CLUSTERED into runs   → (value, count) pairs
//!   BitPack  a narrow RANGE               → w bits per value, not 64
//!   For      a narrow SPREAD, high base   → base + small unsigned deltas
//! ```
//!
//! ══════════════════════════ THE PINNED FORMAT ════════════════════════
//!
//! `Encoded` is the on-wire shape and it is pinned: the harness measures
//! these variants with the formula below and compares your bit layout
//! against its own. Do not add variants and do not change the fields.
//!
//! NULL is a *value* here, not a flag: a dictionary entry can be NULL and a
//! run can repeat NULL. Only `BitPack` and `For` refuse nulls outright —
//! real formats keep nulls out of the packed stream too, which is why lab
//! 04's Parquet reader carries definition levels beside the data.
//!
//! ═══════════════════════════ THE TAPE MEASURE ════════════════════════
//!
//! `plain_size` and `encoded_size` are GIVEN, and the grader uses the same
//! two formulas. They are not open to negotiation — that is the point of a
//! bound. Every encoding pays `HEADER` bytes of framing (a tag plus its
//! counts), then:
//!
//! ```text
//!   Plain   { values }                 8·n  + ⌈n/8⌉ if the column has a null
//!   Dict    { dict, codes }            8·dict.len() + 4·codes.len()
//!   Rle     { runs }                   12·runs.len()          (8 value + 4 count)
//!   BitPack { width, len, words }      8·words.len()
//!   For     { base, width, len, words } 8 (the base) + 8·words.len()
//! ```
//!
//! ══════════════════════════ THE BIT LAYOUT ═══════════════════════════
//!
//! `pack`/`unpack` are the primitive underneath both `BitPack` and `For`,
//! and the stream is pinned LSB-first so that two implementations of this
//! lab can read each other's blocks:
//!
//! ```text
//!   value i occupies bits [i·w, (i+1)·w) of the stream
//!   the stream is words[0] bits 0..64, then words[1] bits 64..128, …
//!   a value MAY straddle a word boundary — it is a bit stream, not an array
//!   words.len() = ⌈n·w / 64⌉, and every unused trailing bit is ZERO
//! ```
//!
//! Two shifts are where implementations die: `1u64 << 64` is undefined
//! (Rust panics in debug, wraps in release), so width 64 needs its own mask,
//! and the carry into `words[w + 1]` only exists when `off + w > 64`.
//!
//! ═══════════════════ THE RULE THAT MAKES IT REALISTIC ════════════════
//!
//! `encode_column` considers EXACTLY five candidates and returns the
//! smallest by `encoded_size`:
//!
//! ```text
//!   Plain, Dict, Rle  — always
//!   BitPack, For      — only when the column contains no null
//! ```
//!
//! Ties are your call. Because `Plain` is always a candidate, the chosen
//! encoding can never exceed `plain_size` — that is the whole content of
//! the `never_expands` check, and it is the fallback every real format has.
//! A dictionary over an all-distinct column is *larger* than the original
//! (a table of every value PLUS an index per row); your job is not to make
//! that case small, it is to notice and stop.
//!
//! Two rules for the rest of the course:
//!   * A codec that cannot round-trip is data loss, not a slow path. Every
//!     roundtrip check is byte-exact, nulls included.
//!   * Cost here is a COUNT of bytes, never a clock. `encoded_size` means
//!     the same thing on your laptop, in CI and in the browser.
//!
//! One wasm rule: BTreeMap, never HashMap. std's HashMap seeds itself from
//! OS randomness that does not exist on `wasm32-unknown-unknown`.

/// Framing bytes every encoding pays: one tag plus its counts. This is the
/// "header bound" — an encoding may cost the plain payload plus HEADER, and
/// not one byte more.
pub const HEADER: usize = 8;

/// One encoded column. The on-wire shape is pinned (see the module header).
#[allow(dead_code)] // your encoders construct these; the harness only measures them
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Encoded {
    /// Verbatim values — the honest baseline and the mandatory fallback.
    Plain { values: Vec<Option<i64>> },
    /// `dict` holds each DISTINCT value once (NULL included); `codes[i]` is
    /// the dictionary index of value i. Dictionary order is yours to choose
    /// — first appearance, sorted, whatever — as long as decode inverts it.
    Dict { dict: Vec<Option<i64>>, codes: Vec<u32> },
    /// MAXIMAL runs: no two adjacent runs hold equal values, so a constant
    /// column is exactly ONE run. The value count is implicit: Σ counts.
    Rle { runs: Vec<(Option<i64>, u32)> },
    /// `len` values, each `width` bits (1..=32), LSB-first in `words`.
    BitPack { width: u32, len: u32, words: Vec<u64> },
    /// `base` plus `len` unsigned deltas of `width` bits (1..=64) each.
    For { base: i64, width: u32, len: u32, words: Vec<u64> },
}

/* --------------------------- the tape measure ------------------------ */
/* GIVEN. The grader computes these same two numbers independently — if    */
/* you edit them, only your chooser goes blind.                            */

/// The baseline every codec is measured against: 8 bytes per value, plus
/// one validity bit per value when (and only when) the column actually
/// contains a NULL. A column with no nulls pays nothing for nulls, which is
/// why Parquet writes definition levels only when the schema permits them.
pub fn plain_size(values: &[Option<i64>]) -> usize {
    let bitmap = if values.iter().any(|v| v.is_none()) { (values.len() + 7) / 8 } else { 0 };
    HEADER + 8 * values.len() + bitmap
}

/// The pinned size of an encoded column, in bytes. A count, not a clock.
pub fn encoded_size(e: &Encoded) -> usize {
    match e {
        Encoded::Plain { values } => plain_size(values),
        Encoded::Dict { dict, codes } => HEADER + 8 * dict.len() + 4 * codes.len(),
        Encoded::Rle { runs } => HEADER + 12 * runs.len(),
        Encoded::BitPack { words, .. } => HEADER + 8 * words.len(),
        Encoded::For { words, .. } => HEADER + 8 + 8 * words.len(),
    }
}

/* ------------------------------ your work ---------------------------- */

/// The smallest `w` with `max < 2^w`, clamped to at least 1: a column of
/// nothing but zeroes still needs a legal width, and width 0 would make
/// `words.len()` a division by zero later. `bits_needed(u64::MAX) == 64`.
#[allow(dead_code)] // your codecs call this; the harness derives widths itself
pub fn bits_needed(max: u64) -> u32 {
    let _ = max;
    todo!("count the significant bits of max (leading_zeros is the whole job), and never return 0")
}

/// Pack `values` into a bit stream of `width`-bit fields, LSB-first, layout
/// pinned in the module header. Bits above `width` in a value are not your
/// problem — mask them off. Panics for a width outside 1..=64.
pub fn pack(values: &[u64], width: u32) -> Vec<u64> {
    let _ = (values, width);
    todo!("⌈n·width/64⌉ zeroed words; for value i at bit i·width, OR the masked value into words[bit/64] << (bit%64), and when bit%64 + width > 64 OR the remainder into the next word")
}

/// The exact inverse: read `len` fields of `width` bits back out. Trailing
/// bits beyond `len` values are not data — `len` is the only authority on
/// how many values a word holds.
pub fn unpack(words: &[u64], width: u32, len: usize) -> Vec<u64> {
    let _ = (words, width, len);
    todo!("for value i: shift words[bit/64] right by bit%64, carry in words[bit/64+1] << (64 - bit%64) when the field straddles, then mask to width bits (width 64 needs its own mask — 1u64 << 64 is not 0)")
}

/// Dictionary-encode: each distinct value (NULL included) lands in `dict`
/// exactly once, and every row becomes its index. The win is
/// `rows × 8` versus `distinct × 8 + rows × 4` — which is a LOSS as soon as
/// `distinct` approaches `rows`. Encode honestly here; `encode_column` is
/// where you refuse to use it.
///
/// Use a `BTreeMap<Option<i64>, u32>` for the lookup. Never HashMap.
pub fn dict_encode(values: &[Option<i64>]) -> Encoded {
    let _ = values;
    todo!("one pass: look each value up; a value seen for the first time is pushed onto dict and takes the next code; codes[i] is always defined, so codes.len() == values.len()")
}

/// Run-length-encode into MAXIMAL runs: after this, no two adjacent runs
/// hold equal values. That invariant is what makes RLE a canonical form —
/// a constant column is one run, an alternating column is n runs, and there
/// is exactly one correct answer for every column in between.
pub fn rle_encode(values: &[Option<i64>]) -> Encoded {
    let _ = values;
    todo!("one pass: if the last run holds an equal value, bump its count; otherwise push (value, 1)")
}

/// Bit-pack a non-null column. The codec's declared domain is unsigned
/// 32-bit: every value must be in `0..=u32::MAX`, giving a width in
/// 1..=32. Anything outside that returns None — a codec that cannot
/// represent the data must say so rather than truncate it. An empty column
/// is `width 1, len 0, no words`.
pub fn bitpack_encode(values: &[i64]) -> Option<Encoded> {
    let _ = values;
    todo!("reject any value < 0 or > u32::MAX; width = bits_needed(max); words = pack(values as u64, width)")
}

/// Frame-of-reference: store the frame `base` once, then each value as an
/// UNSIGNED delta from it. `base` is pinned to the column's MINIMUM, so
/// every delta is non-negative — but a column holding both i64::MIN and
/// i64::MAX spans more than i64 can express, so `max - min` computed in
/// i64 overflows. Compute deltas as `(v as u64).wrapping_sub(base as u64)`:
/// in two's complement that is the true distance whenever `v >= base`, for
/// every pair of i64 in existence. Width is then 1..=64.
///
/// This is why a monotonically increasing timestamp column is nearly free:
/// the values are enormous, their spread is not.
///
/// An empty column is `base 0, width 1, len 0, no words`.
pub fn for_encode(values: &[i64]) -> Encoded {
    let _ = values;
    todo!("base = min; deltas via wrapping_sub on u64; width = bits_needed(max delta); words = pack(deltas, width)")
}

/// The one inverse for all five variants — byte-exact, nulls included.
/// `BitPack` and `For` decode to all-Some values by construction.
pub fn decode(e: &Encoded) -> Vec<Option<i64>> {
    let _ = e;
    todo!("Plain clones; Dict maps each code through dict; Rle expands (value, count); BitPack unpacks to i64; For unpacks deltas and adds them back onto base with wrapping_add")
}

/// The chooser: exactly five candidates (Plain, Dict, Rle always; BitPack
/// and For only for a column with no nulls), return the smallest by
/// `encoded_size`. Ties are your call.
///
/// Plain is always in the running, which is the guarantee: the encoding you
/// return can never be larger than `plain_size(values)`. Every real format
/// works this way — Parquet falls back to plain pages, ORC to direct
/// encoding — because "compressed" is a claim you have to check.
pub fn encode_column(values: &[Option<i64>]) -> Encoded {
    let _ = values;
    todo!("size all applicable candidates with encoded_size and return the smallest — never something larger than plain_size(values)")
}
