import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'a2.l4',
  slug: 'observability-and-the-query-slo',
  trackId: 'a2',
  index: 4,
  title: 'Observability and the Query SLO',
  minutes: 19,
  hook: 'Two of the five Column Week incidents were visible in telemetry for days before anyone acted, and neither showed up in job status. One was visible twelve hours before the invoice moved. This is the page that decides what wakes you up.',
  exercise: 'quiz',
  takeaway: {
    number: '12 hours vs 11 days',
    claim:
      'Clustering depth moved 12 hours before the scan bill tripled and the null rate moved on day 1 of an 11-day silent error, so alerting on data shape rather than job status is the difference between a warning and a post-mortem.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Two promises are being made in this lesson and they are usually confused, so separate them first.

**A query SLO** is a promise to your consumer about what they may expect. It is a p95, per workload **class**, at a stated concurrency, with one class explicitly excluded and fenced instead.

**Observability** is how *you* find out that a promise is about to break. It is not the same set of numbers, and the important half of it is not about queries at all — it is about the shape of the data, because **the incident that actually happens has green pipelines.**

Column Week is the evidence. Of the five incidents, three were silent in every operational dashboard a platform team normally builds:

- **INC-1** tripled the scan bill overnight with byte-identical queries and *no latency change worth noticing*, because the engine was wide enough to absorb a 9× increase in row groups read. The only moving metric before the invoice was **clustering depth**, and it moved about twelve hours earlier.
- **INC-4** delivered a wrong revenue number for **eleven days** with **zero failed jobs**. The null rate on the new column moved on **day one**.
- **INC-3** ran a nightly join from 8 minutes to 51 while **mean partition size stayed flat all month** — the maximum was the runtime, and the mean is what every default dashboard shows.

That is the design constraint, stated as a sentence you can say in a review: **monitoring job status tells you about failures that announce themselves, and the expensive failures do not announce themselves.** Which is exactly the consumer room's fatal rebuttal — *"it covers the ones that announce themselves… my team becomes your monitoring."*`,
    },
    {
      type: 'prose',
      md: `## The SLO: a p95 per class, and one class you refuse to promise

A single platform-wide p95 is either a lie or useless, because the workloads it averages have nothing in common. Three classes, and the third is the interesting one:

| class | what it contains | the promise | why it is promisable |
|---|---|---|---|
| **dashboard / serving** | fixed queries, known projections, predicates that match the layout | **p95 ≤ 4 s at 60 concurrent queries** | columns, predicates and frequency are all known, so bytes scanned is arithmetic (C0.L5) |
| **pipeline / batch** | scheduled transforms, wide scans, known shape | **p95 ≤ 15 min, and a completion deadline** | same reason, different magnitude; the deadline matters more than the latency |
| **ad-hoc / exploratory** | unpredictable projections, weak or absent predicates | **no p95 at all** — a per-query ceiling of 200 GB and a pool ceiling of 1.5 TB/day | not computable; the honest control is a fence, and the fence is what you report |

Two details that decide whether the number means anything.

**A p95 without a concurrency figure is a single-user benchmark.** "Four seconds" measured with one query running is not a promise about Monday at 09:00. State the concurrency the SLO holds at, and state what happens above it — queueing, or a separate pool, or degradation you have chosen deliberately.

**The excluded class must be excluded loudly.** This is the move the consumer room rewards: *"per class, with the wild one fenced off. That is honest, and it means the number means something."* An unpredicated ad-hoc scan is the query your layout is worst at (C2.L6, and the principal's \`no_worst_query\` objection), so promising it a latency is promising something the physical design cannot deliver. Fence it with a quota and report the ceiling.

And the caveat, first: **your SLO cannot exceed your catalog's availability** (A2.L1). A 99.9% catalog in series with storage gives about 47 minutes a month in which no query can be planned at all, and no p95 survives that. Put the availability number and the latency number on the same page or somebody will read the second one as covering the first.`,
    },
    {
      type: 'prose',
      md: `## Alert on shape, and put the leading indicator next to the lagging one

Three families of shape detector. All three are counts, all three are cheap, and all three fired in Column Week before anybody noticed:

**Row-count deltas against expectation.** Not "did the job succeed" but "did this partition receive between 0.7× and 1.4× the rows it received on the same weekday for the last four weeks". This is the detector for the case the consumer room describes: *ingest succeeds, every job is green, and the table has half the rows it should.*

**Null-rate and distribution drift, per column.** INC-4's null rate on \`discount_applied\` went from nothing to a rate that moved every day thereafter. A threshold as blunt as "null rate changed by more than 10 percentage points week over week" turns eleven days into one. Distribution drift catches the sibling cases from A2.L2: a new category at 2% of rows, or a unit change that shifts a mean by a suspiciously round factor.

**Freshness per partition, not per table.** A table-level freshness metric is dominated by whichever partition was written last, so a single stalled upstream partition is invisible in it. Measure max age per partition against the SLA the consumer recorded, and alert on the maximum — the same "max, not mean" discipline INC-3 teaches for skew.

Then the part that makes this a cost discipline rather than a data-quality one. **Clustering depth is the leading indicator of the scan bill.** Run INC-1's arithmetic:

\`\`\`text
depth 1 → 9            (upstream stopped writing in event_time order)
pruning 89% → 11%      (min/max now overlap the predicate everywhere)
row groups read 180 → 1,620       = 9×
daily scan 1.2 TB → 3.9 TB        = 3.25×
latency: barely moves — the engine absorbs it
\`\`\`

The query did not change. The plan did not change. The layout document is still accurate. The only thing that changed is how *ordered* the arriving data was, which is a property of a system upstream of you, and it converted into a 3.25× cost multiplier with **no error and no latency signal**. Twelve hours of warning existed in a metric nobody was plotting.

So the runbook pairs each leading indicator with the lagging symptom it precedes, and you monitor the left column:

| leading indicator (monitor this) | lead time | lagging symptom (what you get instead) |
|---|---|---|
| clustering depth per partition | ~12 h | bytes scanned, then the invoice |
| compaction backlog slope, created vs merged per hour | days to weeks | planning share of query time: 4% → 61% |
| null-rate and distribution drift per column | 1 day of 11 | a finance analyst noticing at month-end |
| max ÷ mean partition bytes on shuffle keys | one run | job runtime 8 min → 51 min, cluster 14% utilised |
| requests/s and bytes per request | immediate | p95 40 ms → 610 ms with the fabric 21% used |

Every one of those left-hand entries is a count, which is why they transfer between platforms and why they can be diffed week to week.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '3.25×',
          label: 'scan volume increase in INC-1 with byte-identical queries',
          hint: '1.2 TB/day to 3.9 TB/day, from pruning falling 89% to 11% as clustering depth went 1 to 9. No error, no deploy, and almost no latency change.',
        },
        {
          value: '12 h',
          label: 'lead time clustering depth gave over the invoice',
          hint: 'The leading indicator moved about half a day before the cost did. It was in the telemetry and on nobody\'s dashboard, which is the difference between a warning and a post-mortem.',
        },
        {
          value: 'day 1 of 11',
          label: 'when INC-4 was detectable from null-rate drift',
          hint: 'Eleven days of a wrong revenue figure with zero failed jobs. A blunt threshold on null-rate change week over week would have caught it in the first twenty-four hours.',
        },
        {
          value: '≤ 2 pages/week',
          label: 'the alert budget that makes the rest of this real',
          hint: '400 tables × 4 detectors is 1,600 rules; at a 2% weekly false-positive rate that is 32 pages a week and an on-call who stops reading. Tier the detectors or the design is decorative.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the alert budget, because your 3am is part of the architecture',
      md: `Everything above is easy to design and easy to ruin, and the ruin is arithmetic:

\`\`\`text
400 tables × 4 detectors                       = 1,600 rules
at a 2% weekly false-positive rate per rule    = 32 pages/week
\`\`\`

Thirty-two pages a week is not monitoring. It is a filter that trains one specific behaviour — acknowledging without reading — and after a month the platform is *less* observable than it was with nothing, because now there is a green wall that means "nobody looked". A page nobody reads is worse than a missing detector, because it also consumes the budget you would have spent on the detector that mattered.

So tier it deliberately, and write the tiering down where the on-call can see it:

- **Pages** (wake a human): the erasure deadline at risk, the catalog unavailable, freshness breached on a **contract-bearing** dataset, compaction backlog slope positive for 24 hours. Target: **≤ 2 a week**, and if you exceed that for a month the thresholds are wrong, not the humans.
- **Tickets** (next working day): shape drift on a non-critical dataset, clustering depth rising, storage multiple above the policy, orphan candidate count above its sanity bound.
- **Dashboard only** (nobody is notified): everything else, plotted next to the lagging metric it predicts so the pairing is legible at 3am by someone who did not build it.

The honest caveat to state before the room finds it: **a shape detector has a false-positive rate you are choosing, and the sensitivity you want on a revenue column is a sensitivity you cannot afford across four hundred tables.** Say which datasets are contract-bearing — for a mature platform this is a real list, perhaps 40 of the 400 — and accept slower detection on the rest as a deliberate decision with an owner, rather than an accident with a survivor.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'Clustering depth is a real, queryable metric in at least one platform — and computable everywhere',
      systems: ['snowflake'],
      sources: [
        'https://docs.snowflake.com/en/sql-reference/functions/system_clustering_depth',
        'https://docs.snowflake.com/en/sql-reference/functions/system_clustering_information',
      ],
      md: `Snowflake exposes clustering quality directly: \`SYSTEM$CLUSTERING_DEPTH\` returns the average depth of a table over specified columns, and \`SYSTEM$CLUSTERING_INFORMATION\` returns clustering details including a depth histogram. The documented meaning of depth is the one C2.L5 derives from first principles: it is **the average number of overlapping micro-partitions for the given columns**, so a smaller depth means better clustering, and the minimum meaningful value is 1.

Two things to take from that, neither of them about Snowflake.

**First, the indicator is legitimate rather than invented for this course.** A production platform ships it as a system function, with the same semantics — overlap of value ranges across storage units — that INC-1 diagnoses. If your platform does not expose it, you can compute it: read per-file or per-row-group min/max for the clustering column from the manifests or footers you already have (C2.L1, C3.L1), and count how many ranges overlap a sampled point. That is a metadata-only scan, so the detector costs manifest reads rather than data reads.

**Second, the mechanism is not vendor-specific and neither is the failure.** Any system that skips storage units using value ranges loses pruning when ranges overlap, whatever it calls the unit — micro-partition, row group, block, chunk. So "monitor the overlap of the clustering column" transfers to Iceberg on object storage, to a shared-everything platform, and to whatever you migrate to next; only the query that produces the number changes.

Treat the function names as perishable and the definition as durable, and check both against your own version before you put either in a runbook.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — two promises, three detectors, and one paging budget',
      height: 76,
      nodes: [
        { id: 'dash', x: 2, y: 2, w: 30, h: 9, label: 'class: dashboard', sub: 'p95 ≤ 4 s at 60 concurrent', color: '#3EF2A4' },
        { id: 'batch', x: 35, y: 2, w: 30, h: 9, label: 'class: pipeline', sub: 'p95 ≤ 15 min + a deadline', color: '#5CA8FF' },
        { id: 'adhoc', x: 68, y: 2, w: 30, h: 9, label: 'class: ad-hoc', sub: 'NO p95 · 200 GB/query, 1.5 TB/day pool', color: '#FBBF24' },
        { id: 'slo', x: 2, y: 15, w: 96, h: 9, label: 'the query SLO: per class, at a stated concurrency, with the unpromisable class fenced by quota instead', sub: 'and capped by the catalog\'s availability — about 47 min/month in which nothing can be planned at all (A2.L1)', color: '#F97316' },
        { id: 'rows', x: 2, y: 28, w: 30, h: 9, label: 'row-count deltas', sub: 'per partition, vs the last 4 same weekdays', color: '#22D3EE' },
        { id: 'nulls', x: 35, y: 28, w: 30, h: 9, label: 'null-rate + drift', sub: 'per column — INC-4 moved on day 1', color: '#22D3EE' },
        { id: 'fresh', x: 68, y: 28, w: 30, h: 9, label: 'freshness per partition', sub: 'the MAX, never the table mean', color: '#22D3EE' },
        { id: 'depth', x: 2, y: 41, w: 96, h: 9, label: 'plus the cost indicator: clustering depth per partition — 1 → 9 gave 12 hours of warning before 1.2 TB/day became 3.9 TB/day', sub: 'no error, no deploy, no latency signal: the engine absorbed 9× the row groups read and only the bill noticed', color: '#FB7185' },
        { id: 'budget', x: 2, y: 54, w: 96, h: 9, label: 'the paging budget: 400 tables × 4 detectors = 1,600 rules; at 2% weekly false positives that is 32 pages a week', sub: 'so pages ≤ 2/week on contract-bearing datasets, tickets next working day, everything else dashboard-only', color: '#A78BFA' },
        { id: 'pair', x: 2, y: 67, w: 96, h: 9, label: 'and every leading indicator is plotted next to the lagging symptom it precedes, so the pairing is legible at 3am by someone who did not build it', sub: 'depth → bytes scanned · backlog slope → planning share · null drift → a wrong board number · max ÷ mean → job runtime', color: '#F97316' },
      ],
      edges: [
        { from: 'dash', to: 'slo' },
        { from: 'batch', to: 'slo' },
        { from: 'adhoc', to: 'slo' },
        { from: 'rows', to: 'budget' },
        { from: 'nulls', to: 'budget' },
        { from: 'fresh', to: 'budget' },
        { from: 'slo', to: 'depth' },
        { from: 'depth', to: 'budget' },
        { from: 'budget', to: 'pair' },
      ],
      steps: [
        {
          caption:
            'Split the workload into classes before promising anything, because a platform-wide p95 averages queries with nothing in common and is therefore either a lie or useless to the person relying on it.',
          active: ['dash', 'batch', 'adhoc'],
        },
        {
          caption:
            'Two classes are computable from columns, predicates and frequency, so they get a p95 at a stated concurrency. The third is not computable, so it gets a fence — a per-query ceiling and a pool ceiling reported as bounds rather than forecasts.',
          active: ['slo'],
          edges: ['dash->slo', 'batch->slo', 'adhoc->slo'],
        },
        {
          caption:
            'Then the detectors, none of which look at job status: row counts per partition against the same weekday, null rate and distribution per column, and freshness measured as the worst partition rather than the table average.',
          active: ['rows', 'nulls', 'fresh'],
        },
        {
          caption:
            'And the one that is a cost control rather than a quality control: clustering depth, which moved from 1 to 9 about twelve hours before the daily scan volume went from 1.2 TB to 3.9 TB with byte-identical queries.',
          active: ['depth'],
          edges: ['slo->depth'],
        },
        {
          caption:
            'Now bound the whole design by what a human can absorb: sixteen hundred rules at a two-percent weekly false-positive rate is thirty-two pages a week, which trains acknowledging without reading and leaves you less observable than before.',
          active: ['budget'],
          edges: ['rows->budget', 'nulls->budget', 'fresh->budget', 'depth->budget'],
        },
        {
          caption:
            'Finish by pairing each leading indicator with the lagging symptom it predicts on the same dashboard, because the person reading it at 3am did not build it and needs the causal link rendered rather than remembered.',
          active: ['pair'],
          edges: ['budget->pair'],
        },
      ],
    },
    {
      type: 'isomorphism',
      title: 'this page ≡ three disciplines that already solved it elsewhere',
      pairs: [
        {
          os: 'SRE error budgets and SLO classes',
          osLine:
            'You promise availability per service tier, exclude what you cannot control, and spend a budget rather than chasing perfection. The excluded traffic gets admission control, not a promise.',
          llm: 'p95 per workload class with the ad-hoc class quota-fenced',
          llmLine:
            'The identical structure, and the ad-hoc pool is literally an admission-control problem in a finance costume: a per-query ceiling and a daily pool ceiling are load shedding, and reporting the ceiling instead of a forecast is what makes the number honest.',
        },
        {
          os: 'statistical process control',
          osLine:
            'Shewhart charts monitor the shape of the output rather than the state of the machine, precisely because a machine can be running perfectly and producing parts out of tolerance. Thresholds are set from observed variance, and you choose a detection latency against a false-alarm rate.',
          llm: 'row-count deltas, null-rate drift, distribution shift',
          llmLine:
            'The same argument moved onto tables: the pipeline is the machine, the data is the part, and the green job is the machine reporting that it ran. Choosing thresholds from four weeks of the same weekday is the control chart, and the alert budget is the false-alarm rate stated out loud.',
        },
        {
          os: 'index fragmentation and bloat monitoring',
          osLine:
            'DBAs watch fragmentation rather than query latency, because the engine absorbs degradation until it suddenly does not, and by then the fix is a maintenance window rather than a setting.',
          llm: 'clustering depth as the cost indicator',
          llmLine:
            'Same relationship, different currency: the engine absorbed a 9× increase in row groups read with almost no latency change, so the degradation surfaced as a bill instead of as a slow query. Watch the physical property, not the user-visible symptom. (→ tablespace T3 for the row store\'s fragmentation story.)',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Overnight, one dashboard\'s daily scan volume goes from 1.2 TB to 3.9 TB. The queries are byte-identical, nothing was deployed, row counts grew 3%, and p95 latency is essentially unchanged. Which monitoring change would have caught this, and what does it cost you to have missed it?',
          options: [
            'Alerting on p95 latency per dashboard, since a 3.25× increase in work must eventually show up as slower queries',
            'Alerting on clustering depth per partition: it went from 1 to 9 about twelve hours before the cost moved, because pruning fell from 89% to 11% when the loader stopped writing in event_time order. Latency stayed flat because the engine simply read 9× more row groups in parallel, so the only lagging signal was the invoice',
            'Alerting on row-count growth, since a table growing faster than expected is the usual cause of scan-volume increases',
            'Alerting on job status for the ingest pipeline, since the upstream change is what caused this',
          ],
          correct: [1],
          explanation:
            'This is INC-1 and its whole lesson is that the expensive signal and the visible signal are different. Pruning is a property your physical layout makes possible, not a feature the engine provides, so an unordered write pattern gives every row group nearly the full value range and none can be skipped — 9× the row groups read for the same answer. Latency is a terrible detector here precisely because a wide engine absorbs the extra work, which is why the first option fails: waiting for a latency signal means waiting for the bill. Row counts grew 3%, exactly as they always do, so growth explains none of it. And job status is clean because the loader did not fail — it just changed the order it wrote in, which no pipeline check inspects.',
        },
        {
          q: 'Your consumer asks what they may expect from a query on the new platform. Which SLO is defensible, and why is the awkward part of it the part that earns the room?',
          options: [
            '"p95 under 4 seconds across the platform, measured continuously, with a dashboard everyone can see."',
            '"p95 under 4 seconds at 60 concurrent queries for the dashboard class, p95 under 15 minutes plus a completion deadline for the pipeline class, and no latency promise at all for ad-hoc — that class gets a 200 GB per-query ceiling and a 1.5 TB daily pool instead. All of it is capped by catalog availability of about 47 minutes a month during which nothing can be planned."',
            '"Best-effort performance while we learn the workload, then a formal SLO next quarter once patterns emerge."',
            '"p95 under 4 seconds for all classes, with ad-hoc queries automatically routed to a larger compute pool so they meet it too."',
          ],
          correct: [1],
          explanation:
            'The awkward parts are the load-bearing ones: naming the concurrency turns a single-user benchmark into a promise about Monday morning, refusing to promise a latency for unpredicated ad-hoc scans matches what the physical layout can actually deliver, and stating the availability cap stops the latency number from being read as covering an outage. A single platform-wide p95 averages workloads with nothing in common and will be broken by the first analyst who scans a year of history. Best-effort is fatal in this room for the reason the consumer gives — they cannot promise anything downstream either, and the first question they get is whose fault that is. The last option is the most tempting and the most wrong: a bigger pool changes how fast an unpruned full scan runs, not the fact that it reads the whole table, so you have promised a latency backed by spend that grows with the table.',
        },
        {
          q: 'Ingest succeeds every night, every job is green, and a revenue model has been under-reporting for eleven days after an upstream column was renamed and a new nullable one added. Which detector family closes this, and what is the honest cost of running it?',
          options: [
            'Stricter schema validation on ingest, rejecting any change that is not explicitly approved',
            'Null-rate and distribution drift per column, which moved on day one of eleven — with the honest cost being a false-positive rate you are choosing, so the sensitivity you want on a revenue column is not affordable across 400 tables, and the answer is a named list of contract-bearing datasets plus deliberately slower detection elsewhere',
            'End-to-end reconciliation against the source system for every table nightly, which would have caught the discrepancy directly',
            'Alerting on schema version changes, so any bump to the table schema notifies the consuming teams',
          ],
          correct: [1],
          explanation:
            'The signal existed from the first hour and nobody was reading it, so the fix is a detector on data shape rather than on job state — and the lesson insists you state its price, because a detector budget is a paging budget: 400 tables times four rules at a two-percent weekly false-positive rate is thirty-two pages a week, which trains an on-call to acknowledge without reading. Strict ingest validation blocks the mechanically incompatible changes, which are the ones that were never the problem: this change was legal, additive and green. Full reconciliation is the strongest control and the most expensive, and proposing it for every table nightly is how a good idea gets rejected wholesale rather than applied to the forty datasets that justify it. Alerting on schema version bumps notifies on every additive change too, which is most of them, so it degrades into noise and misses the one that mattered because nothing distinguishes it.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: SLOs, shape monitoring, and choosing a detection latency on purpose',
      md: `Start with **the SRE workbook's chapters on SLO engineering and alerting on SLOs** — burn-rate alerting in particular, because it is the correct answer to the paging-budget arithmetic in this lesson: you alert on the *rate at which a budget is being consumed* rather than on individual breaches, which collapses many noisy rules into a few meaningful ones. **Chapters on load shedding and graceful degradation** are the right frame for the ad-hoc pool, which is admission control however the finance team describes it.

For shape monitoring, the honest genealogy is **statistical process control**: Shewhart's control charts and the average-run-length framing give you the vocabulary for the trade you are making — detection latency against false-alarm rate — and that vocabulary is what lets you defend a threshold to somebody who was paged by it. In the data-specific literature, **Great Expectations, Deequ (Amazon's "Automating Large-Scale Data Quality Verification", VLDB 2018) and Monte Carlo's writing on data downtime** are the practical corpus; read Deequ first, because it is a paper and it states its constraint-checking model precisely rather than as product surface.

On the specific claim that latency is a poor cost detector, the underlying reason is worth reading properly: **Little's Law and basic queueing** explain why a wide, parallel engine converts extra work into throughput consumption rather than latency until it saturates, at which point the curve is a cliff. That is why bytes and row groups are the metrics and seconds are the symptom — the same argument C0 makes about cost being a count rather than a clock.

For clustering depth specifically, read **Snowflake's clustering-depth documentation** for a production definition, then C2.L5 for how to compute the same thing from manifests and footers you already own. It is a metadata-only scan, which is what makes it affordable as a standing detector.

Next: **A2.L5**. You now know what to promise and how you will find out it is breaking. The remaining question is what the platform will need over twenty-four months, which component gives out first, and who pays for each tenant's share of it — because a platform that cannot attribute its consumption cannot be governed.`,
    },
  ],
}

export default lesson
