import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c1.l4',
  slug: 'nulls-strings-and-the-floor',
  trackId: 'c1',
  index: 4,
  title: 'Nulls, Strings, and the Floor',
  minutes: 16,
  hook: 'Four codecs handle integers with structure. Real tables are full of absent values and free text, and those set the floor your whole storage plan sits on.',
  exercise: 'quiz',
  takeaway: {
    number: '1 column',
    claim:
      'Total compression is dominated by the single least compressible column, so the ratio to plan with is the floor, not the average.',
  },
  blocks: [
    {
      type: 'prose',
      md: `The four codecs in this track exploit structure in numbers: few distinct values, physical clustering, a narrow range, an arithmetic progression. Real tables are not made of that. They are made of that **plus** two shapes that fight back — values that are absent, and values that are prose.

This matters more than it sounds, for one arithmetic reason. Compression ratios do not average; they are dominated by whatever survives. If nine columns of a ten-column table compress 20× and one compresses 1×, and that one column holds a third of the bytes, your table ratio is not 18×. Work it out for 100 bytes per row where 33 are the incompressible column:

\`\`\`
compressible:    67 B ÷ 20  =  3.35 B
incompressible:  33 B ÷ 1   = 33.00 B
                              ───────
total:                        36.35 B  →  2.75×
\`\`\`

**2.75×, not 18×.** The nine well-behaved columns contributed almost nothing once the tenth was in the room. This is Amdahl's law wearing a storage costume, and it is why the number to put in a capacity plan is the *floor* — the ratio of your worst significant column — rather than the average of a table scan.`,
    },
    {
      type: 'prose',
      md: `## Nulls are not free, and they are not a value

An absent value has to be recorded somewhere, and there are two established ways to do it.

**A null bitmap:** one bit per value, alongside the data. Cheap and uniform — 1 bit per row regardless of how many nulls there are, so 2 million rows cost 250 KB of bitmap whether one value is null or all of them are. The forge lab uses this shape: its \`Plain\` encoding adds \`⌈n/8⌉\` bytes exactly when a null is present, and not otherwise.

**Definition levels:** an integer per value recording *how deep* the value is defined. This is Parquet's mechanism, and it exists because Parquet must describe nested structures where "absent" has several meanings — the field is null, or its parent is null, or the containing list is empty. For a flat, non-nullable column the levels are omitted entirely; for a flat nullable column they are effectively a bitmap, run-length encoded, so an all-null or almost-never-null column costs close to nothing.

Two consequences worth carrying:

1. **Declaring a column nullable is not free**, even if it never holds a null. It changes the physical layout. On a wide table of mostly-non-null columns this is real overhead accumulated one shrug at a time.
2. **A mostly-null column is nearly free**, which is the opposite of most people's intuition. A column that is 99% null holds 20,000 real values in 2 million rows: the levels run-length encode to almost nothing and the data page holds only the values that exist. Sparse columns are cheap; it is *dense high-entropy* columns that cost.

And the trap the pruning lesson already warned about: **null is not a value, and comparison against it is not a comparison.** \`WHERE x > 5\` does not match nulls. A block whose min and max are 3 and 9 could still be entirely null on the rows you care about, which is why block statistics carry a null count as a separate field and why forge lab 02 grades \`IS NULL\` semantics on its own.`,
    },
    {
      type: 'prose',
      md: `## Strings are where the floor usually is

Free text is the most common incompressible column in a real analytical table, and there are three regimes.

**Low cardinality — dictionary territory.** \`status\`, \`region\`, \`currency\`, \`device_type\`. A few dozen distinct values across millions of rows: the dictionary holds each string once and the column becomes small integer codes. This is the best case in the whole track, and it is why C1.L2's arithmetic matters most for strings: the values are wide, so replacing them with codes wins more than it does for integers.

**High cardinality, short, structured** — \`session_id\`, \`sku\`, \`url_path\`. Too many distinct values for a dictionary to pay (past \`d ≈ n/2\` it stops helping and starts hurting), but the strings share prefixes and substrings. This is what **FSST** (Fast Static Symbol Table) is for: it builds a table of frequent *substrings* rather than whole values, so \`/api/v2/orders/8412\` and \`/api/v2/orders/9903\` share their common prefix as one symbol. It is a genuinely different bet from dictionary encoding, and it is why modern engines carry both.

**High cardinality, long, natural language** — a review body, an error message with a stack trace, a JSON blob. Here you are down to general-purpose byte compression (LZ4, Snappy, zstd) doing what it can, and the achievable ratio is a property of the text, not of your layout. Somewhere between 2× and 4× is ordinary; expecting 10× is not.

That last regime is your floor, and it deserves a design decision rather than a shrug. The options are all architectural: **do not store it in the fact table** (move it to a side table keyed by id, so the analytical columns stay narrow), **do not store it at all** (keep a hash or a truncated form if queries only ever check equality or existence), or **accept it and plan around it** (store it, exclude it from every dashboard projection, and quote your floor honestly). Any of the three is defensible. Not noticing is not.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '2.75×',
          label: 'table ratio when one column of ten resists',
          hint: 'Nine columns at 20× plus one at 1× holding a third of the bytes. Ratios do not average — the survivor dominates.',
        },
        {
          value: '1 bit',
          label: 'per row for a null bitmap, always',
          hint: 'Uniform cost regardless of null count. 2M rows is ~250 KB of bitmap whether one value is absent or all of them.',
        },
        {
          value: '99% null',
          label: 'is nearly free, not expensive',
          hint: 'Levels run-length encode and the data page holds only values that exist. Sparse is cheap; dense and high-entropy is what costs.',
        },
        {
          value: '2–4×',
          label: 'what natural-language text actually gives you',
          hint: 'General-purpose byte compression on prose. Order-of-magnitude expectation, not a measurement — and the number to plan your floor around.',
        },
      ],
    },
    {
      type: 'diagram',
      caption: 'fig 1 — where the bytes end up after everything worked',
      height: 66,
      nodes: [
        { id: 'row', x: 2, y: 2, w: 96, h: 8, label: '100 B per row, ten columns', sub: 'nine with structure, one with prose', color: '#A3E635' },
        { id: 'nine', x: 2, y: 16, w: 44, h: 9, label: 'nine structured columns', sub: '67 B → 3.35 B at 20×', color: '#3EF2A4' },
        { id: 'one', x: 54, y: 16, w: 44, h: 9, label: 'one text column', sub: '33 B → 33 B at 1×', color: '#FB7185' },
        { id: 'total', x: 26, y: 31, w: 48, h: 9, label: 'total: 36.35 B', sub: '2.75× — not 18×', color: '#FBBF24' },
        { id: 'side', x: 2, y: 46, w: 30, h: 9, label: 'move it to a side table', sub: 'fact table stays narrow', color: '#22D3EE' },
        { id: 'hash', x: 35, y: 46, w: 30, h: 9, label: 'store a hash instead', sub: 'if queries only test equality', color: '#22D3EE' },
        { id: 'accept', x: 68, y: 46, w: 30, h: 9, label: 'keep it, quote the floor', sub: 'and never project it', color: '#22D3EE' },
        { id: 'plan', x: 26, y: 58, w: 48, h: 7, label: 'the number in the capacity plan', sub: 'the floor, never the average', color: '#A78BFA' },
      ],
      edges: [
        { from: 'row', to: 'nine' },
        { from: 'row', to: 'one' },
        { from: 'nine', to: 'total' },
        { from: 'one', to: 'total', label: 'dominates' },
        { from: 'total', to: 'side' },
        { from: 'total', to: 'hash' },
        { from: 'total', to: 'accept' },
        { from: 'accept', to: 'plan' },
      ],
      steps: [
        {
          caption:
            'A hundred bytes a row across ten columns. Nine of them have the structure this track has been exploiting — low cardinality, clustering, narrow ranges. One is free text, and it holds a third of the bytes.',
          active: ['row'],
        },
        {
          caption:
            'Compress everything as well as it can be compressed. The nine structured columns go from 67 bytes to 3.35 — a genuine 20×, exactly what the codecs promise. The text column goes from 33 bytes to 33.',
          active: ['nine', 'one'],
          edges: ['row->nine', 'row->one'],
        },
        {
          caption:
            'Add them up and the table ratio is 2.75×, not the 18× an average of the columns would suggest. The incompressible column now accounts for over 90% of the stored bytes, so every further improvement to the other nine is worth almost nothing.',
          active: ['total'],
          edges: ['nine->total', 'one->total'],
        },
        {
          caption:
            'Which makes the text column an architectural decision rather than a compression problem. Move it to a side table keyed by id; keep only a hash if queries just test equality; or keep it, never project it, and quote your floor honestly. All three are defensible.',
          active: ['side', 'hash', 'accept'],
          edges: ['total->side', 'total->hash', 'total->accept'],
        },
        {
          caption:
            'And whichever you choose, the number that goes into the capacity plan is the floor rather than the average — because the floor is what the bytes will actually obey once the easy columns have given everything they have.',
          active: ['plan'],
          edges: ['accept->plan'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the ratio somebody will quote at you',
      md: `"Parquet gives about 10× compression" is a sentence with no subject. Ten times on *what data*, written by *which writer*, with *which codec*, measured across *which columns*?

The codec bench in C1.L1 makes the point sharply on synthetic data: the same file format, the same compressor and the same writer produce ratios from roughly 1× to well over 100× depending only on the column. So a single table-level ratio is the weighted average of a set of wildly different numbers, and quoting it forward as a planning assumption imports somebody else's column mix into your capacity model.

What to do instead takes one query: get per-column compressed and uncompressed sizes out of your own file footers, sort descending by compressed size, and read the top three. Those three are your storage plan. The rest is rounding.`,
    },
    {
      type: 'isomorphism',
      title: 'the floor ≡ bottlenecks you already respect',
      pairs: [
        {
          os: "Amdahl's law",
          osLine:
            'Parallelise 90% perfectly and the serial 10% caps your speedup at 10×. The part you did not fix sets the limit.',
          llm: 'the incompressible column',
          llmLine:
            'Compress nine columns perfectly and the tenth caps your ratio. Identical structure, and the same instruction: measure which part dominates before optimising.',
        },
        {
          os: 'p99 latency',
          osLine:
            'Nobody experiences the mean. You plan for the tail, because the tail is what pages you.',
          llm: 'the floor ratio',
          llmLine:
            'Nothing is stored at the mean ratio. You plan for the worst significant column, because that is what fills the disk.',
        },
        {
          os: 'a blob column in an OLTP schema',
          osLine:
            'Reviewers move it to a side table so the hot row stays narrow and the common query stays cheap.',
          llm: 'free text in a fact table',
          llmLine:
            'Exactly the same instinct, one layer over: narrow the analytical columns and key the wide thing separately.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A ten-column table has nine columns compressing 20× and one compressing 1×. The incompressible column is a third of the raw bytes. What is the table ratio?',
          options: [
            'About 18×, the average of the column ratios weighted by count',
            'About 2.75×: 67 B ÷ 20 plus 33 B ÷ 1 is 36.35 B per 100 B, and the incompressible column now holds over 90% of what is stored',
            'About 10×, since compression effects multiply',
            'About 20×, because the dominant behaviour is the majority of columns',
          ],
          correct: [1],
          explanation:
            'Ratios do not average — you must add the compressed sizes and divide. The consequence is the useful part: after compression the resistant column dominates the stored bytes, so further work on the other nine is nearly worthless and the number to plan with is the floor rather than the mean.',
        },
        {
          q: 'Which of these columns is CHEAPEST to store, per row, in a columnar file?',
          options: [
            'A dense 64-bit float of uniform random values',
            'A column that is 99% null with 20,000 real values in 2 million rows',
            'A free-text description averaging 200 characters',
            'A high-cardinality unique identifier string',
          ],
          correct: [1],
          explanation:
            'Sparse is cheap and counterintuitive: the definition levels run-length encode to almost nothing and the data page holds only values that exist. The random float is the near-worst case — dense, high-entropy, and a byte-oriented compressor cannot see the redundancy. Free text and unique identifiers are the two shapes that set the floor.',
        },
        {
          q: 'A capacity plan for a 400 TB raw table assumes 10× compression, citing a figure from a vendor blog post. What is the correct challenge?',
          options: [
            '"Ten times is optimistic; assume five to be safe."',
            '"That ratio is a property of their column mix, not of the format. Pull per-column compressed and uncompressed sizes from our own footers, sort by compressed size, and plan from the top three — and if a text column dominates, the decision is whether it belongs in the fact table at all, not which codec to pick."',
            '"We should benchmark all the available compression codecs first."',
            '"Storage is inexpensive enough that the assumption does not matter."',
          ],
          correct: [1],
          explanation:
            'The challenge is to the provenance of the number, and the fix is a query against your own data — the footers already contain per-column sizes. Halving the assumption is still somebody else\'s number with a safety factor. Codec benchmarking optimises a term that the floor column will dominate anyway, and the third option ignores that the same layout decision also drives the scan bill, which is usually the larger line.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: strings, nulls, and nested absence',
      md: `The string regime that most people have never heard of is worth the paper: **"FSST: Fast Random Access String Compression" (Boncz, Neumann, Leis — VLDB 2020)** builds a static symbol table over frequent *substrings*, which is why it beats dictionary encoding on high-cardinality-but-structured values like URLs and identifiers, while keeping random access. If you only read one paper from this track, read this one — it is the clearest example of a codec designed for a data shape rather than for a benchmark.

For nulls and nested absence, the source is **"Dremel: Interactive Analysis of Web-Scale Datasets" (Melnik et al., VLDB 2010)**, which introduced the repetition-and-definition-level encoding that Parquet adopted wholesale. C7 returns to it for nested data; here it is enough to know that a flat nullable column is the degenerate case of a general mechanism, which is why it is cheaper than it looks.

The **Apache Parquet encodings specification** documents \`RLE_DICTIONARY\`, \`DELTA_BINARY_PACKED\` and \`BYTE_STREAM_SPLIT\` — and notes that the last one does not reduce size at all on its own; it reorders float bytes so that a downstream general-purpose compressor has something to find. That is a good reminder that a "compression" feature can be a preparation step rather than a codec.

For the general-purpose layer underneath all of this, the practical comparison to read is **zstd's own documentation on levels and dictionaries** — particularly that a trained dictionary changes small-payload compression dramatically, which is the same insight as FSST arrived at from another direction.

Next: **C1.L5** takes the last and least obvious payoff — computing on the encoded form without decoding it at all.`,
    },
  ],
}

export default lesson
