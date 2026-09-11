import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c1.l3',
  slug: 'bit-packing-and-frame-of-reference',
  trackId: 'c1',
  index: 3,
  title: 'Bit-Packing and the Frame of Reference',
  minutes: 18,
  hook: 'A type width is a promise about the worst case. Your column is a fact. Every bit between the two is a bit you pay to read and never use.',
  exercise: 'lab+quiz',
  takeaway: {
    number: '10 bits, not 64',
    claim:
      'Bit-packing charges you for the range the data actually spans rather than the width the type reserved, and on a 0..999 column that is 6.4× before any general-purpose compressor is involved.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Dictionary and run-length encoding both exploit **cardinality** — how few distinct values there are, and how tidily they clump. The two codecs in this lesson exploit something else entirely: **range**. They do not care how many distinct values a column holds. They care how far apart the smallest and the largest are.

That distinction matters because it is where the two codecs win on columns the first two cannot touch. A column of 4,096 random values in \`0..999\` has nearly a thousand distinct values and no runs at all — dictionary and RLE both give up. Bit-packing does not, because the *range* is 1,000 wide even though the *cardinality* is high.

Both codecs are graded by forge **lab 01**, and this lesson fronts its two hardest checks: \`bitpack_roundtrip\`, which compares your bit stream against the harness's own word for word at every width from 1 to 64, and \`for_roundtrip\`, which runs a column holding both \`i64::MIN\` and \`i64::MAX\` through your frame. Then it closes on \`never_expands\`, which is the check that stops all of this being a lie.`,
    },
    {
      type: 'prose',
      md: `## The type width is a promise, not a measurement

When you declare a column \`BIGINT\`, you are not describing your data. You are reserving enough room for the worst value the type permits — roughly ±9.2 quintillion — because the type system has to be right for every possible future row. That reservation is a contract about the *worst case*, and it is renegotiable per block once the block is written and you can see what is inside it.

Take a real column: a \`status_code\` or a \`quantity\` or a \`latency_ms\`, values spanning \`0..999\`. The smallest \`w\` with \`999 < 2^w\` is **10**, because 2^10 is 1,024. So each value needs 10 bits, and the other 54 are storing a guarantee nobody in this block is using.

Run the arithmetic at a size worth caring about — **2,000,000 values**:

- plain: 2,000,000 × 8 B = **16,000,000 B** (16 MB)
- bit-packed at 10 bits: ⌈2,000,000 × 10 / 64⌉ = **312,500 words** × 8 B = **2,500,000 B** (2.5 MB)

That is **6.4×**, and it is not a compression algorithm in any interesting sense — there is no model, no entropy coding, no dictionary. It is arithmetic on the width. Which is exactly why it is the codec you can predict before running anything: hand me the min and the max and I will tell you the byte count.

One tempting shortcut costs most of the win. If you round 10 bits up to a byte boundary — 16 bits, so that every value starts somewhere addressable — you get 4,000,000 B instead of 2,500,000 B. **1.6× more bytes for the convenience of not doing shifts.** The lab does not allow it: \`bitpack_roundtrip\` computes the width as "the smallest that holds the max, no rounding to bytes" and compares your words against the reference, so a byte-aligned stream fails at width 10 the same way a wrong value does.`,
    },
    {
      type: 'prose',
      md: `## Where implementations die: the word boundary

If values are 10 bits and words are 64, then values do not divide into words. Value 0 occupies bits 0–9, value 6 occupies bits 60–69 — **four bits in \`words[0]\` and six in \`words[1]\`**. The stream is a bit stream, not an array of fields, and the harness pins the layout LSB-first precisely so that two independent implementations of this lab can read each other's blocks.

Three lines of that primitive are where implementations actually break, and \`bitpack_roundtrip\` is built to find each one:

1. **The carry only sometimes exists.** You write into \`words[bit / 64]\`, and you write the remainder into \`words[bit / 64 + 1]\` *only when* \`bit % 64 + width > 64\`. Write it unconditionally and you index past the end of the vector on the final value; forget it and every straddling value is truncated. The check runs **n = 97** values at every width for exactly this reason — 97 × w is almost never a multiple of 64, so the last word is always partial.
2. **Width 64 needs its own mask.** \`1u64 << 64\` is not 0; it is undefined behaviour that panics in debug and wraps in release. The bit-packing codec caps at 32 bits, but the same \`pack\`/\`unpack\` primitive is graded at **1..=64**, because frame-of-reference deltas can need all 64 — and the check's failure message tells you so before you have finished reading it.
3. **\`len\` is the only authority.** Trailing bits in the last word are not data. \`unpack(words, width, 0)\` must return an empty vector even when \`words\` is full of bits, and every unused trailing bit must be **zero** on write, or your words differ from the reference even though your round-trip passes.

There is a fourth, quieter one. An empty column must encode as \`BitPack { width: 1, len: 0, words: [] }\` — **width 1, not width 0.** A column of nothing, or a column of nothing but zeroes, still has to declare a legal width, because zero has no meaning downstream: nothing can be read at a field size of zero bits.

And the codec has a **declared domain**: unsigned 32-bit, so \`0..=u32::MAX\`. A negative value, \`i64::MIN\`, \`i64::MAX\`, or anything one past \`u32::MAX\` must come back as \`None\`. Not clamped, not truncated, not "close enough" — refused. \`bitpack_encode\` returning \`Some\` for \`[1, -1]\` is silent corruption, and the harness fails it with the note that frame-of-reference is the codec for that column.`,
    },
    {
      type: 'code',
      filename: 'labs/encodings/src/encodings.rs',
      lang: 'rust',
      chips: ['lab 01 · the only file you edit', 'LSB-first', 'pack graded at widths 1..=64'],
      code: `// the width is a fact about the block, derived once, stored once
pub fn bits_needed(max: u64) -> u32;          // bits_needed(999) == 10, bits_needed(0) == 1

// the primitive under BOTH codecs. graded word-for-word against the harness.
//   value i occupies bits [i*w, (i+1)*w) of one contiguous stream
//   words.len() == ceil(n*w / 64), and every trailing bit is ZERO
//   the carry into words[k+1] exists only when bit % 64 + w > 64
pub fn pack(values: &[u64], width: u32) -> Vec<u64>;
pub fn unpack(words: &[u64], width: u32, len: usize) -> Vec<u64>;

// domain: 0..=u32::MAX, so width in 1..=32. Outside it, say None.
pub fn bitpack_encode(values: &[i64]) -> Option<Encoded>;

// base is the column MINIMUM. deltas are UNSIGNED. width in 1..=64.
pub fn for_encode(values: &[i64]) -> Encoded;

// the tape measure is GIVEN, and the grader keeps its own copy:
//   HEADER                       = 8
//   Plain   { values }           = HEADER + 8*n + ceil(n/8) if any value is NULL
//   BitPack { width, len, words } = HEADER + 8*words.len()
//   For     { base, .., words }   = HEADER + 8 + 8*words.len()   // the base costs 8 B, always`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — 64 bits of promise, 10 bits of data, and one straddle',
      height: 72,
      nodes: [
        { id: 'declared', x: 2, y: 2, w: 96, h: 9, label: 'declared: BIGINT / i64', sub: '64 bits × 2,000,000 values = 16 MB', color: '#FB7185' },
        { id: 'range', x: 2, y: 15, w: 30, h: 9, label: 'observed range', sub: 'min 0 · max 999', color: '#A3E635' },
        { id: 'width', x: 35, y: 15, w: 30, h: 9, label: 'width = bits_needed(999)', sub: '999 < 2^10 → 10 bits', color: '#3EF2A4' },
        { id: 'packed', x: 68, y: 15, w: 30, h: 9, label: 'packed stream', sub: '312,500 words = 2.5 MB', color: '#3EF2A4' },
        { id: 'w0', x: 2, y: 28, w: 22, h: 10, label: 'words[0]', sub: 'values 0–5, then 4 bits of value 6', color: '#22D3EE' },
        { id: 'straddle', x: 26, y: 28, w: 22, h: 10, label: 'the straddle', sub: 'value 6 = bits 60..70', color: '#FBBF24' },
        { id: 'w1', x: 50, y: 28, w: 22, h: 10, label: 'words[1]', sub: 'the carry, then values 7–12', color: '#22D3EE' },
        { id: 'tail', x: 74, y: 28, w: 24, h: 10, label: 'trailing bits = 0', sub: 'len is the only authority', color: '#94A3B8' },
        { id: 'base', x: 2, y: 42, w: 30, h: 10, label: 'FOR: base = min', sub: 'one i64 · 8 B · always paid', color: '#A78BFA' },
        { id: 'deltas', x: 35, y: 42, w: 30, h: 10, label: 'unsigned deltas', sub: 'wrapping_sub on u64', color: '#A78BFA' },
        { id: 'packfor', x: 68, y: 42, w: 30, h: 10, label: 'pack(deltas, ~17)', sub: '4096 stamps ≈ 8.7 kB', color: '#A78BFA' },
        { id: 'cands', x: 2, y: 56, w: 46, h: 10, label: 'size all five candidates', sub: 'plain · dict · rle · bitpack · for', color: '#FDE047' },
        { id: 'fallback', x: 50, y: 56, w: 48, h: 10, label: 'smallest wins — sometimes Plain', sub: 'the bound: never above plain + header', color: '#FDE047' },
      ],
      edges: [
        { from: 'declared', to: 'range', label: 'measure the block' },
        { from: 'range', to: 'width' },
        { from: 'width', to: 'packed' },
        { from: 'packed', to: 'w0' },
        { from: 'w0', to: 'straddle' },
        { from: 'straddle', to: 'w1', label: 'carry when bit%64 + w > 64' },
        { from: 'w1', to: 'tail' },
        { from: 'declared', to: 'base', label: 'huge values, tiny spread' },
        { from: 'base', to: 'deltas' },
        { from: 'deltas', to: 'packfor' },
        { from: 'packfor', to: 'cands' },
        { from: 'packed', to: 'cands' },
        { from: 'cands', to: 'fallback' },
      ],
      steps: [
        {
          caption:
            'The declared type reserves 64 bits per value because it must hold every value the type permits. At two million values that reservation is 16 MB, and almost none of it is carrying information about this particular block.',
          active: ['declared'],
        },
        {
          caption:
            'Read the block instead of the schema: min 0, max 999. The smallest width that holds 999 is 10 bits, because 999 is below 2^10. This is the only measurement bit-packing needs, and it is why the byte count is predictable before you run anything.',
          active: ['range', 'width', 'packed'],
          edges: ['declared->range', 'range->width', 'width->packed'],
        },
        {
          caption:
            'Ten does not divide sixty-four, so the stream is bits and not fields. Value 6 begins at bit 60 and ends at bit 70: four bits live in words[0] and six in words[1]. The carry into the next word exists only when bit%64 + width exceeds 64 — write it unconditionally and the last value indexes past the end.',
          active: ['w0', 'straddle', 'w1', 'tail'],
          edges: ['packed->w0', 'w0->straddle', 'straddle->w1', 'w1->tail'],
        },
        {
          caption:
            'A timestamp column defeats bit-packing outright: the values need 41 bits each and they are all enormous. Frame-of-reference stores the minimum once and packs unsigned deltas from it — the values are big, their spread is not, and 4096 seeded stamps land near 8.7 kB against 32.8 kB plain.',
          active: ['base', 'deltas', 'packfor'],
          edges: ['declared->base', 'base->deltas', 'deltas->packfor'],
        },
        {
          caption:
            'Then the honest part. The chooser sizes all five candidates and returns the smallest, which means Plain is always in the running and the encoded block can never exceed plain plus its header. On 2048 random 64-bit values every codec loses and Plain is the correct answer.',
          active: ['cands', 'fallback'],
          edges: ['packed->cands', 'packfor->cands', 'cands->fallback'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'segfault',
      title: 'the two shifts that kill this lab',
      md: `\`1u64 << 64\` is undefined in Rust: it panics in a debug build and wraps to 1 in a release build. So the mask for width 64 cannot be written \`(1u64 << width) - 1\` — it needs its own branch to \`u64::MAX\`. You will meet this even though the bit-packing codec stops at 32 bits, because \`pack\` and \`unpack\` are graded at every width **1..=64** for frame-of-reference's benefit.

The second is \`words[w + 1]\` when the straddle does not exist. Guard it with the same condition that creates it — \`off + width > 64\` — and both the panic and the truncation go away together.

Neither of these is a compression bug. They are a correctness bug that reports itself as a compression bug, which is the worst failure mode in this whole subject: the block is smaller and the values are wrong.`,
    },
    {
      type: 'prose',
      md: `## Frame of reference: subtract the boring part

Bit-packing fails completely on the most common column in analytics. A millisecond epoch timestamp is about 1.7 × 10^12, which needs **41 bits** per value, and it is negative-free but nowhere near a narrow range in absolute terms. Width 41 on a 64-bit type saves you a third and no more.

But look at what a timestamp column actually *is*: a huge number, repeated with small variations. Store the frame once and the variations per value:

\`\`\`
base   = min(values)                         one i64, 8 bytes, paid once
delta  = (v as u64).wrapping_sub(base as u64)   unsigned, so no sign bit
width  = bits_needed(max delta)
words  = pack(deltas, width)
\`\`\`

The lab's seeded timestamp generator steps forward by 0..59 ms per row. Over **4,096 rows** that is a spread of roughly 120,000 — redo it: 4,095 steps × ~29.5 mean ≈ 121,000, and 121,000 < 2^17, so **17 bits**. Then ⌈4,096 × 17 / 64⌉ = 1,088 words, and the encoded block is 8 + 8 + 8,704 = **≈8.7 kB against 32.8 kB plain**, about 3.8×. That figure is arithmetic from the generator rather than a measurement, and your exact width may land at 17 or 18 depending on the draw — but the ceiling is not vague at all. \`for_roundtrip\` fails you if the block is more than a third of plain, which is **10,925 B**, and computing the width from the values instead of the deltas gives 41 bits, 2,624 words, **21,008 B** — a clean, immediate failure. The check's message even tells you which mistake you made.

The same 10,925 B ceiling shows up again in \`never_expands\` as the budget on the monotone column, stated there as \`(HEADER + 8 × 4096) / 3\`. Two checks, one number, because falling back to Plain on a column with obvious structure stays inside the bound and wastes the codec.

**41 bits of value, 17 bits of spread.** That gap is the whole codec, and it is why frame-of-reference then composes with bit-packing rather than competing with it: FOR's job is to make the numbers small, and packing's job is to stop paying for the bits they no longer need.`,
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the two traps for_roundtrip is built to catch',
      md: `**Trap one: base is the minimum, not the first value.** They are the same thing on an ascending column and nothing alike on a descending one. Set \`base\` to \`values[0]\` on \`(0..500).map(|i| 1_000_000 - i * 7)\` and every delta after the first is negative — and an unsigned bit stream has nowhere to put a sign. Clamping the negatives to zero passes your own round-trip on ascending test data and silently destroys every descending column in production. The harness pins \`base\` to the minimum and says why: it is what makes every delta non-negative for every column in existence.

**Trap two: \`max - min\` overflows.** A column holding both \`i64::MIN\` and \`i64::MAX\` spans more than \`i64\` can express, so the subtraction that computes your width panics in debug and produces garbage in release. The fix is one cast: \`(v as u64).wrapping_sub(base as u64)\`. In two's complement that is the *true* distance whenever \`v >= base\`, for every pair of i64 there is — and decode reverses it with \`wrapping_add\`. \`for_roundtrip\` runs \`[i64::MIN, i64::MAX]\`, \`[i64::MAX, 0, i64::MIN]\`, three values adjacent to the floor and three adjacent to the ceiling, precisely so that "it worked on my timestamps" is not a passing grade.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '6.4×',
          label: 'bit-packing a 0..999 column',
          hint: '2,000,000 values at 64 bits is 16,000,000 B; at 10 bits it is ceil(2e6 × 10 / 64) = 312,500 words = 2,500,000 B. Redo it on your own column with min and max.',
        },
        {
          value: '520 B',
          label: 'the budget on 4,096 flags',
          hint: 'HEADER + 8 × 64 words — exactly the width-1 packed size, with zero slack. A byte per flag (4,096 B) fails; a dictionary with 4-byte codes (16,408 B) fails by 31×.',
        },
        {
          value: '41 → 17 bits',
          label: 'value width versus delta width',
          hint: 'A millisecond epoch stamp needs 41 bits. The spread of 4,096 consecutive stamps needs about 17. Frame-of-reference charges you for the second number.',
        },
        {
          value: '+8 B',
          label: 'what a frame costs when it loses',
          hint: 'On 1,000 values alternating i64::MIN and i64::MAX the deltas need all 64 bits, so For is plain plus the base: 8,016 B against 8,008 B. It expands, and the chooser must notice.',
        },
      ],
    },
    {
      type: 'prose',
      md: `## never_expands: a codec that cannot decline is a bug

Everything above is a claim about a *shape* of data. Point any of these codecs at the wrong column and it makes the block **bigger**, and the numbers are small enough to be embarrassing:

| column (from the harness) | what the wrong codec does | plain |
|---|---|---|
| 1,000 × alternating \`i64::MIN\`/\`i64::MAX\` | For: deltas need 64 bits → 8 + 8 + 8,000 = **8,016 B** | 8,008 B |
| 2,048 random 64-bit values | For: 64-bit deltas → 16 + 16,384 = **16,400 B** | 16,392 B |
| 2,048 random 64-bit values | Dict: 8 + 8×2,048 + 4×2,048 = **24,584 B** | 16,392 B |
| 4,096 values in \`0..5\` | For: min is already 0 → **1,552 B** vs bit-packing's 1,544 B | 32,776 B |

Read the first two rows again: frame-of-reference loses by **exactly 8 bytes**, which is the base it insisted on writing. That is the entire penalty, and it is unavoidable — the base is in the format. The fourth row is the same 8 bytes appearing as a rounding error rather than a disaster, because when the minimum is already zero, a frame is just bit-packing with a wasted word.

So the chooser's contract is not "compress the column". It is: **size all five candidates and return the smallest.** Plain, Dict and Rle always; BitPack and For only when the column contains no null, because a packed stream has nowhere to put one. Because Plain is always a candidate, the encoded block can never exceed \`plain_size\`, and that is the complete content of \`never_expands\`.

The bound is worth stating precisely, because "we never expand data" is the kind of thing people say loosely and then cannot defend. The honest form is **plain plus a header**: \`HEADER\` (8 bytes of framing) + 8 bytes per value + a validity bitmap of ⌈n/8⌉ bytes *only when the column actually contains a null*. Nothing else. An empty column is 8 bytes. And the check is not satisfied by cowardice either — it also asserts your chosen size **equals** the best of the five candidates, so "always fall back to Plain" fails on the flags column, on the 6-distinct column and on the timestamps, each of which carries its own byte budget.

Every real format works this way. Parquet falls back to plain pages; ORC falls back to direct encoding. "Compressed" is a claim you check, and the check has a fallback branch.`,
    },
    {
      type: 'isomorphism',
      title: 'range codecs ≡ three things you already do',
      pairs: [
        {
          os: 'a C bitfield',
          osLine:
            'You write `unsigned flags : 3` because you know the field holds 0..7, and the compiler packs several into one word.',
          llm: 'bit-packing a column',
          llmLine:
            'Same idea, decided per block from measured min/max instead of per struct at compile time — so it adapts when a block genuinely needs more bits.',
        },
        {
          os: 'base-plus-offset addressing',
          osLine:
            'A relocatable binary stores a base address once and 32-bit offsets from it, rather than 64-bit absolute pointers everywhere.',
          llm: 'frame of reference',
          llmLine:
            'Stores the column minimum once and small unsigned deltas from it. The values are enormous; the distances between them are not.',
        },
        {
          os: 'Content-Encoding: identity',
          osLine:
            'A server that gzips an already-compressed JPEG makes the response larger, so the correct answer is sometimes to send it unchanged.',
          llm: 'the Plain fallback',
          llmLine:
            'A codec that cannot decline is a bug. `never_expands` is the machine-checkable version of knowing when to send the bytes as they are.',
        },
      ],
    },
    {
      type: 'prose',
      md: `## What this lets you say in a review, and what it does not

The useful sentence out of this lesson is not "we use bit-packing". It is: **"I can predict this column's encoded size from its min and its max, and here is the arithmetic."** Range codecs are the only ones in C1 whose ratio you can compute exactly before running anything — dictionary depends on cardinality you have to count, RLE depends on clustering you have to measure, but width follows from two numbers that any statistics query will hand you.

Now state the caveat first, because it is a real one. **The width is a property of a block, not of a column.** Every number above assumed a block whose values genuinely span 0..999 or step by 0..59 ms. One outlier — a sentinel −1, a bad epoch conversion producing a year-9999 timestamp, a backfill that writes a different unit into the same field — and \`bits_needed(max)\` jumps for the *whole block*, taking the ratio with it. That is not a hypothetical: a single \`i64::MIN\` sentinel in a non-null integer column pushes a frame's delta width to 64 and turns a 3.8× win into an 8-byte loss, and nothing in the pipeline will report it as anything other than "compression got worse".

And a second caveat, which is the one that catches people who have just learned this material: **a format defining an encoding does not mean your writer emits it.** Parquet specifies \`DELTA_BINARY_PACKED\`, which is exactly the frame-of-reference construction above. It does not follow that your timestamps arrive delta-encoded. Run the codec bench in C1.L1 and you will find a strictly monotonic timestamp column compressing at roughly **1.1×** — because the writer in that lab emits \`PLAIN\` for \`TIMESTAMP\` and leaves the rest to a general-purpose byte compressor, which finds very little in eight-byte integers whose low bytes all differ.

So the codec you wrote here is real, its arithmetic is right, and it would crush that column. Whether anything in your pipeline actually applies it is a separate, checkable question — and the answer is in the footer, not in the specification. Read the \`encodings\` field of your own files before quoting any of these ratios.

Which means the operational form of this lesson is: **encode per block, choose per block, and alert on the chosen codec changing** rather than on the ratio. A block that silently switched from For to Plain is telling you the data changed shape, and that is a more useful signal than any percentage. C2 then puts min/max statistics on top of these same blocks — the same two numbers, used to skip reads rather than to shrink them — and lab 03 executes over them without decoding at all.`,
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A colleague implements frame-of-reference with base = values[0] because "the first value is the frame". The timestamp columns all pass. Which production column breaks, and how?',
          options: [
            'None — for an ascending column the first value is the minimum, so the two definitions agree',
            'Any descending or unordered column: deltas below the base come out negative, and an unsigned bit stream cannot hold them — so they are either clamped (silent data loss) or wrapped into 64-bit-wide deltas (the block expands)',
            'Only nullable columns, because a null has no delta',
            'Only columns wider than 32 bits, since the packing primitive stops at 32',
          ],
          correct: [1],
          explanation:
            'Base must be the column minimum, which is the definition that makes every delta non-negative for every column that exists. On an ascending column the two definitions coincide, which is exactly why the bug ships: the test data hides it. A descending column then either loses values to clamping or produces near-u64::MAX deltas that force width 64, so the block ends up plain-plus-eight-bytes. The lab grades the descending case and the base directly, not just the round-trip.',
        },
        {
          q: 'A column of 4,096 boolean flags has 2 distinct values. The lab requires the encoded block to be at most 520 bytes. Why does dictionary encoding — the codec for low cardinality — fail this budget?',
          options: [
            'Because the dictionary must store nulls, which doubles its size',
            'Because a dictionary charges a 4-byte code per row regardless of cardinality: 8 + 8×2 + 4×4,096 = 16,408 B, while bit-packing at width 1 needs 4,096 bits = 64 words = 520 B with the header',
            'Because dictionary encoding cannot represent boolean values',
            'Because the dictionary has to be rebuilt per block, and the rebuild cost exceeds the budget',
          ],
          correct: [1],
          explanation:
            'Cardinality tells you how big the dictionary is, not how big the codes are — and the codes are the dominant term at 4 bytes per row, 32 times wider than the 1 bit this column actually needs. Two distinct values is the strongest possible case for a dictionary by cardinality and it still loses by 31×, which is the general lesson: choose on computed bytes, never on which property of the column you noticed first. The 520 B budget is exactly HEADER + 8×64, so there is no slack for byte-aligning the fields either.',
        },
        {
          q: 'After enabling encoding on a table whose main column is a random 64-bit surrogate key, stored bytes went UP and the team is being asked why. What is the correct diagnosis and fix?',
          options: [
            'Increase the compression level so the codec has more budget to find structure',
            'Re-sort the table on the key so that run-length encoding has runs to find',
            'The codec has no decline path. On all-distinct 64-bit values a dictionary is 24,584 B against 16,392 B plain and a frame needs 64-bit deltas — every candidate loses, so the writer must size them all and emit Plain, whose worst case is plain plus a header',
            'Accept it: encoding metadata always adds a fixed overhead, and the ratio recovers at larger scale',
          ],
          correct: [2],
          explanation:
            'A random surrogate key has maximum cardinality, no clustering and no exploitable range, so there is nothing for any of the four codecs to exploit — and both dictionary and frame-of-reference actively expand it, the dictionary by storing every value plus a 4-byte code per row and the frame by paying 8 bytes for a base whose deltas still need all 64 bits. The fix is the fallback, and the defensible bound to quote is plain plus a header rather than a ratio. Sorting on a unique key gives runs of length one, so RLE goes to 12 bytes per value and makes it worse; raising a compression level cannot manufacture structure that is not there.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: where these two codecs come from',
      md: `Frame-of-reference is named and analysed in **Goldstein, Ramakrishnan and Shaft, "Compressing Relations and Indexes" (ICDE 1998)** — the paper that made the argument in this lesson explicitly: store a frame per block and code each value as an offset within it, so the width follows the block's range rather than the type's.

The industrial-strength version is **Zukowski, Héman, Nes and Boncz, "Super-Scalar RAM-CPU Cache Compression" (ICDE 2006)**, from the MonetDB/X100 line. It introduces PFOR, PFOR-DELTA and PDICT, and its central move is the *exception mechanism*: rather than letting one outlier widen the whole block, code the common case narrowly and store the rare wide values in a patch list. That is the direct answer to the caveat this lesson closes on, and it is worth reading immediately after you finish lab 01, because it is the next thing you would build.

For decode throughput — where the shifts stop being incidental — **Lemire and Boytsov, "Decoding billions of integers per second through vectorization" (2015)** benchmarks SIMD bit-unpacking schemes, and **Lemire, Kurz and Rupp on "Stream VByte"** covers the variable-length alternative. For why any of this composes with query execution instead of just storage, **Abadi, Madden and Ferreira, "Integrating Compression and Execution in Column-Oriented Database Systems" (SIGMOD 2006)** is the one to read, and it is the paper behind lab 03.

Then read the standardised forms of exactly what you just wrote: the **Apache Parquet encodings specification** — \`RLE_DICTIONARY\`, the RLE/bit-packing hybrid, and \`DELTA_BINARY_PACKED\`, which is frame-of-reference applied per mini-block with its own per-block width — and **Apache ORC's** integer encodings, which make a different bet with SHORT_REPEAT, DIRECT, PATCHED_BASE and DELTA. PATCHED_BASE is PFOR's exception mechanism shipped in a format you can read today.

If you have done vectorspace, note the difference rather than the similarity: quantization spends accuracy to shrink a value and needs an error budget. Bit-packing spends nothing, because the bits it removes were never carrying information — which is why \`bitpack_roundtrip\` can demand byte-exactness and a quantizer cannot.`,
    },
  ],
}

export default lesson
