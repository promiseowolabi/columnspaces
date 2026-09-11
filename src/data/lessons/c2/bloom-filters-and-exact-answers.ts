import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c2.l4',
  slug: 'bloom-filters-and-exact-answers',
  trackId: 'c2',
  index: 4,
  title: 'Bloom Filters and Exact Answers',
  minutes: 16,
  hook: 'A min/max pair cannot help an equality predicate on a column nobody sorted by. There are two mechanisms that can, and the one everybody reaches for does nothing at all for a range.',
  exercise: 'quiz',
  artifact: 'layout-design',
  takeaway: {
    number: '10.5 bits',
    claim:
      'A 1% bloom filter costs about 10.5 bits per distinct value and is the only pruning mechanism in this track that does not depend on physical order — so it is the escape hatch for your second predicate, paid in metadata bytes on every query.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Everything C2 has built so far prunes on **ranges**, and it works because a min/max pair over a physically clustered column is informative. Now take the predicate that a range summary cannot touch:

\`\`\`
table        2,000,000,000 rows, physically sorted by tenant_id
user_id      4,000,000 distinct values, 22 bits packed
row group    131,072 rows            →  15,259 row groups
predicate    user_id = 3412559       →  ~500 matching rows
\`\`\`

Five hundred matching rows out of two billion. That is as selective as a predicate gets — 0.000025% of the table — and the rows are scattered, because the physical order was spent on \`tenant_id\`. So at most 500 row groups can hold one of them, and **at least 14,759 row groups (96.7%) provably hold nothing**.

Ask the zone map. Each row group holds 131,072 user ids drawn from a domain of four million, so every block's range is approximately \`[0, 4000000]\` — and \`3412559\` sits inside every one of them. The reference planner in forge lab 02 states the equality rule in one line:

\`\`\`rust
Predicate::Eq(_, k) => min <= *k && *k <= max
\`\`\`

Which is a *maybe* for all 15,259 blocks. **0% pruned**, on the most selective predicate in the workload. This is not a defect in the statistics — they are exact, and lab 02's \`stats_exact\` grades them as exact — it is that a range is the wrong shape of answer for the question.

The layout designer measures precisely this: its \`needle\` class, one end user anywhere in the table, prunes **0.0%** of row groups under the conventional day-partitioned, tenant-sorted design and reads 71.19 GiB to find a handful of rows.`,
    },
    {
      type: 'prose',
      md: `## Two mechanisms that answer equality

A range says "possibly, because k is between my endpoints". Two other structures answer the *membership* question directly, and they fail in opposite directions.

**A dictionary is exact.** C1.L5 established the property that matters here: a dictionary is the **complete set of values present in that block**. So if the literal is absent from the dictionary, the block cannot contain a matching row, and the proof is total — no false positives at all, which is strictly better than a range. The catch is size. A dictionary for a 131,072-row block of near-unique user ids holds ~131,000 entries: it is as large as the column it summarises, which is why writers stop emitting dictionaries above a cardinality threshold and fall back to plain encoding. Dictionaries answer equality exactly *and only pay where cardinality is low* — which is exactly where equality was already cheap.

**A bloom filter is one-sided.** A fixed-size bit array plus a hash function, answering only two things: **"definitely not present"** or **"probably present"**. It cannot say "definitely present", and — this is the contract — **it can never say "definitely not" about a value that was inserted.** No false negatives, by construction.

That contract is the same asymmetry lab 02 grades, one level down. A "definitely not" is a proof and licenses a skip. A "probably" is not a proof, so you read the block, exactly as the harness insists when statistics cannot speak:

> \`no statistics is NOT a proof of absence. The block holds [Some(1), None, Some(9)], every one of these predicates matches one of those rows, and the skip returns a wrong answer with no error. When the metadata cannot speak, you read the block and pay the bill.\`

Where the filter wins is size, and the size is where the interesting arithmetic lives.`,
    },
    {
      type: 'prose',
      md: `## Sizing the filter: cost is linear, error is exponential

The false-positive rate is a **budget you set**, and it buys down error at a linear price in bits. These are the published figures from the Parquet specification's own sizing table for split-block bloom filters:

| bits of space per inserted value | false-positive probability |
|---|---|
| 6.0 | 10% |
| 10.5 | 1% |
| 16.9 | 0.1% |
| 26.4 | 0.01% |
| 41 | 0.001% |

Read the shape rather than the rows: **each additional ~5–6 bits per value divides the false-positive rate by ten.** Cost is linear, error is exponential, so the first ten bits buy almost everything and the next thirty buy very little you can spend.

Now price the whole thing on the table above, at 1% — nearly every value is distinct, so "per distinct value" and "per row" are the same number:

\`\`\`
filter:   2e9 values × 10.5 bits = 21e9 bits = 2.6 GB
column:   2e9 values × 22 bits   = 44e9 bits = 5.5 GB
                                               ───────
filter ÷ the column it indexes  =  48%
\`\`\`

**Half the size of the column, to index one column for one predicate shape.** That is why bloom filters are opt-in per column in every format that has them, and why "turn them on everywhere" is a storage decision nobody costed.

Then the win, for the query we started with:

\`\`\`
read the whole thing         15,259 row groups × 131,072 rows × 28 B  =  56.0 GB
with a 1% filter            500 true maybes
                          + 1% of 14,759  ≈ 148 false maybes
                            ─────────────────────────────────────
                            648 row groups read  →  95.8% pruned
                            648 × 131,072 × 28 B  =  2.4 GB of data
                          + the filters themselves =  2.6 GB
                                                      ───────
                                                      5.0 GB   →  11.2× fewer bytes
\`\`\`

Eleven times fewer bytes for an identical answer — and note what the composition of the bill just became: **2.6 of the remaining 5.0 GB is metadata.** You did not remove the cost, you changed its shape from data bytes to metadata bytes, and metadata bytes are paid on **every** run of that query whether it matches anything or not. At the layout designer's 40 needle queries a day that is ~104 GB/day of filter reads. The zone map, by contrast, is a few tens of bytes per block: ~0.5 MB for the same 15,259 blocks.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — three mechanisms, two predicate shapes',
      height: 72,
      nodes: [
        { id: 'q', x: 20, y: 2, w: 60, h: 8, label: 'WHERE user_id = k', sub: '4M distinct · table sorted by tenant_id', color: '#A3E635' },
        { id: 'mm', x: 2, y: 14, w: 30, h: 10, label: 'min/max', sub: 'range [lo, hi] → maybe', color: '#FB7185' },
        { id: 'dict', x: 35, y: 14, w: 30, h: 10, label: 'dictionary', sub: 'the complete value set → yes / no', color: '#22D3EE' },
        { id: 'bloom', x: 68, y: 14, w: 30, h: 10, label: 'bloom filter', sub: 'definitely no / probably yes', color: '#3EF2A4' },
        { id: 'mmout', x: 2, y: 27, w: 30, h: 9, label: '0% pruned', sub: 'every range contains k', color: '#FB7185' },
        { id: 'dictout', x: 35, y: 27, w: 30, h: 9, label: 'exact, and 131k entries', sub: 'as large as the column', color: '#22D3EE' },
        { id: 'bloomout', x: 68, y: 27, w: 30, h: 9, label: '95.8% pruned', sub: '10.5 bits per value at 1%', color: '#3EF2A4' },
        { id: 'range', x: 20, y: 40, w: 60, h: 8, label: 'now change the shape: ts BETWEEN a AND b', sub: 'one week of two years', color: '#FBBF24' },
        { id: 'mm2', x: 2, y: 51, w: 30, h: 9, label: 'min/max: 95% pruned', sub: 'if clustered on ts', color: '#3EF2A4' },
        { id: 'dict2', x: 35, y: 51, w: 30, h: 9, label: 'dictionary: one probe per value', sub: 'and there are 604,800,000', color: '#FB7185' },
        { id: 'bloom2', x: 68, y: 51, w: 30, h: 9, label: 'bloom: nothing at all', sub: 'the hash destroyed order', color: '#FB7185' },
        { id: 'rule', x: 10, y: 63, w: 80, h: 8, label: 'match the mechanism to the predicate SHAPE', sub: 'ranges need order · equality needs membership · one table has one order', color: '#A78BFA' },
      ],
      edges: [
        { from: 'q', to: 'mm' },
        { from: 'q', to: 'dict' },
        { from: 'q', to: 'bloom' },
        { from: 'mm', to: 'mmout' },
        { from: 'dict', to: 'dictout' },
        { from: 'bloom', to: 'bloomout' },
        { from: 'bloomout', to: 'range' },
        { from: 'range', to: 'mm2' },
        { from: 'range', to: 'dict2' },
        { from: 'range', to: 'bloom2' },
        { from: 'mm2', to: 'rule' },
        { from: 'bloom2', to: 'rule' },
      ],
      steps: [
        {
          caption:
            'One equality predicate on a high-cardinality column that the physical order knows nothing about — the needle query, and the single most common thing a well-sorted table is still bad at.',
          active: ['q'],
        },
        {
          caption:
            'The zone map answers with a range, and a range that spans the whole domain answers "maybe" for every block. The statistics are exact and completely uninformative, which are not the same failure.',
          active: ['mm', 'mmout'],
          edges: ['q->mm', 'mm->mmout'],
        },
        {
          caption:
            'A dictionary answers exactly, because it is the complete set of values present in the block — but on a near-unique column it holds one entry per row and stops being a summary of anything.',
          active: ['dict', 'dictout'],
          edges: ['q->dict', 'dict->dictout'],
        },
        {
          caption:
            'The bloom filter trades exactness for size: about 10.5 bits per value buys a 1% false-positive rate, which turns 15,259 candidate row groups into 648. One-sided error, so a "no" is a proof and a "maybe" is read.',
          active: ['bloom', 'bloomout'],
          edges: ['q->bloom', 'bloom->bloomout'],
        },
        {
          caption:
            'Now keep everything and change only the predicate shape to a range. The zone map comes alive if the column is clustered; the dictionary would need one probe per value in the interval; the filter offers literally nothing, because hashing is chosen to destroy the adjacency a range depends on.',
          active: ['range', 'mm2', 'dict2', 'bloom2'],
          edges: ['bloomout->range', 'range->mm2', 'range->dict2', 'range->bloom2'],
        },
        {
          caption:
            'Which is the whole lesson in one line: the mechanism follows the predicate shape, not the column. And since a table has exactly one physical order, the filter is the only one of the three you can add to a second column without taking the order away from the first.',
          active: ['rule'],
          edges: ['mm2->rule', 'bloom2->rule'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the folklore answer: "pruning is bad, add a bloom filter on the timestamp"',
      md: `This is the most common wrong move in the subject, and it is wrong for a reason worth being able to state in one sentence: **a bloom filter answers membership of a point, and hashing is designed to destroy the locality a range predicate needs.** \`h(k)\` and \`h(k + 1)\` are uncorrelated on purpose — that is what makes the filter's error rate independent of the data distribution, and it is exactly what makes it useless for intervals.

To answer \`ts BETWEEN '2025-12-25' AND '2026-01-01'\` with a filter you would have to probe every candidate value in the interval. At millisecond resolution that is 604,800,000 probes per row group, times 15,259 row groups. The structure does not decline politely; there is simply no question you can ask it.

Two corollaries that save real money:

- **A bloom filter on your sort key is almost always waste.** For a clustered column the zone map already answers equality *and* ranges, exactly, for tens of bytes per block. You would be paying 10.5 bits per row to duplicate an answer you already have.
- **A bloom filter on a column you never test for equality is pure overhead** — storage you wrote, and metadata bytes an engine may fetch, for a predicate shape that never arrives.

The correct reading of "pruning is bad on this query" is always: *which predicate shape, on which column, against which physical order?* Three questions, and the answer names the mechanism.`,
    },
    {
      type: 'prose',
      md: `## Where else it stops, and the one place it kills you

The limits are not exotic; they are the ordinary predicates in a query log.

- **\`IN\` lists work** — one probe per literal, so a twenty-value \`IN\` is twenty probes and the block is read if any says maybe.
- **\`!=\` does not work.** A filter cannot prove that *every* row equals \`k\`, which is what a skip would require.
- **\`LIKE 'abc%'\` does not work.** A prefix is a range in disguise. (Nor does any function wrapped around the column, unless the writer built the filter over that expression — which some engines will do, and which then only serves that one expression.)
- **\`IS NULL\` does not work.** Nulls are not values and are not inserted, so the filter has nothing to say. The null count still owns that question, which is why forge lab 02 grades \`null_semantics\` as its own check and why the harness's block-level cases insist that an all-null block is *pruned by comparisons and read by \`IS NULL\`*.

And the failure mode that turns a cost mechanism into an incident: **a filter must be built over every row in the block it describes.** Consider the two directions.

A filter built over *more* rows than the block holds — say it was built before some rows were deleted — is safe. It says "maybe" more often. A bill.

A filter built over *fewer* rows than the block holds — rows appended without rebuilding it, a filter constructed from a sample, a filter copied from a predecessor file during a rewrite — says **"definitely not"** about values that are physically present. That is a false negative, and it is worse than the ones lab 02 grades: it is a wrong answer produced by metadata that was *authoritative and lying*, rather than by a planner being too aggressive. No error, no warning, a smaller number in a report.

The engineering answer is structural rather than careful: **the filter lives inside the immutable file whose rows it describes.** Parquet puts the bloom filter data in the file and records its byte offset in the column chunk metadata, so a filter and its rows are written once, together, and neither can be revised. Immutability is the correctness argument. Any design where a filter is maintained *alongside* mutable data — a side index, a cached filter, a filter rebuilt asynchronously — has to answer for that gap explicitly, and merge-on-read delete files (C5) are the good case precisely because they can only ever add false positives.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '0%',
          label: 'pruned by min/max on the needle query',
          hint: 'Measured by the layout designer: the needle class prunes 0.0% of row groups under the conventional design, because the physical order was spent on another column.',
        },
        {
          value: '10.5 bits',
          label: 'per value for a 1% false-positive rate',
          hint: "Parquet's published sizing table for split-block bloom filters. Roughly 5–6 more bits per value divides the error rate by ten: linear cost, exponential error.",
        },
        {
          value: '48%',
          label: 'of the column, for the filter that indexes it',
          hint: '2e9 values at 10.5 bits is 2.6 GB against a 22-bit packed column at 5.5 GB. This is why filters are opt-in per column rather than a default.',
        },
        {
          value: '52%',
          label: 'of the remaining bill that is now metadata',
          hint: '2.6 GB of filter beside 2.4 GB of data. Pruning did not remove the cost, it changed its shape — and metadata is paid on every run, match or no match.',
        },
      ],
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'Split-block bloom filters, as Parquet actually specifies them',
      systems: ['parquet'],
      sources: [
        'https://parquet.apache.org/docs/file-format/bloomfilter/',
        'https://parquet.apache.org/docs/file-format/pageindex/',
      ],
      md: `The format specification states this lesson's thesis better than a lesson can, and it is worth reading in the original because it is a *problem statement* rather than a feature list:

> "Statistics include minimum and maximum value, which can be used to filter out values not in the range. Dictionaries are more specific, and readers can filter out values that are between min and max but not in the dictionary. However, when there are too many distinct values, writers sometimes choose not to add dictionaries because of the extra space they occupy. This leaves columns with large cardinalities and widely separated min and max without support for predicate pushdown."

That is the gap the mechanism exists to fill — stated by the people who added it, in exactly the terms this track uses. The specification also states the contract flatly: **"Bloom filters do not have false negatives."**

Durable mechanism, worth knowing:

- The representation is a **split-block bloom filter** (SBBF): a sequence of 256-bit blocks, each eight 32-bit words, where an insert sets one bit per word in a single block. One block per operation means one cache line per probe, which is the reason for the design — it is a cache-locality decision, not a mathematical one, and it is why the false-positive rate is slightly worse than a textbook bloom filter of the same size.
- Values are hashed with **xxHash (XXH64, seed 0)** before insertion, so the filter is over hashes and knows nothing about the type's ordering.
- **One filter serves one column chunk**, and the column chunk metadata carries \`bloom_filter_offset\` (and, in later format versions, \`bloom_filter_length\` so a reader can fetch header and bitset in a single request). Filter data may sit between row groups or after all of them.
- A stated goal is to **induce no additional I/O for queries on columns without filters, or for non-selective queries** — the filter is fetched when an equality predicate on that column can use it, not on every scan.
- Filters on sensitive columns are **encrypted with the column key**, because "is this value present" is itself a disclosure. Worth remembering the next time somebody proposes filters on an email column in a table with column-level access control.

The page index, linked beside this, is the other half of the same story: per-page min/max plus offsets, which is what makes intra-row-group skipping possible. Both are metadata you choose to write, both cost bytes on the read path, and both are absent by default in some writers — so "does our writer emit them" is a question with a real answer, and it is worth checking on your own files rather than assuming.`,
    },
    {
      type: 'isomorphism',
      title: 'one-sided error ≡ structures you already trust',
      pairs: [
        {
          os: 'a hash index',
          osLine:
            'Answers equality in one probe and cannot serve ORDER BY or BETWEEN, because hashing does not preserve order. Nobody is surprised by this.',
          llm: 'a bloom filter',
          llmLine:
            'The same limitation with the same cause, one layer down and with error allowed in exchange for size. If you would not expect a hash index to serve a range, do not expect a filter to.',
        },
        {
          os: 'a negative cache',
          osLine:
            'Cheap to say "this key does not exist"; a stale entry claiming absence is an outage, one claiming presence is a wasted lookup.',
          llm: 'the filter contract',
          llmLine:
            'Definitely-no versus probably-yes, and identical consequences: a filter that under-covers its rows produces silent wrong answers, which is why it ships inside the immutable file it describes.',
        },
        {
          os: 'a content hash in a build cache',
          osLine:
            'Tells you whether you have exactly this object, and nothing whatsoever about which objects are near it.',
          llm: 'hashing a column value',
          llmLine:
            'Exactly why a filter cannot answer an interval: adjacency was the information, and the hash was chosen to destroy it.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Ad-hoc lookups by user_id scan the whole table. The table is sorted by tenant_id, and an engineer proposes adding a bloom filter on order_ts "since the timestamp predicate is what everyone filters on and pruning clearly is not working". What happens?',
          options: [
            'Range pruning improves, because the filter summarises the timestamp column more finely than min/max does',
            'Nothing for the range predicate — a filter answers point membership and hashing destroys the ordering a range needs — while the filter still costs storage on write and metadata bytes on read; the user_id lookup needs either a filter on user_id or the physical order',
            'It helps only if the timestamp column is also the sort key',
            'It helps, because bloom filters and min/max statistics are combined by the planner into a tighter bound',
          ],
          correct: [1],
          explanation:
            'A bloom filter can only answer "was this exact value inserted", and the hash is deliberately order-destroying, so there is no question you can ask it about an interval. Worse, the proposal targets the wrong column entirely: the failing predicate is the equality on user_id. On a clustered timestamp column the zone map already answers both equality and ranges exactly for tens of bytes per block, so a filter there duplicates an answer you have and charges roughly 10.5 bits per row for it.',
        },
        {
          q: 'A 1% filter on the 2-billion-row table costs 2.6 GB and leaves ~148 false-positive row groups out of 14,759 non-matching ones, each row group being ~3.7 MB of projected bytes. Someone proposes tightening to 0.1%, which costs 16.9 bits per value instead of 10.5. Does it pay?',
          options: [
            'Yes — false positives are wasted reads, and a 10× reduction in them is worth 60% more filter bytes',
            'No: the filter grows from 2.6 GB to ~4.2 GB and that +1.6 GB is read on every query, while the ~133 false positives it eliminates are worth only about 0.49 GB of data — so the tighter setting loses roughly 1.1 GB per query',
            'Yes, because a lower false-positive rate also reduces the number of true positives that must be read',
            'It makes no difference; false-positive rate affects correctness margin rather than bytes',
          ],
          correct: [1],
          explanation:
            'Do the two sides in the same unit. Filter bytes are paid in full on every run of the query; false positives cost only the blocks they wrongly admit. 133 fewer false-positive row groups is 133 × 3.7 MB ≈ 0.49 GB saved against +1.6 GB spent, so the "obviously better" setting is a net loss of about 1.1 GB per query. This is the general shape: cost is linear in bits and error is exponential, so the first ten bits per value buy nearly everything worth buying, and tightening past that is a bill with no matching saving. Note also that true positives are unaffected — those blocks contain matches and must be read.',
        },
        {
          q: 'A compaction job rewrites small files into large ones and, for speed, copies each input file\'s bloom filter into the output file rather than recomputing it over the merged rows. What is the consequence?',
          options: [
            'The output filters are slightly too large, costing storage but nothing else',
            'Each output filter describes only a subset of the rows in its file, so it returns "definitely not present" for values that are physically there — a false negative that silently drops rows from query results, with no error anywhere',
            'The false-positive rate rises, so queries read more blocks than necessary',
            'Nothing, since bloom filters are advisory and the engine verifies matches by reading the block anyway',
          ],
          correct: [1],
          explanation:
            'The one-sided-error contract holds only if the filter covers every row it is consulted about. A filter over a subset answers "definitely no" for present values, and "definitely no" is treated as a proof, so those rows vanish from results with no error raised — the worst failure mode in this course, because the metadata was authoritative and wrong rather than merely uninformative. Over-covering is the safe direction: more maybes, which is only a bill. This asymmetry is why the format keeps the filter inside the immutable file whose rows it describes, and why any design that maintains a filter beside mutable data owes an explicit answer for the gap.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: approximate membership, and the range filters nobody mentions',
      md: `**Bloom (1970), "Space/time trade-offs in hash coding with allowable errors"** is the origin and is four pages long. Read it for the framing: Bloom was explicit that the error is one-sided and that the application decides the budget, which is the discipline this lesson turns into an arithmetic.

For why Parquet's variant looks the way it does, **Putze, Sanders and Singler, "Cache-, Hash- and Space-Efficient Bloom Filters" (JEA 2009)** is the source of blocked filters: confining an insert to one cache-line-sized block costs a little accuracy per bit and buys a large constant factor in probe cost. It is a good example of a data structure being reshaped by the memory hierarchy rather than by its mathematics.

The modern successors are worth knowing, because "bloom filter" is often used to mean "approximate membership structure" and the bloom filter is no longer the best one. **Fan, Andersen, Kaminsky and Mitzenmacher, "Cuckoo Filter" (CoNEXT 2014)** supports deletion and beats bloom below roughly 3% error. **Graf and Lemire, "Xor Filters" (2019/2020)** get within about 1.23× of the information-theoretic lower bound for static sets — which is the common case here, since a filter in an immutable file never changes. **The Ribbon filter** (Dillinger and Walzer, used in RocksDB) trades construction time for space near that same bound. If you are choosing a filter for a format you control rather than consuming one from a format you do not, start there rather than at Bloom.

And the honest answer to "so is there a one-sided-error structure for *ranges*?": yes, and it is recent enough that most practitioners have not met it. **Zhang et al., "SuRF: Succinct Range Filters" (SIGMOD 2018)** builds a succinct trie that answers approximate range queries with one-sided error — the same contract as a bloom filter, extended to intervals — and **Rosetta (Luo et al., SIGMOD 2020)** attacks the same problem with a hierarchy of bloom filters over prefixes. Both exist because the gap this lesson describes is real and structural, and neither is in a mainstream open columnar format today. That is exactly the sort of claim to date and re-check rather than carry.

For the cost model of consulting metadata at all — the 52%-is-metadata observation — **C3** takes the footer apart byte by byte, and \`parquet-anatomy\` lets you measure the metadata share on your own file instead of trusting the number above.

Next: **C2.L5** turns to the other way a layout stops pruning, and it is not about statistics at all. It is about how many files you made.`,
    },
  ],
}

export default lesson
