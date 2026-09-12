import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c0.l1',
  slug: 'bytes-scanned-is-the-bill',
  trackId: 'c0',
  index: 1,
  title: 'Bytes Scanned Is the Bill',
  minutes: 15,
  hook: 'Three numbers decide what analytics costs you — columns projected, blocks skipped, queries per day — and only the last one is on anybody\'s dashboard.',
  exercise: 'quiz',
  artifact: 'scan-budget',
  takeaway: {
    number: '3 × 2 × 1',
    claim:
      'Bytes scanned is projection × pruning × frequency, so a 3× improvement in each of the first two is a 9× bill reduction that requires no new hardware.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Analytics has one physical cost. Not CPU, not memory, not the cluster size on the invoice — **bytes that had to leave storage to answer the question.** Everything else is downstream of it. Latency is that number divided by bandwidth. Cost, on a consumption platform, is that number multiplied by a rate. Concurrency limits are that number competing with itself.

This is unusual and worth sitting with, because it means the central skill of this course is arithmetic you can do before touching an engine. You can be handed a schema, a query and a row count, and produce a defensible estimate of what the query will cost — and then check it, which is what the lab at the end of this lesson is for.

The formula has three factors:

\`\`\`
bytes scanned  =  bytes per row you actually need
                × rows the engine could not skip
                × how often the query runs
\`\`\`

Every technique in the engine half of this course attacks one of those three. Columnar layout and projection pushdown attack the first. Clustering, zone maps and partitioning attack the second. Materialization, caching and — bluntly — asking fewer questions attack the third. **Most teams only ever manage the third**, because it is the only one visible in a dashboard, and it is the one with the least headroom.`,
    },
    {
      type: 'prose',
      md: `## The bill, computed

Take a table that looks like most fact tables: \`orders\`, **2 billion rows**, 60 columns, averaging **400 bytes per row**. That is **800 GB** logical — call it 0.8 TB before any compression.

The query that runs on every dashboard refresh:

\`\`\`sql
SELECT region, SUM(net_revenue)
FROM orders
WHERE order_ts >= now() - INTERVAL 7 DAY
GROUP BY region
\`\`\`

Three columns of sixty. \`order_ts\` (8 B), \`region\` (a short string, ~12 B), \`net_revenue\` (8 B) — about **28 bytes of the 400** each row carries. And the predicate is selective: seven days of a two-year table is roughly **1% of the rows**, 20 million of them.

Now price it under two layouts, using nothing but the arithmetic above.

**Row store.** The unit of I/O is a page, and a page holds whole rows. To read 28 bytes you fetch 400. No index rescues you either — a 1% predicate on an unclustered column means the matching rows are scattered across effectively every page, and once you are touching most pages, a scan beats an index lookup. So: **~800 GB read to use ~560 MB.** You paid for 400 bytes 2 billion times and used 28 of them.

**Column store, badly laid out.** Projection works immediately: three column files instead of sixty. 2 billion rows × 28 bytes = **56 GB**. That is a **14× reduction from layout alone**, before compression, before pruning, without changing one character of the query. This is the entire content of "just use a column store", and it is real.

**Column store, laid out for this query.** If the table is physically clustered on \`order_ts\`, the seven-day window lives in a small number of contiguous blocks. Block statistics — min and max \`order_ts\` per block — let the engine skip the rest **unread**. Skip blocks holding 95% of the rows and you read **~2.8 GB** of the 56 GB; skip 99% and you read **~560 MB**. (Note the phrasing: 95% of the *rows*, not 95% of the *blocks*. The two coincide only when blocks are equally full, and the lab below is about to show you a case where they are not.) Compression then shrinks whatever survived, by a factor that depends entirely on which columns you kept — C1 measures it, and it is the one factor here you cannot predict from the schema alone.

That is the arc of this course in one example: **800 GB → 56 GB → single-digit GB**, same data, same answer, same SQL. Three orders of magnitude, and not one of the steps was a hardware decision.

The lab below runs exactly this comparison on a real columnar engine, on 500,000 rows rather than 2 billion. Run in a browser it reports a **projection factor of 19×**, **96% of row groups skipped**, and a **1,103× total**, with the identical query reading **64× more bytes** once the rows were written in a different order. Your numbers should match those closely, because the fixture is seeded; if they do not, one of us has learned something.

One trap in that sentence, and it is worth the detour because it is the kind of thing that gets quoted into a design document. **96% of row groups skipped is not a 25× reduction in bytes.** Blocks are the unit of skipping, but blocks are not all the same size: 500,000 rows at 20,480 per group is 24 full groups and a final partial one holding 8,480, and a seven-day window at the end of the history lands inside that small one. So one group of twenty-five survives and it holds 1.70% of the rows — a **59×** byte reduction, not 25×. Group count is how many decisions the planner made. Bytes are what the survivors happened to contain. Quote the one you are being billed for.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '28 / 400',
          label: 'bytes the query needs per row',
          hint: 'The schema fact this all rests on: three columns of sixty. A row store bills you for all 400; a column store bills for 28. On the 2-billion-row table above that is a 14x projection factor — the measured figures below come from the lab, which runs a different, smaller fixture, so do not multiply across the two.',
        },
        {
          value: '19×',
          label: 'projection, measured',
          hint: 'The lab fixture: 101.7 MiB for all 45 columns against 5.42 MiB for the three the query projects. Close to the schema arithmetic, and not identical to it, because columns do not all compress alike.',
        },
        {
          value: '59×',
          label: 'pruning, measured in BYTES',
          hint: 'Not 25x. 1 of 25 row groups is read — 96% of groups skipped — but groups are not the same size: 500,000 rows at 20,480 per group is 24 full groups plus a final partial one of 8,480, and the seven-day window lands inside that small one. So the surviving group holds 1.70% of the rows, not 4%. Group count is how many decisions the planner made; bytes are what the survivors actually hold.',
        },
        {
          value: '1,103×',
          label: 'the two measured factors multiplied',
          hint: '18.8 x 58.8 = 1,103, and 101.7 MiB ÷ 94 KiB = 1,103 independently. They multiply because they act on different terms of the same product: bytes per row, and rows read.',
        },
      ],
    },
    {
      type: 'prose',
      md: `## Why the factors multiply

This is the point most people miss, and it is worth being precise about because it is where the money is.

Projection reduces **bytes per row**. Pruning reduces **rows read**. They act on different terms of the same product, so their effects compose: 14× and 100× is 1,400×, not 114×. Compression then reduces the physical size of whatever survives both, which is a third independent factor.

The practical consequence is that **the weakest factor dominates your bill**. A beautifully compressed, perfectly projected table that prunes nothing still reads every block. A well-clustered table queried with \`SELECT *\` still ships sixty columns. Teams tend to optimise the factor they most recently read a blog post about, and then report a disappointing improvement, because they improved a 2× factor while a 1× factor sat untouched.

So the first question to ask about any analytical workload is not "is it fast" but: **which of the three factors is currently equal to one?**`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the same query, four bills',
      height: 66,
      nodes: [
        { id: 'q', x: 30, y: 2, w: 40, h: 9, label: 'the query', sub: '3 of 60 cols · 1% of rows', color: '#A3E635' },
        { id: 'row', x: 3, y: 18, w: 21, h: 10, label: 'row store', sub: '~800 GB', color: '#FB7185' },
        { id: 'proj', x: 27, y: 18, w: 21, h: 10, label: '+ projection', sub: '~56 GB', color: '#FBBF24' },
        { id: 'prune', x: 51, y: 18, w: 21, h: 10, label: '+ pruning', sub: '~2.8 GB', color: '#3EF2A4' },
        { id: 'comp', x: 75, y: 18, w: 21, h: 10, label: '+ compression', sub: 'column-dependent', color: '#22D3EE' },
        { id: 'need', x: 30, y: 38, w: 40, h: 9, label: 'bytes the answer needed', sub: '~1% of the rows', color: '#94A3B8' },
        { id: 'waste', x: 3, y: 52, w: 45, h: 9, label: 'the 60 columns you did not ask for', sub: 'layout tax', color: '#FB7185' },
        { id: 'skip', x: 52, y: 52, w: 44, h: 9, label: 'the 99% of rows outside the window', sub: 'pruning tax', color: '#FBBF24' },
      ],
      edges: [
        { from: 'q', to: 'row' },
        { from: 'row', to: 'proj', label: 'store columns apart' },
        { from: 'proj', to: 'prune', label: 'cluster + block stats' },
        { from: 'prune', to: 'comp', label: 'encode' },
        { from: 'row', to: 'waste' },
        { from: 'proj', to: 'skip' },
        { from: 'prune', to: 'need' },
      ],
      steps: [
        {
          caption:
            'One query, stated in terms of the two things that matter: how much of each row it needs (3 columns of 60) and how much of the table it needs (1% of rows, a seven-day window).',
          active: ['q'],
        },
        {
          caption:
            'The row store reads ~800 GB because the page is the unit of I/O and a page holds whole rows. The 57 columns nobody asked for are not overhead — they are the layout. No index helps: at 1% scattered across every page, a scan is already the cheaper plan.',
          active: ['row', 'waste'],
          edges: ['q->row', 'row->waste'],
        },
        {
          caption:
            'Storing columns separately makes projection physical: three column files, ~56 GB. A 14× cut from layout alone. But every block of those three columns is still read, because nothing yet tells the engine which blocks could contain the seven-day window.',
          active: ['proj', 'skip'],
          edges: ['row->proj', 'proj->skip'],
        },
        {
          caption:
            'Cluster the table on order_ts and keep min/max per block. Now the predicate can be answered against metadata: a block whose max timestamp predates the window cannot contain a match, so it is skipped unread. The lab below measures 96% skipped — 1 row group of 25, a further 58×, and the two factors multiply because they act on different terms.',
          active: ['prune', 'need'],
          edges: ['proj->prune', 'prune->need'],
        },
        {
          caption:
            'Encoding shrinks what survives — but by how much depends on the columns you kept, not on the format. A monotonic timestamp delta-encodes to almost nothing; a high-entropy numeric column barely moves. C1 measures it. Same data, same SQL, same answer, three orders of magnitude apart, and every step was a layout decision rather than a hardware one.',
          active: ['comp'],
          edges: ['prune->comp'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'analogy',
      title: 'the archive request',
      md: `You ask an archivist for the dates and amounts of last week's invoices. The row-store archivist brings you every complete invoice file in the building, because files are what the shelves hold. The column-store archivist keeps a ledger of dates, a ledger of amounts and a ledger of regions, and brings three thin ledgers. The *well-laid-out* column-store archivist keeps those ledgers in date order with the date range written on each spine, walks past the ones whose spine says last year, and brings you a single page.

The query never changed. The filing did.`,
    },
    {
      type: 'isomorphism',
      title: 'bytes scanned ≡ things you already meter',
      pairs: [
        {
          os: 'cache hit rate',
          osLine:
            'A miss costs a fetch you hoped to avoid. You tune the layout so the working set fits, and you watch the ratio.',
          llm: 'pruning ratio',
          llmLine:
            'A read block that held no match is a miss you paid for. You tune physical clustering so the predicate matches the layout — and you watch the ratio.',
        },
        {
          os: 'SELECT * in an OLTP code review',
          osLine:
            'Rejected on sight: it fetches columns the caller does not use and defeats covering indexes.',
          llm: 'SELECT * on a column store',
          llmLine:
            'Worse, and rarely flagged: it converts the one structural advantage of your storage layout back into a row scan.',
        },
        {
          os: 'a covering index',
          osLine:
            'Answers a query from the index alone. You pay for it on every write, forever, and you must choose it in advance.',
          llm: 'a zone map',
          llmLine:
            'Answers "can I skip this block?" from a few bytes per block. Costs nothing extra on write — but only works to the extent the data is physically clustered.',
        },
      ],
    },
    {
      type: 'prose',
      md: `## Where the bytes come from matters too

The formula gives you a byte count. What that byte count *costs* depends on where the bytes live, and in 2026 there are three regimes worth separating — not by their headline bandwidth, but by **what you are charged per unit of work**:

| regime | what dominates | what breaks a workload |
|---|---|---|
| local NVMe | bandwidth; requests are cheap | running out of one machine |
| shared flash over a fabric | bandwidth is abundant; **round trips are not free** | many tiny reads at high concurrency |
| object storage | request latency and request count | small files, many of them |

The third column is where architectures actually fail. On local NVMe nobody thinks about request count, so nobody carries the habit forward. Move the same workload onto a fabric or onto object storage and the term that dominates changes — a workload of thousands of small reads can be bound by *round trips* while aggregate bandwidth sits mostly idle. That is not a defect of disaggregation; it is a different cost model, and it is why C0.L3 prices all three and why the last Column Week drill is exactly this incident.

Keep the two questions separate and you will not be confused by any platform claim: **how many bytes does the layout require me to read**, and **what does this storage regime charge me per read**. Almost every marketing argument about analytics collapses into one or the other.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'Where VAST DataBase sits in this picture',
      systems: ['vast-db', 'duckdb', 'clickhouse'],
      sources: [
        'https://support.vastdata.com/hc/en-us/articles/11910669291548-VAST-Database-Overview',
        'https://www.vastdata.com/blog/the-future-of-hpc-storage-is-dase',
        'https://www.vastdata.com/features/transactional-and-analytical-support',
      ],
      md: `This course deep-dives **VAST DataBase**, and it does so without a VAST cluster — so the rules are stated once, here, and hold for every vendor block that follows.

By VAST's own documentation, VAST DB is a **tabular database that resides on a VAST cluster and uses that cluster's storage**, positioned to bridge warehouse-style performance and data-lake scale. The cluster architecture VAST calls **DASE — Disaggregated, Shared-Everything** — decouples the storage media from the CPUs that manage it, and shares that storage *including system metadata* across all servers in the cluster. On the write path, VAST describes new data landing in persistent memory and then being converted into optimised columnar form for analytics.

Read against this lesson, that maps onto the middle regime of the table above: **shared flash reached over a fabric**, with the shared-everything property meaning any compute node can serve any data rather than owning a slice of it. That is a genuinely different point in the design space from the shared-nothing MPP model — and it changes different terms of the cost model than you might expect, which is what C6 is for.

Three commitments for the rest of the course:

1. **Mechanisms, not benchmarks.** We have no cluster, so we never present a VAST performance number as *ours*. Where VAST publishes figures, they are labelled as VAST's, on VAST's configuration.
2. **Dated and sourced.** Every claim carries the month it was verified and a link. Product specifics change; the physics does not, which is why the physics is what we teach.
3. **Never a price, never a ranking.** We describe pricing *shapes* and name mechanisms. "Storage is shared by all compute nodes" is a fact. "Therefore it is the best platform" is marketing, and it would be wrong for someone's workload within a year.`,
    },
    {
      type: 'ducklab',
      lab: 'scan-bill',
    },
    {
      type: 'prose',
      md: `## The habit this course is really teaching

Everything above is arithmetic, and arithmetic can be wrong. The professional habit that matters more than any of it: **state the caveat before the room finds it.**

The estimate in this lesson assumes average row width represents the rows the query touches, that the seven-day window is genuinely 1% of the table, and that clustering on \`order_ts\` reflects how the data physically arrives. Any of those can be false. A wide free-text column pulls the average around. Recent data is often denser than historical. Upstream loaders reorder without telling anyone — and that last one is Column Week's first incident, because it triples a bill overnight while every dashboard stays green.

Naming those assumptions out loud does not weaken the estimate. It is the difference between an estimate someone can act on and a number someone will later be embarrassed by. The architecture half of this course grades you on exactly this, in front of adversaries who go looking for the assumption you did not mention.`,
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A table has 2B rows, 60 columns, ~400 B/row (~800 GB). A query projects 3 columns (~28 B/row) and filters to 1% of rows on a column the table is NOT clustered by. Roughly what does a column store read?',
          options: [
            '~2.8 GB — projection and the 1% predicate both apply',
            '~56 GB — projection applies (3 of 60 columns), but with no clustering on the filter column almost no blocks can be skipped, so all blocks of those columns are read',
            '~800 GB — the predicate forces a full table scan regardless of layout',
            '~8 GB — the engine samples blocks and interpolates',
          ],
          correct: [1],
          explanation:
            'Projection is structural: storing columns apart means only three column files are opened, giving the 14× cut. Pruning is not structural — it requires the filter column to be physically clustered so that block min/max ranges exclude the predicate. Unclustered, every block might contain a matching row, so every block must be read. The two factors are independent, which is exactly why one of them can be 1× while the other is 14×.',
        },
        {
          q: 'Two teams each cut their scan volume. Team A improves projection 10× and leaves pruning at 1×. Team B improves both 3×. Which reads fewer bytes, and why?',
          options: [
            'Team A — 10× is the larger single improvement',
            'Team B — the factors multiply, so 3 × 3 = 9× versus Team A\'s 10 × 1 = 10×, making them roughly equal; but B has removed both weak factors while A still has one stuck at 1×',
            'They are identical because total reduction is what matters',
            'Team A — pruning only helps time-series data',
          ],
          correct: [1],
          explanation:
            'The arithmetic makes them nearly equal today (10× vs 9×), which is the trap. The engineering difference is structural: Team A has an untouched 1× factor, so their next improvement is available and large. Team B has extracted from both and their next gain is harder to find. The diagnostic question is always "which factor is still 1×", not "what is my total".',
        },
        {
          q: 'Your platform bills per TB scanned. Finance asks what next year costs. Which answer survives the room?',
          options: [
            '"It scales with usage, so cost tracks value delivered."',
            '"About double this year, based on last year\'s trend."',
            '"Two growth terms, separately: data volume growth, and query-mix growth as adoption spreads — with the second larger and less predictable. Here is the arithmetic for both, and the assumption I am least sure about is that the recurring queries stay clustered."',
            '"Compression improvements should keep it roughly flat."',
          ],
          correct: [2],
          explanation:
            'Two mechanisms separated, arithmetic shown, and the weakest assumption named before it is found. The first answer describes losing control of a line item and calls it a benefit. The second is a number with no mechanism. The fourth confuses stored size with scanned bytes — compression reduces what you store and what a well-pruned query reads, and does nothing for a query that reads every block.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: where this cost model comes from',
      md: `The argument that bytes-read is the metric worth designing around is made most completely in **Stonebraker et al., "C-Store: A Column-oriented DBMS" (VLDB 2005)** — projections, compression, late materialization, all justified against one number. Its acknowledged predecessor is **MonetDB** (Boncz and colleagues from the 1990s), whose execution model opens C4. For a modern textbook treatment, **Abadi, Boncz and Harizopoulos, "The Design and Implementation of Modern Column-Oriented Database Systems"** is the survey that ties the pieces together.

For the layout question stated as arithmetic rather than architecture, the original is older than all of them: **Copeland & Khoshafian, "A Decomposition Storage Model" (SIGMOD 1985)** — the paper that named DSM and priced it against NSM.

For the practitioner view of the same numbers, read the **DuckDB storage and performance documentation** (how row group size, sort order and compression interact) and the **Apache Parquet format specification** (row groups, column chunks, page statistics — the metadata that makes pruning possible).

Sibling courses: **tablespace T0.L2** derives the random-versus-sequential cost model this lesson stands on, and **tablespace T7.L1** works the NSM/DSM comparison from the row store's side. If you want the layer beneath "the page is the unit of I/O", that is where it is.`,
    },
  ],
}

export default lesson
