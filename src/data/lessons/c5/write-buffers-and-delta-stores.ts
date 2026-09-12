import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c5.l2',
  slug: 'write-buffers-and-delta-stores',
  trackId: 'c5',
  index: 2,
  title: 'Write Buffers and Delta Stores',
  minutes: 18,
  hook: 'Every columnar platform has the same two-stage write path, and the only interesting question about yours is whether stage one can answer a query. If it cannot, your freshness is not your commit interval — it is your conversion lag, and nobody wrote that number down.',
  exercise: 'quiz',
  takeaway: {
    number: '11.7 MiB',
    claim:
      'A queryable write buffer turns a freshness delay into a read-amplification term you can compute: 8 commits of 24,000 rows at 64 B is 11.7 MiB scanned unpruned on every query, plus 8 footers at 24 KiB — so freshness is not free, it is a line item with a size.',
  },
  blocks: [
    {
      type: 'prose',
      md: `C5.L1 ended on two clauses: accept the change somewhere cheap, reconcile later. This lesson is the first clause, and the shape it takes is the same in every system that has ever solved it:

1. **a write-optimised staging area** that accepts rows as they arrive, durably, without encoding them into the analytical layout;
2. **a conversion step** that turns accumulated rows into the columnar representation, in the background, in batches large enough to encode well;
3. **a read path that consults both**, because otherwise stage one is invisible and the table is only as fresh as stage two.

The names change and the mechanism does not. C-Store called it a writable store with a tuple mover. An LSM engine calls it a memtable that flushes to a run. ClickHouse calls it a part. Iceberg and Delta call it a small data file plus a delete file, and the "conversion" is compaction. What is actually varying between these systems is three properties of stage one, and each one is a number you should be able to state about your own platform.

**Is it durable?** The buffer is where committed data lives before it is columnar. If the buffer is memory-only, your RPO is the flush interval no matter what the storage layer promises, and that belongs in the DR conversation rather than the ingest one (\`dr-desk\`).

**Is it bounded?** A buffer that grows without limit converts a compaction problem into an out-of-memory one. Bounded means there is a trigger — a size, a row count, a file count, an age — and that trigger is the same dial C5.L3 grades.

**Is it queryable?** This is the one people discover late, and it decides what "fresh" means:

\`\`\`text
buffer NOT readable by queries:   p99 staleness = commit interval + CONVERSION LAG
buffer readable by queries:       p99 staleness = commit interval + commit time
                                  and the conversion becomes a background COST
                                  rather than a latency
\`\`\`

Those are different products. The first is a batch system with a low commit interval, which is a thing people ship by accident and then defend in a review by quoting the commit interval.`,
    },
    {
      type: 'prose',
      md: `## What "queryable" costs, in counts

Making the buffer readable does not make freshness free. It moves the price from latency to read amplification, and the term is computable from three constants — the same three the C5 browser lab is priced with, taken from the Warehouse engine rather than re-chosen: **64 B per row**, **24 KiB of footer per file opened**, **8 B per delete position**.

Take the lab's reference write rate — hourly loads, about 24,000 rows a commit — and a policy that tolerates 8 uncompacted files before compacting:

\`\`\`text
delta rows at the trigger   8 commits x 24,000 rows      = 192,000 rows
delta bytes                 192,000 x 64 B               ≈ 11.7 MiB
metadata to open them       8 files x 24 KiB footer      = 192 KiB
delete positions           1 per superseded row x 8 B    = 8 MB per 1M restatements

every one of those bytes is read on EVERY query that must see current data,
and none of it prunes, because the delta is not sorted by your sort key
\`\`\`

Three things follow, and they are the whole reason a buffer needs a policy rather than a default.

**The delta is unpruned by construction.** C2's entire mechanism rests on physical clustering, and freshly arrived rows are clustered by arrival, not by your sort key. So a query that could skip 99% of the base scans 100% of the delta. That is not a bug in the delta — it is what makes it cheap to write.

**The bill is charged per read, not per write.** 11.7 MiB is nothing on one query. On a dashboard running 64 times an hour it is about 18 GiB a day of reading that produces no rows a user asked for, and it grows linearly with how long you let the delta sit. This is the asymmetry that makes freshness a *cost* decision rather than a latency one.

**Delete positions are a second, separate stream.** A tombstone is not a row; it is a position, and a reader must load every one of them to know what to discard. At 8 B a position, a million restatements is 8 MB read on every query until compaction folds them away — which is exactly why C5.L5's policy has to name an expiry as well as a trigger.

And the caveat, said first because the sibling labs will show it to you anyway: the number above assumes the delta is *scanned*. Give delta files their own min/max statistics and a selective query can skip some of them, which is why forge lab 02's statistics are brought forward into lab 05 rather than left behind. Statistics on the delta reduce the term; they do not remove it, because a delta file spanning the whole key range prunes for nobody.`,
    },
    {
      type: 'prose',
      md: `## What you build in forge lab 05, and which check is the buffer

Lab 05 is this lesson made executable. The store you implement has exactly the three parts above — a base of sorted rows, a set of runs, and a memtable that accepts writes — and the harness charges you for the shape you leave behind rather than for anything your code reports about itself.

The check that *is* the queryable-buffer requirement is **\`read_your_writes\`**, and it is an absolute with zero tolerance: a read after a write sees that write, always. Not after a flush, not after a compaction, not eventually. If your buffer is not on the read path, this check fails on the first operation, which is the honest way to grade a design property — the lab will not let you build a system whose freshness depends on a background job.

Two more absolutes constrain the merge itself: **\`merge_ordered\`** (the merged view of base plus delta is one ordered, duplicate-free stream) and **\`delete_semantics\`** (a delete is a written tombstone, and after any sequence of writes and deletes each key resolves to exactly one visible version or none). Those three are the correctness floor; the two banded checks are the cost, and they are C5.L3's subject.

The read cost is charged as **levels probed per read** — the memtable, each run, and the base — averaged over the workload, on a seeded stream of 4,096 mutations over a 512-row base with one read per mutation. The band ends at **6.0 probes per read**. A store that never compacts lands near **34.0**, which is the delta scan term above expressed as a count instead of as bytes. The harness reads those levels off your \`Store\` directly, so no cleverness inside \`read\` can move the number: the only lever is the policy.

Read that last sentence as the design lesson. **Freshness is not an optimisation you can implement your way out of.** It is a structural property of how much unconverted data you allow to exist, and the only control surface is the trigger.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'How VAST DataBase describes its write path — and what a proof-of-concept would have to measure',
      systems: ['vast-db', 'duckdb', 'clickhouse'],
      sources: [
        'https://www.vastdata.com/features/transactional-and-analytical-support',
        'https://support.vastdata.com/hc/en-us/articles/11910669291548-VAST-Database-Overview',
        'https://www.vastdata.com/blog/the-data-lake-dilemma',
      ],
      md: `**The mechanism, in VAST's own words.** VAST's feature documentation describes the two-stage shape this lesson just built: *"Newly written data lands instantly in persistent memory, then converts into optimized columnar chunks for high-speed analytics."* It is more specific about stage one elsewhere on the same page — Storage Class Memory *"acts as a 'shock absorber' while background processes transform row-based writes into optimized 32KB columnar chunks on an all-flash architecture"* — and about durability: ACID compliance is described as resting on *"SCM write buffers that instantly persist transactions"*, with atomic updates supported within and across tables. The 2024 blog on small files states the same pipeline from the ingest side: the database *"ingests data row-by-row and seamlessly transforms it into optimized columnar chunks."*

**The physics that would explain a difference.** Two numbers in that description are architectural rather than promotional. The first is the *medium* of the buffer: a durable buffer on storage-class memory absorbs many small, random, row-shaped writes without paying the per-request cost that makes small commits expensive on object storage (C0.L3's request-versus-bandwidth split). The second is the *unit of conversion*: **32 KB chunks** rather than 512 MB files. Almost everything in C2 and C5 — the 48-partition ceiling, the compaction rewrite bill, the stranded-tombstone term — is derived from a large-file target on immutable object storage. Change the unit of rewrite by four orders of magnitude and the arithmetic that produced those bounds has to be redone rather than assumed. VAST also states the consequence it draws from this directly: updates *"create new 32KB columnar chunks with metadata links rather than rewriting entire files, while deletions use logical tombstoning"*, which it says removes the need for compaction and vacuuming.

**What is not ours, and never will be.** There is no VAST cluster behind this course. VAST publishes performance figures — on the same page, *"up to 20× faster query performance on highly selective workloads while using up to 90% less CPU"* — and those are **VAST's numbers, on VAST's configuration**, cited here as a claim rather than a result. Nothing in this course measures them, and note what the phrase "highly selective" implies: selective workloads are precisely where physical layout dominates (C2), so that comparison only means something if both sides are laid out by someone who read C2.

**So what would a POC have to measure?** Five things, all counts, none of which appear in a vendor benchmark:

1. **p99 staleness measured while a query stream runs at your target concurrency** — the age of the newest visible row, not an idle-cluster insert-then-select.
2. **The same query, twice: immediately after ingest and once conversion has run.** If the buffer is queryable, the second run should be *cheaper*, and the size of that gap is the read-amplification term you will be paying for freshness.
3. **The sustained ingest rate at which conversion stops keeping up**, the symptom when it does — throttled writes, rising read cost, a backlog you can alarm on — and whether that metric is exposed to you at all.
4. **The cost of a restatement against cold data**: an update to a row written a year ago. Every "no compaction needed" claim lives or dies on this case, because it is the one the merge-policy lab shows stranding tombstones no trigger can reach.
5. **What is durable at the moment the client is acknowledged**, and the RPO if the buffer tier is lost — the \`dr-desk\` question, asked of stage one specifically.

Write those five down before the POC, because \`poc_undefined\` is a severity-3 objection in the vendor room, and "we ran their benchmark and it was fast" is the answer that loses it.`,
    },
    {
      type: 'diagram',
      caption: 'fig 2 — the two-stage write path, and the single question that decides what "fresh" means',
      height: 72,
      nodes: [
        { id: 'w', x: 2, y: 2, w: 30, h: 9, label: 'commit arrives', sub: 'rows, in arrival order, unencoded', color: '#FB923C' },
        { id: 'buf', x: 35, y: 2, w: 30, h: 9, label: 'write buffer / memtable', sub: 'durable, bounded, write-optimised', color: '#22D3EE' },
        { id: 'rd', x: 68, y: 2, w: 30, h: 9, label: 'reader merges base + delta', sub: 'or does not — that is the whole question', color: '#5CA8FF' },
        { id: 'q', x: 2, y: 15, w: 96, h: 10, label: 'if the buffer is NOT on the read path: p99 staleness = commit interval + CONVERSION LAG', sub: 'and the number you quote in the review — the commit interval — is not the number your users experience', color: '#FB7185' },
        { id: 'dur', x: 2, y: 29, w: 46, h: 10, label: 'durable, or your RPO is the flush interval', sub: 'whatever the storage layer promises about the files it has not received yet', color: '#FBBF24' },
        { id: 'bnd', x: 52, y: 29, w: 46, h: 10, label: 'bounded, by a trigger you chose', sub: 'files, rows, bytes or age — the same dial the merge policy grades', color: '#FBBF24' },
        { id: 'cost', x: 2, y: 43, w: 96, h: 10, label: 'queryable moves the price from latency to reads: 192,000 delta rows ≈ 11.7 MiB + 8 footers × 24 KiB, unpruned, per query', sub: 'plus 8 B per delete position, and none of it prunes because the delta is clustered by arrival rather than by your sort key', color: '#A78BFA' },
        { id: 'drain', x: 2, y: 57, w: 96, h: 10, label: 'so stage two must drain at least as fast as stage one fills — graded as levels probed per read, band ≤ 6.0, never-compacting ≈ 34.0', sub: 'and read_your_writes is an absolute in lab 05: a design whose freshness depends on a background job fails on operation one', color: '#3EF2A4' },
      ],
      edges: [
        { from: 'w', to: 'buf' },
        { from: 'buf', to: 'rd' },
        { from: 'buf', to: 'q' },
        { from: 'q', to: 'dur' },
        { from: 'q', to: 'bnd' },
        { from: 'rd', to: 'cost' },
        { from: 'cost', to: 'drain' },
      ],
      steps: [
        {
          caption:
            'A commit arrives as rows in arrival order. Encoding them into the analytical layout now would be expensive and would produce a tiny badly-encoded file, so stage one deliberately does not: it accepts them as they are.',
          active: ['w', 'buf'],
          edges: ['w->buf'],
        },
        {
          caption:
            'The single question that decides what your platform is: can a query see stage one? If not, the freshness your users experience is the conversion lag, and the commit interval you quote in reviews is a number about a different system.',
          active: ['q'],
          edges: ['buf->q'],
        },
        {
          caption:
            'Two properties before that question is even worth asking. Durable, or the recovery point is the flush interval regardless of what the storage layer guarantees about files it has not been handed yet.',
          active: ['dur'],
          edges: ['q->dur'],
        },
        {
          caption:
            'And bounded, by an explicit trigger on files, rows, bytes or age — because an unbounded buffer converts a compaction problem into an out-of-memory one, and the trigger is the dial the next lesson grades.',
          active: ['bnd'],
          edges: ['q->bnd'],
        },
        {
          caption:
            'Making it queryable does not make freshness free; it moves the price onto readers. At the reference rate that is 11.7 MiB of unpruned delta plus 192 KiB of footers on every query that must see current data.',
          active: ['rd', 'cost'],
          edges: ['buf->rd', 'cost'],
        },
        {
          caption:
            'Which means stage two is a rate, not a job: it must fold data away at least as fast as stage one accepts it. Lab 05 charges that as levels probed per read, and a store that never compacts lands near 34 against a band of 6.',
          active: ['drain'],
          edges: ['cost->drain'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '11.7 MiB',
          label: 'unpruned delta scanned per query at the reference policy',
          hint: '8 uncompacted commits × 24,000 rows × 64 B, using the merge-policy lab\'s row width. It grows linearly with how long you let the delta sit before folding it in.',
        },
        {
          value: '24 KiB',
          label: 'footer per file opened',
          hint: 'The Warehouse engine\'s figure, reused by the merge-policy lab rather than re-chosen. Eight delta files is 192 KiB of metadata before a single data byte is read.',
        },
        {
          value: '8 B',
          label: 'per delete position',
          hint: 'A tombstone is a position, not a row, and a reader must load all of them to know what to discard. A million restatements is 8 MB read on every query until compaction.',
        },
        {
          value: '6.0 probes',
          label: 'the read band in forge lab 05',
          hint: 'Levels consulted per read — memtable, each run, the base — averaged over 4,096 seeded mutations. Never compacting lands near 34.0; the only lever is the policy.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the freshness number that is true and useless',
      md: `Two systems, both described in a design document as *"two-minute freshness"*:

- **System A** commits every two minutes and its buffer is on the read path. A row written at 12:00:01 is visible to the next query. p99 staleness ≈ the commit interval plus commit time.
- **System B** commits every two minutes and its queries read only converted columnar files. Conversion runs every ten minutes and takes four. A row written at 12:00:01 becomes visible somewhere around 12:14. p99 staleness ≈ **14 minutes**, and the two-minute figure in the document is not wrong about anything except what the reader cares about.

Both documents say "we commit every two minutes". Only one of them is a freshness claim.

The test that separates them is embarrassingly simple, and it is the one forge lab 05 grades as \`read_your_writes\`: **write a row, immediately query for it, and require it back.** Run it continuously, in production, as a synthetic probe, and graph the age of the newest visible row — not the commit interval, which is an input you already know. If that probe is the only monitoring you add from this track, you will still catch the incident this callout describes, because the day conversion falls behind is the day p99 staleness moves and nothing else does.`,
    },
    {
      type: 'isomorphism',
      title: 'a queryable write buffer ≡ patterns you already run',
      pairs: [
        {
          os: 'an LSM memtable',
          osLine:
            'Writes land in a sorted in-memory structure backed by a WAL; reads consult the memtable first and then each immutable run in age order. The read cost is the number of levels, and compaction exists to keep that number small.',
          llm: 'the delta store you build in lab 05',
          llmLine:
            'The same structure with a schema and column encodings, graded as levels probed per read. Merge-on-read is not analogous to LSM compaction — it is LSM compaction, applied to a table with columns and statistics.',
        },
        {
          os: 'a write-through cache',
          osLine:
            'The value is visible from the fast layer immediately and lands in the slow layer behind it. Correctness depends entirely on readers consulting the fast layer, and the failure mode of forgetting is a stale read.',
          llm: 'the buffer on the read path',
          llmLine:
            'Same dependency, same failure mode, one difference worth stating: here the "stale read" is a missing row rather than an old value, and it looks exactly like an ingest delay, which is why teams debug the pipeline instead of the read path.',
        },
        {
          os: 'a Kafka topic in front of a warehouse',
          osLine:
            'The usual workaround for small files: stream into a queue, flush periodically into the table. It bounds file count and adds a hop, and the hop is where your freshness goes.',
          llm: 'an in-platform write buffer',
          llmLine:
            'The same staging function moved inside the storage layer, which is the whole architectural argument for it: one durability boundary instead of two, and no external component whose lag is invisible to the table\'s own metrics.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Ingest commits every 60 seconds. Queries read only compacted columnar files; a conversion job runs every 15 minutes. The team\'s dashboard shows "commit lag: 60s" and is green. Analysts complain that data is missing for a quarter of an hour. What is the correct diagnosis and fix?',
          options: [
            'The conversion job is too slow and needs more compute; add workers until commit lag and query freshness converge',
            'Freshness is commit interval plus conversion lag, not commit interval — so p99 staleness is about 15 minutes and the green dashboard is measuring an input rather than an outcome. Either put the buffer on the read path so queries merge unconverted data, or restate the SLA as 15 minutes; and monitor the age of the newest visible row with a write-then-read probe',
            'Analysts are querying a stale replica; point them at the primary and the problem disappears',
            'The commit interval should be lowered to 15 seconds so that data reaches the conversion job sooner',
          ],
          correct: [1],
          explanation:
            'The dashboard is green because it measures the thing the team controls rather than the thing users experience: with an unqueryable buffer, staleness is dominated by conversion lag and the commit interval is nearly irrelevant. Adding workers shortens the lag but does not change the structure — freshness still waits on a background job, so the SLA is only as good as that job\'s worst run. Lowering the commit interval makes it strictly worse: it multiplies the file count (C2.L5) while leaving visibility gated on the same conversion. The structural fix is to make the buffer readable, which is exactly what read_your_writes grades in lab 05, and the monitoring fix is to probe the outcome: write a row, read it back, graph the age of the newest visible row.',
        },
        {
          q: 'You make the write buffer queryable and freshness becomes excellent. Two weeks later the analytics bill on a bytes-scanned platform is up and no query changed. The delta holds about 190,000 rows at 64 B between compactions and the dashboard suite runs 64 times an hour. What do you say in the review?',
          options: [
            'The increase is compaction rewriting data, so the fix is to compact less often and let the delta grow',
            'Freshness is now charged to readers: roughly 11.7 MiB of unpruned delta plus 8 footers at 24 KiB on every query, which at 64 queries an hour is about 18 GiB a day of reading that answers nobody\'s question. The levers are a tighter compaction trigger, statistics on delta files so selective queries can skip some, and deciding how much freshness this suite actually needs',
            'Bytes scanned is dominated by the base table, so a delta of 190,000 rows cannot be the cause and the increase must be growth in the underlying data',
            'The delta should be excluded from dashboard queries, since dashboards aggregate over long windows where recent rows do not matter',
          ],
          correct: [1],
          explanation:
            'This is the trade the lesson exists to make visible: a queryable buffer converts a latency problem into a per-read cost, and the cost is small per query and large per day. Do the arithmetic on screen — 190,000 × 64 B ≈ 11.7 MiB, times 64 queries an hour, is order 18 GiB a day of scanning with no rows a user asked for — because a number that size is defensible and a shrug is not. Compacting less often moves the wrong way: it grows the delta and therefore the per-read term. Dismissing it as base-table growth ignores that the delta is unpruned while the base is not, so a well-pruned query can have the delta as its dominant term. And excluding the delta from dashboards is silently reintroducing staleness for the exact class that just got fresh, which may be a legitimate decision but must be stated as one rather than implemented as a filter.',
        },
        {
          q: 'A vendor\'s documentation describes writes landing in persistent memory and converting to small columnar chunks in the background, and publishes a large speedup figure on selective queries. You have budget for a two-week POC. What goes in the plan?',
          options: [
            'Reproduce the vendor\'s published benchmark on their reference configuration, since matching it validates the claim and failing to match it identifies a configuration problem',
            'Measure p99 staleness while a query stream runs at target concurrency; run the same query immediately after ingest and again after conversion to size the freshness term; find the sustained ingest rate at which conversion falls behind and which metric shows it; price a restatement against year-old data; and establish what is durable at acknowledgement. Treat the published figure as the vendor\'s, on their configuration, and never as a result of yours',
            'Run a standard analytics benchmark suite and compare total runtime against the current platform, since that is the closest available proxy for the production workload',
            'Ask the vendor for a reference customer with a similar workload and rely on that account rather than spending POC time on measurement',
          ],
          correct: [1],
          explanation:
            'A POC exists to test the claims that would change your architecture, and the architectural claims here are about the write path: how fresh the data is under load, what querying unconverted data costs, when conversion stops keeping up, and what happens to a restatement against cold data — the case any "no compaction needed" story must answer. Reproducing the vendor benchmark measures the vendor\'s configuration on the vendor\'s workload; both are already known to be favourable. A generic benchmark suite is better than nothing and still answers a question nobody asked, especially since a "highly selective" speedup is dominated by physical layout, which the suite chooses for you. And a reference call is evidence about someone else\'s workload. Note the discipline in the correct answer: the vendor figure is cited as theirs, and the POC measures counts you define in advance — which is what the vendor room grades as poc_undefined when it is missing.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: five systems that built this, and what they disagree about',
      md: `The two-stage write path is close to a universal law of analytical storage, so the interesting reading is not *whether* a system has one but which of the three properties it compromises.

**C-Store (Stonebraker et al., VLDB 2005)** is the ancestor: a writable store beside the read-optimised store, with a tuple mover between them, and queries that read both. **Vertica's** later published descriptions of the same lineage — a write-optimised store, a read-optimised store, and background *moveout* and *mergeout* operations — are the industrial version, and the papers are explicit that the writable side uses a different encoding because its job is different.

**Kudu (Lipcon et al., "Kudu: Storage for Fast Analytics on Fast Data", 2015)** is the cleanest modern statement: an in-memory row-oriented \`MemRowSet\` that flushes into columnar \`DiskRowSets\`, with delta stores tracking subsequent updates *by position within a rowset*. Read the sections on delta compaction specifically — it separates "minor" delta compaction from "major", which is the same distinction C5.L5 draws between folding the pile and rewriting a base file.

**SAP HANA's delta/main** design (Färber et al., and the later "efficient transaction processing in SAP HANA" papers) is worth reading because it is the same structure inside a system whose primary claim is transactional: an uncompressed, write-optimised delta with its own index, a dictionary-compressed main, and a *delta merge* operation whose cost and scheduling are documented as operational concerns. The vocabulary is the giveaway: when a transactional system and an analytical system arrive at the same two structures, the structure is not a product decision.

**Druid** solves the queryable-buffer problem architecturally instead of structurally: real-time ingestion tasks serve queries over the data they are still accumulating and then hand a finished segment off to historical nodes. It is the same "the buffer answers queries" property, implemented as a different process rather than a different tier.

**The LSM lineage** — **O'Neil et al. (1996)**, then **Dayan/Athanassoulis/Idreos on Monkey and Dostoevsky** — is where the *policy* mathematics lives, and it is the part most data-platform teams have not read. If you want the tuning of your compaction trigger to be arithmetic rather than taste, that is the literature.

For the buffer's in-memory representation, **Apache Arrow** is the standard answer and worth knowing for a reason beyond performance: if your buffer is already Arrow, "queryable" is close to free, because the read path can consume it without a conversion.

Next: **C5.L3**. You now have both halves of the design space in your hands — rewrite the file, or write a note beside it. The lesson is the arithmetic that picks, and the browser lab where 30 policies get priced and no policy wins both.`,
    },
  ],
}

export default lesson
