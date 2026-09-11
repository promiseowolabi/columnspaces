import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c2.l2',
  slug: 'sort-keys-versus-partition-keys',
  trackId: 'c2',
  index: 2,
  title: 'Sort Keys Versus Partition Keys',
  minutes: 20,
  hook: 'A partition key cuts the file list. A sort key cuts the bytes inside the files that survive. Treating them as one decision is the most expensive confusion in this field, and a four-column sort key does not serve four predicates.',
  exercise: 'lab+quiz',
  artifact: 'layout-design',
  takeaway: {
    number: '2 of 120',
    claim:
      'Only two of the 120 layouts in the C2 designer meet both targets, and the design that minimises the dashboard bill misses the starved-class ceiling by 14× — because one partition key and one sort key cannot serve five query classes.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Two sentences, and the rest of this lesson is their consequences:

- **Partitioning is a metadata decision.** It changes which files appear in the list a query has to consider, and it does that *before any file is opened*. Its unit is the file. Its currency is the file count.
- **Sorting is a physics decision.** It changes where values sit inside the files that survive the list, and therefore what the per-row-group min/max pairs are able to prove. Its unit is the row group. Its currency is bytes.

They are not two names for one thing, they fail in different ways, and the failure modes are asymmetric in a way that catches good engineers. Get the sort key wrong and you over-read: a bill, recoverable by rewriting the data. Get the partition key wrong — specifically, too fine — and you generate files faster than compaction can remove them, planning time starts to dominate execution, and the damage is in the catalog rather than in the data. That is Column Week's second incident, at 1.4M live files against 9 TB, with planning taking longer than execution on the same table.

The confusion is expensive because the two decisions *sound* interchangeable. "We partition by day and we filter by day" and "we sort by day and we filter by day" both prune. They do not prune the same thing, they do not cost the same thing, and only one of them has an upper bound on how badly it can go wrong.`,
    },
    {
      type: 'prose',
      md: `## Partitioning: arithmetic on the file list

A partition key is a function from a row to a directory (or, in a table format, to a value in the file's metadata tuple). The rule that makes the arithmetic work is that **a data file belongs to exactly one partition** — every row in it has the same partition value. That is not a convention; it is required, and it means partitioning has a hard multiplicative floor on file count:

\`\`\`
live files  ≥  partitions that received data  ×  writers  ×  commits not yet compacted
\`\`\`

Take the Warehouse table the C2 designer prices against: **180,000,000 rows**, and the partition keys on offer are \`day\` (90 values), \`tenant\` (64, Zipf-distributed so the partitions are wildly uneven), \`region\` (6) and \`none\` (1).

- **\`day\`** gives 90 partitions and 2,000,000 rows each. Any query with a time range drops most of the list without reading a footer. This is the key that works, and it works because the cardinality is bounded by time rather than by your business.
- **\`region\`** gives 6 partitions of 30,000,000 rows. Tidy, cheap, and almost worthless: a region predicate drops five sixths of the list and every other predicate drops nothing. This is the key that looks like governance and buys no pruning.
- **\`day\` + \`tenant\`** gives 5,760 directories. Now do the ingest arithmetic: eight writers, a commit every five minutes, 288 commits a day. Even if data only ever lands in today's partition, that is 64 × 8 × 288 = **147,456 files a day**, and every one of them carries a footer that the planner opens.
- **\`user_id\`**, which somebody will propose because the needle query filters on it, has **4,000,000 values**. 180,000,000 rows over 4,000,000 partitions is **45 rows per file.** At 45 rows the footer is larger than the data. This is what "a high-cardinality partition column is a small-file generator" means arithmetically, and it is why the answer to "our point lookups are slow" is never "partition by the id".

The rule of thumb that survives contact with production: **the partition key's cardinality must be bounded and small enough that each partition holds a target-sized file's worth of data, per commit.** Everything else is a sort-key problem.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'How Iceberg separates the two decisions — transforms, and a sort order that is only advice',
      systems: ['iceberg', 'parquet'],
      sources: [
        'https://iceberg.apache.org/spec/',
        'https://github.com/apache/parquet-format/blob/master/src/main/thrift/parquet.thrift',
      ],
      md: `**Apache Iceberg** makes the split structural, which is the clearest place to see that these are two different mechanisms.

*Partitioning* is a **partition spec**: a list of fields, each a transform applied to a source column. The transforms in the spec are \`identity\`, \`bucket[N]\`, \`truncate[W]\`, \`year\`, \`month\`, \`day\`, \`hour\` and \`void\`. Two of them exist specifically to *reduce* the cardinality of a partition key so it stops being a small-file generator:

- \`bucket[N]\` is \`(murmur3_x86_32(v) & Integer.MAX_VALUE) % N\` — a high-cardinality column mapped into exactly N partitions. It answers equality on the source column and nothing else, because a hash destroys order.
- \`truncate[W]\` keeps a prefix: for strings, \`L=3\` maps \`iceberg\` to \`ice\`.

The spec also documents *why* this is a metadata decision: scan predicates are converted to partition predicates by **inclusive projection**, so \`ts > X\` becomes \`ts_day >= day(X)\`. Files are eliminated from the list using partition values, before their contents are consulted at all. And the spec is explicit that partition values must be identical for every record in a data file — which is the floor on file count in the arithmetic above.

*Sorting* is a separate **sort order**: an ordered list of sort fields, each with a source column, a transform, a direction (\`asc\`/\`desc\`) and a null order (\`nulls-first\`/\`nulls-last\`). Order id \`0\` is reserved for "unsorted". The sentence to read twice is the spec's own caveat on the table's default sort order: writers *should* use it, **but "are not required to if the default order is prohibitively expensive, as it would be for streaming writes."**

So a declared sort order is a statement of intent that a streaming writer is permitted to ignore, and each file records the \`sort_order_id\` it was actually written with — where a missing or unknown id means the file is assumed unsorted. **Parquet** does the same thing one level down: \`RowGroup.sorting_columns\` records \`(column_idx, descending, nulls_first)\` as metadata about how the rows were written. Neither format enforces order. Both record a claim about it. That gap is where clustering silently dies, and C2.L3 is about measuring it.`,
    },
    {
      type: 'prose',
      md: `## Sorting: why a four-column sort key does not serve four predicates

A compound sort key is not four independent orderings. It is one ordering, in which the second column is only sorted *within the runs of rows that share a first-column value*, the third only within runs sharing the first two, and so on. Whether that residual ordering is worth anything depends on one comparison, and you can do it on a napkin.

For column *k* of a sort key, the rows that share a given prefix of columns 1..*k*−1 number roughly:

\`\`\`
rows_per_prefix(k) = total rows ÷ (product of cardinalities of columns 1 .. k-1)
\`\`\`

**Column *k* can prune across row groups only while \`rows_per_prefix(k)\` is comfortably larger than one row group.** Once a prefix's rows fit inside a single group, every group holds many different prefixes, column *k* restarts its range inside each of them, and that group's min/max on column *k* covers a wide slice of its domain — so nothing can be excluded.

Run it on the designer's table: 180,000,000 rows, 131,072-row groups (so 1,373 groups), sort key \`(tenant_id, region, event_type, user_id)\` with cardinalities 64, 6, 24 and 4,000,000.

| column | rows per prefix | in row groups | what a predicate on it alone can prune |
|---|---|---|---|
| 1. \`tenant_id\` | 180,000,000 | 1,373 | almost everything — each tenant occupies its own ~21 groups |
| 2. \`region\` | 2,812,500 | 21.5 | a lot, but only 64 separate runs of ~4 groups each |
| 3. \`event_type\` | 468,750 | 3.6 | weakly — ~384 groups still hold any given event type |
| 4. \`user_id\` | 19,531 | **0.15** | **nothing.** Every group spans nearly the whole 4M-value domain |

That is the whole phenomenon in one column of arithmetic: **21.5 groups, then 3.6, then 0.15.** The fourth column of the sort key is decoration. It appears in the DDL, it satisfies the reviewer who asked "is user_id in the sort key?", and it prunes zero row groups — which is exactly why the designer's \`needle\` class (one end user, anywhere in the table, four ids out of four million) is starved so badly under a conventional dashboard layout. The needle does not need \`user_id\` in the sort key. It needs \`user_id\` **first**, and the dashboard will pay for that.

Two honest corollaries:

- **Put the coarsest useful column first only if you can afford it.** A low-cardinality leading column leaves room for the second one to still span many groups. A leading column with near-unique values (\`ts\` at second resolution, an event id) makes every subsequent column of the key worthless at row-group granularity, because \`rows_per_prefix(2)\` is already about one row.
- **Space-filling curves change the shape, not the physics.** Z-ordering and Hilbert ordering trade excellent clustering on one column for moderate clustering on several. That is sometimes the right trade and it is never a free one — you are choosing to make the first predicate worse in order to make the third predicate possible.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — two mechanisms, two currencies, and where a compound sort key stops working',
      height: 80,
      nodes: [
        { id: 'query', x: 2, y: 2, w: 96, h: 9, label: "WHERE ts >= now() - 7 days AND tenant_id = 42 AND user_id = 8117403", sub: 'three predicates, one physical layout to serve them', color: '#A3E635' },
        { id: 'catalog', x: 2, y: 15, w: 46, h: 10, label: 'partition pruning', sub: 'cuts the FILE LIST · no file opened yet', color: '#22D3EE' },
        { id: 'bytes', x: 52, y: 15, w: 46, h: 10, label: 'row-group pruning', sub: 'cuts the BYTES INSIDE surviving files', color: '#3EF2A4' },
        { id: 'dirs', x: 2, y: 29, w: 46, h: 10, label: 'day(90) × tenant(64) = 5,760 dirs', sub: 'a metadata decision, made in the catalog', color: '#22D3EE' },
        { id: 'groups', x: 52, y: 29, w: 46, h: 10, label: '180M rows ÷ 131,072 = 1,373 groups', sub: 'one physical order · min/max per group', color: '#3EF2A4' },
        { id: 'files', x: 2, y: 43, w: 46, h: 10, label: 'files ≥ partitions × writers × commits', sub: '64 × 8 × 288 = 147,456 files a day', color: '#FBBF24' },
        { id: 'sortkey', x: 52, y: 43, w: 46, h: 10, label: 'sort (tenant, region, event_type, user_id)', sub: 'rows per prefix: 1,373 → 21.5 → 3.6 → 0.15 groups', color: '#FBBF24' },
        { id: 'small', x: 2, y: 57, w: 46, h: 10, label: 'partition by user_id: 4M dirs', sub: '45 rows per file — the footer outweighs the data', color: '#FB7185' },
        { id: 'collapse', x: 52, y: 57, w: 46, h: 10, label: 'column 4 prunes nothing', sub: 'every group spans the whole 4M-id domain', color: '#FB7185' },
        { id: 'verdict', x: 2, y: 71, w: 96, h: 8, label: 'one partition key + one sort key, five query classes', sub: '2 of the 120 designs meet both targets; the dashboard-optimal one misses the ceiling by 14×', color: '#A78BFA' },
      ],
      edges: [
        { from: 'query', to: 'catalog' },
        { from: 'query', to: 'bytes' },
        { from: 'catalog', to: 'dirs' },
        { from: 'bytes', to: 'groups' },
        { from: 'dirs', to: 'files' },
        { from: 'groups', to: 'sortkey' },
        { from: 'files', to: 'small' },
        { from: 'sortkey', to: 'collapse' },
        { from: 'small', to: 'verdict' },
        { from: 'collapse', to: 'verdict' },
      ],
      steps: [
        {
          caption:
            'One query, three predicates: a time window, a tenant, and one end user out of four million. It will be served by exactly one partition key and exactly one sort key, because that is all a table has.',
          active: ['query'],
        },
        {
          caption:
            'The two mechanisms act at different moments on different things. Partition pruning shortens the list of files before any of them is opened; row-group pruning shortens the byte ranges requested from the files that made the list. Neither substitutes for the other.',
          active: ['catalog', 'bytes'],
          edges: ['query->catalog', 'query->bytes'],
        },
        {
          caption:
            'Partitioning is arithmetic on directories: ninety days times sixty-four tenants is 5,760 of them. Sorting is arithmetic on row groups: 180 million rows at 131,072 rows per group is 1,373 separate min/max claims per column.',
          active: ['dirs', 'groups'],
          edges: ['catalog->dirs', 'bytes->groups'],
        },
        {
          caption:
            'Now the costs diverge. Finer partitions multiply files — eight writers committing every five minutes into sixty-four tenant directories is over 147,000 files a day. A compound sort key instead degrades: rows per prefix falls 1,373 → 21.5 → 3.6 → 0.15 row groups across its four columns.',
          active: ['files', 'sortkey'],
          edges: ['dirs->files', 'groups->sortkey'],
        },
        {
          caption:
            'Both failure modes are reached by a reasonable-sounding request. "Partition by user_id so the lookups are fast" yields 45 rows per file. "Put user_id in the sort key" yields a fourth column whose prefix fits inside one row group, so every group spans the whole id domain and nothing prunes.',
          active: ['small', 'collapse'],
          edges: ['files->small', 'sortkey->collapse'],
        },
        {
          caption:
            'Which is why the layout designer can be graded structurally rather than by taste: across all 120 designs a strictly worst-served class always exists, exactly two designs satisfy both targets, and the design that minimises the dashboard bill abandons the needle class by fourteen times the ceiling.',
          active: ['verdict'],
          edges: ['small->verdict', 'collapse->verdict'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '21.5 → 0.15',
          label: 'row groups per prefix, sort column 2 → column 4',
          hint: '180M rows ÷ 131,072 per group, cardinalities 64 · 6 · 24 · 4M. Below one group per prefix, that column of the sort key prunes nothing at all.',
        },
        {
          value: '45 rows',
          label: 'per file when you partition by a 4M-value id',
          hint: '180,000,000 ÷ 4,000,000. The Parquet footer is larger than the data. This is the arithmetic behind "high cardinality partition key = small-file generator".',
        },
        {
          value: '14×',
          label: 'the starved class overshoots its ceiling under the dashboard-optimal design',
          hint: 'The design that minimises dashboard bytes lands the needle class at 71.5 GiB against a 5 GiB ceiling. Computed by sweeping the whole design grid, not chosen by taste.',
        },
        {
          value: '2 of 120',
          label: 'designs that satisfy both targets',
          hint: '4 partition keys × 6 sort keys × 5 row-group sizes. Two work, and reaching them costs roughly 4.6× on the dashboard versus its own best case.',
        },
      ],
    },
    {
      type: 'lab',
      lab: 'layout-designer',
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the two ways a partition key stops pruning without anyone touching it',
      md: `**One: the predicate stops being expressible on the partition value.** Partition pruning needs the engine to convert a predicate on a *column* into a predicate on a *partition value*. \`ts >= X\` against day partitions becomes \`ts_day >= day(X)\` and works. Wrap the column in a function the planner cannot invert — a timezone conversion, a cast, a string manipulation, a user-defined function — and the conversion is unavailable, so every partition stays in the list. Nothing was misconfigured, the query text changed. In Hive-style layouts the classic version is filtering on a \`date\` column while the directories are keyed on a separately-materialised \`dt\` string that nobody keeps consistent.

**Two: the key is right and the data is skewed.** \`tenant\` gives 64 partitions and the sizes are Zipf, so the largest is orders of magnitude bigger than the mean. Partition pruning still works exactly as designed — you drop 63 of 64 directories — and the one you kept is most of the table. The pruning *ratio* looks excellent and the bytes barely move. Report bytes, not ratios; and for anything partitioned, alert on max over mean, because the maximum is the runtime (C6, and Column Week's third incident).`,
    },
    {
      type: 'callout',
      variant: 'info',
      title: 'what the layout designer grades, and the one task with no layout answer',
      md: `The lab prices five query classes against one design — dashboard, tenant audit, region rollup, needle, analyst — and every number on the page is a count produced by the same model the Warehouse runs, against byte-identical queries.

Its five graded tasks are worth reading as a summary of this lesson: **name the class your design starves**, then **move the physical order until a different class is worst-served and name that one too** (starvation is a property of your design, not of the workload), then **starve the dashboard itself** — its best case is 17.9 MiB, so it has the furthest to fall — then **hit the dashboard target while keeping the starved class under its ceiling**, which exactly two of the 120 designs manage.

The fifth task is the architectural one: **name the class that no design in the space rescues.** The analyst's wide projections and weak predicates — one of them has no predicate at all — have no layout that helps, and the lab computes that fact rather than asserting it: it is the class whose *best case over the entire grid* is still the largest bill in the mix. That class needs a quota, which is C0.L5's subject and the scan desk's.

Note what the lab deliberately does *not* let you change: clustering itself is pinned. In production that dial belongs to whoever writes the table, and letting a reader "fix" a starved class with it would teach the wrong lesson. That knob is C2.L3's and forge lab 02's.`,
    },
    {
      type: 'isomorphism',
      title: 'the two decisions ≡ things you have already chosen once',
      pairs: [
        {
          os: 'a composite B-tree index',
          osLine:
            'An index on (a, b, c) serves predicates on a, on (a, b) and on (a, b, c). A predicate on c alone cannot use it — the leftmost-prefix rule, which every DBA learns once and never forgets.',
          llm: 'a compound sort key',
          llmLine:
            'The same rule, degraded into a gradient rather than a cliff: column k prunes in proportion to how many row groups its prefix still spans. 21.5 groups, then 3.6, then 0.15, then nothing.',
        },
        {
          os: 'a shard key',
          osLine:
            'Chosen for routing and for even distribution. Too coarse and one shard is hot; too fine and you drown in shards, connections and rebalancing metadata.',
          llm: 'a partition key',
          llmLine:
            'Chosen for list elimination and for file size. Too coarse and it prunes nothing; too fine and it is a small-file generator that outruns compaction — same curve, and both ends are reachable in one DDL statement.',
        },
        {
          os: 'a .gitignore versus a build cache',
          osLine:
            'One stops files from being considered at all; the other makes the files you do consider cheaper to process. Nobody confuses them, because they live in different tools.',
          llm: 'partition key versus sort key',
          llmLine:
            'Exactly the same division — eliminate candidates, then make survivors cheap — living in the same DDL statement, which is the entire reason the confusion exists.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Point lookups by user_id are slow on a 180M-row table with 4M distinct users. An engineer proposes partitioning by user_id "so each query touches one partition". What happens, and what is the alternative?',
          options: [
            'It works: one partition per user is the most selective layout available, and file count is a storage concern rather than a query concern',
            'It creates 4,000,000 partitions holding about 45 rows each, where the footer outweighs the data and planning enumerates millions of files — the alternative is to leave partitioning coarse (a bucket transform if the key must appear at all) and make user_id the LEADING sort column, accepting that the time-window queries get worse',
            'It works but only if compaction runs frequently enough to merge the small files back together',
            'It has no effect either way, since row-group statistics already prune on user_id',
          ],
          correct: [1],
          explanation:
            'Every row in a data file must share its partition value, so partition count is a hard floor on file count: 180M rows over 4M partitions is 45 rows per file, and planning cost scales with files rather than with data. Compaction cannot rescue it, because merging files across partitions is not allowed — the partitions are the thing generating them, so the backlog is structural rather than a throughput problem. If the key has to appear in the spec at all, a bucket transform maps it into a bounded number of partitions and answers equality only. The real fix is the sort key, and the honest part of the answer is the loser: making user_id lead means the time-window queries lose their clustering, which is a trade you state out loud rather than discover later.',
        },
        {
          q: 'A table is sorted by (ts, tenant_id, region, event_type) with second-resolution timestamps, 131,072-row groups, and 180M rows. A tenant-scoped audit query that filters only on tenant_id prunes nothing. Why?',
          options: [
            'Because tenant_id is the second column and second columns always prune half as well as the first',
            'Because ts is nearly unique, so rows sharing a ts prefix number about one — every row group therefore holds tenants from across the whole domain and every group\'s tenant_id range overlaps the predicate',
            'Because statistics are not collected for integer columns unless they are the leading sort column',
            'Because the audit query has no time filter, and predicates without a time filter cannot use row-group statistics',
          ],
          correct: [1],
          explanation:
            'The comparison that decides whether sort column k prunes is rows-per-prefix against rows-per-row-group. With second-resolution timestamps the rows sharing any given ts value number roughly one, so a 131,072-row group contains 131,072 different prefixes and the tenants inside it are effectively unordered — that group\'s tenant_id min and max span nearly the whole range, so nothing can be excluded. The position in the key is not the point; the cardinality of everything to its left is. Statistics are being collected and are perfectly accurate, which is precisely what makes this invisible: the metadata is correct and uninformative. The fix is either to lead with tenant_id and let the time-range queries pay, or to partition by tenant and sort by ts inside each partition — which is the standard resolution, and it works because the two mechanisms are independent.',
        },
        {
          q: 'You have to defend a layout in a review on Thursday. The dashboard is the loudest stakeholder and its best achievable bill is 17.9 MiB per pass. What is the defensible position?',
          options: [
            '"We minimised the dashboard, since it runs 64 times a day and is the highest-volume workload" — volume decides priority',
            '"We named the class this layout starves, priced it, and chose a design that keeps it under its ceiling — which costs the dashboard about 4.6× its best case. The analyst class is not a layout problem at all and gets a scan quota instead"',
            '"We used the vendor\'s recommended defaults for partition key and sort key, so the layout is not our decision to defend"',
            '"We added every filtered column to the sort key so all five classes are served"',
          ],
          correct: [1],
          explanation:
            'The room does not reward the smallest number for the loudest stakeholder; it rewards knowing what you gave up and being able to price it. Minimising the dashboard alone drives the needle class to 71.5 GiB — fourteen times the 5 GiB ceiling — so the design that passes gives up roughly 4.6× on the dashboard, and the ability to say that sentence with both figures in it is the deliverable. Adding every column to the sort key is the folklore answer and the arithmetic kills it: past the point where rows-per-prefix falls below one row group, the extra columns prune nothing while making the leading column\'s clustering more expensive to maintain. And separating the class that no layout can help — wide projections, weak or absent predicates — from the classes layout does serve is what turns an argument about fairness into a quota with a number on it.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: hidden partitioning, curves, and the paper that formalises the trade',
      md: `Read **Iceberg's partition spec and sort order sections** side by side — they are short, and seeing the two structures next to each other in one metadata document makes the distinction permanent in a way no paragraph does. Then read the **partition evolution** rules, because they answer the question this lesson provokes: what happens when the partition key you chose turns out to be wrong? (New spec, new manifests, old files keep their old spec, and scans derive the right filter for each — which is what "hidden partitioning" actually buys you.) **Delta Lake's** liquid clustering and **Hive-style** static partitioning are the two poles to compare it against: one hides the physical decision behind the logical predicate, the other exposes the directory layout in the query and makes every consumer's SQL depend on it.

For multi-column clustering, the standard answers are **Z-ordering** (Morton order) and **Hilbert curves**, and the honest framing is in the data-skipping literature rather than in vendor blogs: **Sun et al., "Fine-grained Partitioning for Aggressive Data Skipping" (SIGMOD 2014)** and the follow-on **"Skipping-oriented Partitioning for Columnar Layouts" (VLDB 2016)** treat layout selection as an optimisation problem over an actual query workload, which is the only way the question is well-posed. If you want the older lineage, **"Automated Data Layout Optimization"** and the AutoAdmin index-selection work make the same argument for indexes: layout follows workload, and a layout chosen without a query log is a guess with a schema.

On the small-file side, the arithmetic in C5 is the one that matters — creation rate against merge rate, with the commit interval as the only free variable — and **tablespace T0.L2** has the underlying random-versus-sequential cost model that makes per-file overhead a physical quantity rather than a rule of thumb. Do not re-derive either here.

Next: **C2.L3** on the metric that moves before the bill does — clustering depth, how to compute it from footers alone, and why it belongs on a dashboard next to cost.`,
    },
  ],
}

export default lesson
