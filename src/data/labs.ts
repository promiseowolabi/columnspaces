/**
 * Forge labs — local-only Rust labs, graded in-browser by the same zero-dep
 * wasm ABI as the rest of the series (ks_alloc/ks_free/ks_run, crate `kslab`).
 *
 * Columnspaces arc: one columnar engine, built layer by layer — encode the
 * bytes, learn to skip them, execute without decoding them, read the real
 * format, survive updates, then cross a network.
 *
 * Check ids here MUST match the harness `Check` ids in each lab's src/lib.rs
 * verbatim. The site renders these labels; the wasm reports these ids.
 */

import type { TrackId } from '@/data/lessons/types'

export interface ForgeLabCheck {
  id: string
  label: string
}

export interface ForgeLab {
  id: string
  index: number
  title: string
  hook: string
  trackId: TrackId
  lessonId: string
  minutes: number
  zip: string
  artifact: string
  editFile: string
  completion: { title: string; next: string }
  checks: ForgeLabCheck[]
  brief: string[]
}

export const FORGE_LABS: ForgeLab[] = [
  {
    id: 'encodings',
    index: 1,
    title: 'Make the Column Small',
    hook: 'Four codecs — dictionary, run-length, bit-packing, frame-of-reference — that must round-trip byte-exact on the columns designed to break them.',
    trackId: 'c1',
    lessonId: 'c1.l2',
    minutes: 70,
    zip: '/labs/encodings.zip',
    artifact: 'target/wasm32-unknown-unknown/release/encodings.wasm',
    editFile: 'src/encodings.rs',
    completion: {
      title: 'all six green — your columns are small and still honest.',
      next: 'next: lab 02. Small bytes are good; unread bytes are better.',
    },
    checks: [
      { id: 'dict_roundtrip', label: 'dictionary encode/decode round-trips byte-exact' },
      { id: 'rle_roundtrip', label: 'RLE round-trips, including single-element runs' },
      { id: 'bitpack_roundtrip', label: 'bit-packing round-trips at every width 1..32' },
      { id: 'for_roundtrip', label: 'frame-of-reference handles negative deltas and full-range values' },
      { id: 'never_expands', label: 'no codec exceeds the plain encoding by more than the header bound' },
      { id: 'storm', label: '2000 seeded columns (all-null, all-distinct, single-value, zipf) vs a reference model' },
    ],
    brief: [
      'A column is one type and one domain, and every codec in this lab is a different way of exploiting that. Dictionary encoding replaces values with indexes into a distinct-value table — the win scales with how few distinct values there are. Run-length encoding replaces repeated runs with (value, count) — the win scales with clustering, which is why sort order and compression are the same subject. Bit-packing stores values in exactly as many bits as the range requires rather than the width the type declares. Frame-of-reference stores a base and small deltas, which is what makes a monotonically increasing timestamp column nearly free.',
      'The grading is round-trip exactness first, because a codec that loses information is not a compression bug, it is a data-loss bug. Then a bound: no encoding may exceed the plain representation by more than its header, which forces you to implement the fallback every real format has — when the data does not compress, stop trying. The storm check runs 2000 seeded columns chosen specifically to embarrass a codec: all-null, all-distinct, single-value, and zipf-distributed. All-distinct is the one that catches people, because a dictionary of every value plus an index per row is *larger* than the original and your implementation has to notice.',
      'Bring nothing forward; this is the first lab. Everything after it uses these bytes: lab 02 puts statistics on top of them, lab 03 executes over them without decoding, and lab 04 reads the real format that standardises them.',
    ],
  },
  {
    id: 'zone-maps',
    index: 2,
    title: 'Learn Not to Read',
    hook: 'Block statistics and a pruning planner — where a false negative is a correctness bug and a false positive is only a bill.',
    trackId: 'c2',
    lessonId: 'c2.l3',
    minutes: 70,
    zip: '/labs/zone-maps.zip',
    artifact: 'target/wasm32-unknown-unknown/release/zone_maps.wasm',
    editFile: 'src/zone_maps.rs',
    completion: {
      title: 'all five green — and not one false negative.',
      next: 'next: lab 03. You have stopped reading bytes; now stop decoding the ones you do read.',
    },
    checks: [
      { id: 'stats_exact', label: 'per-block min/max/null-count exact, including all-null blocks' },
      { id: 'no_false_negatives', label: 'never skips a block that contains a matching row — under every predicate' },
      { id: 'prunes_target', label: 'pruning ratio within band of the reference planner on clustered data' },
      { id: 'null_semantics', label: 'IS NULL / IS NOT NULL and null-vs-predicate handled correctly' },
      { id: 'storm', label: '1500 seeded predicate/layout combinations vs a reference planner' },
    ],
    brief: [
      'A zone map is a few bytes of metadata per block — min, max, null count — and it is the cheapest index in databases: no write-path maintenance beyond the append you were already doing, no tree to keep balanced. The planner\'s job is to compare a predicate against those statistics and decide whether the block could possibly contain a match. If it could not, the block is never read. That is the entire mechanism behind most of the cost difference between a well-laid-out table and a badly laid-out one.',
      'The asymmetry is the lesson, and it is graded as such. Skipping a block that contained a matching row silently returns wrong results: `no_false_negatives` is the check that cannot be argued with, and it is run against every predicate shape including open-ended ranges, negations and null comparisons. Reading a block that turned out to hold nothing is merely wasteful — it costs money, not correctness. So the planner you write must be *conservative when uncertain*, and the pruning-ratio band exists to stop you being trivially conservative by never skipping anything.',
      'Nulls are where implementations break. A block of entirely null values has no meaningful min or max; a predicate like `x > 5` must not match nulls; `IS NULL` must consult the null count rather than the range. Bring your lab 01 encodings forward — the template reads encoded blocks, so your statistics are computed over data you compressed yourself.',
    ],
  },
  {
    id: 'vectorized',
    index: 3,
    title: 'A Batch at a Time',
    hook: 'Selection vectors, a filter, and a hash aggregate over batches — plus the path that computes on compressed data without decoding it.',
    trackId: 'c4',
    lessonId: 'c4.l3',
    minutes: 80,
    zip: '/labs/vectorized.zip',
    artifact: 'target/wasm32-unknown-unknown/release/vectorized.wasm',
    editFile: 'src/vectorized.rs',
    completion: {
      title: 'all five green — and the compressed path agrees with the decoded one.',
      next: 'next: lab 04. Your engine works; now make it read the format the world actually writes.',
    },
    checks: [
      { id: 'filter_matches_scalar', label: 'batched filter produces the same rows as a scalar reference' },
      { id: 'selection_vector', label: 'selection vectors compose across chained predicates without materializing' },
      { id: 'aggregate_correct', label: 'hash aggregate matches reference groups and sums exactly' },
      { id: 'compressed_path', label: 'execute-on-compressed agrees with the decode-then-execute path' },
      { id: 'storm', label: '2000 seeded batches, including partial final batches and empty selections' },
    ],
    brief: [
      'Row-at-a-time execution pays its overhead per tuple: a virtual call, a bounds check, a null check, a branch. Column-at-a-time amortises all of it across a batch, and the resulting loops are tight enough that the compiler can vectorize them. The batch is the unit, the selection vector is how you avoid copying, and late materialization is why an aggregate can consume values by position and never assemble a row at all.',
      'The interesting check is `compressed_path`. Summing a run-length-encoded column is value × count, not a loop over the expanded values. Filtering a dictionary column compares *codes*, so the predicate is evaluated once against the dictionary and then applied as an integer comparison. Both must produce results identical to decoding first — that equivalence is what makes the optimisation safe, and proving it is the exercise.',
      'Edge cases carry the grade: a partial final batch, a selection that survives nothing, a group key that appears in exactly one batch. Bring lab 01 forward for the encodings and lab 02 for the block statistics — by the end of this lab your wasm is a small columnar execution engine.',
    ],
  },
  {
    id: 'parquet-reader',
    index: 4,
    title: 'Read the Real Thing',
    hook: 'Parse a Parquet-shaped footer and read a column chunk — projection means touching only the chunks you asked for, and malformed input means refusing rather than guessing.',
    trackId: 'c3',
    lessonId: 'c3.l2',
    minutes: 80,
    zip: '/labs/parquet-reader.zip',
    artifact: 'target/wasm32-unknown-unknown/release/parquet_reader.wasm',
    editFile: 'src/parquet_reader.rs',
    completion: {
      title: 'all five green — you can read a file written by something that is not you.',
      next: 'next: lab 05. Reading is solved. Now handle the part column stores are bad at: change.',
    },
    checks: [
      { id: 'footer_parse', label: 'magic, footer length and schema parsed from a generated fixture' },
      { id: 'rowgroup_metadata', label: 'row-group and column-chunk offsets, sizes and statistics read correctly' },
      { id: 'projection_reads_minimum', label: 'a two-column projection touches only those column chunks (counted)' },
      { id: 'rejects_malformed', label: 'truncated, wrong-magic and inconsistent-length files are rejected, not guessed at' },
      { id: 'storm', label: '400 seeded read plans across fixtures vs a reference reader' },
    ],
    brief: [
      'Every lab so far let you choose your own layout. This one makes you read someone else\'s, because that is the actual job: an interchange format is a contract you did not write, and a platform that cannot read one is not part of the ecosystem. You will read KSPQ — a Parquet-SHAPED teaching format the harness generates, with the same four levels (file, row group, column chunk, page) and the same end-of-file footer, but without Thrift, page headers, definition and repetition levels, encodings, compression codecs or the index structures. That is deliberate: real Parquet parsing is a week of Thrift plumbing and none of it is the lesson. The template names every omission, so you know exactly what you have and have not built.',
      '`projection_reads_minimum` is graded as a count, not a time: the harness records which byte ranges you requested and asserts that a two-column projection never touched the other chunks. This is the whole promise of columnar storage expressed as a test, and it is easy to fail accidentally by reading a whole row group into memory because it was simpler.',
      '`rejects_malformed` matters more than it looks. A reader that guesses at a truncated footer produces plausible garbage, and plausible garbage in an analytics platform becomes a number in a report. Refuse loudly instead. Bring lab 01 forward for the decoders — real Parquet chunks are encoded with the same families you implemented.',
    ],
  },
  {
    id: 'merge-on-read',
    index: 5,
    title: 'Change Is the Hard Part',
    hook: 'A delta store, a merge, and a compaction policy — with read amplification and write amplification graded in bands under seeded update storms.',
    trackId: 'c5',
    lessonId: 'c5.l3',
    minutes: 90,
    zip: '/labs/merge-on-read.zip',
    artifact: 'target/wasm32-unknown-unknown/release/merge_on_read.wasm',
    editFile: 'src/merge_on_read.rs',
    completion: {
      title: 'all six green — your table accepts change and still answers fast.',
      next: 'next: lab 06. One machine is solved. The bill moves to the network.',
    },
    checks: [
      { id: 'read_your_writes', label: 'a read after a write sees the write, always' },
      { id: 'merge_ordered', label: 'merge output is ordered and duplicate-free across base and delta' },
      { id: 'delete_semantics', label: 'deletes and updates resolve to exactly one visible version per key' },
      { id: 'read_amp_bounded', label: 'read amplification stays within band as the delta grows' },
      { id: 'write_amp_budget', label: 'compaction stays within its stated write-amplification budget' },
      { id: 'storm', label: '3000 seeded mixed read/write/delete operations vs a reference model' },
    ],
    brief: [
      'Columnar layouts are optimised for reading, which makes writing the interesting problem. One updated row cannot be edited in place inside a compressed, statistics-annotated block, so every column store answers the same way: accept the change somewhere cheap and reconcile later. That is a delta store plus a merge on the read path, and the cost you have just deferred is read amplification, which grows with the delta until compaction pays it down.',
      'The two banded checks are the design tension made gradeable. `read_amp_bounded` fails if your merge path degrades as the delta accumulates; `write_amp_budget` fails if your compaction fixes that by rewriting everything constantly. Both passing at once means you found a policy, not a preference — and the policy is the artifact an architect actually ships.',
      '`read_your_writes` is listed first because it is the one that must never bend: a merge that misses the newest version of a key is a correctness bug that looks like a caching problem in production. Bring lab 02 forward for statistics (delta blocks need them too) and lab 03 for the merge execution.',
    ],
  },
  {
    id: 'shuffle',
    index: 6,
    title: 'When the Bill Moves to the Network',
    hook: 'A partitioned hash join with skew handling — join results exact, bytes shuffled in band, and no partition allowed to run away with the job.',
    trackId: 'c6',
    lessonId: 'c6.l3',
    minutes: 90,
    zip: '/labs/shuffle.zip',
    artifact: 'target/wasm32-unknown-unknown/release/shuffle.wasm',
    editFile: 'src/shuffle.rs',
    completion: {
      title: 'all five green — including the skewed key that ruins naive implementations.',
      next: 'next: the architecture half. You have measured all of this; now defend a platform built on it.',
    },
    checks: [
      { id: 'join_correct', label: 'join output matches a reference hash join exactly' },
      { id: 'bytes_shuffled', label: 'bytes moved within band of the reference plan' },
      { id: 'broadcast_choice', label: 'broadcast chosen iff it moves fewer bytes than partitioning, given the stats' },
      { id: 'skew_bounded', label: 'no partition exceeds the per-partition bound on a deliberately skewed key' },
      { id: 'storm', label: '800 seeded join plans across cardinalities and skew profiles' },
    ],
    brief: [
      'On one machine the cost is bytes read. Across machines it becomes bytes moved, and a join is where the moving happens. Two strategies: broadcast the small side to every worker, or partition both sides by the join key so matching rows meet on the same worker. The choice is arithmetic — broadcast moves smallSide × workers, partitioning moves both sides once — and `broadcast_choice` grades that you made it from the statistics rather than by habit.',
      '`skew_bounded` is the check that teaches the real lesson. Hash partitioning distributes keys evenly, not rows: a single value holding a large share of the rows lands entirely in one partition, and that partition is the runtime of the whole job no matter how many workers you have. The harness hands you a deliberately skewed key distribution and asserts no partition exceeds the bound, which forces you to detect the heavy hitter and split it.',
      'Cost is graded as bytes moved, not seconds, because a count means the same thing on every machine — the same principle that has held since lab 01. Bring lab 03 forward for the batched execution and lab 05 for the merge; this is the last forge lab, and by the end your artifacts have covered the whole engine half.',
    ],
  },
]

export function forgeLab(id: string): ForgeLab | undefined {
  return FORGE_LABS.find((l) => l.id === id)
}

export const forgeLabsForTrack = (trackId: TrackId): ForgeLab[] =>
  FORGE_LABS.filter((l) => l.trackId === trackId)
