import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c1.l5',
  slug: 'compute-without-decoding',
  trackId: 'c1',
  index: 5,
  title: 'Compute Without Decoding',
  minutes: 15,
  hook: 'Summing a run-length encoded column is one multiplication. Decoding it first is 300,000 additions for the same answer.',
  exercise: 'quiz',
  takeaway: {
    number: '3 payoffs',
    claim:
      'Encoding buys less I/O, less memory bandwidth, and less CPU — but only the third requires operators that never decode, which is why it is the one most systems leave on the table.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Every codec in this track has been justified by bytes: fewer bytes on storage, fewer bytes across a fabric. That is the first payoff and the obvious one. There are two more, and the last one changes how operators are written.

Take a column of 300,000 rows where \`status = 'paid'\` throughout. Run-length encoded, it is **one run**: the value, and the count. Now sum a related measure grouped by that status, or count the rows matching it.

**Decode first, then compute.** Expand the run into 300,000 values, walk them, accumulate. 300,000 iterations, 2.4 MB of memory traffic to materialise data you already knew the shape of.

**Compute on the encoded form.** The count is the run length. A sum of a constant is *value × count*. **One multiplication.** Same answer, and you never allocated the array.

That is the third payoff: encoding reduced the *work*, not just the bytes. And unlike the first two it is not free — it requires operators that understand the encoded representation, which is a real cost in engine complexity and the reason many systems decode eagerly and leave this on the table.`,
    },
    {
      type: 'prose',
      md: `## The three that actually pay

| encoding | what the operator can do without decoding | the win |
|---|---|---|
| **RLE** | count = run length; sum of constant = value × count; a predicate is evaluated once per *run* | proportional to run length — unbounded |
| **Dictionary** | evaluate the predicate against the *dictionary*, then compare integer codes; group by code, translate once at the end | one comparison per distinct value instead of per row |
| **Bit-packing / FOR** | compare against the packed representation, or narrow the comparison to the frame's range | SIMD-friendly: more values per register |

The dictionary case is the one worth internalising, because it inverts where the work happens. Consider \`WHERE region = 'EMEA'\` over 2 million rows with 8 distinct regions:

**Decoded:** 2,000,000 string comparisons. Each one is a pointer chase and a memcmp.

**On codes:** compare \`'EMEA'\` against the 8 dictionary entries — **8 string comparisons** — which yields the code, say 3. Then the filter over the column is \`code == 3\`: 2 million integer comparisons over a tightly packed array, which is exactly the shape a compiler vectorises. String comparison, the expensive operation, happened 8 times instead of 2 million.

And it composes with pruning: a dictionary is a *complete* list of the values present in that block, so if \`'EMEA'\` is not in the dictionary, the block cannot contain a matching row and can be skipped without reading the data pages at all. That is a zone map with exact answers rather than a range — one-sided error becomes no error, for equality predicates.

The **group-by** case is better still. Grouping by a dictionary-encoded column means hashing small integers instead of strings, with the dictionary translation applied once per group at the very end — so a group-by over 2 million rows resolving to 8 groups does 8 string operations total.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the same filter, two places to do the work',
      height: 68,
      nodes: [
        { id: 'q', x: 22, y: 2, w: 56, h: 8, label: "WHERE region = 'EMEA'", sub: '2,000,000 rows · 8 distinct values', color: '#A3E635' },
        { id: 'dec', x: 2, y: 16, w: 44, h: 9, label: 'decode first', sub: 'expand codes back to strings', color: '#FB7185' },
        { id: 'enc', x: 54, y: 16, w: 44, h: 9, label: 'stay encoded', sub: 'the dictionary is 8 entries', color: '#3EF2A4' },
        { id: 'deccost', x: 2, y: 30, w: 44, h: 9, label: '2,000,000 string compares', sub: 'pointer chase + memcmp each', color: '#FB7185' },
        { id: 'dict', x: 54, y: 30, w: 44, h: 9, label: '8 string compares', sub: "'EMEA' → code 3", color: '#3EF2A4' },
        { id: 'codes', x: 54, y: 43, w: 44, h: 9, label: 'then code == 3', sub: 'packed ints · vectorises', color: '#22D3EE' },
        { id: 'skip', x: 54, y: 56, w: 44, h: 9, label: 'or skip the block entirely', sub: 'code absent from the dictionary', color: '#A78BFA' },
        { id: 'same', x: 2, y: 43, w: 44, h: 9, label: 'identical answer', sub: 'the results must agree — graded', color: '#FBBF24' },
      ],
      edges: [
        { from: 'q', to: 'dec' },
        { from: 'q', to: 'enc' },
        { from: 'dec', to: 'deccost' },
        { from: 'enc', to: 'dict' },
        { from: 'dict', to: 'codes' },
        { from: 'dict', to: 'skip', label: 'not present' },
        { from: 'deccost', to: 'same' },
        { from: 'codes', to: 'same' },
      ],
      steps: [
        {
          caption:
            'One equality predicate over two million rows on a column with eight distinct values. The bytes on storage are identical in both branches below — the only difference is where the comparison happens.',
          active: ['q'],
        },
        {
          caption:
            'The eager path decodes the column back into strings and then compares each one. Two million pointer chases and memcmps, plus the memory traffic to materialise strings the engine had already compressed away.',
          active: ['dec', 'deccost'],
          edges: ['q->dec', 'dec->deccost'],
        },
        {
          caption:
            'The lazy path compares the literal against the dictionary instead — eight string comparisons, once — and learns that EMEA is code 3. The expensive operation just happened 250,000 times less often.',
          active: ['enc', 'dict'],
          edges: ['q->enc', 'enc->dict'],
        },
        {
          caption:
            'The filter over the column is now an integer comparison against a densely packed array, which is the shape a compiler will vectorise. This is where encoding stops being a storage technique and becomes an execution one.',
          active: ['codes'],
          edges: ['dict->codes'],
        },
        {
          caption:
            'And there is a shortcut the range-based zone map cannot offer: a dictionary is the complete set of values present in the block, so if the literal is absent the block cannot match and the data pages are never read. For equality, one-sided error becomes no error.',
          active: ['skip'],
          edges: ['dict->skip'],
        },
        {
          caption:
            'Both paths must return the identical answer, and that equivalence is what makes the optimisation safe rather than clever. Forge lab 01 grades it directly: the compressed path and the decode-then-execute path have to agree on every seeded batch.',
          active: ['same'],
          edges: ['deccost->same', 'codes->same'],
        },
      ],
    },
    {
      type: 'code',
      filename: 'the two shapes, side by side',
      lang: 'python',
      chips: ['same answer', 'different work'],
      code: `# decode first — correct, and it does work proportional to rows
def sum_decoded(runs):
    values = []
    for value, count in runs:
        values.extend([value] * count)      # materialise everything
    return sum(values)                       # 300,000 additions

# compute on the encoded form — work proportional to RUNS
def sum_encoded(runs):
    return sum(value * count for value, count in runs)   # 1 multiply per run

# a constant column of 300,000 rows is ONE run:
runs = [(19.99, 300_000)]
assert sum_decoded(runs) == sum_encoded(runs)   # the equivalence that makes it safe
# 300,000 additions and 2.4 MB of allocation  vs  one multiplication`,
    },
    {
      type: 'prose',
      md: `## Where it stops

State the limits, because "execute on compressed" is repeated as a slogan more often than it is qualified.

**It does not compose freely.** Two dictionary-encoded columns from *different* blocks have different dictionaries, so their codes are not comparable. A join on dictionary codes requires either a shared global dictionary or a translation step, and global dictionaries are expensive to maintain under concurrent writes. This is why engines that lean hardest on dictionary execution tend to have opinionated ingest paths.

**It does not survive most functions.** \`WHERE upper(region) = 'EMEA'\` cannot use the dictionary trick directly — though a good engine will apply the function to the 8 dictionary entries instead of the 2 million values, which recovers the win. \`WHERE region LIKE '%MEA%'\` recovers it too, for the same reason. But arbitrary user-defined functions over the decoded value do not.

**It costs engine complexity.** Every operator needs a path per encoding, and every path is a place for the two branches to disagree. That is precisely why forge lab 01 grades \`compressed_path\` as an equivalence — a fast path that returns a different answer from the slow path is not an optimisation, it is a correctness bug with better benchmarks. In an engine, this is normally handled by making the encoded path optional: operators may implement it, and correctness is defined by the decoded reference.

**And the biggest win is usually still the first payoff.** If a query reads 40 GB, the bytes dominate; execute-on-compressed matters most once the I/O has already been cut by projection and pruning, which is exactly the order this course teaches them in. C4 picks this up as the batch execution model, where these per-encoding fast paths live.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '300,000 → 1',
          label: 'operations to sum a constant column',
          hint: 'One run means count and sum are arithmetic on the run header. Work proportional to runs, not to rows.',
        },
        {
          value: '2,000,000 → 8',
          label: 'string comparisons for an equality filter',
          hint: 'Compare against the dictionary once per distinct value, then filter integer codes. The expensive operation happens 8 times.',
        },
        {
          value: '3',
          label: 'payoffs from one encoding decision',
          hint: 'I/O, memory bandwidth, and CPU. Only the third needs operators that never decode — which is why it is the one most often skipped.',
        },
        {
          value: '0',
          label: 'answers the fast path may change',
          hint: 'Graded as an equivalence in forge lab 01: the compressed path must agree with decode-then-execute on every seeded batch.',
        },
      ],
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'Encoded chunks, and what a shared-everything design does with them',
      systems: ['vast-db', 'duckdb', 'clickhouse'],
      sources: [
        'https://support.vastdata.com/hc/en-us/articles/11910669291548-VAST-Database-Overview',
        'https://www.vastdata.com/features/transactional-and-analytical-support',
        'https://parquet.apache.org/docs/file-format/data-pages/encodings/',
      ],
      md: `Two claims to keep apart, because they are usually blurred.

**The specification level.** Parquet's encodings specification defines \`RLE_DICTIONARY\`, \`DELTA_BINARY_PACKED\` and the RLE/bit-packing hybrid — the standardised forms of what you implemented in forge lab 01. Whether an operator *executes* on those forms is not a format question at all: the format defines the bytes, the engine decides whether to decode them.

**The platform level.** VAST's own documentation describes new data landing in persistent memory and then being converted into optimised **columnar chunks** for analytics — so encoded columnar blocks are the analytical representation, as in every columnar system, and the write path is what C5 is about. What their engine does or does not compute without decoding is not something this course can tell you, and we are not going to imply it: we have no cluster, no source states it in those terms, and a plausible inference is still an inference.

What *is* worth reasoning about is the interaction between dictionary execution and the shared-everything property from C0.L3. The limitation above — that dictionary codes are only comparable within a block, so cross-block work needs a shared dictionary or a translation — is a coordination problem, and coordination is exactly what a design with shared metadata across all compute nodes changes the cost of. That is a *hypothesis about where an architecture might pay off*, not a claim about a product, and it is the right shape of question to bring to a proof-of-concept: measure a high-cardinality group-by and a join on a dictionary-friendly key, and see whether the encoded path survives crossing a block boundary.

The vendor room asks precisely this, and it is the difference between having read a whitepaper and having an evaluation plan.`,
    },
    {
      type: 'isomorphism',
      title: 'compute-on-encoded ≡ laziness you already exploit',
      pairs: [
        {
          os: 'predicate pushdown',
          osLine:
            'Move the filter to where the data is instead of moving the data to the filter. The win is the work you never do.',
          llm: 'evaluating against the dictionary',
          llmLine:
            'Move the comparison to where the distinct values are — eight of them — instead of to where the rows are.',
        },
        {
          os: 'a materialized view you did not need',
          osLine:
            'Computing eagerly is only cheaper if the result gets used. Otherwise it is work plus storage plus staleness.',
          llm: 'decoding eagerly',
          llmLine:
            'Materialising values the operator could have consumed encoded is work plus allocation plus memory traffic, for nothing.',
        },
        {
          os: 'a fast path in a hot loop',
          osLine:
            'Every specialised path must return exactly what the general path returns, or you have shipped a bug that only appears under load.',
          llm: 'the compressed execution path',
          llmLine:
            'Graded as an equivalence for the same reason: a fast path that disagrees with the reference is a correctness bug wearing a benchmark.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A column of 300,000 rows holds one value throughout, run-length encoded as a single run. What does SUM over that column cost on the encoded form?',
          options: [
            '300,000 additions — the values must be visited to be summed',
            'One multiplication: value × count, taken from the run header, with no array materialised',
            'It cannot be computed without decoding, since SUM needs individual values',
            'Two operations: one to decode the run and one to sum it',
          ],
          correct: [1],
          explanation:
            'A sum of a constant is the constant times the count, and both are in the run header. Work becomes proportional to the number of runs rather than the number of rows, which is unbounded upside on a well-clustered column — and it is the clearest case of encoding reducing CPU rather than just bytes.',
        },
        {
          q: 'Why does filtering on a dictionary-encoded column turn 2,000,000 string comparisons into 8?',
          options: [
            'The dictionary is sorted, so a binary search finds the matching rows',
            'The literal is compared against the dictionary\'s distinct values once to obtain its code, and the filter over the column is then an integer comparison on packed codes',
            'The compressor removes duplicate rows before the filter runs',
            'Because string comparison is vectorised in modern CPUs',
          ],
          correct: [1],
          explanation:
            'The expensive operation — string comparison — is moved from once per row to once per distinct value, and what remains is an integer comparison over a dense array, which is what actually vectorises. It also enables an exact block skip: a dictionary is the complete set of values present, so an absent literal means the block cannot match.',
        },
        {
          q: 'An engineer proposes joining two tables on dictionary codes instead of decoded strings, "since codes are just integers and integers compare faster". What is wrong?',
          options: [
            'Nothing — this is the standard way to execute a join on encoded columns',
            'Dictionaries are per block, so the same string can have different codes in different blocks: the join needs a shared global dictionary or a translation step, and maintaining a global dictionary under concurrent writes is its own cost',
            'Joins cannot use integer keys, only strings',
            'It works but produces the wrong row counts when nulls are present',
          ],
          correct: [1],
          explanation:
            'Codes are local identifiers, not values, so comparing them across blocks compares two different namespaces and silently returns wrong results. Recovering the optimisation needs either a global dictionary — expensive to maintain as data arrives — or a translation on one side. This is the main limit on how far execute-on-compressed composes, and it is why the equivalence with the decoded path has to be graded rather than assumed.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the paper that made this a design principle',
      md: `The canonical reference is **Abadi, Madden and Ferreira, "Integrating Compression and Execution in Column-Oriented Database Systems" (SIGMOD 2006)**. It is the paper that argued compression should not be a storage-layer detail hidden behind a decode step, and it introduced the framing this lesson uses: operators that accept encoded blocks, with the decoded path as the correctness reference. Read section by section against what you implemented in forge lab 01 — the correspondence is close, and the paper's discussion of *when* the encoded path loses is as valuable as when it wins.

For the vectorised-execution side of the same story, **Boncz, Zukowski and Nes, "MonetDB/X100: Hyper-Pipelining Query Execution" (CIDR 2005)** is where batch-at-a-time execution and its interaction with encodings was established. That paper opens **C4**, which is where these per-encoding fast paths actually live in an engine.

For the SIMD-specific layer, **Lemire and Boytsov, "Decoding billions of integers per second through vectorization"** measures what bit-packed integer decoding costs when it is done well — useful because it quantifies the decode you are trying to avoid, which is the honest way to size this optimisation.

Engines to read rather than papers: **DuckDB's execution documentation** on how it stores and scans compressed vectors, and **ClickHouse's documentation on column codecs** (particularly that codecs are specified per column, which makes the per-column reasoning of C1.L4 an explicit configuration surface rather than an inference).

Next: **C2** takes the second factor apart. You have made bytes small; now make them unread — row groups, statistics, sort keys, and the arithmetic that says whether your clustering will actually prune.`,
    },
  ],
}

export default lesson
