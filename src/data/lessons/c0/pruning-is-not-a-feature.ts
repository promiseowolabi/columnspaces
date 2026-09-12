import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c0.l4',
  slug: 'pruning-is-not-a-feature',
  trackId: 'c0',
  index: 4,
  title: 'Pruning Is Not a Feature',
  minutes: 15,
  hook: 'The same query on the same engine read 64× more bytes because the rows arrived in a different order. Nothing was configured. Nothing was disabled.',
  exercise: 'quiz',
  artifact: 'layout-design',
  takeaway: {
    number: '64×',
    claim:
      'Identical query, identical format, identical engine: the shuffled file read 64× more bytes than the clustered one, because pruning is a property of physical order rather than of the format.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Here is the measurement from C0.L1's lab, run in a browser. Same 500,000 rows. Same three-column projection. Same seven-day predicate. Same engine, same Parquet, same compression codec, same row group size.

| file | row groups read | pruned | bytes read |
|---|---|---|---|
| written in timestamp order | 1 of 25 | 96.0% | 94 KiB |
| the same rows, written shuffled | 25 of 25 | 0.0% | 5.9 MiB |

**64× more bytes to answer an identical question.** No setting differs. No feature was switched off. The only difference is the order the rows were physically written in — and that order was decided by an upstream process that has no idea this query exists.

This is why the sentence "the engine handles pruning automatically" is one of the more expensive things a person can believe. The engine will skip every block it can *prove* cannot match. Whether that is 95% of them or none of them is decided by your layout, upstream of the engine entirely.`,
    },
    {
      type: 'prose',
      md: `## What the engine actually knows

Per block, the engine keeps a few bytes: **minimum, maximum, null count**. That is essentially the whole mechanism — a min/max index, often called a zone map, and it is the cheapest index in databases because it requires no maintenance beyond the append you were already doing.

The decision procedure is a proof by contradiction. Given \`WHERE order_ts >= '2025-12-25'\` and a block whose maximum \`order_ts\` is \`'2025-06-30'\`, no row in that block can satisfy the predicate, so the block is skipped **unread** — the bytes never leave storage.

Now watch the mechanism break, without changing anything about it:

- **Clustered by time.** Each block spans a narrow slice — block 3 covers March, block 4 covers April. A seven-day predicate contradicts 19 of 20 blocks. 95% skipped.
- **Shuffled.** Every block contains a scattering of rows from across two years, so every block's min is near the start of history and its max near the end. **Every block's range overlaps every predicate.** Nothing can be proven impossible, so nothing is skipped.

The statistics are equally correct in both cases. They are simply *useless* in the second, because a min/max pair only carries information when values are physically near each other. Clustering is what makes a summary informative.

This generalises past timestamps. Any predicate prunes in proportion to how well the physical order correlates with it — and a table has **exactly one** physical order. That constraint is the entire subject of C2, and it is why every layout has a query it is bad at.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the same predicate against two physical orders',
      height: 66,
      nodes: [
        { id: 'pred', x: 24, y: 2, w: 52, h: 8, label: "WHERE order_ts >= '2025-12-25'", sub: 'one week of two years', color: '#A3E635' },
        { id: 'c0', x: 2, y: 18, w: 15, h: 8, label: 'blk 0', sub: 'Jan–Feb 24', color: '#94A3B8' },
        { id: 'c1', x: 19, y: 18, w: 15, h: 8, label: 'blk 1', sub: 'Mar–Apr 24', color: '#94A3B8' },
        { id: 'c2', x: 36, y: 18, w: 15, h: 8, label: '… 17 more', sub: 'all older', color: '#94A3B8' },
        { id: 'c3', x: 53, y: 18, w: 15, h: 8, label: 'blk 24', sub: 'Dec 25–31', color: '#3EF2A4' },
        { id: 'cwin', x: 72, y: 18, w: 26, h: 8, label: '1 of 25 read', sub: '96% skipped', color: '#3EF2A4' },
        { id: 's0', x: 2, y: 36, w: 15, h: 8, label: 'blk 0', sub: 'Jan 24–Dec 25', color: '#FB7185' },
        { id: 's1', x: 19, y: 36, w: 15, h: 8, label: 'blk 1', sub: 'Jan 24–Dec 25', color: '#FB7185' },
        { id: 's2', x: 36, y: 36, w: 15, h: 8, label: '… 17 more', sub: 'same range', color: '#FB7185' },
        { id: 's3', x: 53, y: 36, w: 15, h: 8, label: 'blk 24', sub: 'Jan 24–Dec 25', color: '#FB7185' },
        { id: 'swin', x: 72, y: 36, w: 26, h: 8, label: '25 of 25 read', sub: '0% skipped', color: '#FB7185' },
        { id: 'note', x: 12, y: 52, w: 76, h: 10, label: 'the statistics are correct in both rows', sub: 'a min/max pair only carries information when values sit near each other', color: '#FBBF24' },
      ],
      edges: [
        { from: 'pred', to: 'c0' },
        { from: 'pred', to: 's0' },
        { from: 'c3', to: 'cwin' },
        { from: 's3', to: 'swin' },
        { from: 'swin', to: 'note' },
      ],
      steps: [
        {
          caption:
            'One predicate: seven days out of a two-year table, about 1% of the rows. It is issued against two files holding byte-identical data in different physical orders.',
          active: ['pred'],
        },
        {
          caption:
            'Clustered by time, each block covers a narrow slice of history. The predicate contradicts nineteen of them outright — their maximum timestamp predates the window, so no row inside can match and the bytes are never requested.',
          active: ['c0', 'c1', 'c2', 'c3', 'cwin'],
          edges: ['pred->c0', 'c3->cwin'],
        },
        {
          caption:
            'Shuffled, every block holds a scattering of rows from across the whole history. Every block\'s min is near the beginning and its max near the end, so every range overlaps the predicate and nothing can be proven impossible.',
          active: ['s0', 's1', 's2', 's3', 'swin'],
          edges: ['pred->s0', 's3->swin'],
        },
        {
          caption:
            'Both sets of statistics are accurate. The second set is merely uninformative — which is the point: pruning is not something the format provides, it is something physical clustering makes available. 64× in bytes, from write order alone.',
          active: ['note'],
          edges: ['swin->note'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## The asymmetry that makes this a correctness question

Pruning has two ways to be wrong, and they are not equally bad. This distinction is worth internalising because it governs how every pruning implementation must be written — including the one you write in forge lab 02.

**A false positive** — reading a block that turned out to contain no matching rows — costs money and nothing else. The answer is still right. You over-read.

**A false negative** — skipping a block that *did* contain matching rows — returns the wrong answer, silently. No error, no warning, a plausible number in a report that somebody makes a decision on.

So the rule is: **when the statistics do not let you prove a block impossible, you must read it.** A block with no statistics at all? Read it. A predicate the statistics cannot speak to, like a function applied to the column? Read it. Nulls, whose comparison semantics are not the same as values? Read the block unless the null count proves otherwise.

That is why forge lab 02 grades \`no_false_negatives\` as an absolute, and grades pruning ratio only in a band. Being conservative is *correct but expensive*; being aggressive is *cheap and wrong*. One of those is a tuning problem and the other is an incident.

It is also why "pruning stopped working" is a cost incident rather than an outage, and therefore invisible until the invoice arrives — which is precisely what makes it Column Week's first drill. The dashboard stayed fast. The clustering depth moved twelve hours before the bill did.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '95% → 0%',
          label: 'row groups pruned, clustered vs shuffled',
          hint: 'Measured on the course fixture. Same rows, same query, same engine — only the write order differs.',
        },
        {
          value: '64×',
          label: 'more bytes read by the shuffled file',
          hint: 'For an identical query and an identical answer. This is the cost of a layout decision made by somebody else, upstream.',
        },
        {
          value: '1',
          label: 'physical order a table can have',
          hint: 'Which is why every layout privileges some predicates and starves others. Name the starved one before the review does.',
        },
        {
          value: '0',
          label: 'false negatives permitted',
          hint: 'Skipping a block that held a match is a silent wrong answer. Over-reading is only a bill. The two failure modes are not comparable.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'info',
      title: 'clustering depth: the metric that moves first',
      md: `If pruning depends on physical clustering, then clustering is the thing to monitor — not the bill, which lags by a billing cycle, and not latency, which a wide enough engine absorbs entirely.

The measurable form is **clustering depth**: for a given column, how many blocks a typical value's range overlaps. Depth 1 means blocks are disjoint on that column and pruning is maximal. Depth 9 means a typical predicate touches nine blocks where it could have touched one, and your scan bill is roughly nine times what the design assumed.

Put it on a dashboard next to cost. In Column Week's first incident it moves half a day before anybody notices the money.`,
    },
    {
      type: 'isomorphism',
      title: 'zone maps ≡ things you already trust',
      pairs: [
        {
          os: 'a bloom filter',
          osLine:
            'Answers "definitely not present" or "possibly present". False positives cost a lookup; false negatives would be a bug.',
          llm: 'a zone map',
          llmLine:
            'The same contract for ranges. Same asymmetry, same consequence: never skip on an inconclusive answer.',
        },
        {
          os: 'a covering index',
          osLine:
            'You choose it in advance, maintain it on every write, and it works regardless of physical row order.',
          llm: 'min/max statistics',
          llmLine:
            'Free to maintain and chosen for you — but worthless unless the data is physically clustered on the column you filter.',
        },
        {
          os: 'a git commit history that has been rebased into noise',
          osLine:
            'Every commit still records the truth. The history is simply no longer useful for bisecting, because adjacency stopped meaning anything.',
          llm: 'statistics on a shuffled table',
          llmLine:
            'Every min/max pair is accurate and every one is useless, for exactly the same reason: adjacency carried the information.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A dashboard\'s daily scan volume triples overnight. The queries are unchanged, row count grew 3%, and latency is unchanged. Clustering depth on the sort key moved from 1 to 9. What happened?',
          options: [
            'The table crossed a size threshold and the engine switched to full scans',
            'Statistics went stale and need recollecting',
            'An upstream change stopped writing in sort-key order, so every block now spans the full range and nothing can be pruned — the statistics are still accurate, just uninformative',
            'Compression degraded, so the same rows occupy more bytes',
          ],
          correct: [2],
          explanation:
            'Clustering depth moving 1 → 9 is the direct measurement of the cause: blocks that used to be disjoint on that column now overlap. The statistics are recomputed on every write and are correct; they simply cannot exclude anything once every block spans the whole range. Latency stayed flat because a wide engine absorbs the extra bytes, which is why the bill is the first thing anyone notices.',
        },
        {
          q: 'A pruning implementation cannot determine whether a block might contain matching rows — the column has no statistics for that block. What must it do?',
          options: [
            'Skip the block: without statistics it cannot contain relevant data',
            'Read the block: skipping on an inconclusive answer risks a false negative, which is a silent wrong result, whereas reading it is only wasted cost',
            'Collect statistics on the fly and then decide',
            'Fail the query with an error so the user knows statistics are missing'
          ],
          correct: [1],
          explanation:
            'The two failure modes are not symmetric. Over-reading costs money; under-reading returns wrong answers with no error. So the rule is to skip only when the block can be PROVEN impossible. Failing the query would be defensible in a stricter system but is not what an analytical engine does — and collecting statistics on the fly means reading the block anyway.',
        },
        {
          q: 'A vendor demo shows their format pruning 98% of blocks on a query like yours. What is the useful next question?',
          options: [
            '"What compression codec produces that?"',
            '"Was the demo data physically clustered on the predicate column, and is our data — because pruning follows physical order, not format. Also: which of our queries filters on something other than that column, since a table has one physical order?"',
            '"Can we see the throughput numbers as well?"',
            '"How many nodes was that running on?"',
          ],
          correct: [1],
          explanation:
            'The demo number is probably real and almost certainly measured on data clustered for the query being shown. The transferable question is whether YOUR data has that property and what happens to the queries that filter on a different column, because one physical order cannot serve all predicates. This is the question the principal-engineer room asks, and the answer "we would measure clustering depth on our own data during the POC" is what survives it.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: small metadata, large consequences',
      md: `The min/max index is old and keeps being rediscovered under new names. **Netezza's zone maps** popularised the term; **Oracle Exadata's storage indexes** are the same idea in a different product; **Parquet's page and column-chunk statistics** are the open-format version, and the format specification's statistics structure is worth reading directly, because it also documents the null-count and distinct-count fields most people forget exist.

For a rigorous treatment of *choosing* the physical order, **"Automated Data Layout Optimization" and the data-skipping literature** (including Sun et al. on fine-grained data skipping, VLDB) formalises what this lesson states informally: pruning effectiveness is a function of the correlation between physical order and the query predicate distribution. **Z-ordering and Hilbert curves**, as used by Delta Lake and Iceberg implementations, are the standard answer to "we filter on two columns" — a partial answer, since a space-filling curve gives you moderate clustering on several columns instead of excellent clustering on one, and C2 prices that trade.

The bloom-filter analogy is not loose: **Bloom (1970)** is the original one-sided-error data structure, and the reason both mechanisms share the "never say no when you mean maybe" rule.

Next: **C0.L5** turns all of this into a number you can defend, and hands it to the scan desk.`,
    },
  ],
}

export default lesson
