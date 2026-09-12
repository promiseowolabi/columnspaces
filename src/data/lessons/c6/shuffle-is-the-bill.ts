import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c6.l1',
  slug: 'shuffle-is-the-bill',
  trackId: 'c6',
  index: 1,
  title: 'Shuffle Is the Bill',
  minutes: 15,
  hook: 'Filters, projections and partial aggregates never cross the network. Joins on the wrong key and final aggregations on a new key do — and that single line item is the one no codec, zone map or vectorised kernel can reduce.',
  exercise: 'quiz',
  takeaway: {
    number: '3,662×',
    claim:
      'Pre-aggregating before the exchange moves group states instead of rows, so the bytes that cross the network are bounded by distinct keys times workers rather than by row count — and which aggregates allow it is decided by mergeability, not by the planner.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Every bill this course has charged so far was paid inside one process. C0 charged **bytes read** off storage. C1 charged **bytes decoded**. C2 and C3 charged **bytes rewritten** when a layout had to change. All three are settled by the time a row is in a register, and all three respond to the techniques you have been building: narrower encodings, better clustering, fewer files.

Now the table is spread over several machines and the join key does not agree with how the rows were distributed. Matching rows sit on different nodes. Something has to move, and **bytes moved is the fourth bill** — the only one in the stack that no codec, no zone map and no vectorised kernel can reduce, because it is not a statement about how you read. It is a statement about where the rows are.

Forge lab 06 makes it a count, exactly as every lab since 01 has: a row on the wire is 16 bytes (\`ROW_BYTES\`), and a partitioned plan moves both sides once, so the reference cost of a shuffle is \`(left_rows + right_rows) × 16\`. A count means the same thing on your laptop, in CI, in the browser and on the cluster you are actually sizing. A clock does not.`,
    },
    {
      type: 'prose',
      md: `## What does not shuffle, and why that is a property rather than a favour

Three of the four operators in a typical scan-and-aggregate query never cross the exchange, and the reason is the same in each case: they are functions of one row, or of one node's rows, and nothing else.

- **Filters.** A predicate on a row needs only that row. It runs where the bytes already are, which is why pushing it to the leaf is the first thing every planner does — and why the pruning work in C2 is the cheapest possible form of shuffle avoidance: a block that is skipped is a block whose rows never enter the exchange at all.
- **Projections.** Dropping columns is per-row and local. It is also the single largest reduction available to a shuffle, because what crosses the wire is the row *as projected*, not the row as stored. A join that ships 40 columns when the query needs 4 is paying the C0 factor a second time, at network prices.
- **Partial aggregates.** This is the interesting one. A \`GROUP BY\` does not have to move rows. Each node aggregates what it holds, and then only the **group states** cross the exchange.

That last one deserves arithmetic, because the factor is not small. Take the fixture the skew lab actually builds: **480,000 rows over 4,096 distinct keys**, on **32 workers**.

\`\`\`
move the rows                480,000 rows
move partial group states    32 workers × 4,096 keys  =  131,072 states
ratio                        480,000 / 131,072        ≈  3.7×
\`\`\`

That is arithmetic on a real fixture's shape, not a benchmark. Now hold the key domain fixed and grow the table, which is what actually happens to a fact table:

\`\`\`
480,000,000 rows over the same 4,096 keys
move the rows                480,000,000
move partial group states    32 × 4,096  =  131,072
ratio                                        ≈ 3,662×
\`\`\`

**The row count cancels out.** Once every node pre-aggregates, the bytes crossing the exchange stop being a function of table size and become a function of *distinct keys × workers*. That is why cardinality — not volume — is the number to ask for when someone describes a distributed aggregation, and why a \`GROUP BY user_id\` over a hundred million users behaves nothing like a \`GROUP BY country\` over the same rows.`,
    },
    {
      type: 'prose',
      md: `## What does shuffle

Four shapes, and each one is a specific mismatch between the key the operator needs and the key the data was distributed on.

| operator | what crosses | how much |
|---|---|---|
| join on a key that is not the distribution key | both sides, once each — or the small side to every worker | \`(left + right) × row bytes\`, or \`small × workers\` |
| final aggregation whose key differs from where partials live | group states, not rows | \`distinct keys × workers × state size\` |
| global \`ORDER BY\` | every row, range-partitioned | the whole projected result |
| window function whose \`PARTITION BY\` does not match the layout | every row in the frame | the whole projected input |

Two of those are worth separating from the folklore around them.

**A final aggregation still shuffles, and it is still cheap.** "Partial aggregates do not shuffle" is loose: the partial states have to be combined, and combining them requires all states for one key to meet on one node. So an exchange happens — it just carries 131,072 states rather than 480,000,000 rows. The lesson is not "aggregation avoids the network", it is **"aggregation changes what the network is carrying from rows to states"**.

**Whether that is available at all is decided by mergeability, not by the planner.** This is C4.L4's property arriving one layer out. \`COUNT\`, \`SUM\`, \`MIN\`, \`MAX\` are mergeable — combine two partial states and you get the state you would have got from the union. \`AVG\` is mergeable if you carry the pair \`(sum, count)\` rather than the ratio. Exact \`COUNT(DISTINCT)\` and exact median are **not**: the partial state is, in the worst case, the input itself, which is precisely why those two operators shuffle rows and the others do not. Approximate distinct counts — sketches — are mergeable by construction, and that is the whole reason they exist. They buy shuffle-avoidance with an error bar, which is a trade you must declare rather than discover.

So the question to ask about any distributed query is not "how big is the table". It is: **which operators here need a key the data is not distributed on, and for each one, is what crosses a row or a state?**`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '16 bytes',
          label: 'one row on the wire, in lab 06',
          hint: 'An 8-byte key plus an 8-byte payload. Fixed width, so bytes moved is a row count times a constant — which makes the bill countable rather than measurable.',
        },
        {
          value: '3,662×',
          label: 'pre-aggregation factor at 480M rows over 4,096 keys',
          hint: 'Arithmetic: 480,000,000 rows against 32 workers × 4,096 group states. The row count cancels, so the exchange cost becomes a function of cardinality rather than volume.',
        },
        {
          value: '1.01×',
          label: 'bytes moved by lab 06 reference solution, against a plan that moves both sides once',
          hint: 'Measured by running the harness: 568,672 bytes over 10 plans against a reference of 564,000, worst single plan 1.05×. The band is 1.10× aggregate and 1.12× per plan.',
        },
        {
          value: '302,982',
          label: 'output pairs compared row for row across 800 storm plans',
          hint: 'The cost band has a tolerance. Correctness does not: every pair in every plan, exact as a multiset, through both the partitioned path and the plan the planner chose.',
        },
      ],
    },
    {
      type: 'diagram',
      caption: 'fig 1 — one query, three nodes, and the only line billed in bytes moved',
      height: 72,
      nodes: [
        { id: 'q', x: 26, y: 2, w: 48, h: 8, label: 'one query, three nodes', sub: 'the rows are already spread; the keys do not agree', color: '#A78BFA' },
        { id: 'scan', x: 2, y: 14, w: 30, h: 9, label: 'scan + filter', sub: 'per row · 0 bytes moved', color: '#A3E635' },
        { id: 'proj', x: 35, y: 14, w: 30, h: 9, label: 'projection', sub: 'per row · 0 bytes moved', color: '#A3E635' },
        { id: 'part', x: 68, y: 14, w: 30, h: 9, label: 'partial aggregate', sub: 'per node · states, not rows', color: '#3EF2A4' },
        { id: 'ex', x: 2, y: 26, w: 96, h: 9, label: 'the exchange', sub: 'the fourth bill: bytes MOVED, and no codec touches it', color: '#FB7185' },
        { id: 'join', x: 2, y: 38, w: 46, h: 9, label: 'join on a non-distribution key', sub: 'both sides once, or small side × workers', color: '#FBBF24' },
        { id: 'fin', x: 52, y: 38, w: 46, h: 9, label: 'final aggregate on a new key', sub: '131,072 states, not 480,000,000 rows', color: '#22D3EE' },
        { id: 'floor', x: 2, y: 50, w: 96, h: 9, label: 'so what crosses is what the plan could not make local', sub: 'and mergeability, not the planner, decides whether it is a row or a state', color: '#A78BFA' },
        { id: 'bill', x: 26, y: 62, w: 48, h: 8, label: 'quote it as a count: bytes moved per run', sub: 'the number survives a change of hardware', color: '#94A3B8' },
      ],
      edges: [
        { from: 'q', to: 'scan' },
        { from: 'scan', to: 'proj' },
        { from: 'proj', to: 'part' },
        { from: 'part', to: 'ex' },
        { from: 'ex', to: 'join' },
        { from: 'ex', to: 'fin' },
        { from: 'join', to: 'floor' },
        { from: 'fin', to: 'floor' },
        { from: 'floor', to: 'bill' },
      ],
      steps: [
        {
          caption:
            'One query over rows that are already distributed, on a key that does not match what the query asks for. Nothing below changes the row count; it changes how many of those rows have to leave the machine they are on.',
          active: ['q'],
        },
        {
          caption:
            'The filter and the projection cost zero bytes on the wire, because both are functions of a single row. This is why pruning is shuffle avoidance and why an unprojected join pays the C0 factor again at network prices.',
          active: ['scan', 'proj'],
          edges: ['q->scan', 'scan->proj'],
        },
        {
          caption:
            'The partial aggregate is also local, and it is the one that changes the units: each node reduces its own rows to at most one state per key it saw, so what leaves the node is bounded by cardinality rather than by volume.',
          active: ['part'],
          edges: ['proj->part'],
        },
        {
          caption:
            'Only now does anything cross the exchange, and this is the line item finance never sees on a scan bill — it shows up as elapsed time, as node-hours and as a spill, which is exactly why it goes unbudgeted until a job doubles.',
          active: ['ex'],
          edges: ['part->ex'],
        },
        {
          caption:
            'Two things ride it. A join on a non-distribution key moves both sides once, or the small side to every worker. A final aggregation moves 131,072 group states where the naive plan would have moved 480 million rows.',
          active: ['join', 'fin'],
          edges: ['ex->join', 'ex->fin'],
        },
        {
          caption:
            'And whether an operator gets the cheap version is not a planner setting: it is whether its aggregate is mergeable. Exact COUNT(DISTINCT) and exact median have no small partial state, so they move rows and the others do not.',
          active: ['floor', 'bill'],
          edges: ['join->floor', 'fin->floor', 'floor->bill'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'bytes shuffled is not on your scan bill, and that is why nobody budgets it',
      md: `On a consumption platform the number finance can see is bytes scanned (C0.L1). Bytes moved appears nowhere on that invoice. It shows up instead as:

- **elapsed time**, which is charged as node-hours or as a slot reservation rather than as a byte count;
- **spill**, when one partition exceeds a worker's memory and the exchange starts writing to disk — Column Week's third incident goes from 0 to 74 GB of spill without a single byte of extra data being read;
- **a job that is slower with the same inputs**, which is the shape that gets misdiagnosed as "the cluster needs to be bigger".

So it needs its own line in your own numbers, and the honest form is a count per run: *bytes moved per execution, split by exchange*. The Warehouse reports \`bytes shuffled\` as a separate metric from bytes scanned for exactly this reason — the two move independently, and a change that improves one can worsen the other.

**State the caveat before the room finds it:** a bytes-moved figure derived from row counts assumes the projected row width you assumed. If a downstream consumer adds a wide free-text column to the join's select list, the count you quoted is wrong and nothing will error.`,
    },
    {
      type: 'prose',
      md: `## The two bills of a shuffle, and which one gets a tolerance

Lab 06 splits its grading the way the production consequences split, and the split is worth internalising because it is how you should present your own shuffle numbers:

- **\`bytes_shuffled\` is a band.** Bytes moved must stay within 1.10× of a plan that moves both sides once across the plan set, and within 1.12× on any single plan. A cost model is never *correct*; it is within tolerance and honestly caveated. Running the reference solution, the whole plan set comes in at **1.01×**, with the worst single plan — a hot key whose other side is not tiny — at **1.05×**.
- **\`join_correct\` and \`storm\` are absolutes with zero tolerance.** The output is a multiset and it is exact: **302,982 output pairs across 800 seeded plans**, every pair once, no pair dropped, no pair duplicated, through both the partitioned path and the plan the planner chose.

That asymmetry is the professional habit this track exists to build. When you present a shuffle design, present the byte estimate as a band with its assumptions named, and present the correctness properties as absolutes — because a re-partitioning that loses a row has not made the job cheaper, it has made the answer wrong, and the class of bug that does it (a key whose two sides never met on the same node) produces no error anywhere.`,
    },
    {
      type: 'isomorphism',
      title: 'a shuffle ≡ three things you already pay for',
      pairs: [
        {
          os: 'an external merge sort',
          osLine:
            'Data too big for memory is partitioned into runs, each run is processed where it lands, and the merge is the only phase that has to see everything.',
          llm: 'a partitioned exchange',
          llmLine:
            'Same structure with the network as the slow medium. Partial aggregates are the runs; the exchange is the merge; and both designs win by making the merge carry states rather than rows.',
        },
        {
          os: 'an N+1 query in an ORM',
          osLine:
            'A thousand round trips for data one query could have returned. The fix is batching, not a faster database.',
          llm: 'a row-shipping exchange',
          llmLine:
            'Millions of rows crossing a network to be reduced on the other side. The fix is pre-aggregating before the exchange, not a faster fabric.',
        },
        {
          os: 'a GROUP BY that has to hit disk',
          osLine:
            'Once the hash table exceeds memory the operator partitions by key and spills, and the cost stops being CPU and becomes I/O.',
          llm: 'a GROUP BY that has to cross a network',
          llmLine:
            'Literally the same operator with a more expensive medium — which is why the mergeability property from C4.L4 is what decides the cost here, exactly as it decided the spill there.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A nightly job aggregates a 4-billion-row event table by user_id across 64 workers. There are roughly 90 million distinct users. A colleague proposes the same fix that worked for the country-level report: "pre-aggregate on each node before the exchange, then merge". What do you expect, and why?',
          options: [
            'The same win: pre-aggregation always reduces the exchange, because partial states are smaller than rows',
            'Much less of a win: pre-aggregation bounds the exchange at distinct keys × workers, which here is 90M × 64 ≈ 5.8 billion states against 4 billion rows, so the states can exceed the rows and the group tables will not fit in memory either',
            'No effect at all, because a GROUP BY never shuffles once partial aggregates are enabled',
            'A win, but only after increasing the worker count so each node has fewer rows to aggregate',
          ],
          correct: [1],
          explanation:
            'Pre-aggregation replaces a row count with distinct keys × workers, and that substitution only helps when cardinality is far below volume. At 90 million users over 64 workers the bound is above the row count, so in the worst case each node emits nearly one state per row and you have added hash-table work and memory pressure for nothing — the country report worked because its cardinality was a couple of hundred. Raising the worker count makes it worse, since workers multiply the bound. The real fixes are to reduce cardinality (aggregate to a coarser key, or two-phase on a prefix) or to accept that this exchange moves rows and size it honestly.',
        },
        {
          q: 'Which of these queries has an exchange whose cost is proportional to the number of rows rather than to the number of distinct keys?',
          options: [
            'SELECT country, sum(amount) FROM orders GROUP BY country',
            'SELECT user_id, count(*) FROM events GROUP BY user_id, where the table is already distributed on user_id',
            'SELECT country, count(DISTINCT session_id) FROM events GROUP BY country, computed exactly',
            'SELECT country, avg(amount) FROM orders GROUP BY country, with the partial state carried as (sum, count)',
          ],
          correct: [2],
          explanation:
            'An exact distinct count has no small mergeable partial state: to know whether a session_id was already seen, the receiving node needs the values themselves, so what crosses is proportional to rows (or at least to distinct session ids, which is the same order here). SUM and COUNT are mergeable, and AVG becomes mergeable the moment you carry the pair rather than the ratio — which is why engines represent it that way. The user_id case shuffles nothing at all, because the data is already distributed on the grouping key. The general rule: mergeability decides whether an exchange carries states or rows, and approximate sketches exist precisely to buy mergeability at the price of an error bar you have to declare.',
        },
        {
          q: 'Your platform bills per byte scanned. A team halves bytes scanned on a distributed join by adding a filter, and the job gets slower and starts spilling. The finance dashboard shows the win. What is the most likely explanation, and what do you put in front of the room?',
          options: [
            '"Compression got worse after the filter, so the same rows now decode more slowly" — show the compression ratio',
            '"The filter reduced bytes read but the surviving rows are concentrated on one join key, so bytes moved barely fell and the busiest partition grew" — show bytes moved and max-over-mean partition size next to bytes scanned, since the scan bill cannot see the exchange',
            '"The cluster is undersized for the new plan" — show utilisation and propose more workers',
            '"Filters are pushed down after the exchange in this engine" — show the query plan and ask for a planner hint',
          ],
          correct: [1],
          explanation:
            'Bytes scanned and bytes moved are separate bills that move independently, and only the first is on the invoice. A predicate that is selective overall can be entirely unselective on the hot key, so the exchange keeps almost all of its skewed traffic while the scan drops — and once one partition exceeds a worker memory budget the exchange spills, which is elapsed time and node-hours rather than bytes. Compression is a red herring: it changes bytes read, not partition balance. Adding workers leaves the hot partition on one worker (C6.L3). The professional move is to bring both counts, name which one the invoice can see, and state the assumption in your byte estimate — the projected row width — before someone else does.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the exchange operator, and the papers that priced it',
      md: `**Graefe, "Encapsulation of Parallelism in the Volcano Query Processing System" (SIGMOD 1990)** is the origin of the idea that makes all of this tractable: parallelism and data movement are packaged into a single \`exchange\` operator, so every other operator stays single-threaded and location-agnostic. Read it for the design discipline rather than the implementation — the reason a modern planner can decide between broadcast and partitioned without rewriting the join is that the movement is a separate operator with its own cost.

**Shatdal and Naughton, "Adaptive Parallel Aggregation Algorithms" (SIGMOD 1995)** is the paper behind this lesson's central arithmetic. It works through when pre-aggregation pays and when it does not, and its answer is the one in the quiz: the win is a function of the ratio between rows and distinct groups, and a system that pre-aggregates unconditionally loses on high-cardinality keys.

For the sketch side, **Flajolet et al., "HyperLogLog" (2007)** and **Cormode and Muthukrishnan's Count-Min sketch** are the standard references, and the property to notice in both is *mergeability* — the reason they belong in a distributed engine at all is that two sketches combine into the sketch of the union, which exact distinct counting cannot do.

**Dean and Ghemawat, "MapReduce" (OSDI 2004)** is worth reading now rather than historically: its shuffle is the most explicit one ever shipped, its combiner is exactly the partial aggregate above, and its skew behaviour — the reduce task that runs ten times longer than the others — is C6.L3 arriving twenty years early.

Siblings: **C4.L4** derives the mergeability property this lesson leans on, and **tablespace T0.L2** has the random-versus-sequential cost model that explains why a spilled exchange is so much worse than a resident one.`,
    },
  ],
}

export default lesson
