import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c6.l4',
  slug: 'shared-nothing-disk-everything',
  trackId: 'c6',
  index: 4,
  title: 'Shared Nothing, Shared Disk, Shared Everything',
  minutes: 17,
  hook: 'Compare the three architectures on throughput and you learn nothing you can defend. Compare them on what happens when a node dies and what happens when you resize, and the differences are arithmetic: 8.4 TB moved versus 0.',
  exercise: 'quiz',
  takeaway: {
    number: '8.4 TB',
    claim:
      'Growing a shared-nothing cluster from 32 to 40 nodes redistributes one fifth of the table before the new capacity is usable — the same rescale on shared storage moves no table data at all, which is the entire elasticity argument in one count.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Architecture comparisons usually get run on throughput, which is the one axis that tells you nothing durable. Throughput depends on the configuration, the workload, the codec, the year and who paid for the benchmark. It also has almost no bearing on the decision, because a platform is chosen for a decade and the questions that hurt over a decade are operational.

So compare the three architectures on two events instead, both of which are certain to happen:

1. **A node is lost** — hardware failure, kernel panic, spot reclamation, a rack losing power mid-query.
2. **The cluster is resized** — because the data grew, or because quarter-end needs three times the compute for four days.

Those two events separate the designs cleanly, and both answers are counts you can compute from a capacity plan you already have. C0.L3 priced where the bytes live; this lesson prices who owns them.`,
    },
    {
      type: 'prose',
      md: `## The three designs, in one sentence each

- **Shared-nothing.** Every node owns a slice of the data on its own storage, and a query is a plan over those slices. The classic MPP design, and the design behind a sharded table in most open-source engines. Locality is perfect: a scan reads local disk, and a join on the distribution key needs no exchange at all.
- **Shared-disk.** Compute nodes are interchangeable and all of them can reach all of the data over a network — a SAN historically, object storage or a flash fabric now. No node owns a slice. Metadata and coordination live in a separate service.
- **Shared-everything.** Shared-disk, plus the *metadata* is shared by every compute node rather than living in a coordinating service. This is the newest of the three and the one with the least folklore attached, which is exactly why the mechanism has to be stated carefully rather than praised.

Now run the two events.

### Event 1 — a node dies mid-query

| | shared-nothing | shared-disk | shared-everything |
|---|---|---|---|
| is any data unreachable? | **yes**, unless replicated | no | no |
| what does the query do? | fails, or waits for a replica | re-runs the lost tasks elsewhere | re-runs the lost tasks elsewhere |
| what does recovery move? | a full slice, to rebuild redundancy | nothing | nothing |
| what does the survivor pay? | **the dead node's share on top of its own** | an extra slice of scan work, spread | an extra slice of scan work, spread |

The last row is the one people miss, and it is C6.L3 wearing a different hat. Take a 42 TB table on 32 nodes at replication factor 2. Each node holds a 1.31 TB primary slice plus a secondary copy of someone else's, so the raw footprint is **84 TB for 42 TB of table**. Lose a node and the survivor holding its secondary copy is now serving **two slices**:

\`\`\`
per-node share, healthy   42 TB / 32  =  1.31 TB
the survivor, degraded    1.31 × 2    =  2.62 TB
max ÷ mean                            =  2.0
\`\`\`

**A replication factor of 2 does not make node loss free; it converts an outage into a skew factor of 2.** And because the largest partition is the runtime, the whole cluster runs at roughly half speed until the rebuild finishes — while every average-based dashboard shows a cluster that has lost 3% of its capacity.

On shared storage there is no slice to be unreachable, so the failed work is redistributed across every surviving node instead of landing on one. That is the difference between a design that degrades by \`1/n\` and a design that degrades by \`2×\` on one worker.

### Event 2 — the cluster is resized

Here the arithmetic is blunt. Grow 32 nodes to 40 with the same 42 TB:

\`\`\`
per-node share now       42 / 32  =  1.3125 TB
per-node share after     42 / 40  =  1.05   TB
each old node sheds      0.2625 TB
total redistributed      32 × 0.2625  =  8.4 TB   ( = 20% of the table )
\`\`\`

Generalised: moving from \`n\` nodes to \`m\` nodes redistributes \`1 − n/m\` of the table. **8.4 TB has to cross the network before any of the new capacity is usable**, and it competes with queries while it does. Scaling back down moves the same 8.4 TB again. A quarter-end spike handled this way pays the rebalance twice for four days of extra compute, which is why in practice nobody does it — the cluster is sized for the peak and idles the rest of the year. *That* is the real cost of shared-nothing elasticity: not the rebalance you run, but the resize you decline to attempt.

On shared-disk and shared-everything the same resize moves **0 bytes of table data**. You start processes. What you lose is not free either, and the honest list is short: **cache warmth** (a new node's local cache is empty, so its first queries pay full remote-read cost), **locality** (every scan is a remote read, which is C0.L3's request-size discipline becoming mandatory rather than optional), and — for shared-disk specifically — **the coordination service**, because the catalog that knows where everything is has now become the thing every node must agree with.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the same two events, three architectures, and the counts that separate them',
      height: 74,
      nodes: [
        { id: 'sn', x: 2, y: 2, w: 30, h: 9, label: 'shared-nothing', sub: 'each node owns a slice', color: '#FBBF24' },
        { id: 'sd', x: 35, y: 2, w: 30, h: 9, label: 'shared-disk', sub: 'data shared, metadata is a service', color: '#22D3EE' },
        { id: 'se', x: 68, y: 2, w: 30, h: 9, label: 'shared-everything', sub: 'data AND metadata shared', color: '#3EF2A4' },
        { id: 'loss', x: 2, y: 14, w: 96, h: 8, label: 'event 1 — a node dies mid-query', sub: '42 TB table, 32 nodes, replication factor 2', color: '#FB7185' },
        { id: 'snl', x: 2, y: 25, w: 30, h: 10, label: 'slice unreachable', sub: 'the survivor serves 2.62 TB — a skew factor of 2.0', color: '#FBBF24' },
        { id: 'sdl', x: 35, y: 25, w: 30, h: 10, label: 'retry the lost tasks', sub: 'no data unreachable · cache warmth lost', color: '#22D3EE' },
        { id: 'sel', x: 68, y: 25, w: 30, h: 10, label: 'retry the lost tasks', sub: 'nothing was owned, so nothing is missing', color: '#3EF2A4' },
        { id: 'res', x: 2, y: 38, w: 96, h: 8, label: 'event 2 — resize from 32 nodes to 40', sub: 'moving from n to m redistributes 1 − n/m of the table', color: '#A78BFA' },
        { id: 'snr', x: 2, y: 49, w: 30, h: 11, label: '8.4 TB redistributed', sub: '20% of the table before any new capacity is usable', color: '#FBBF24' },
        { id: 'sdr', x: 35, y: 49, w: 30, h: 11, label: '0 bytes of table data', sub: 'but the catalog is now the coordination point', color: '#22D3EE' },
        { id: 'ser', x: 68, y: 49, w: 30, h: 11, label: '0 bytes, metadata shared too', sub: 'a vendor claim — dated, sourced, unmeasured by us', color: '#3EF2A4' },
        { id: 'ask', x: 2, y: 63, w: 96, h: 9, label: 'so ask two questions, not a throughput number', sub: 'bytes moved on rescale, and work per survivor on loss — both computable before you buy', color: '#A3E635' },
      ],
      edges: [
        { from: 'sn', to: 'loss' },
        { from: 'sd', to: 'loss' },
        { from: 'se', to: 'loss' },
        { from: 'loss', to: 'snl' },
        { from: 'loss', to: 'sdl' },
        { from: 'loss', to: 'sel' },
        { from: 'snl', to: 'res' },
        { from: 'res', to: 'snr' },
        { from: 'res', to: 'sdr' },
        { from: 'res', to: 'ser' },
        { from: 'snr', to: 'ask' },
        { from: 'sdr', to: 'ask' },
        { from: 'ser', to: 'ask' },
      ],
      steps: [
        {
          caption:
            'Three designs, distinguished by one question: does a compute node own data? Shared-nothing says yes and gets perfect locality for it. The other two say no, and everything below is the consequence of that single answer.',
          active: ['sn', 'sd', 'se'],
        },
        {
          caption:
            'First event, and it is certain: a node is lost mid-query. Hold the configuration fixed — a 42 TB table over 32 nodes, replicated twice, which is 84 TB of raw footprint for 42 TB of table.',
          active: ['loss'],
          edges: ['sn->loss', 'sd->loss', 'se->loss'],
        },
        {
          caption:
            'Shared-nothing: the slice is unreachable unless replicated, and if it is replicated the survivor now serves 2.62 TB against a 1.31 TB mean. Replication did not make loss free — it converted an outage into a skew factor of 2, and the maximum is the runtime.',
          active: ['snl'],
          edges: ['loss->snl'],
        },
        {
          caption:
            'On shared storage no data is unreachable, so the lost work is redistributed across every survivor rather than landing on one: the cluster degrades by one node instead of by a factor of two. What it loses is cache warmth, which is a first-query cost rather than a structural one.',
          active: ['sdl', 'sel'],
          edges: ['loss->sdl', 'loss->sel'],
        },
        {
          caption:
            'Second event: a resize. This is where the difference stops being about failure modes and becomes a number in a capacity plan, because moving from n nodes to m redistributes one minus n over m of the table.',
          active: ['res'],
          edges: ['snl->res'],
        },
        {
          caption:
            'Thirty-two nodes to forty is 8.4 TB across the network before a single new core is usable, and the same 8.4 TB again on the way back down — which is why shared-nothing clusters get sized for the peak and idle. Shared storage moves no table data at all.',
          active: ['snr', 'sdr', 'ser'],
          edges: ['res->snr', 'res->sdr', 'res->ser'],
        },
        {
          caption:
            'Both answers are counts you can compute before signing anything, from numbers a capacity plan already holds. Bring those two instead of a throughput figure, and a proof-of-concept has something falsifiable to measure.',
          active: ['ask'],
          edges: ['snr->ask', 'sdr->ask', 'ser->ask'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '8.4 TB',
          label: 'redistributed to go from 32 nodes to 40',
          hint: 'Arithmetic on a 42 TB table: each node sheds 1.3125 − 1.05 TB and there are 32 of them. Equivalently 1 − 32/40 = 20% of the table, and the same again to scale back down.',
        },
        {
          value: '2.0',
          label: 'skew factor after one node loss at replication factor 2',
          hint: 'The survivor holding the dead node\'s secondary copy serves 2.62 TB against a 1.31 TB mean. Since the maximum is the runtime, the cluster runs at about half speed until rebuild.',
        },
        {
          value: '84 TB',
          label: 'raw footprint for a 42 TB table at replication factor 2',
          hint: 'Redundancy in a shared-nothing design is paid in copies of the data plus a write fan-out. On shared storage it is paid once, inside the storage layer, as erasure coding.',
        },
        {
          value: '0 bytes',
          label: 'table data moved by a resize on shared storage',
          hint: 'You start and stop processes. The costs that remain are cache warmth, mandatory remote reads, and whatever coordinates metadata — none of which is a byte count proportional to the table.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'shared-nothing is not the loser here — it prices different physics',
      md: `Nothing above says shared-nothing is a mistake. It buys things the other two cannot:

- **A join on the distribution key needs no exchange at all.** Co-partition two tables on \`account_id\` and the biggest cost in C6.L1 and C6.L2 goes to zero for every join on that key. That is not an optimisation, it is a structural removal of the exchange — and it is available only when a node owns a slice.
- **Every scan is a local read.** No request-size discipline, no round-trip amplification, no coalescing logic. C0.L3's middle and right columns simply do not apply.
- **Predictability.** A design where the data does not move has a performance profile that is easier to reason about and easier to promise.

What it cannot buy is elasticity, because elasticity in a design where nodes own data is a data migration. So the honest framing in a review is a trade, not a ranking: **shared-nothing pre-pays for locality with rebalance cost and node-loss skew; shared storage pre-pays for elasticity with round trips and a coordination point.** Say which of those two your workload's next three years contain. If the answer is "a table that grows 40% a year and a quarter-end spike", you have named the axis; if it is "a fixed-size fact table joined on one key forever", you have named a different one.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'VAST DataBase: shared-everything, and specifically the shared-metadata part',
      systems: ['vast-db', 'clickhouse', 'duckdb'],
      sources: [
        'https://www.vastdata.com/blog/vasts-datastore-and-the-case-for-true-shared-everything-architecture',
        'https://www.vastdata.com/blog/the-future-of-hpc-storage-is-dase',
        'https://support.vastdata.com/hc/en-us/articles/11910669291548-VAST-Database-Overview',
        'https://www.vastdata.com/features/transactional-and-analytical-support',
      ],
      md: `C0.L3 introduced VAST's architecture as the middle column of the storage table. This lesson is where the second half of the name does the work, so here is the mechanism as VAST describes it, with nothing added.

**What is claimed, in their words.** VAST's architecture is **DASE — Disaggregated, Shared-Everything**: the storage media are decoupled from the CPUs that manage them, and that storage is then shared across every server in the cluster *including all system metadata*. In the DataStore, **compute nodes (CNodes) are stateless and storage nodes (DNodes) hold the data**, and VAST's position is that "all data and metadata are globally accessible across the system", with the consequence stated plainly: **"There are no shards to rebalance, no volumes to migrate, no locality constraints to manage."** On the database side, the feature page says added compute contributes query capacity with "no rebalancing, coordination, or data redistribution required". VAST DataBase is described as a tabular database residing on such a cluster and using its storage.

**Why the metadata clause is the load-bearing one.** Read the two events of this lesson against it. Shared-disk already answers event 2 with zero table bytes moved — that is not what distinguishes this design. What distinguishes it is the claim about *where the coordination lives*. In most disaggregated designs the catalog is a separate service, and it becomes the ceiling: the capacity desk's usual answer to "what saturates first" is metadata operations, not bytes. A design where metadata sits in the same shared all-flash namespace as the data moves that ceiling somewhere else. Whether it *removes* it is precisely the question a proof-of-concept exists to answer.

**The number on that page that you should not bring to this lesson.** The same blog cites a demonstration of over 11 TB/s aggregate throughput. That is VAST's figure, on VAST's configuration, and **we have no cluster and have measured nothing.** It is also the wrong axis for this decision: throughput does not tell you what a rescale moves or what a survivor pays after a node loss, which are the two things that will shape your operations for a decade. Quoting it would be exactly the mistake this lesson opened by naming.

**What a proof-of-concept would have to measure** — because a claim that changes an architecture has to be falsifiable, and \`poc_undefined\` is a severity-3 objection in the vendor room:

1. **A rescale, timed and counted.** Add compute, then measure bytes moved and elapsed time before the new capacity is serving your queries at full rate. The claim is that the first number is zero for table data; verify it, and separately verify what the cache-warmth transient costs your first queries.
2. **A node loss, during a query.** Kill a compute node mid-scan and record whether the query completes, how long the retry takes, and — the number that matters — whether the remaining work spread evenly or landed on one survivor. That is the shared-nothing failure this lesson quantified at 2.0; the claim is that it does not exist here.
3. **Metadata operations at your scale, not at a demo's scale.** Partitions, files, columns and snapshots at the cardinality your catalog will actually hold in year three, with concurrent writers. If shared metadata is the differentiator, this is where it either shows or does not.
4. **Requests per second and bytes per request** for your worst small-read workload (C0.L3). A fabric is not a local bus, and this is the workload class that regresses when it moves regime.

Any platform, ours or theirs, deserves that test rather than that sentence.`,
    },
    {
      type: 'isomorphism',
      title: 'the three architectures ≡ three application designs you have shipped',
      pairs: [
        {
          os: 'a sharded application database',
          osLine:
            'Fast, local, and resharding is a migration project with a change-freeze, a dual-write period and a rollback plan. Everybody who has done one remembers it.',
          llm: 'shared-nothing rescale',
          llmLine:
            'The same project, expressed as 8.4 TB moved to go from 32 nodes to 40 — which is why shared-nothing clusters are sized for the peak and left to idle.',
        },
        {
          os: 'a stateless web tier behind a shared database',
          osLine:
            'Any instance serves any request, autoscaling is trivial, and the database became the thing everyone must agree with — so that is where the ceiling moved.',
          llm: 'shared-disk analytics',
          llmLine:
            'Compute is disposable and the catalog is now the coordination point. The elasticity is real and the bottleneck relocated rather than disappeared.',
        },
        {
          os: 'RAID rebuild versus a restore from backup',
          osLine:
            'Redundancy does not make a disk failure free; it converts an outage into a degraded window whose length is set by how much has to be re-read.',
          llm: 'replication factor 2 under node loss',
          llmLine:
            'Identical: the survivor serves two slices, so the cluster runs at a skew factor of 2 until rebuild — a degraded window, not a non-event, and invisible on any average.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A shared-nothing warehouse holds 60 TB across 20 nodes. Finance wants to handle a four-day quarter-end peak by temporarily doubling the cluster to 40 nodes. What do you tell them, with the arithmetic?',
          options: [
            'It works well: doubling the nodes halves the per-node data and the peak is absorbed, since the data is already replicated',
            'A resize from 20 to 40 nodes redistributes 1 − 20/40 = 50% of the table, so 30 TB crosses the network before any new capacity is usable — and the same 30 TB again to scale back down, competing with queries both times. Either size for the peak, or move this workload to an architecture where compute scales without moving table data',
            'It works if we increase the replication factor first, so the new nodes can serve from existing replicas',
            'It is fine as long as the rebalance runs overnight, since the peak is during business hours',
          ],
          correct: [1],
          explanation:
            'In a design where nodes own data, adding compute is a data migration whose size is 1 − n/m of the table, which here is half of 60 TB. Two rebalances of 30 TB to buy four days of compute is the arithmetic that kills the plan, and it is available before anyone provisions anything. Raising the replication factor makes it worse, not better — it adds a full copy of the data and a write fan-out, and the new nodes still hold no primary slice. "Run it overnight" assumes the rebalance fits in one night and that nothing else needs that bandwidth, and it still pays the second migration on the way down. The honest options are exactly two: size for the peak and accept the idle, or separate compute from storage so this becomes a process-count change.',
        },
        {
          q: 'Two platforms are being compared. One publishes a much higher aggregate throughput figure. Which pair of questions actually discriminates between them for a ten-year platform decision?',
          options: [
            'Throughput per node and compression ratio, since together they determine how much hardware is needed',
            'What a rescale moves in bytes, and what one survivor\'s share becomes after a node loss — both computable from a capacity plan, both unchanged by workload and benchmark configuration',
            'Peak concurrency and maximum table size, since those are the published limits most likely to be hit',
            'Query latency at p95 on a standard benchmark, since that is what users experience',
          ],
          correct: [1],
          explanation:
            'Throughput is configuration-dependent, workload-dependent and vendor-published, and it does not answer either question that will shape your operations: what happens when you resize, and what happens when a node dies. Those two are structural properties of the architecture, they are counts rather than clocks, and you can compute both from numbers you already have — 1 − n/m of the table for the rescale, and the degraded max-over-mean for the loss. Benchmark latency tells you about the benchmark; published limits matter but are perishable and belong in a dated vendor note rather than in an architecture comparison. The general habit: prefer durable architectural facts to version-specific figures, and prefer a number you can recompute to one you have to be told.',
        },
        {
          q: 'A vendor states that adding compute nodes requires no data redistribution. Your architect treats this as settled. What is the correct professional response?',
          options: [
            'Accept it: it is a durable architectural property of a shared-everything design, not a performance claim, so it does not need verification',
            'Accept the mechanism and define the test: it is their claim, dated and sourced, so a proof-of-concept should add compute and measure bytes moved and time-to-full-rate, kill a node mid-query and measure whether the remaining work spread evenly or landed on one node, and exercise metadata operations at year-three cardinality rather than at demo scale',
            'Reject it until an independent benchmark confirms the throughput numbers on the same page',
            'Ask for a reference customer at similar scale and treat their experience as the measurement',
          ],
          correct: [1],
          explanation:
            'The mechanism is plausible and durable — if no compute node owns a slice, there is nothing to redistribute — so the right move is neither credulity nor rejection: it is naming what would falsify it. Bytes moved and time-to-full-rate cover the rescale claim including the cache-warmth transient the claim does not mention; a node kill during a query tests the failure path that shared-nothing designs answer with a skew factor of 2; metadata at real cardinality tests the part of the claim that is actually novel, since shared-disk already answers rescale with zero table bytes. Demanding a throughput benchmark tests the wrong axis. A reference customer is useful context and is not your workload, your cardinality or your concurrency — and an architecture decision that rests on somebody else\'s workload is the one that gets revisited in year two.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the argument in its original form, and both sides since',
      md: `**Stonebraker, "The Case for Shared Nothing" (1986)** is four pages and still the clearest statement of why locality wins: no interference, no coordination, linear scaling on the workloads that partition well. Read it knowing that every assumption in it about the cost of a network round trip has since moved by orders of magnitude, and notice which parts of the argument survive that change and which do not.

**DeWitt and Gray (CACM 1992)** is the mature version, and it is where the vocabulary of partition skew, execution skew and rebalance cost comes from. **The Gamma database machine papers** are worth skimming for how much of a shared-nothing engine's complexity is redistribution machinery.

For the other direction, **"The Snowflake Elastic Data Warehouse" (SIGMOD 2016)** is the canonical statement of separating compute from storage, and the part to read closely is not the elasticity but the *ephemeral cache*: it is the design's answer to losing locality, and it is why cache warmth appears in this lesson's cost list. **Vuppalapati et al., "Building an Elastic Query Engine on Disaggregated Storage" (NSDI 2020)** is the follow-up with production telemetry, and it quantifies exactly the thing this lesson asks a proof-of-concept to measure.

**Antonopoulos et al., "Socrates: The New SQL Server in the Cloud" (SIGMOD 2019)** and the **Amazon Aurora papers (SIGMOD 2017, 2018)** are the OLTP-side treatments of the same disaggregation, and they are useful here because their failure-and-rescale analyses are more explicit than the analytics literature's.

For the shared-nothing engine you can actually run, the **ClickHouse documentation on sharding, distributed tables and replication** is honest about what a resize involves and about what a lost replica means — read the operational pages rather than the feature pages, since those are where rebalancing appears.

Siblings: **C0.L3** prices the three storage regimes this lesson's designs sit on, and **C6.L3** supplies the max-over-mean reasoning that turns a replicated node loss into a measurable skew factor rather than a shrug.`,
    },
  ],
}

export default lesson
