import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c0.l3',
  slug: 'three-places-bytes-live',
  trackId: 'c0',
  index: 3,
  title: 'Three Places Bytes Live',
  minutes: 16,
  hook: 'Local flash, a storage fabric, object storage: the same byte count costs three different things, and only one of the three is about bandwidth.',
  exercise: 'quiz',
  artifact: 'scan-budget',
  takeaway: {
    number: '2 numbers',
    claim:
      'Every storage regime is characterised by requests per second and bytes per request — quote both, because bandwidth alone hides the workloads that regress.',
  },
  blocks: [
    {
      type: 'prose',
      md: `You now have a byte count. This lesson is about what a byte count *costs*, and the answer depends on where the bytes are — not by a constant factor, but by which term dominates.

Keep two numbers for any storage regime and you can reason about all of them:

- **bytes per request** — how much data one round trip returns
- **requests per second** — how many round trips you can have outstanding and completing

Aggregate bandwidth is the product of those two. Which means bandwidth is a *derived* number, and quoting only bandwidth hides exactly the workloads that fail: the ones with small requests. A platform can be at 20% of its rated throughput and completely saturated, because it ran out of requests rather than bytes. That is not a hypothetical — it is Column Week's fifth incident, and it is the single most common surprise when a workload moves between the regimes below.`,
    },
    {
      type: 'prose',
      md: `## The three regimes

Orders of magnitude, labelled as such. These are not benchmarks and you should not quote them as measurements — they are the *shape* of each regime, and the shape is what changes an architecture.

| | local NVMe | shared flash over a fabric | object storage |
|---|---|---|---|
| latency for a small read | ~100 µs, order-of-magnitude | ~200 µs–1 ms, order-of-magnitude | ~10–100 ms first byte, order-of-magnitude |
| bandwidth | GB/s per device | GB/s, aggregated across the fleet | GB/s, effectively unbounded *with concurrency* |
| what runs out first | device bandwidth, and capacity per box | **round trips** under small-read workloads | **requests**, and per-request overhead |
| what a workload must do | little — it is the easy case | batch reads into larger requests | batch aggressively; request in parallel |
| capacity ceiling | one machine | the cluster | practically none |
| who else can read it | that machine | every compute node | anyone with credentials |

The interesting column is the last row of behaviour, not the first row of latency. **Local NVMe is where bad habits are free.** A workload of a million tiny reads runs acceptably, so nobody batches, nobody coalesces, and nobody learns that request count is a resource. Move that workload one regime to the right and the term that dominates changes underneath it.

The arithmetic is blunt. Read 1 GiB in 8 KiB requests and that is 131,072 round trips. At an optimistic 20 ms each, served **serially**, you have committed to 44 minutes. The same gigabyte in 8 MiB requests is 128 round trips — about 2.5 seconds at the same latency. Same bytes, same storage, a factor of a thousand, and the only thing that changed was request size. This is why every mature object-storage reader coalesces adjacent ranges and issues them concurrently, and why a columnar layout with tiny row groups can be *pathological* on object storage while merely suboptimal on local disk.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '131,072',
          label: 'requests to read 1 GiB in 8 KiB pieces',
          hint: 'Arithmetic, not a measurement: 1 GiB ÷ 8 KiB. In 8 MiB pieces it is 128 requests for the same data.',
        },
        {
          value: '~1000×',
          label: 'the cost of getting request size wrong',
          hint: '131,072 round trips versus 128, at the same per-request latency. Bandwidth was never the constraint.',
        },
        {
          value: '~100 µs → ~10 ms',
          label: 'small-read latency, local flash to object storage',
          hint: 'Order-of-magnitude only. Roughly two orders of magnitude, which is why the same code changes regime when the storage does.',
        },
        {
          value: '2',
          label: 'numbers to quote for any regime',
          hint: 'Requests per second and bytes per request. Bandwidth is their product, and quoting only the product hides the failure mode.',
        },
      ],
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the same gigabyte, three regimes, two request sizes',
      height: 68,
      nodes: [
        { id: 'q', x: 26, y: 2, w: 48, h: 8, label: 'read 1 GiB of column chunks', sub: 'the byte count is fixed', color: '#A3E635' },
        { id: 'small', x: 2, y: 16, w: 44, h: 9, label: '8 KiB requests', sub: '131,072 round trips', color: '#FB7185' },
        { id: 'big', x: 54, y: 16, w: 44, h: 9, label: '8 MiB requests', sub: '128 round trips', color: '#3EF2A4' },
        { id: 'nvme', x: 2, y: 32, w: 30, h: 9, label: 'local NVMe', sub: 'both fine · habits form here', color: '#22D3EE' },
        { id: 'fabric', x: 35, y: 32, w: 30, h: 9, label: 'over a fabric', sub: 'small reads bind on round trips', color: '#FBBF24' },
        { id: 'object', x: 68, y: 32, w: 30, h: 9, label: 'object storage', sub: 'small reads are pathological', color: '#FB7185' },
        { id: 'idle', x: 2, y: 48, w: 46, h: 9, label: 'bandwidth graph: 20% used', sub: 'and the workload is saturated', color: '#94A3B8' },
        { id: 'fix', x: 52, y: 48, w: 46, h: 9, label: 'coalesce + parallelise', sub: 'fewer, larger, concurrent requests', color: '#3EF2A4' },
        { id: 'layout', x: 26, y: 60, w: 48, h: 7, label: 'so row group size is a storage decision', sub: 'not just a pruning decision', color: '#A78BFA' },
      ],
      edges: [
        { from: 'q', to: 'small' },
        { from: 'q', to: 'big' },
        { from: 'small', to: 'nvme' },
        { from: 'small', to: 'fabric' },
        { from: 'small', to: 'object' },
        { from: 'object', to: 'idle', label: 'the misleading graph' },
        { from: 'big', to: 'fix' },
        { from: 'fix', to: 'layout' },
      ],
      steps: [
        {
          caption:
            'Fix the byte count: one gigabyte of column chunks has to come off storage. C0.L1 and C0.L2 got you this number, and nothing below changes it — only what it costs.',
          active: ['q'],
        },
        {
          caption:
            'Split it two ways. In 8 KiB pieces that is 131,072 round trips; in 8 MiB pieces, 128. The bytes are identical, so any difference in outcome is a property of request count alone.',
          active: ['small', 'big'],
          edges: ['q->small', 'q->big'],
        },
        {
          caption:
            'On local NVMe both work, which is exactly the problem: the workload learns nothing. Across a fabric the small-read version starts binding on round trips. On object storage, at tens of milliseconds per first byte, it stops being a performance question and becomes an outage.',
          active: ['nvme', 'fabric', 'object'],
          edges: ['small->nvme', 'small->fabric', 'small->object'],
        },
        {
          caption:
            'And the dashboard lies to you, because bandwidth is a product: throughput sits at a fraction of the rated figure while the workload is completely saturated on requests. Watch requests per second and bytes per request instead, and the diagnosis is immediate.',
          active: ['idle'],
          edges: ['object->idle'],
        },
        {
          caption:
            'The fix is always the same shape — fewer, larger, concurrent requests — which means row group and page sizing is not only a pruning decision. It sets your request size, so the right value depends on where the bytes live.',
          active: ['fix', 'layout'],
          edges: ['big->fix', 'fix->layout'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## Why the industry moved right, and what it bought

The trajectory of analytical platforms over the last decade is a march from left to right across that table, and the reason was never latency — object storage is worse at latency by two orders of magnitude. It was **elasticity and the separation of concerns**:

- **Storage and compute scale independently.** A table that grows 40% a year does not force you to buy CPUs you do not need, and a quarter-end reporting spike does not force you to buy storage.
- **Compute becomes disposable.** If no node owns any data, a node can die mid-query and be replaced, and a cluster can resize between queries. In a shared-nothing design where each node owns a slice, losing a node means its slice is unreachable and rebalancing means moving data.
- **One copy, many engines.** If the data is in an open format on shared storage, a warehouse engine, a Python process and a training job read the same bytes without a pipeline between them.

What it cost is the thing this lesson is about: **the storage layer got further away, and round trips became a first-class resource.** Every technique in C1 through C4 — bigger encoded blocks, zone maps that avoid requests entirely, late materialization, batch execution — is partly a response to that distance.

The shared-nothing MPP design sits at the left of the table and pays the opposite price: excellent locality, painful elasticity. Neither is a mistake. They price different physics, and C6 works the comparison properly.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'VAST DataBase: the middle column, taken seriously',
      systems: ['vast-db', 'clickhouse', 'duckdb'],
      sources: [
        'https://www.vastdata.com/blog/the-future-of-hpc-storage-is-dase',
        'https://support.vastdata.com/hc/en-us/articles/11910669291548-VAST-Database-Overview',
        'https://www.vastdata.com/blog/vasts-datastore-and-the-case-for-true-shared-everything-architecture',
      ],
      md: `The middle column of that table is the one most engineers have the least intuition for, and it is where VAST's architecture lives.

By VAST's own description, **DASE — Disaggregated, Shared-Everything** — decouples the storage media from the CPUs that manage it, and then shares that storage, *including all system metadata*, across every server in the cluster. VAST DataBase is described as a tabular database residing on such a cluster and using its storage, positioned to bridge warehouse performance and data-lake scale.

Read against this lesson, three consequences follow from that description, and they are worth separating from any performance claim:

1. **It is not the shared-nothing model.** No compute node owns a slice, so node loss does not make a slice unreachable and rescaling does not mean redistributing data. That is the elasticity argument for object storage, obtained without object-storage latency.
2. **Shared metadata is the load-bearing part.** In most disaggregated designs the catalog is a separate service and becomes the coordination bottleneck — the capacity desk's usual answer to "what saturates first". A design where metadata lives in the same shared, all-flash namespace as data changes where that ceiling is.
3. **Latency sits between the columns, not at one end.** A fabric is not a local bus and not the public internet. So the request-size discipline of this lesson still applies — it is simply less brutal than object storage and less forgiving than local NVMe.

**What we have not measured, and neither should you assume.** There is no VAST cluster behind this course. Nothing above is a performance claim, and where VAST publishes figures they are theirs, on their configuration. If this architecture matters to a decision you are making, the proof-of-concept has to measure *your* workload's requests per second and bytes per request — not aggregate throughput, because throughput is the number that looked fine in the incident above. The vendor room grades you on being able to say that.`,
    },
    {
      type: 'isomorphism',
      title: 'the request/bandwidth split ≡ splits you already know',
      pairs: [
        {
          os: 'IOPS versus throughput',
          osLine:
            'A storage volume is provisioned on both, and the one you exhaust first depends entirely on your I/O size.',
          llm: 'requests versus bandwidth',
          llmLine:
            'Identical structure one layer up. A columnar scan with tiny row groups exhausts requests while bandwidth idles.',
        },
        {
          os: 'N+1 queries in an ORM',
          osLine:
            'A thousand round trips to a database that could have answered in one. The fix is to batch, not to speed up the database.',
          llm: 'unbatched column-chunk reads',
          llmLine:
            'A thousand range requests to storage that could have served eight. The fix is coalescing, not a faster fabric.',
        },
        {
          os: 'buying a bigger instance to fix a lock',
          osLine:
            'The resource you added was never the constrained one, so the graph does not move and the bill does.',
          llm: 'adding bandwidth to fix a request-bound scan',
          llmLine:
            'Same error, same outcome. The 20%-utilised throughput graph was telling you this before you spent the money.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A workload moves from local NVMe to disaggregated storage. Most queries improve; one class — many small, highly selective reads at high concurrency — degrades badly. Fabric throughput utilisation sits at 21%. What is the diagnosis?',
          options: [
            'The fabric is oversubscribed and needs more bandwidth provisioned',
            'The workload is request-bound rather than bandwidth-bound: each tiny read pays a round trip that small requests cannot amortise, so utilisation stays low while latency climbs',
            'Disaggregated storage is simply slower and this workload should move back',
            'Compression is now being decoded on the compute nodes and that is the new cost',
          ],
          correct: [1],
          explanation:
            'The 21% figure is the tell. If bandwidth were the constraint it would be near 100%. Low utilisation with rising latency and rising request count means the constraint is round trips and outstanding-request concurrency. More bandwidth changes nothing; coalescing reads, raising the minimum read granularity and increasing concurrency change everything.',
        },
        {
          q: 'You are reading 1 GiB of column data from object storage where first-byte latency is roughly 20 ms. Which change helps most?',
          options: [
            'Compressing the data 2× so there is less to read',
            'Coalescing the reads into 8 MiB requests and issuing them concurrently, taking round trips from ~131,000 to ~128',
            'Moving to a region with 10 ms latency instead of 20 ms',
            'Increasing the compute node size',
          ],
          correct: [1],
          explanation:
            'Request size is the dominant term by three orders of magnitude here, so it is the only change of the right size. Halving the bytes helps by 2×; halving the latency helps by 2×; going from 131,000 round trips to 128 helps by about 1000×. Diagnose which term dominates before optimising, or you will spend effort proportional to your habits rather than to the problem.',
        },
        {
          q: 'Your platform is billed per TB scanned and a colleague argues that moving to cheaper storage will cut the analytics bill. What is the correct response?',
          options: [
            '"Agreed — storage cost is the dominant term in analytics spend."',
            '"Those are different line items. Storage price affects what we pay to keep bytes; the scan bill is set by how many bytes queries read, which is a layout question. I can show both numbers — and if the cheaper tier has higher per-request latency, the same queries may need larger row groups to stay economical."',
            '"It will not matter, because compression already minimises what we store."',
            '"We should benchmark it and see."',
          ],
          correct: [1],
          explanation:
            'Separating the two bills is the whole skill: cost-to-keep is a function of stored bytes and price per byte; cost-to-query is a function of bytes read, which layout controls. The second half of the answer is what makes it senior — a storage change can silently alter the right row group size, so it is a layout decision as well as a procurement one.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: disaggregation, argued both ways',
      md: `The canonical statement of the separation-of-compute-and-storage argument for analytics is **"The Snowflake Elastic Data Warehouse" (SIGMOD 2016)** — read it for the reasoning about elasticity and node disposability rather than the product. For the counter-position, **the ClickHouse documentation on MergeTree and sharding** describes what tight locality buys and what it costs when a node dies or the cluster is resized.

For a rigorous treatment of *why* small requests are the enemy on object storage, and what a reader must do about it, the **DuckDB documentation on reading remote Parquet** and the **Apache Arrow / Parquet range-coalescing implementations** are the practitioner's answer: prefetch, coalesce adjacent ranges, and issue concurrently. Reading either one's read-planning code teaches more than any blog post about latency.

On the hardware end, **NVMe over Fabrics** specifications explain how the middle column of this lesson's table achieves near-local latency over a network, and the honest caveat that a round trip remains a round trip.

Siblings: **tablespace T0.L2** derives the random-versus-sequential cost model this lesson generalises, and it is worth reading first if the phrase "the page is the unit of I/O" is not yet reflexive.`,
    },
  ],
}

export default lesson
