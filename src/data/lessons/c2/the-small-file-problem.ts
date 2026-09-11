import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c2.l5',
  slug: 'the-small-file-problem',
  trackId: 'c2',
  index: 5,
  title: 'The Small File Problem',
  minutes: 17,
  hook: 'Planning took 61% of query time on a 9 TB table. The data had not grown. There were 1.4 million files where there used to be thirty-five thousand.',
  exercise: 'quiz',
  artifact: 'layout-design',
  takeaway: {
    number: '48 partitions',
    claim:
      'File count is a product of commit rate, partitions written and writers, and partition boundaries block compaction from merging across them — so at 25 GB/day and a 512 MB target file, about 48 actively-written partitions is the arithmetic ceiling, not a preference.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Partitioning is the one pruning mechanism that works without reading any statistics at all. The partition values are in the path or the manifest, so a predicate on the partition key eliminates files before a single footer is opened. That is genuinely the cheapest skip available, and it is why the reflex "add a partition" feels free.

It is not free, and the cost is not paid on the read path where you would look for it. **The number of files a table holds is a product**:

\`\`\`
files created per day  =  commits per day
                       ×  partitions written per commit
                       ×  writers per commit
\`\`\`

Three multiplicands, each set by a different team. The commit rate belongs to whoever owns the freshness requirement. The partition count belongs to whoever designed the layout. The writer count belongs to whoever sized the ingest job. Nobody owns the product, which is why it is usually nobody's number until it is an incident.

Column Week's second drill is that incident. Streaming ingest moved from 15-minute batches to 30-second micro-batches to hit a two-minute freshness target. The freshness target was met exactly as designed. Then:

| metric | before | after |
|---|---|---|
| files created per hour | 120 | 9,600 |
| average file size | 240 MB | 6 MB |
| planning share of query time | 4% | 61% |
| compaction backlog | 0 | 940,000 files |

Live file count: **1.4 million files over 9 TB** — an average of 6.4 MB per file. No query changed. No data was added beyond ordinary growth. The dial that moved was the commit interval, and the commit interval is one of three multiplicands.`,
    },
    {
      type: 'prose',
      md: `## Planning scales with file count, not with data size

This is the part that surprises people who have internalised C0's metric, and it is worth being precise about because it is the one place bytes-scanned lies to you.

Per file, a planner does a **bounded amount of work that does not depend on the file's size**: locate it in the metadata, read its footer or manifest entry, evaluate the predicate against its statistics, decide read or skip. Call it one request and a few kilobytes. Then:

\`\`\`
planning cost  ≈  files considered × (1 request + footer bytes)
\`\`\`

Two consequences fall straight out of that expression.

**First: doubling the file count at constant data doubles planning and leaves bytes-scanned unchanged.** The metric this course is built on does not move. Your dashboard of scan volume shows a flat line while queries get slower and per-request charges climb, which is exactly why the drill's telemetry needed a *planning share* series to see it at all.

**Second: pruning never saves the metadata read that authorised it.** You cannot know a file's statistics exclude it without reading its statistics. Pruning is a saving on the data path only. Partition pruning is the exception that proves the rule — it works from the manifest without opening the file — and it is precisely the mechanism whose overuse created the file count in the first place.

Put a number on the incident. A query covering seven days of a ninety-day table touches roughly \`1.4e6 × 7/90 ≈ 109,000\` files. That is 109,000 metadata reads before a single data byte is fetched, for a query whose data volume is a few hundred gigabytes. Footers of a few kilobytes each put that at order 1 GB of pure metadata — an order-of-magnitude estimate, not a measurement, but the *count* is exact and the count is what you cite: **109,000 requests to plan one query.** At 61% of query time, planning had become the workload.`,
    },
    {
      type: 'prose',
      md: `## Creation rate versus compaction rate: there is no steady state to find

Compaction merges small files into large ones. It is not an optimisation; it is a **rate-matching mechanism**, and rate-matching has exactly one condition:

\`\`\`
merge rate (files removed per hour)  ≥  creation rate (files added per hour)
\`\`\`

If that inequality fails, the backlog is unbounded. Not large — unbounded. There is no size the cluster can be to fix a deficit, because the deficit accumulates.

The drill's arithmetic, in full:

\`\`\`
creation      9,600 files/hour
merge         5,000 files/hour   (what the job actually sustained)
              ──────────────────
deficit       4,600 files/hour  =  110,400 files/day
observed backlog 940,000 files  ≈  8.5 days of deficit
\`\`\`

Now cost the version that *does* keep up, because this is the number nobody budgets. To remove 9,600 files an hour you must read and rewrite them:

\`\`\`
9,600 files/hour × 6 MB  =  57.6 GB/hour read + 57.6 GB/hour written
                         =  ~1.4 TB/day of rewrite
\`\`\`

**1.4 TB of rewrite per day, forever, on a 9 TB table.** Compaction is rewriting about 15% of the table daily just to undo a decision made in the ingest configuration. That is write amplification with no user-visible product, it consumes ingest-adjacent compute, and it is the reason the compaction desk grades a **write amplification budget** rather than only a read-amplification target.

The correct place to intervene is the input variable. The drill's own debrief says it plainly: *the interval is the input variable, the file count is the consequence.* Raise the batch interval to the largest value the freshness requirement permits, and the file count falls proportionally before compaction has to do anything. Halving the interval doubles the files for identical data — the ingest desk grades exactly that trade as \`freshness_sla\` against \`compaction_keeps_up\`, and C5 derives the freshness curve properly.`,
    },
    {
      type: 'prose',
      md: `## The floor: partition boundaries are merge barriers

Everything above is a backlog, and a backlog can in principle be caught up. This next part cannot, and it is the reason high-cardinality partitioning is a different class of mistake from a fast commit loop.

**A file belongs to exactly one partition.** Its partition values are part of its identity in the metadata, and they are what lets the planner eliminate it without reading it. A merged file spanning two partitions would have no single partition value, which breaks that contract for every query. So **compaction can only merge files within a partition** — the boundary is a wall the merge cannot cross.

Therefore the largest file compaction can ever produce in a partition is bounded by the data in that partition. Turn that around and it becomes a design rule with a division in it:

\`\`\`
target file size  ≤  daily ingest ÷ partitions written per day

so:   P_max  =  daily ingest ÷ target file size
              =  25 GB/day ÷ 512 MB  =  48 partitions
\`\`\`

A table ingesting 25 GB a day, targeting 512 MB files, supports about **48 actively-written partitions**. Past that, its files are permanently small, and no compaction policy, cluster size or vendor can fix it — the data to fill a large file does not exist inside the boundary.

Watch the same 25 GB/day meet different partition schemes:

| partition scheme | partitions written per day | best achievable average file |
|---|---|---|
| \`day\` | 1 | 512 MB (49 files, target met) |
| \`day, region\` (6 regions) | 6 | 512 MB (comfortable) |
| \`day, tenant\` (200 tenants) | 200 | 125 MB |
| \`day, tenant, region\` | 1,200 | 21 MB |
| \`hour, tenant\` | 4,800 | 5.2 MB |
| \`day, user_id\` (4M users) | ~4,000,000 | ~6 KB |

The last row is not a strawman; it is what "partition by the column we filter on" produces when that column is high-cardinality, and it is the folklore mitigation the drill offers and marks wrong: *partition more finely so each query touches fewer files*. Finer partitioning reduces files per query **only when the predicate names the partition key**, and it increases total file count **unconditionally**.

So the rule, in one sentence you can say in a review: **partition cardinality is capped by ingest volume divided by target file size; everything else you want to prune on belongs in the sort key.** Sorting is the right home for high cardinality because sorting changes the order *inside* files and has no effect on how many there are — that asymmetry is the whole point of C2.L2, and it is why the two decisions are not interchangeable.

The middle option, when equality pruning on a high-cardinality column really is the requirement: **bucket it.** Hash the column into a fixed number of buckets — 64, 256 — and partition on the bucket. You get partition-style elimination for equality predicates with a file count bounded by a constant you chose, at the cost of no help whatsoever for ranges. Which is the same trade C2.L4 just priced in bits.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the file count is a product, and one of its factors is a wall',
      height: 68,
      nodes: [
        { id: 'commits', x: 2, y: 2, w: 30, h: 9, label: '30-second commits', sub: '2,880 per day', color: '#FB923C' },
        { id: 'parts', x: 35, y: 2, w: 30, h: 9, label: '× partitions written', sub: 'day × tenant × region', color: '#FB923C' },
        { id: 'writers', x: 68, y: 2, w: 30, h: 9, label: '× parallel writers', sub: 'each emits its own file', color: '#FB923C' },
        { id: 'files', x: 20, y: 15, w: 60, h: 9, label: '= 9,600 files/hour', sub: '120/hour before the change · avg 240 MB → 6 MB', color: '#FB7185' },
        { id: 'plan', x: 2, y: 28, w: 46, h: 9, label: 'planning enumerates files', sub: '1.4M live · 61% of query time', color: '#FB7185' },
        { id: 'comp', x: 52, y: 28, w: 46, h: 9, label: 'compaction merges files', sub: '5,000/hr against 9,600/hr → 940k backlog', color: '#FBBF24' },
        { id: 'wall', x: 20, y: 41, w: 60, h: 9, label: 'a partition boundary is a merge barrier', sub: 'no file may span two partitions, so the floor is per-partition data', color: '#A78BFA' },
        { id: 'rule', x: 2, y: 54, w: 46, h: 9, label: 'so: P ≤ ingest ÷ target size', sub: '25 GB/day ÷ 512 MB = 48', color: '#3EF2A4' },
        { id: 'dial', x: 52, y: 54, w: 46, h: 9, label: 'and the interval is the dial', sub: 'freshness sets the file count, not compaction', color: '#3EF2A4' },
      ],
      edges: [
        { from: 'commits', to: 'files' },
        { from: 'parts', to: 'files' },
        { from: 'writers', to: 'files' },
        { from: 'files', to: 'plan' },
        { from: 'files', to: 'comp' },
        { from: 'comp', to: 'wall' },
        { from: 'wall', to: 'rule' },
        { from: 'wall', to: 'dial' },
      ],
      steps: [
        {
          caption:
            'Three factors, owned by three different people: the commit interval belongs to the freshness requirement, the partition count to the layout design, the writer count to the ingest job. Nobody owns the product.',
          active: ['commits', 'parts', 'writers'],
        },
        {
          caption:
            'Multiply them and the file count is the answer. Moving from 15-minute to 30-second batches took creation from 120 files an hour to 9,600 and dragged the average file from 240 MB down to 6 MB, on identical data.',
          active: ['files'],
          edges: ['commits->files', 'parts->files', 'writers->files'],
        },
        {
          caption:
            'The read side pays first and invisibly. Planning does bounded work per file regardless of file size, so 1.4 million files means 1.4 million metadata decisions — and bytes-scanned, the metric on the dashboard, does not move at all.',
          active: ['plan'],
          edges: ['files->plan'],
        },
        {
          caption:
            'Compaction is rate-matching, not tidying: merging 5,000 files an hour against a creation rate of 9,600 gives a deficit of 4,600 an hour, and a deficit accumulates without bound. The observed 940,000-file backlog is about eight and a half days of it.',
          active: ['comp'],
          edges: ['files->comp'],
        },
        {
          caption:
            'And a partition boundary is a wall the merge cannot cross, because a file belongs to exactly one partition and that is what makes partition pruning free. So the biggest file achievable in a partition is bounded by the data inside it.',
          active: ['wall'],
          edges: ['comp->wall'],
        },
        {
          caption:
            'Which yields both fixes as arithmetic rather than taste: cap partition cardinality at daily ingest divided by target file size, and treat the batch interval — not the compaction cluster — as the variable that sets the file count.',
          active: ['rule', 'dial'],
          edges: ['wall->rule', 'wall->dial'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '240 MB → 6 MB',
          label: 'average file size, from one config change',
          hint: 'Column Week INC-2. The commit interval went from 15 minutes to 30 seconds; the data volume did not change at all.',
        },
        {
          value: '61%',
          label: 'of query time spent planning',
          hint: 'Up from 4%. Planning does bounded work per file, so it scales with file count and is invisible to a bytes-scanned dashboard.',
        },
        {
          value: '48',
          label: 'actively-written partitions the ingest volume supports',
          hint: '25 GB/day ÷ 512 MB target. Past this the files are structurally small and no compaction policy can fix it.',
        },
        {
          value: '1.4 TB/day',
          label: 'rewrite needed to keep up on a 9 TB table',
          hint: '9,600 files/hour × 6 MB, read and written. Compaction that keeps pace rewrites ~15% of the table daily with no user-visible product.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the metric that hides this, and the four that show it',
      md: `Bytes scanned — the number C0 spent five lessons teaching you to defend — **does not move when the file count explodes.** Same data, same predicates, same bytes, and a query that now spends most of its life before touching a byte. If your only cost dashboard is scan volume, this incident is invisible until somebody complains about latency or a per-request line item.

Four counts catch it, and all four are counts rather than clocks:

- **live file count**, and **average file size** beside it. One is meaningless without the other.
- **files touched per query**, per query class. This is the one that turns "the table has a lot of files" into "this query enumerates 109,000 of them".
- **planning share of query time.** The single most diagnostic series in the drill, and almost nobody graphs it.
- **compaction backlog, as a trend.** The absolute number is noise; the *slope* is the entire question, because a positive slope means no steady state exists.

If you take one operational habit from this lesson: graph creation rate and merge rate on the same axis. The failure is a crossing, and a crossing is visible weeks before a backlog is.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'Target file size as a table property — and what the format cannot do for you',
      systems: ['iceberg'],
      sources: [
        'https://iceberg.apache.org/docs/latest/configuration/',
        'https://iceberg.apache.org/docs/latest/maintenance/',
      ],
      md: `Iceberg exposes the target directly: \`write.target-file-size-bytes\`, documented with a default of **536870912 — 512 MB**. There is a separate, smaller default for delete files, which is a hint about their expected lifetime rather than a preference.

Two durable things to take from that, and one warning.

**The target is a property of the table; the achieved size is a property of your ingest and your partitioning.** Setting the target does not create data. If a commit only has 6 MB to write into a partition, it writes a 6 MB file and the target is simply not reachable — which is the floor this lesson derives, appearing in a configuration key that looks like it ought to prevent it.

**Compaction is an explicit, scheduled operation you own.** The maintenance documentation treats rewriting data files, rewriting manifests and expiring snapshots as jobs a table operator runs — not as background housekeeping the format performs for you. That is a durable architectural fact about this whole family of formats, and it is why "who runs compaction, on what schedule, with what capacity" is a question with an owner, and why an unanswered version of it is how the drill happens. Note that the *metadata* needs the same treatment: manifests accumulate per commit, so a fast commit loop grows the metadata tree as well as the data file list.

**The warning:** treat specific defaults as dated. This one was checked in the month in the snapshot above, against the documentation linked, and defaults across engines and versions are exactly the class of fact that rots. The arithmetic — ingest ÷ target — does not rot, so carry that and re-check the constant.

DuckDB, ClickHouse, Delta Lake and every managed warehouse have their own version of this dial and their own compaction story. The shape is the same everywhere because the physics is: files are the unit of metadata, metadata is enumerated per query, and a boundary that enables free pruning also prevents merging.`,
    },
    {
      type: 'isomorphism',
      title: 'the file count ≡ problems you have already had',
      pairs: [
        {
          os: 'a queue whose arrival rate exceeds its service rate',
          osLine:
            'There is no steady state and no consumer size that fixes it; the backlog grows without bound until you change the arrival rate.',
          llm: 'compaction against ingest',
          llmLine:
            'Identical, and identically diagnosed: graph the two rates on one axis and look for the crossing, because the backlog only tells you how long ago it happened.',
        },
        {
          os: 'an over-indexed OLTP table',
          osLine:
            'Every index accelerates one access path and taxes every single write. Nobody adds the eleventh index without an argument.',
          llm: 'an over-partitioned analytical table',
          llmLine:
            'Every partition column accelerates predicates that name it and multiplies the file count for all writes. The eleventh partition column deserves the same argument.',
        },
        {
          os: 'a directory holding a million tiny files',
          osLine:
            'The bytes are trivial and listing it is unusable, because the cost was never in the bytes — it was per directory entry.',
          llm: 'a table holding a million data files',
          llmLine:
            'The planner is the listing, and it runs before every query. Per-entry costs do not care that each entry is small.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Planning is 61% of query time on a table with 1.4M small files. Which of these actually reduces the file count?',
          options: [
            'Partition more finely so each query touches fewer files',
            'Raise the batch interval to the largest value the freshness requirement permits, and size compaction capacity against the resulting creation rate — the interval is the input variable and the file count is the consequence',
            'Scale up query compute so the planning phase completes faster',
            'Disable statistics collection on ingest so there is less metadata per file',
          ],
          correct: [1],
          explanation:
            'File count is commits × partitions × writers, so the only levers are those three factors, and the commit interval is usually the one with the most headroom against its actual requirement. Finer partitioning is the trap: it reduces files per query only when the predicate names the partition key, and it multiplies total file count unconditionally — and partition boundaries then block compaction from merging across them, turning a backlog into a permanent floor. Scaling query compute pays the planning cost faster rather than removing it, and dropping statistics removes the pruning that makes the surviving files cheap to skip.',
        },
        {
          q: 'A team ingests 25 GB/day and wants to partition by day and tenant_id (200 tenants) so tenant-scoped queries prune well. They target 512 MB files. What should you tell them?',
          options: [
            'Fine — 512 MB is the format default and compaction will reach it',
            '200 partitions a day over 25 GB/day is 125 MB per partition per day, so 512 MB is unreachable inside a daily boundary no matter how compaction is tuned; either widen the partition to just day and put tenant_id in the sort key, or accept 125 MB files and say so in the design',
            'Add hourly partitioning as well, so compaction has smaller units to work with',
            'Increase the target to 1 GB so compaction merges more aggressively',
          ],
          correct: [1],
          explanation:
            'Divide before deciding: 25 GB ÷ 200 = 125 MB of data per partition per day, and a file cannot span two partitions, so 125 MB is the ceiling — the target is not a promise the format can keep. The fix is to move the high-cardinality column from the partition key to the sort key, which prunes inside files without multiplying them. Hourly partitioning divides the same data by another 24 and makes it strictly worse; raising the target changes a number nothing can reach.',
        },
        {
          q: 'You are on a consumption pricing shape billed per byte scanned. You propose a week of work to cut the file count from 1.4M to 40k. Finance asks what it saves. What is the honest answer?',
          options: [
            'Roughly a 35× reduction in the query bill, since the file count falls 35×',
            'Close to nothing on the per-byte line, because bytes scanned barely changes — the saving is in latency, compute-seconds and per-request charges, plus the compaction rewrite volume it removes; so the case has to be made in those currencies and in the ad-hoc queries that are currently unusable',
            'Nothing measurable at all, so the work should be deprioritised',
            'A 61% reduction in cost, matching the planning share of query time',
          ],
          correct: [1],
          explanation:
            'This is the trap C0.L5 set up: the optimisation and the pricing shape have to match, or you will be technically right and commercially irrelevant. File count barely touches bytes scanned, so a per-byte-scanned bill hardly moves. The real savings are elsewhere and are still real — request counts, compute time, the ~1.4 TB/day of compaction rewrite, and the analyst queries that currently spend most of their life planning. Quoting the 61% planning share as a cost reduction is the specific mistake: it is a share of time, on a shape that does not bill time.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: why small files are a metadata problem wearing a storage costume',
      md: `The canonical prior art is the **Hadoop small files problem**, and it is worth reading the old material rather than dismissing it as HDFS trivia: the original constraint was NameNode memory — one in-memory object per file and block — and the modern constraint is a catalog and manifest tree enumerated per query. Different mechanism, identical arithmetic, and the fact that it recurred after the storage layer was replaced tells you the cause was never the storage layer.

For how a table format actually enumerates files, the **Iceberg specification** on manifests and manifest lists is the primary source, and it is short enough to read directly. The important structural detail is that partition value ranges are recorded in the manifest list, so partition pruning happens *above* the file list — which is both why partition pruning is so cheap and why a table with millions of files still pays per-manifest work. **C3** takes this apart properly.

On the rate-matching argument, the honest reference is not a database paper: it is **queueing theory** — arrival rate against service rate, and the result that utilisation at or above one has no steady state. If you have internalised that for request queues, you already have the compaction model; the drill is just Little's law with files as customers.

For compaction policy design, the LSM-tree literature is where this was worked out with the trade named explicitly: **O'Neil et al., "The Log-Structured Merge-Tree" (1996)** and, for the modern formulation, **Dayan, Athanassoulis and Idreos on Monkey and the RUM conjecture** — read, update and memory as a three-way trade you can move along but not escape. **C5** builds a merge-on-read store and grades write amplification against read amplification directly, and the compaction desk grades a policy with no stated write-amp budget as an unbounded background bill.

The industry-facing version, if you want a single sentence for a review: files are the unit of metadata, metadata is enumerated per query, and a partition boundary that makes pruning free also makes merging impossible.

Next: **C2.L6** turns everything in this track into one page you can hand to a room — a pruning ratio stated as a promise, the query it starves named out loud, and the monitor that keeps the promise honest.`,
    },
  ],
}

export default lesson
