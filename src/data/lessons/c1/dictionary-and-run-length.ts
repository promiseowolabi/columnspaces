import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c1.l2',
  slug: 'dictionary-and-run-length',
  trackId: 'c1',
  index: 2,
  title: 'Dictionary and Run-Length',
  minutes: 16,
  hook: 'A column with one distinct value is the best case a dictionary can ever see, and the dictionary gets 2× on it. Run-length gets 1,639× on the same bytes. Cardinality tells you which codec applies; adjacency tells you what you get.',
  exercise: 'lab+quiz',
  artifact: 'layout-design',
  takeaway: {
    number: 'd < n/2',
    claim:
      'Dictionary encoding only pays when distinct values are fewer than half the rows, and its ceiling is 2× however low the cardinality goes — while run-length on a one-distinct-value column reaches 1,639×, because the win is physical adjacency rather than cardinality.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Both codecs in this lesson are two lines of arithmetic, and forge lab 01 pins both formulas so there is nothing to argue about. \`HEADER\` is 8 bytes of framing, \`n\` is rows, \`d\` is distinct values, \`r\` is maximal runs:

\`\`\`text
  plain   =  HEADER + 8·n            (+ ⌈n/8⌉ if the column has a null)
  dict    =  HEADER + 8·d  + 4·n     a distinct-value table, plus one code per row
  rle     =  HEADER + 12·r           one (value, count) pair per run
\`\`\`

Set them against each other and the whole lesson falls out.

**Dictionary beats plain when \`8d + 4n < 8n\`, which is \`d < n/2\`.** Distinct values fewer than half the rows. That is the number to carry: not "dictionary is for low-cardinality columns" — *fewer than half the rows*, in this block, at this size.

**Dictionary's ceiling is exactly 2×.** Drive \`d\` to 1 and the cost converges on \`4n\`: one code per row, four bytes each, against eight bytes per value. A code is half a value, so half the bytes is all you can ever win. A column of one repeated value — the best case that exists — encodes at 1.99×.

**RLE beats plain when \`12r < 8n\`, which is \`r < 2n/3\`:** mean run length above 1.5. And RLE has **no ceiling.** A 4,096-row constant column is one run: \`8 + 12 = 20 B\` against 32,776 B plain, **1,639×**. The same column through a dictionary is \`8 + 8 + 16,384 = 16,400 B\`, **2.03×**.

Sit with that pair. Identical column. Cardinality of one — the most compressible cardinality possible. **2.03× versus 1,639×.** Cardinality decided that a dictionary *applied*; it said nothing about the size of the win. What decided the win was that the equal values were physically next to each other.`,
    },
    {
      type: 'prose',
      md: `## Dictionary: an inlined foreign key, and the case where it loses

The mechanism is one pass. Keep a map from value to code; a value seen for the first time is appended to the dictionary and takes the next code; every row emits its code. \`codes.len() == n\` always, and NULL is a dictionary entry like any other value rather than a flag beside the stream.

Decode is an array index per row, which is the operationally interesting part: it is cheap, it is branch-free, and — the point C4 builds on — a predicate like \`status = 'refunded'\` can be evaluated **once against the dictionary** and then applied as an integer comparison against the codes. You never materialise a string. That is why dictionary encoding is the most valuable codec in practice even though its ratio ceiling is the lowest of the four.

Now the loss, because this is the one people get wrong in review.

Take 2,048 rows of distinct 64-bit values — the shape of an event id, a hash, a high-resolution timestamp in a small block:

\`\`\`text
  plain  =  8 + 8·2048              =  16,392 B
  dict   =  8 + 8·2048 + 4·2048     =  24,584 B     ← 1.50× LARGER
\`\`\`

You stored **every value, in full, in the dictionary** — that is what \`d = n\` means — and then added a 4-byte code per row on top. The result is exactly \`1.5 × plain\` and it will be for any all-distinct column, at any size, forever. The arithmetic is not subtle. What makes it a real bug is that the encoder does not feel any different while it is happening: the map fills, codes get emitted, everything round-trips perfectly. It is a correct dictionary of a column that should not have one.

So every real format carries a fallback, and the fallback is the actual engineering. Forge lab 01's chooser considers exactly five candidates and returns the smallest, with Plain always among them — which is what makes "the encoding is never larger than plain" a *provable* property rather than a hope. The \`never_expands\` check enforces the bound, and it also asserts the sharper thing: on 2,048 distinct full-range values, \`encode_column\` **must** return \`Plain\`. Staying inside the bound by accident is not enough; you have to pick the winner among all five.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — one column, four encodings, and the sort that changes the answer',
      height: 68,
      nodes: [
        { id: 'col', x: 22, y: 2, w: 56, h: 9, label: 'one column · n = 1,000 · d = 2', sub: 'a flag, in arrival order', color: '#A3E635' },
        { id: 'plain', x: 2, y: 15, w: 22, h: 9, label: 'Plain', sub: 'the baseline', color: '#94A3B8' },
        { id: 'dict', x: 27, y: 15, w: 22, h: 9, label: 'Dict', sub: 'd = 2', color: '#22D3EE' },
        { id: 'rleA', x: 52, y: 15, w: 22, h: 9, label: 'Rle · as written', sub: 'r = 1,000', color: '#FB7185' },
        { id: 'rleB', x: 77, y: 15, w: 21, h: 9, label: 'Rle · sorted', sub: 'r = 2', color: '#3EF2A4' },
        { id: 'szP', x: 2, y: 28, w: 22, h: 8, label: '8,008 B', sub: '1.0×', color: '#94A3B8' },
        { id: 'szD', x: 27, y: 28, w: 22, h: 8, label: '4,024 B', sub: '1.99×', color: '#22D3EE' },
        { id: 'szR', x: 52, y: 28, w: 22, h: 8, label: '12,008 B', sub: '1.5× LARGER', color: '#FB7185' },
        { id: 'szS', x: 77, y: 28, w: 21, h: 8, label: '32 B', sub: '250×', color: '#3EF2A4' },
        { id: 'cross', x: 2, y: 40, w: 47, h: 9, label: 'the crossover: d < n/2', sub: 'and a 2× ceiling, because a code is half a value', color: '#22D3EE' },
        { id: 'sort', x: 52, y: 40, w: 46, h: 9, label: 'the lever: physical order', sub: '375× between the same two RLE encodings', color: '#3EF2A4' },
        { id: 'fb', x: 14, y: 53, w: 72, h: 10, label: 'Plain is always a candidate', sub: 'so the chosen encoding can never exceed it — never_expands', color: '#FBBF24' },
      ],
      edges: [
        { from: 'col', to: 'plain' },
        { from: 'col', to: 'dict' },
        { from: 'col', to: 'rleA' },
        { from: 'col', to: 'rleB', label: 'ORDER BY' },
        { from: 'plain', to: 'szP' },
        { from: 'dict', to: 'szD' },
        { from: 'rleA', to: 'szR' },
        { from: 'rleB', to: 'szS' },
        { from: 'szD', to: 'cross' },
        { from: 'szR', to: 'sort' },
        { from: 'szS', to: 'sort' },
        { from: 'cross', to: 'fb' },
        { from: 'sort', to: 'fb' },
      ],
      steps: [
        {
          caption:
            'One column: a thousand rows holding two distinct values, a flag, in the order the loader happened to write them. Every encoding below sees these identical bytes, and the information content never changes.',
          active: ['col'],
        },
        {
          caption:
            'Plain is the baseline and the mandatory fallback: eight bytes per value plus framing, 8,008 bytes, and no assumption whatsoever about the shape of the data. Every ratio in this course is measured against this number.',
          active: ['plain', 'szP'],
          edges: ['col->plain', 'plain->szP'],
        },
        {
          caption:
            'The dictionary holds two eight-byte entries and a four-byte code per row: 4,024 bytes, 1.99×. That is essentially the ceiling — with cardinality two out of a thousand you are already at the limit, because the limit is set by the code width and not by the cardinality.',
          active: ['dict', 'szD', 'cross'],
          edges: ['col->dict', 'dict->szD', 'szD->cross'],
        },
        {
          caption:
            'Run-length on the same column as written: the two values alternate, so every run is one element long, a thousand runs at twelve bytes each. 12,008 bytes — half again LARGER than plain, on a column whose cardinality is two. This is why cardinality alone cannot pick a codec.',
          active: ['rleA', 'szR'],
          edges: ['col->rleA', 'rleA->szR'],
        },
        {
          caption:
            'Sort the same thousand values and run-length finds two runs: 32 bytes, 250×. Nothing was added, nothing was configured, no codec changed — only the physical order, which is the identical lever C0.L4 measured for pruning. Sort order and compression are one subject.',
          active: ['rleB', 'szS', 'sort'],
          edges: ['col->rleB', 'rleB->szS', 'szS->sort', 'szR->sort'],
        },
        {
          caption:
            'And because Plain sits in the candidate set on every column, the chooser can never return something larger than it. That bound is what forge lab 01 grades as never_expands, and it is the only reason the word "compressed" can be trusted.',
          active: ['fb'],
          edges: ['cross->fb', 'sort->fb'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## Run-length: the codec that grades your sort key

RLE stores \`(value, count)\` pairs and the run must be **maximal** — after encoding, no two adjacent runs hold equal values. That invariant is what makes RLE a *canonical form*: a run count is a fact about the column, not about your implementation, so two encoders must agree on the same input. Forge lab 01 grades the run vector itself and not merely the round-trip, for exactly that reason.

The consequence is that RLE has no independent existence as a tuning decision. Its ratio is \`8n / 12r\`, and \`r\` is decided entirely by physical order:

| the same 1,000-value flag column | runs | rle size | vs plain |
|---|---|---|---|
| as written (values alternate) | 1,000 | 12,008 B | **1.5× larger** |
| clustered in blocks of ten | 100 | 1,208 B | 6.6× |
| sorted | 2 | 32 B | **250×** |

**375× between the top row and the bottom row**, and the only difference is the order the rows were written in. C0.L4 measured 39.8× in *bytes read* from the same lever. Here it is again in *bytes stored*. The lever is one thing, and it is not a feature of anything: a table has exactly one physical order, and that order simultaneously sets your pruning ratio and your RLE ratio.

This is the reason sort-key selection is the highest-leverage physical decision in a column store, and the reason it is genuinely hard. Two consequences follow, and both are worth saying in a review:

- **Sort order is a shared resource with a single owner.** The column you sort by prunes well and run-length-encodes well. Every other column gets whatever clustering falls out — which for an independent column is none. You cannot have both, and C2 spends a track on how to lose least.
- **RLE ratio is a monitorable proxy for clustering.** If a column's run count triples overnight, the loader changed its order. That shows up in stored bytes *and* in your pruning ratio, and it shows up before the bill does.

One more constraint, because it is where the naive version breaks: low cardinality does not imply long runs, and a sorted column is not a sorted table. Sorting by \`order_ts\` gives \`order_ts\` runs of length one and \`status\` runs of length one, because the statuses arrive interleaved in time. Sorting by \`(status, order_ts)\` gives \`status\` four enormous runs and destroys \`order_ts\` clustering across the file. **Name the loser.**`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: 'd < n/2',
          label: 'when a dictionary is worth having',
          hint: '8·d + 4·n < 8·n. Distinct values fewer than half the rows in THIS block — not in the table, which is the arithmetic error that costs people the never_expands check.',
        },
        {
          value: '2×',
          label: 'the dictionary ceiling, at any cardinality',
          hint: 'A code is 4 bytes, a value is 8. Drive distinct to 1 and you still pay 4·n. The ratio cannot exceed 2× in this format however repetitive the column is.',
        },
        {
          value: '1,639×',
          label: 'RLE on a 4,096-row constant column',
          hint: '8 + 12 = 20 B against 32,776 B plain — one maximal run. RLE has no ceiling, which is why it is the codec worth designing your layout around.',
        },
        {
          value: '375×',
          label: 'the sort-order swing on identical data',
          hint: '12,008 B unsorted against 32 B sorted, same 1,000 values, same codec. C0.L4 measured 39.8x from the same lever in bytes read; this is the storage side of it.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'analogy',
      title: 'a dictionary column is an inlined foreign key',
      md: `You have already built this by hand. A wide repeated label — \`'refunded'\`, \`'EMEA'\`, a forty-character product name — gets normalised into a small table plus an integer key, because storing the string ten million times was obviously wasteful. Then someone writes a join in every query forever.

Dictionary encoding is that transformation performed per column chunk, by the writer, and undone by the reader. Same dictionary table, same integer key, no join, no referential integrity to maintain, and a new dictionary per chunk so it adapts to whatever that chunk happens to hold.

Three properties of the hand-rolled version carry over exactly, and are worth knowing before you are surprised by them:

- **The key is only useful with the table.** Read the codes without the dictionary page and you have integers with no meaning — which is why the dictionary page is written *first* in a Parquet column chunk, and why a projection that touches the chunk always pays for it.
- **It stops paying when the "lookup table" approaches the fact table.** Nobody normalises a column that is unique per row. The codec's \`d < n/2\` rule is the same instinct, made exact.
- **Comparisons can happen in key space.** You compare integer keys, not strings, and you resolve to a label only at the end. In a database that is called late materialization, it is worth more than the ratio, and it is C4's subject.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'How Parquet actually ships these two codecs — and the one it does not',
      systems: ['parquet'],
      sources: [
        'https://parquet.apache.org/docs/file-format/data-pages/encodings/',
        'https://parquet.apache.org/docs/file-format/data-pages/columnchunks/',
      ],
      md: `Two differences between forge lab 01's pinned format and the Parquet encodings specification are worth knowing, because both of them change the arithmetic above.

**Dictionary codes are not 4 bytes.** Per the spec, \`RLE_DICTIONARY\` (enum 8) stores the dictionary in a **dictionary page per column chunk**, written before the data pages, and stores the indices using the **RLE/bit-packing hybrid** — the data page begins with the bit width as a single byte (maximum 32) and then the packed indices. So a 200-distinct column spends 8 bits per row, not 32, and the 2× ceiling in this lesson becomes roughly 8× for that column. The direction of the crossover argument is unchanged; the break-even simply moves. The spec also states the fallback explicitly: *"If the dictionary grows too big, whether in size or number of distinct values, the encoding will fall back to the plain encoding."* That is \`never_expands\`, in the format, in one sentence.

**There is no general-purpose RLE for value columns.** This surprises people. The specification restricts \`RLE\` (enum 3) to three things: repetition and definition levels, **dictionary indices**, and boolean values in data pages. There is no \`RLE\` encoding you can apply to an \`INT64\` measure column directly.

So where does clustering pay off in a real Parquet file? Two places, both indirect:

1. **Through the dictionary.** The indices are RLE/bit-packing hybrid, so a run of a thousand identical values becomes a run in *index* space. The dictionary is what makes the column low-width; the run-length hybrid over the indices is what makes clustering pay on top. The two codecs in this lesson compose in the format rather than competing.
2. **Through \`DELTA_BINARY_PACKED\`** (enum 5, \`INT32\`/\`INT64\`), which the spec notes is *"somewhat doing RLE encoding as a block containing all the same values will be bit packed to a zero bit width thus being only a header."*

The lesson to carry: the four codecs you implement in the forge are the *primitives*. A production format composes them, and the composition is where the ratios you actually see come from.`,
    },
    {
      type: 'prose',
      md: `## The lab: forge lab 01, "Make the Column Small"

This lesson fronts **forge lab 01**. You implement four codecs and one chooser over a column of \`Option<i64>\`, and it is graded by an independent second implementation in the harness — the checks re-derive every distinct count, run count and candidate size with their own code, so your own \`encoded_size\` cannot flatter your own chooser.

Three of its six checks are the direct content of this lesson:

- **\`dict_roundtrip\`** — dictionary encode/decode round-trips byte-exact. The dictionary must hold every distinct value **exactly once, with NULL counting as one of them**, every row must carry a valid code, and decode must be byte-identical including nulls. Duplicate entries fail, a code indexing past the dictionary fails, and \`codes.len() != n\` fails. Note what it does *not* let you do: return something other than \`Encoded::Dict\`. Choosing between codecs is the chooser's job, not the codec's.
- **\`rle_roundtrip\`** — runs must be **maximal**, so the check grades the run vector itself against the reference, not just the round-trip. Its hand case is the one that catches people: a value that reappears after a null run starts a *new* run. Single-element runs in the middle of a column are where naive loops drop a value, and a constant 300,000-row column must come out as exactly one run, 20 bytes.
- **\`never_expands\`** — the bound, and the harder half of the lesson. Your chosen encoding may never exceed \`plain_size\`, *and* it must equal the smallest of the five candidates. On 2,048 distinct full-range values it asserts the dictionary is **larger** than plain and that \`encode_column\` returns \`Plain\`. It also carries per-column budgets in the other direction, so falling back to Plain on a column with obvious structure fails too — you cannot pass by being trivially conservative.

The other three checks belong to C1.L3: \`bitpack_roundtrip\` (every width 1 through 32 through the codec, 1 through 64 through the pack primitive, compared word for word against the pinned LSB-first layout) and \`for_roundtrip\` (base pinned to the column minimum, unsigned deltas, surviving a column that holds both \`i64::MIN\` and \`i64::MAX\`). \`storm\` then runs 2,000 seeded columns across all-null, all-distinct, single-value, zipf, monotone, clustered, narrow-with-nulls and flag shapes, and every one of them is checked against the reference model.

Two things about how the grading is framed, because they are the course's discipline and not incidental:

**Cost is a count, never a clock.** Every number the harness prints is a byte count, which is why the suite means the same thing in your terminal, in CI and in the browser tab. Nothing in this lab is timed.

**A codec that cannot round-trip is a data-loss bug, not a slow path.** Round-trip exactness is graded first, before any size is considered. This ordering is the same asymmetry C0.L4 established for pruning — being conservative is expensive, being wrong is silent — and it holds for every lab in this course.`,
    },
    {
      type: 'callout',
      variant: 'segfault',
      title: 'the two failure modes the harness is built to catch',
      md: `**Distinct counted against the wrong denominator.** \`customer_id\` has 250,000 distinct values in the table and about 82,000 in a 100,000-row block. The codec only ever sees the block. Compare \`d\` against the table's row count and you will conclude a dictionary is a clear win on a column where it expands by 32%.

**A dictionary that quietly drops values.** \`never_expands\` contains a check that looks backwards on first reading: it asserts that a dictionary over 2,048 distinct values is **larger** than plain, and *fails you if it is smaller*. A dictionary that comes out small on an all-distinct column is not an impressive optimisation; it means values are missing from the dictionary and the round-trip is about to be wrong. The harness treats a suspiciously good ratio as a bug, which is the correct instinct to carry into production: when the compression dashboard improves and nobody changed anything, something is losing data.`,
    },
    {
      type: 'isomorphism',
      title: 'these two codecs ≡ things you already use',
      pairs: [
        {
          os: 'uniq -c',
          osLine:
            'Collapses adjacent identical lines to a count and a line. Useless on unsorted input, which is why everyone types "sort | uniq -c" without thinking about why the sort is there.',
          llm: 'run-length encoding',
          llmLine:
            'The identical primitive, with the identical precondition. The sort is the ORDER BY in your loader, and the reason a table has exactly one physical order is the reason you can only spend it once.',
        },
        {
          os: 'a canonical form (normalised paths, sorted JSON keys)',
          osLine:
            'You insist on one representation so that two producers of the same content produce identical bytes, and so a hash means something.',
          llm: 'maximal runs',
          llmLine:
            'Why the lab grades the run vector and not only the round-trip: if adjacent runs may hold equal values, two encoders disagree about the same column and the run count stops being a fact about the data.',
        },
        {
          os: 'try_compress() that returns the original on failure',
          osLine:
            'Any compression API you have shipped has this branch. It stores a flag saying "stored, not deflated", because sometimes the output is bigger than the input.',
          llm: 'Plain as a permanent candidate',
          llmLine:
            'The same branch, promoted to an invariant: because Plain is always in the candidate set, "never larger than plain" is provable rather than hoped for. Parquet has the same fallback, spelled out in its spec.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A column holds 2,048 rows of distinct 64-bit event ids. Your dictionary encoder runs on it successfully and round-trips byte-exact. What should `encode_column` return, and what is the dictionary\'s size?',
          options: [
            'Dict — it round-trips correctly, and 2,048 distinct values is a legitimate dictionary',
            'Plain — the dictionary is 24,584 B against 16,392 B plain, exactly 1.5× LARGER, because d = n means you stored every value in full and then added a 4-byte code per row on top',
            'Rle — with all values distinct there are 2,048 runs, which is still better than a dictionary',
            'Dict, but with the dictionary sorted so that binary search keeps it compact',
          ],
          correct: [1],
          explanation:
            'A correct dictionary and a useful dictionary are different things. At d = n the cost is 8n + 4n = 12n against 8n plain: 1.5× larger, for any all-distinct column at any size. RLE is worse still at 12 bytes per single-element run. Sorting the dictionary changes nothing about its size — it is the count of entries that costs, not their order. This is the case never_expands grades directly, and the required answer is that the chooser notices and falls back.',
        },
        {
          q: 'A `status` column has 4 distinct values across 100,000 rows. Run-length encoding it produces 12,008 B where plain is 8,008 B — larger. The cardinality is as low as it gets. What is wrong?',
          options: [
            'The RLE implementation is not merging runs correctly; four distinct values cannot produce that many runs',
            'Nothing is wrong: cardinality says a codec APPLIES, adjacency says what it WINS. The four values arrive interleaved, so runs are ~1 element long and each costs 12 bytes; RLE\'s ratio is 8n/12r and r is set by physical order, not by distinct count',
            'RLE needs a dictionary underneath it to work on non-integer columns',
            'The row group is too large — a smaller block would produce longer runs',
          ],
          correct: [1],
          explanation:
            'This is the central confusion the lesson exists to remove. Low cardinality with interleaved arrival gives runs of length one, and 12 bytes per run against 8 bytes per value is an expansion. The implementation is correct — maximal runs on alternating values genuinely produce n runs. A smaller row group does not help, because clustering is a property of order and not of block size: splitting an interleaved column produces smaller interleaved columns. Sorting is the fix, and it costs you the sort key.',
        },
        {
          q: 'Storage costs are up and a team proposes sorting the fact table by `customer_id`, since "grouping repeat customers together will let RLE compress it". The table is currently sorted by `order_ts` and every dashboard filters on a time window. What do you say?',
          options: [
            '"Agreed — high-cardinality columns benefit most from clustering, so the saving will be largest there."',
            '"Use both: sort by customer_id and add order_ts as a secondary key so neither is starved."',
            '"That trade is heavily negative and I can show the arithmetic. customer_id has ~82,000 distinct values in a 100,000-row block, so even fully sorted its mean run is ~1.2 and RLE still expands; bit-packing at 18 bits is already giving ~3.6× without any sort. Meanwhile a table has exactly one physical order, so we would trade the time clustering every dashboard prunes on — C0.L4 measured 39.8× in bytes read from that lever. We would save a little storage and multiply the scan bill."',
            '"Compression is the wrong lever; we should move older partitions to colder storage instead."',
          ],
          correct: [2],
          explanation:
            'Two independent errors in the proposal, and the answer has to name both. First, sorting a near-unique column does not create long runs: with 82,000 distinct in 100,000 rows the mean run is about 1.2 even when perfectly sorted, so RLE still loses to plain, and the column is already compressing via range rather than via clustering. Second, physical order is a single shared resource — spending it on customer_id takes it away from the time predicate that every dashboard prunes on, and pruning is measured in bytes read while this saving is measured in bytes stored. The secondary-key option sounds reasonable and is the real folklore trap: a secondary sort key only clusters within groups of equal primary key, which for a near-unique primary key means it clusters nothing. Tiering is a real lever but answers a different question.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: canonical forms, code widths and sorted runs',
      md: `The two codecs here are old enough to be folklore, so the interesting reading is about their edges.

On **dictionary code width**, the arithmetic in this lesson deliberately uses a fixed 4-byte code because forge lab 01 pins it that way, and the vendor block above shows what a real format does instead. **Zukowski, Héman, Nes & Boncz, "Super-Scalar RAM-CPU Cache Compression" (ICDE 2006)** is where PDICT and PFOR come from, and its central argument is that a codec's value in a database is decode *bandwidth* rather than ratio — the reason light-weight schemes with fixed widths beat variable-length entropy coders inside an engine, even though the entropy coder produces fewer bytes.

On **why compression and sorting are one problem**, the classic result is **Lemire & Kaser on reordering columns to improve compressibility**, and the practitioner form of the same idea is every warehouse's clustering command. The reason it is hard is a genuine combinatorial one: choosing a column order to minimise total run count across columns is not solved by sorting on the cheapest column, and different query mixes want different answers. C2 works the layout side; the closing question there is always which query you have agreed to make slower.

On **execute-on-compressed**, which is where both codecs earn their keep, go back to **Abadi, Madden & Ferreira (SIGMOD 2006)**: summing an RLE run is \`value × count\` rather than a loop, and filtering a dictionary column compares codes after evaluating the predicate once against the dictionary. Forge lab 03's \`compressed_path\` check grades exactly that equivalence, and C4.L3 derives it.

Read the **Apache Parquet encodings specification** for the standardised versions, particularly the RLE/bit-packing hybrid grammar — the varint-headed alternation between an RLE run and a bit-packed run is the single most reused piece of machinery in the format, and it is what your dictionary indices are actually stored in.

Then open **forge lab 01**. Six checks, four codecs, one chooser; \`dict_roundtrip\`, \`rle_roundtrip\` and \`never_expands\` are this lesson. Next: **C1.L3** takes the other two, bit-packing and frame-of-reference, and the reason a monotone timestamp column is the cheapest thing in your table.`,
    },
  ],
}

export default lesson
