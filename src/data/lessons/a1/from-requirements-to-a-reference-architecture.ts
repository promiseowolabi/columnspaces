import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'a1.l1',
  slug: 'from-requirements-to-a-reference-architecture',
  trackId: 'a1',
  index: 1,
  title: 'From Requirements to a Reference Architecture',
  minutes: 16,
  hook: 'A requirement document has forty statements in it and four of them decide the architecture. This is which four, what number to extract from each, and the one sentence that turns a diagram into a design.',
  exercise: 'quiz',
  takeaway: {
    number: '4 questions, 1 named loser',
    claim:
      'Query mix, freshness, tenants and pricing shape determine the design; everything else is detail — and a design with no named loser is a design with an unexamined one.',
  },
  blocks: [
    {
      type: 'prose',
      md: `**Four questions.** You will be handed a requirements document with forty statements in it, and thirty-six of them are constraints on the detail. Four of them determine the architecture, which means four of them are worth extracting a number from before you draw anything:

1. **What is the query mix?** Per class: what fraction of the table's bytes does it project, how selective is its predicate, how often does it run, and is it recurring or ad-hoc.
2. **What is the freshness requirement?** In seconds, at p99, with the name of the person harmed at p99 plus one.
3. **Who are the tenants?** How many, how uneven, and what boundary has to hold between them.
4. **What is the pricing shape?** Not the price — the shape, because the shape decides which count is the bill and therefore which optimisation pays.

Then the deliverable that is not a question and is the reason the document gets signed: **name the loser.** Every physical layout privileges some access patterns and starves others, because a table has exactly one physical order. Every tenancy model buys isolation at a stated cost in metadata or capacity. Every freshness figure is bought with file count. **A design with no named loser is a design with an unexamined one** — and \`the-principal\`'s \`no_worst_query\` objection fires on exactly that omission, on the grounds that if the answer is "none", the honest reading is not that the design is good but that nobody looked.

The rest of this lesson is the four questions, the number each one yields, and where that number is graded. It is short on purpose. You will be interrupted.`,
    },
    {
      type: 'prose',
      md: `## Question 1 — the query mix, per class, never averaged

The mix is not "analytical queries". It is a list of classes, and each class needs four numbers: **projected fraction** of table bytes, **selectivity**, **runs per day**, and **recurring or ad-hoc**.

Why per class and never averaged: the average is exactly what hides the class that prunes nothing. Take \`scan-desk\`'s worked input, which is the arithmetic the desk actually grades:

\`\`\`text
class        table    projected  pruned   per query     runs/day   per day
dashboards   40 TB    9%         95%      180 GB        996        179.3 TB
pipelines    40 TB    2%         97%      24 GB         96         2.3 TB
analysts     40 TB    25%        60%      quota 200 GB  ~120       CEILING 1.5 TB
                                                        ─────────────────────
                                          recurring 181.6 TB + ad-hoc bound 1.5 TB
\`\`\`

Three things fall out of that table that no amount of diagramming would have given you. **The dashboard class is 98% of the recurring bill**, so the layout is designed for the dashboard predicate or the design is not about money. **The analyst class is not computable** — it has no schedule and a long tail — so it gets a quota and a pool ceiling and is reported as a bound rather than a forecast. And **the mix ratios are an input, not an observation**: flip the shares so ad-hoc dominates and the correct architecture changes from "sort hard on the dashboard predicate" to "fence the ad-hoc pool and stop optimising a layout for queries nobody can predict".

The number to write down: **bytes per query, per class, and the class that is the largest line.** \`the-cfo\`'s \`daily_scan_unbudgeted\` is a severity-3 objection that fires whenever daily scanned bytes is simply absent from the document, and it is not survivable by describing the workload.`,
    },
    {
      type: 'prose',
      md: `## Question 2 — freshness, in seconds, at p99

Freshness is the one legitimate clock in this course, because it is a requirement rather than a cost. Everything it buys is a count.

\`\`\`text
p99 staleness  =  batch interval + commit time
                  (+ conversion lag, if the write buffer is not on the read path)
files/day      =  commits/day × partitions written per commit × writers
\`\`\`

At a 15-minute interval, six partitions per commit and two writers that is 96 × 6 × 2 = **1,152 files a day**. Halve the interval to meet a tighter number and you get **2,304 files a day at exactly the same byte volume**, each one half the size, and the file count is what the planner enumerates and what compaction must merge. That is the whole trade, and it is available to you as a curve rather than a yes or a no.

Two habits here. First, **ask what decision the data drives**, because "real-time" in a requirements document usually means "the number on the morning call was wrong yesterday" and the real requirement is 15 minutes with an alert. Second, **quote p99 and never the mean** — mean staleness is interval ÷ 2 plus commit, so quoting it halves the number you are actually promising, and \`the-consumer\`'s \`freshness_gap\` objection fires precisely when your own stated p99 exceeds the SLA you were given. Surviving it requires bringing the curve: *my number comes down if you spend file count, here is the slope, you choose the point.*

## Question 3 — who the tenants are, and how uneven

Not the count. The **shape**. Tenant sizes are Zipf-distributed, so a per-tenant average is a fiction, and \`tenancy-desk\`'s worked population makes it concrete: 400 tenants over 180 TiB, where the mean tenant is 460.80 GiB, the median is 163.77 GiB, the largest is **17.99 TiB** and the top 1% of tenants hold 27.7% of all bytes. The head is **39.98× the mean** and 112× the median.

Design consequences, both ends: the **largest** tenant sets your capacity ceiling and your noisy-neighbour blast radius, and the **smallest** sets your per-query metadata overhead, because a tiny tenant still opens whole file footers to plan a query. A model built on the average is wrong at both ends simultaneously, in the direction that looks fine in a spreadsheet.

## Question 4 — the pricing shape, which is not the price

Never a price; a **shape**, and \`scan-desk\` grades it as a named string because the same byte count means different things under each:

| shape | the billed count | what an optimisation buys you | how it fails |
|---|---|---|---|
| per-byte-scanned | bytes scanned | money, immediately | one unpredicated query is a bill nobody sees until invoicing |
| provisioned-compute | concurrent slots held | headroom, not a refund | you pay for the peak all month |
| per-node-hour | nodes provisioned | deferred purchase | idle-but-running capacity |
| credits-per-warehouse-second | warehouse-seconds of a sized warehouse | shorter runs at the same size | layout gains show up only as runtime |

This is the question most often missing from the document, and it is the one that decides whether your work is a cost saving or a capacity plan. Under per-byte-scanned, 183 TB/day *is* the line item and the layout work in C2 converts directly into money. Under provisioned compute, bytes are merely the reason you run out of slots, and the number finance thinks in is utilisation. Bring the wrong metric and you will be technically right and commercially irrelevant.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '4',
          label: 'requirements that determine the architecture',
          hint: 'Query mix, freshness, tenants, pricing shape. Everything else in the document constrains the detail rather than the design.',
        },
        {
          value: '98%',
          label: 'of the recurring scan bill in one query class',
          hint: 'From scan-desk\'s worked input: dashboards at 179.3 TB/day against pipelines at 2.3 TB/day. Which is why the layout is designed for one predicate, and why you say so.',
        },
        {
          value: '39.98×',
          label: 'largest tenant ÷ mean tenant',
          hint: 'tenancy-desk\'s worked population: 400 tenants, 180 TiB, head at 17.99 TiB against a 460.80 GiB mean. The average tenant does not exist.',
        },
        {
          value: '2×',
          label: 'files per day for every halving of the batch interval',
          hint: 'Same bytes, twice the files, each half the size. Freshness is bought with file count, and the file count is what the planner pays for.',
        },
      ],
    },
    {
      type: 'diagram',
      caption: 'fig 1 — four answers in, one design and one named loser out',
      height: 72,
      nodes: [
        { id: 'q1', x: 1, y: 2, w: 23, h: 9, label: '1 · query mix', sub: 'per class: projected, selectivity, runs/day', color: '#FBBF24' },
        { id: 'q2', x: 26, y: 2, w: 23, h: 9, label: '2 · freshness', sub: 'seconds, p99, not the mean', color: '#FBBF24' },
        { id: 'q3', x: 51, y: 2, w: 23, h: 9, label: '3 · tenants', sub: 'how many, how uneven, what boundary', color: '#FBBF24' },
        { id: 'q4', x: 76, y: 2, w: 23, h: 9, label: '4 · pricing shape', sub: 'which count is the bill', color: '#FBBF24' },
        { id: 'phys', x: 1, y: 16, w: 48, h: 9, label: 'physical design', sub: 'partition key · sort key · row-group size · ingest interval', color: '#22D3EE' },
        { id: 'org', x: 51, y: 16, w: 48, h: 9, label: 'organisational design', sub: 'isolation boundary · attribution · quotas · pools', color: '#22D3EE' },
        { id: 'design', x: 15, y: 30, w: 70, h: 9, label: 'the reference architecture', sub: 'one page, every number redoable', color: '#A78BFA' },
        { id: 'loser', x: 15, y: 44, w: 70, h: 9, label: 'the named loser', sub: 'the class this design starves, its number, and your response', color: '#FB7185' },
        { id: 'mon', x: 1, y: 58, w: 48, h: 9, label: 'so: a monitor per promise', sub: 'clustering depth · staleness p99 · files created vs merged', color: '#3EF2A4' },
        { id: 'room', x: 51, y: 58, w: 48, h: 9, label: 'and a room you survive', sub: 'no_worst_query and freshness_gap stop firing', color: '#A3E635' },
      ],
      edges: [
        { from: 'q1', to: 'phys' },
        { from: 'q2', to: 'phys' },
        { from: 'q3', to: 'org' },
        { from: 'q4', to: 'org' },
        { from: 'phys', to: 'design' },
        { from: 'org', to: 'design' },
        { from: 'design', to: 'loser' },
        { from: 'loser', to: 'mon' },
        { from: 'loser', to: 'room' },
      ],
      steps: [
        {
          caption:
            'Start by extracting four numbers rather than by drawing boxes. Each of the four questions yields a figure you can defend, and a requirements document that cannot answer one of them has told you what to go and ask for first.',
          active: ['q1', 'q2', 'q3', 'q4'],
        },
        {
          caption:
            'The first two answers land on physical design: the query mix picks the sort key and the row-group size, and the freshness number picks the commit interval and therefore the file count you will have to merge forever.',
          active: ['phys'],
          edges: ['q1->phys', 'q2->phys'],
        },
        {
          caption:
            'The second two land somewhere people forget is architecture at all: tenant shape picks the isolation boundary and the catalog object count, and the pricing shape picks which count you are actually optimising against.',
          active: ['org'],
          edges: ['q3->org', 'q4->org'],
        },
        {
          caption:
            'Only now is there a design, and it fits on one page because every number in it is arithmetic somebody in the room can redo rather than a conclusion they have to accept from you.',
          active: ['design'],
          edges: ['phys->design', 'org->design'],
        },
        {
          caption:
            'Then the sentence that makes it a design instead of a diagram: which query class this layout starves, what ratio that class actually gets, and whether your response is a second table, a secondary index, or nothing deliberately.',
          active: ['loser'],
          edges: ['design->loser'],
        },
        {
          caption:
            'Naming the loser produces two deliverables instead of one — the design, and a monitor on every assumption the design rests on. That pairing is the difference between surviving a review and presenting at one.',
          active: ['mon', 'room'],
          edges: ['loser->mon', 'loser->room'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the requirement that is never in the document',
      md: `Three of the four questions are usually answerable from the document and one almost never is: **the pricing shape.** Nobody writes it down, because it is procurement's field rather than engineering's, and because everyone assumes it does not change the design.

It changes the design more than the query mix does. Consider one decision — whether to spend two engineer-months sorting a table harder to take pruning from 95% to 99%.

- **Per-byte-scanned.** The dashboard class goes from 180 GB per query to 36 GB, and 179.3 TB/day becomes 35.9 TB/day. A 5× cut in the largest line item on the invoice, visible next month, attributable to your name.
- **Provisioned compute.** The same 5× buys you concurrency and defers a capacity purchase. Real, worth doing, and *invisible on the metric finance watches* unless you report it as utilisation and deferred spend.
- **Appliance or capacity.** The same 5× buys you time before you meet the ceiling, and the ceiling is a wall you hit on a Tuesday rather than a curve you watch.

Same work, three different business cases, one of which is a cost saving and two of which are risk reductions. If you cannot name the shape, go and find out before you write the design, because you are about to choose which optimisation to fund without knowing what any of them pay.`,
    },
    {
      type: 'prose',
      md: `## Where each answer gets graded, and what attacks it if you skip it

The four questions are not a framework someone invented for a slide. They are the four inputs the machinery in this half of the course actually consumes:

| question | the number to write down | graded by | attacked by |
|---|---|---|---|
| query mix | bytes per query per class; the largest line | \`scan-desk\` \`per_query\`, \`layout-desk\` \`prunes_target\` | \`the-cfo\` \`daily_scan_unbudgeted\` (severity 3) |
| freshness | p99 staleness in seconds; files/day it implies | \`ingest-desk\` \`freshness_sla\` | \`the-consumer\` \`freshness_gap\` (severity 3) |
| tenants | largest-tenant bytes; catalog objects; the boundary | \`tenancy-desk\` \`worst_tenant\`, \`isolation\` | — |
| pricing shape | the shape, by name | \`scan-desk\` \`shape_stated\` | — |
| **the named loser** | the starved class, its ratio, your response | \`layout-desk\` \`worst_query_stated\` | \`the-principal\` \`no_worst_query\` |

Two of those rows have a dash in the last column, and it is worth being precise about why rather than implying a threat that does not exist: **no room objection in this course fires on tenancy or on the pricing shape.** The desks grade them; the adversaries do not ask. Which tells you something about real reviews — the questions that get asked are the ones with a visible victim, and the tenancy and pricing decisions are the two that quietly set the ceiling for everyone before anybody notices there was a decision.

### The habit: name the tradeoff out loud, in the same breath as the number

The reason to state the loser yourself is not modesty. It is that **stating it converts a weakness into a decision.** Compare:

> "We sort on \`tenant_id, order_ts\`, which gives the dashboard class 99.98% pruning."

> "We sort on \`tenant_id, order_ts\`, which gives the dashboard class 99.98% pruning — 98% of the recurring bill. The rollup class prunes 98.0% but over the whole candidate set, so it reads 2.82 GiB against the dashboard's 36 MiB and it is the most expensive query on the platform. We are accepting that: it runs 96 times a day, not a thousand, and a second physical copy sorted for it would cost more in storage and compaction than the reads are worth. If its frequency doubles, that decision reverses, and the trigger is in the runbook."

The second is the same design. It survives, and the first does not, for three mechanical reasons. It hands over the hole before anyone digs for it, so the digging stops. It attaches a **reversal condition**, which is what makes it a decision rather than an excuse. And it demonstrates that you ranked classes by bytes read rather than by ratio — which is what \`layout-desk\` grades, and the mistake it specifically catches is naming the class with the *worst ratio* instead of the class that reads the *most bytes*.`,
    },
    {
      type: 'callout',
      variant: 'analogy',
      title: 'the ninety-second version, for when you are interrupted at minute two',
      md: `You will not get to slide six. So lead with the four answers and the loser, in this order:

> "Query mix: three classes, dashboards are 98% of the recurring scan volume at 180 GB a query and a thousand runs a day, analysts are unpredictable so they get a quota rather than a forecast. Freshness: 15 minutes p99, which is interval plus commit, and the cost of halving it is double the files at the same bytes. Tenants: 400, Zipf, the largest is 40× the mean and it sets capacity — the average tenant does not exist. Pricing shape: per-byte-scanned, so bytes are the bill and layout work is money rather than headroom.
>
> The design that follows is one physical order, chosen for the dashboard predicate. What it starves is the rollup class, which reads 2.82 GiB a query against the dashboard's 36 MiB; we are accepting that at 96 runs a day, and the reversal trigger is in the runbook. Every number there is arithmetic you can redo, and the one assumption underneath all of it is that the loader keeps writing in key order — which is why clustering depth is on a dashboard rather than in a comment."

Four numbers, one loser, one monitored assumption. If you are cut off after that, the design has already been reviewed.`,
    },
    {
      type: 'isomorphism',
      title: 'a reference architecture ≡ documents you already know how to defend',
      pairs: [
        {
          os: 'an architecture decision record',
          osLine:
            'The valuable field is not the decision. It is "consequences" — what this choice makes harder — because that is the field a future engineer reads before reversing it.',
          llm: 'the named loser',
          llmLine:
            'Identical function, with a number attached: the rollup class reads 2.82 GiB against the dashboard\'s 36 MiB, we accept it at 96 runs a day, and this is the frequency at which we would not.',
        },
        {
          os: 'a load-bearing wall on a floor plan',
          osLine:
            'Cheap to identify before the build and ruinous to discover during it. Nobody asks the architect about it, and every subsequent decision is constrained by it.',
          llm: 'the pricing shape',
          llmLine:
            'Never in the requirements document, changes which optimisation pays, and it is the one input that turns the same 5× pruning improvement into a cost saving, a capacity deferral or a deadline.',
        },
        {
          os: 'a service level objective with an error budget',
          osLine:
            'A stated allowance plus an agreed measurement, so that spending it is a visible event rather than a slow drift somebody notices in a quarterly review.',
          llm: 'the freshness number at p99',
          llmLine:
            'Interval plus commit, quoted at p99 because the mean halves the promise, and paid for in files per day — which makes a request for tighter freshness a priced choice rather than an argument.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A requirements document says: "the platform must support real-time analytics, ad-hoc exploration by our analyst team, and per-customer reporting for 400 customers." You have one hour with the sponsor. Which four numbers do you leave with?',
          options: [
            'Expected concurrent users, total data volume, retention period, and the preferred cloud provider',
            'Bytes per query per class with the mix shares, p99 staleness in seconds, the tenant size distribution at both ends, and the pricing shape by name',
            'The list of dashboards to migrate, the SQL dialect in use, the required uptime percentage, and the integration points',
            'Peak queries per second, the number of tables, the p95 latency target, and the compliance regime',
          ],
          correct: [1],
          explanation:
            'Each of the four determines a different part of the design and nothing else in the document does: the mix picks the physical order, the freshness figure picks the commit interval and therefore the file count, the tenant distribution picks the isolation boundary and sets capacity from the head rather than the mean, and the shape decides which count is the bill. The other options are all real questions that constrain detail — dialect, provider, uptime, table count — but you can answer every one of them and still not know whether to sort on the tenant column or the timestamp. Note that "real-time" and "400 customers" are not answers: they are the two places where the numbers you need have been left out.',
        },
        {
          q: 'You are on provisioned-compute pricing. Your layout work cuts bytes scanned by 80% on the dashboard class, which is 98% of the recurring volume. What do you take to the budget holder?',
          options: [
            'An 80% reduction in the analytics line item, since bytes scanned drives cost',
            'Deferred capacity and improved concurrency: the same slot pool now serves more queries, so the number to report is utilisation and the purchase you no longer need this year — with the caveat that the saving is a deferral rather than a refund',
            'Nothing yet — under provisioned pricing, layout work has no commercial effect and should be justified on latency instead',
            'A request to move to per-byte-scanned pricing, so that the efficiency gain becomes visible as a cost reduction',
          ],
          correct: [1],
          explanation:
            'Under a provisioned shape you pay for the peak whether you use it or not, so efficiency shows up as capacity you did not have to buy and as more concurrent work on the same hardware — real money, on a different line, in a different quarter. Reporting an 80% cut in bytes to a budget holder on this shape is the specific failure of being technically right and commercially irrelevant, and it damages you the next time you bring a number. The third option is wrong because the gain is real and quantifiable, just not as a refund. The fourth mistakes the shape for a variable you control: shape is usually a procurement fact, and reshaping a contract to make your metric look better is a much larger conversation than the optimisation that prompted it.',
        },
        {
          q: 'A design review presents a layout with a 99.9% pruning promise and says "the design covers all known query patterns, so there is no significant loser." What is the strongest reading of that sentence?',
          options: [
            'The design is well matched to the workload and the promise is the number to carry forward',
            'A table has exactly one physical order, so a loser exists whether or not it is named; the absence of a named loser means the classes were never ranked by bytes read, and the promise is therefore unranked as well',
            'The promise is too high and should be reduced to a safer figure such as 95% before it goes in the document',
            'The reviewer should ask for a secondary index on the other predicates, which removes the tradeoff',
          ],
          correct: [1],
          explanation:
            'Physical order is singular, so the tradeoff is structural rather than a sign of poor work: the design necessarily privileges some predicates. An unnamed loser therefore indicates a missing analysis rather than an absent cost, which is exactly why the-principal treats it as an objection and rebuts it with "a design with no loser is a design with an unexamined one". Arbitrarily lowering the promise to 95% is worse than the original error, because a ratio that is not derived from selectivity and candidate-set size is not defensible in either direction. And reaching for a secondary index answers a question nobody has checked: bloom filters serve equality on high-cardinality columns and do nothing for ranges, so naming a mechanism before matching it to the predicate shape is how a design acquires a component that helps nothing.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: requirements that are actually design inputs',
      md: `The four questions are not original and they are not arbitrary. They are the four inputs that appear in every serious treatment of analytical system design, usually without being named as a set.

**On query mix as the primary input.** Read the original **star schema and dimensional modelling literature** (Kimball) against a modern columnar platform and notice what survives: the insistence that you enumerate the queries *before* the schema. What does not survive is the physical advice, because it was written for row stores where the index was the tuning surface. The transferable part is the discipline of a query inventory with frequencies — the thing everybody skips and then reconstructs from a query log a year later.

**On freshness as a purchased quantity rather than a requirement.** The **stream-processing literature's treatment of the latency/throughput/cost triangle** is the right frame, and the specific paper worth reading is anything careful about watermarks: the moment you can state "p99 staleness = interval + commit", the conversation stops being about whether the platform is fast and starts being about which point on a curve the business will pay for. → \`ingest-desk\` grades exactly that arithmetic, and C5.L4 derives it.

**On tenant skew.** The Zipf assumption is not a modelling convenience; it is what real tenant populations do, and the same shape governs partition sizes and join-key frequencies. If you want the theory, the general result is in the **heavy-tailed distributions** literature; if you want the operational version, read any multi-tenant SaaS capacity post-mortem, where the finding is invariably that the plan was built on a mean.

**On pricing shape as an architectural input.** There is no academic literature here, which is itself informative. The material is your own provider's cost-control documentation, read as documentation rather than as advice: every platform's guidance reduces to the same three levers — fewer bytes, bounded concurrency, separated pools — because those are the only levers the physics offers.

**Sibling courses.** → \`vectorspace\` is built entirely around this half of the job for a different subject, and if the defend-a-number register here is new to you, that course teaches it at length. → \`tablespace T0.L2\` has the random-versus-sequential cost model that underlies every file-count argument in A1, and → \`tablespace T7.L1\` gives the NSM/DSM comparison from the row store's side.

Next: **A1.L2** turns question 1 into a document. Six fields, four graded checks, and one of the four has no tolerance band at all — because a layout is allowed to change your bill and never your answer.`,
    },
  ],
}

export default lesson
