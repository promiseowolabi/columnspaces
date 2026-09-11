import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c0.l5',
  slug: 'the-scan-budget',
  trackId: 'c0',
  index: 5,
  title: 'The Scan Budget',
  minutes: 17,
  hook: 'Finance will ask what next year costs. The answer is four numbers and one named assumption — and the assumption is the part that makes it credible.',
  exercise: 'desk+quiz',
  simId: 'warehouse',
  artifact: 'scan-budget',
  takeaway: {
    number: '4 terms + 1 caveat',
    claim:
      'A defensible scan budget is per-query bytes × frequency × growth, split into recurring and ad-hoc, with the weakest assumption named before anyone asks.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Everything so far has been physics. This lesson turns it into an artifact, because the physics is only useful if you can hand somebody a number and survive the follow-up questions.

The artifact is a **scan budget**. It is the first of the four things you finish this course holding, and it is the one that gets quoted in rooms you are not in. Four terms and one caveat:

\`\`\`
per-query bytes  =  projected column bytes per row
                 ×  rows surviving pruning
frequency        =  runs per day, per query class
growth           =  data growth × adoption growth, separately
────────────────────────────────────────────────────
daily bytes      =  Σ over query classes, split
                    recurring | ad-hoc
caveat           =  the assumption you are least sure of
\`\`\`

The split into **recurring** and **ad-hoc** is not presentational. A recurring workload is computable: you know the queries, the columns, the predicates and the schedule, so per-query bytes is arithmetic. An ad-hoc workload is not computable, and pretending otherwise is how budgets get missed. You *bound* it instead — a quota, a separate compute pool, a per-query guardrail — and you report it as a bound rather than an estimate.

An architect who brings one blended number gets asked which part is which, and does not have an answer. An architect who brings two numbers and a fence around the second one gets the sign-off.`,
    },
    {
      type: 'prose',
      md: `## Working one, end to end

Take the C0.L1 table: \`orders\`, 2 billion rows, 60 columns, ~400 B/row logical. Three query classes.

**Class 1 — the dashboard.** Projects \`order_ts\`, \`region\`, \`net_revenue\` (28 B/row), filters to a rolling 7 days (~1% of rows), runs on every refresh: 4 per hour, 16 hours a day = **64 runs/day**.

Per query, clustered on \`order_ts\`, at the 95% pruning the lab actually measured:

\`\`\`
2e9 rows × 28 B          = 56 GB   (projection only)
× 5% of row groups read  = 2.8 GB  (measured pruning, not assumed)
× 64 runs                = 179 GB/day
\`\`\`

**Class 2 — the weekly cohort job.** Projects 9 columns (~90 B/row), no useful time predicate, scans the whole table, runs 4 times a month ≈ **0.13 runs/day**:

\`\`\`
2e9 × 90 B = 180 GB per run × 0.13 = 23 GB/day
\`\`\`

**Class 3 — analysts.** Unpredictable projections, weak predicates. Not computable. From last quarter's query log, the p95 query reads ~40 GB and there are ~120 queries a day, but the distribution has a long tail. So this class gets a **bound, not an estimate**: a per-query quota of 200 GB and a daily pool ceiling of **1.5 TB/day**, sized from the observed p95 with headroom, and reported as a ceiling.

**Recurring: ~202 GB/day. Ad-hoc: bounded at 1.5 TB/day.** Two numbers, and the second is a fence rather than a forecast.

Then growth, as two separate terms, because they have different mechanisms and wildly different confidence:

- **Data growth** — the table grows ~40%/year, so recurring scan volume grows with it: ~283 GB/day in twelve months.
- **Adoption growth** — more dashboards, more analysts. This is the larger and less predictable term, and it is the one that actually breaks budgets. Say so.

And the caveat, stated first rather than extracted: **this budget assumes the table stays clustered on \`order_ts\`.** If an upstream loader stops writing in time order, the 95% pruning becomes 0% and Class 1 goes from 179 GB/day to about 3.6 TB/day — a 20× increase in the largest recurring line, from a change nobody in this room controls. Which is why the budget ships with a monitor on clustering depth and not just on spend.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '202 GB/day',
          label: 'recurring, computed',
          hint: 'Two query classes whose columns, predicates and schedules are known. This part is arithmetic, and it is defensible line by line.',
        },
        {
          value: '1.5 TB/day',
          label: 'ad-hoc, bounded',
          hint: 'Not an estimate — a quota. Unpredictable workloads get a fence, and the fence is the number you report.',
        },
        {
          value: '20×',
          label: 'what losing clustering costs the biggest line',
          hint: '179 GB/day becomes ~3.6 TB/day if pruning goes from 95% to 0%. The single largest risk in the budget, and it is upstream of you.',
        },
        {
          value: '2',
          label: 'growth terms, kept separate',
          hint: 'Data growth is predictable and smaller; adoption growth is larger and less predictable. One blended figure hides the dangerous one.',
        },
      ],
    },
    {
      type: 'diagram',
      caption: 'fig 1 — from a schema to a number somebody signs',
      height: 70,
      nodes: [
        { id: 'schema', x: 2, y: 2, w: 28, h: 9, label: 'schema + query log', sub: 'columns, predicates, schedules', color: '#A3E635' },
        { id: 'classes', x: 36, y: 2, w: 28, h: 9, label: 'split by class', sub: 'recurring vs ad-hoc', color: '#A3E635' },
        { id: 'rec', x: 2, y: 17, w: 28, h: 9, label: 'recurring: computed', sub: '202 GB/day', color: '#3EF2A4' },
        { id: 'adhoc', x: 36, y: 17, w: 28, h: 9, label: 'ad-hoc: bounded', sub: 'quota 1.5 TB/day', color: '#FBBF24' },
        { id: 'growth', x: 70, y: 17, w: 28, h: 9, label: 'two growth terms', sub: 'data · adoption', color: '#22D3EE' },
        { id: 'budget', x: 20, y: 33, w: 60, h: 9, label: 'the scan budget', sub: 'per class, per day, with growth', color: '#A78BFA' },
        { id: 'caveat', x: 20, y: 47, w: 60, h: 9, label: 'the named caveat', sub: 'assumes clustering holds — 20× if it does not', color: '#FB7185' },
        { id: 'monitor', x: 2, y: 60, w: 45, h: 8, label: 'so: monitor clustering depth', sub: 'the leading indicator', color: '#3EF2A4' },
        { id: 'room', x: 53, y: 60, w: 45, h: 8, label: 'and survive the CFO', sub: 'arithmetic, not adjectives', color: '#FBBF24' },
      ],
      edges: [
        { from: 'schema', to: 'classes' },
        { from: 'classes', to: 'rec' },
        { from: 'classes', to: 'adhoc' },
        { from: 'rec', to: 'budget' },
        { from: 'adhoc', to: 'budget' },
        { from: 'growth', to: 'budget' },
        { from: 'budget', to: 'caveat' },
        { from: 'caveat', to: 'monitor' },
        { from: 'caveat', to: 'room' },
      ],
      steps: [
        {
          caption:
            'Start from the schema and the query log rather than from a guess. Both exist already, and together they give you columns, predicates and frequencies — every input the arithmetic needs.',
          active: ['schema', 'classes'],
          edges: ['schema->classes'],
        },
        {
          caption:
            'Split by class before computing anything. Recurring queries are computable because their columns and predicates are fixed; ad-hoc queries are not, and the honest treatment is a quota rather than a forecast.',
          active: ['rec', 'adhoc'],
          edges: ['classes->rec', 'classes->adhoc'],
        },
        {
          caption:
            'Add growth as two separate terms. Data growth is the smaller and more predictable one; adoption growth is larger and vaguer, and blending them into one percentage hides the term that actually breaks the budget.',
          active: ['growth', 'budget'],
          edges: ['rec->budget', 'adhoc->budget', 'growth->budget'],
        },
        {
          caption:
            'Now state the assumption the whole number rests on: that the table stays clustered. If it stops, the largest recurring line multiplies by twenty, and the cause is upstream of the team presenting the budget.',
          active: ['caveat'],
          edges: ['budget->caveat'],
        },
        {
          caption:
            'Naming it produces two deliverables instead of one — a budget, and the monitor that protects it. That pairing is what turns an estimate into something a finance partner will sign, because you found the hole before they did.',
          active: ['monitor', 'room'],
          edges: ['caveat->monitor', 'caveat->room'],
        },
      ],
    },
    {
      type: 'exercise',
      simId: 'warehouse',
      machine: 'dashboard',
      title: 'The Warehouse: run the dashboard trace against your own layout',
      tasks: [
        'Run the dashboard trace on the reference layout and note bytesScanned, pruningRatio and filesTouched.',
        'Change the sort key so it no longer matches the trace predicate, re-run, and watch which metric collapses first.',
        'Take the row group size down by 10× and find the point where filesTouched and metadata work start costing you more than pruning saves.',
        'Switch to the adhoc trace without changing the layout, and explain in one sentence why pruning falls off a cliff.',
        'Return to a layout that ties or beats the reference on bytesScanned for the dashboard trace.',
      ],
      note: 'Every metric the Warehouse reports is a COUNT — bytes, row groups, files, bytes shuffled — never a clock. That is deliberate: a count means the same thing on your machine as on mine, so a run is replayable and can be diffed against the reference. The adhoc trace is the honest one: it is the workload no layout serves well, and the correct architectural response is a quota rather than a cleverer sort key.',
    },
    {
      type: 'desk',
      desk: 'scan-desk',
      brief:
        'You have the arithmetic and the measurements. Now produce the artifact: daily bytes scanned split by class, the pricing shape you are on, and a growth term with its mechanism named. The desk grades in bands, not against one right answer — and it fails you for omitting the growth term even if your point estimate is perfect.',
    },
    {
      type: 'prose',
      md: `## Why the pricing shape matters more than the price

You will notice this course never states a price. That is a rule, and the reason is not squeamishness: prices differ by provider, region, commitment and year, and a course that hardcodes them is misleading within two quarters. What *is* durable — and what actually changes an architecture — is the **shape**:

| shape | you are billed for | what it rewards | the failure mode |
|---|---|---|---|
| **consumption, per byte scanned** | bytes read by queries | layout work; every pruning improvement is immediately money | a single bad query is a bill, and nobody notices until invoicing |
| **consumption, per credit/second** | compute time × size | efficient execution and right-sized clusters | idle-but-running clusters; and layout gains show up only as shorter runtime |
| **instance / reserved** | provisioned capacity | high utilisation | you pay for the peak all month; efficiency gains produce no refund |
| **capacity / appliance** | the platform, up front | predictability, and no per-query anxiety | the ceiling is a wall — and you meet it on a Tuesday |

The reason to identify your shape before writing the budget is that **the shape decides which optimisation pays**. Under per-byte consumption, the layout work in C2 converts directly into money and a scan budget is literally a financial forecast. Under instance pricing, the same layout work converts into *headroom* — you postpone a purchase rather than reduce a bill — and the number finance cares about is utilisation, not bytes.

Bring the wrong metric to the room and you will be technically right and commercially irrelevant. This is also why the TCO desk asks for a shape rather than a total, and why the vendor room's toughest objection is about your walk-away position rather than your throughput.`,
    },
    {
      type: 'callout',
      variant: 'analogy',
      title: 'the caveat-first habit',
      md: `The most valuable professional move in this entire course costs one sentence: **name the weakness of your own analysis before the room finds it.**

"This assumes the table stays clustered on \`order_ts\`; if an upstream loader stops writing in time order, the dashboard line multiplies by twenty, so I have added a monitor on clustering depth."

Say that and three things happen. The room stops hunting, because you have already handed them the thing they were digging for. Your remaining numbers gain credibility, because you have demonstrated you know where the soft ground is. And the mitigation gets funded, because you attached it to a quantified risk instead of asking for it separately.

Withhold it and someone finds it anyway — later, with an invoice in their hand, and the conversation is no longer about the layout.`,
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Finance asks what analytics will cost next year. Which answer survives the room?',
          options: [
            '"It scales with usage, so cost tracks the value we deliver."',
            '"Recurring workload: 202 GB/day, computed per query class from columns and predicates. Ad-hoc: bounded by quota at 1.5 TB/day rather than forecast. Two growth terms — data at ~40%/year and adoption, which is larger and less predictable. The whole number assumes the table stays clustered; if it does not, the biggest line multiplies by 20, so there is a monitor on clustering depth."',
            '"About double this year, based on the trend."',
            '"Hard to say until we observe a quarter of real usage."',
          ],
          correct: [1],
          explanation:
            'It separates computable from uncomputable, fences the uncomputable part instead of guessing, splits growth by mechanism, and names its own weakest assumption with the mitigation attached. The first answer describes losing control of a line item and presents it as a benefit; the third is a number with no mechanism; the fourth asks for an open-ended commitment.',
        },
        {
          q: 'You are on instance-based pricing rather than per-byte consumption. You cut bytes scanned by 60%. What have you actually gained?',
          options: [
            'A 60% cost reduction, since bytes scanned drives cost',
            'Headroom, not a refund: you have deferred the next capacity purchase and improved utilisation and concurrency, and the metric to report is utilisation rather than bytes',
            'Nothing at all — layout work is irrelevant under instance pricing',
            'A 60% reduction in storage cost',
          ],
          correct: [1],
          explanation:
            'Under provisioned pricing you pay for the peak regardless, so efficiency shows up as capacity you did not have to buy and as more concurrent work on the same hardware. The optimisation is still worth doing; the reporting metric changes. Bringing "bytes scanned, down 60%" to a finance meeting under this shape is technically right and commercially meaningless — and storage cost is a separate line item that layout work does not touch.',
        },
        {
          q: 'Your scan budget models an ad-hoc analyst workload as "roughly 40 GB per query × 120 queries/day". What is wrong with it?',
          options: [
            'Nothing — that is the correct way to model an unpredictable workload',
            'It uses a point estimate for a long-tailed, uncontrolled distribution: the mean is not the risk, the tail is, so this class needs a per-query quota and a pool ceiling reported as a bound rather than a forecast',
            'The number is too low and should be doubled for safety',
            'It should use the median rather than the mean',
          ],
          correct: [1],
          explanation:
            'Ad-hoc query volume has no schedule and a long tail; one unpredicated scan can exceed the modelled daily total on its own. Multiplying a central estimate by a count produces a number that is wrong in an unbounded direction. The engineering answer is a fence — quotas and a separate pool — and the reporting answer is to present the ceiling. Doubling for safety is still a forecast, just a vaguer one.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: budgets, quotas and the caveat habit',
      md: `The practitioner literature on this is mostly vendor documentation, and it is worth reading precisely *as* documentation: every major platform's guidance on controlling analytics spend describes the same three levers — reduce bytes scanned, cap concurrency, and separate workloads into pools — because those are the only levers the physics offers. Read your own platform's cost-control page and notice that every recommendation maps onto one of C0's three factors.

On bounding rather than forecasting uncontrolled demand, the transferable material is not from databases at all: **the SRE literature on error budgets and admission control** (Google's SRE book chapters on load shedding and graceful degradation) is the right shape. An ad-hoc analytics pool is an admission-control problem wearing a finance costume.

For the estimation discipline itself — separating what is computable from what must be bounded, and stating uncertainty explicitly — **Douglas Hubbard's *How to Measure Anything*** is the standard reference on giving decision-makers calibrated ranges rather than false points.

Sibling course: **vectorspace** is built entirely around this half of the job — defending numbers to a CFO, a principal engineer and a vendor — for a different subject. If C0.L5 was the most useful lesson in this track for you, that course is the one to read next, and A1 assumes the habit it teaches.

Next: **C1** takes the first of the three factors apart. You have been treating "bytes per row" as a property of the schema; it is mostly a property of the encoding, and you are about to write four of them.`,
    },
  ],
}

export default lesson
