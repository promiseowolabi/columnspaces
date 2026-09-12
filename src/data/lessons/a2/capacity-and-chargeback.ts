import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'a2.l5',
  slug: 'capacity-and-chargeback',
  trackId: 'a2',
  index: 5,
  title: 'Capacity and Chargeback',
  minutes: 20,
  hook: 'Five things saturate and capacity plans are written against one of them. On this platform storage sits at 57% of its ceiling at the horizon and the catalog binds in month 20 — and if you cannot say which tenant caused which share, you cannot govern any of it.',
  exercise: 'desk+quiz',
  takeaway: {
    number: 'month 20, the catalog',
    claim:
      'The first ceiling this platform meets is manifest entries in month 20 — 1.55M against a 1.2M budget, of which 280,500 come from a merge deficit that has nothing to do with how much data we hold — while storage is still at 57% of its own ceiling.',
  },
  blocks: [
    {
      type: 'prose',
      md: `A capacity plan has exactly one deliverable, and it is not a size. It is **a date and a named component**: which limit binds first, and roughly when. Everything else in the document exists to justify those two facts.

The reason plans get this wrong is structural. **Five things saturate, they have five different units, and they are driven by different knobs:**

| component | unit | driven by |
|---|---|---|
| storage | bytes | data growth × retention multiplier |
| compute | instance-hours per wall-hour at peak | **query** growth, not data growth |
| catalog | manifest entries | commit rate, partitions, writers — and the merge deficit |
| network | bytes moved per day | query growth **×** data growth, compounding together |
| ingest | bytes landed per day | data growth |

A plan written in bytes can only see the first row. And bytes are what finance asks about, which is why the plan gets written that way and why the surprise arrives from a different row entirely.

So the sentence to carry into the review: **storage grows with data and metadata grows with file count, and those are different curves.** Halving the commit interval doubles the file count at constant data (A2.L1, C5.L4). That is why the first ceiling on most platforms of this shape is the catalog, and why sizing the disk buys nothing at all.`,
    },
    {
      type: 'prose',
      md: `## Twenty-four months, five curves, arithmetic you can redo

The platform today: **40 TB live**, growing **6%/month**. A **1.4×** retention multiplier for snapshots and orphans (C3 measures about that for a seven-day window). **288 commits/day** across **6 partitions** with **3 writers**. **128 MB** target files. Compaction merges **4,800 files/day**. Peak **900 queries/hour** growing **4%/month**, at **0.02 instance-hours** each, scanning **20 GB** each. **800 GB/day** landing.

**Storage.**

\`\`\`text
1.06^24 = 4.049
live at month 24  =  40 TB × 4.049          =  162 TB
provisioned       =  162 TB × 1.4           =  227 TB
against a 400 TB ceiling                    =  57%   — never binds
\`\`\`

Note that the retention multiplier is not decoration: a plan quoting live bytes as its storage requirement is short by everything it is still pinning.

**Compute.** Grown at the *query* rate, not the data rate — this is the most common cross-contamination in these plans:

\`\`\`text
1.04^24 = 2.563
now:      900 q/h × 0.02              =  18 instance-hours per wall-hour
month 24: 900 × 2.563 × 0.02          =  46.1
against a ceiling of 60               =  77%   — never binds
\`\`\`

**Catalog.** Two terms, and the second one is the point of this lesson:

\`\`\`text
files created/day = 288 commits × 6 partitions × 3 writers   =  5,184
merge deficit     = 5,184 − 4,800                            =    384/day

steady entries at month 24 = 162 TB ÷ 128 MB      =  1,265,000
deficit accumulation       = 384 × 30.437 × 24    =    280,500
total                                             =  1,545,000
against a 1,200,000-entry budget                  =  129%  — BINDS
\`\`\`

Solve for when: entries reach 1.2M between month 19 (1,167,568) and month 20 (1,235,987). **The catalog binds in month 20**, so headroom is **20 months**, and the component nobody sized is the one that sets the date.

**Network.** The only curve where both growth terms multiply:

\`\`\`text
now:      900 q/h × 24 h × 20 GB               =  432 TB/day
month 24: 432 × 2.563 × 4.049                  =  4,484 TB/day
against a 6,000 TB/day ceiling                 =  75%   — never binds
\`\`\`

**Ingest.** 800 GB/day × 4.049 = **3.24 TB/day** against 8 TB/day = **40%**.

**The ledger, which is the artifact:** storage 57%, compute 77%, catalog **129% (binds month 20)**, network 75%, ingest 40%.

And the two things that ledger tells you which no single number could. First, **the comfortable four do not lend capacity to the one that binds** — there is no averaging across components, so a plan reporting "we are at 70% overall" has hidden the only fact that mattered. Second, **the binding curve has a cheaper fix than a purchase**: 280,500 of those entries are a merge deficit, so raising compaction throughput from 4,800 to 5,200 files/day deletes that whole term and moves the date out by months. A capacity plan whose only lever is buying is a plan that has not been read carefully.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: 'month 20',
          label: 'when the catalog binds, and nothing else does inside the horizon',
          hint: 'Manifest entries pass 1.2M between month 19 and month 20. Storage is at 57% of its ceiling at month 24, so a plan written in bytes reports a comfortable platform.',
        },
        {
          value: '280,500',
          label: 'manifest entries from the merge deficit alone',
          hint: '384 files/day of creation over merge, for 24 months. A deficit does not saturate, it accumulates — and this term is completely independent of how much data you hold.',
        },
        {
          value: '227 TB',
          label: 'storage to provision at month 24, not 162 TB',
          hint: 'Live bytes compounded at 6%/month is 162 TB; the 1.4× retention multiplier for snapshots and orphans is the part plans omit, and it is 65 TB.',
        },
        {
          value: '38%',
          label: 'of daily bytes scanned attributable to one tenant of 40',
          hint: 'Tenant sizes are Zipf-distributed, so the mean is fiction: the largest tenant sets your capacity ceiling and the smallest ones set your per-query metadata overhead. Model both ends.',
        },
      ],
    },
    {
      type: 'desk',
      desk: 'capacity-desk',
      brief:
        'Submit the plan for that platform and defend all five checks. storage_plan — bytes provisioned at the horizon with the retention multiplier applied: 40 TB compounded at 6%/month is 162 TB live, and 227 TB is what you buy; quoting live bytes fails because it is short by the snapshots you are still pinning. concurrency — instance-hours per wall-hour at peak, grown at the QUERY rate rather than the data rate: 900 × 1.04^24 × 0.02 = 46.1 against a ceiling of 60. Note it is a count, not a clock. metadata_scale — entries as steady-state bytes ÷ target file size PLUS the accumulated creation-versus-merge deficit: 1,265,000 + 280,500 = about 1.55M, where files created per day is commits × partitions × writers = 5,184 against 4,800 merged. first_limit — the whole deliverable, graded against the computed curves rather than a memorised answer: name the catalog, and be able to show the ledger that rules the other four out, because sizing a component that is not binding buys nothing. headroom — months before that ceiling binds, and this check fails on OMISSION even when every number above is perfect: a plan whose output is a size rather than a date has no trigger anyone can act on. The reference is 20 months, banded to plus or minus two. Grading is in bands: a projection inside the band is within tolerance, never correct. Bring the caveat with you — the deficit term is the softest input in the model, because it assumes today\'s compaction throughput holds while the file count it has to chew through is itself growing.',
    },
    {
      type: 'prose',
      md: `## Chargeback: an unattributable platform cannot be governed

The second half of this lesson is the sentence that decides whether the first half is actionable. A capacity plan says the platform needs more of something in month 20. The immediate next question is *who is causing that*, and if the answer is "the platform", the only available responses are to buy more or to ration everyone equally — both of which punish the tenants who are behaving.

**Attribution is arithmetic over telemetry you already emit.** For each query: bytes scanned, files touched, instance-hours, the principal that ran it, and the tables it read. Group by tenant and day. That is showback, and it is enough to change behaviour on its own — the tenancy desk grades this as its \`attribution\` check, and the dossier field is *spend attributable per tenant*.

Two hard parts, and both are usually skipped.

**Hard part 1 — the Zipf distribution means you must model both ends.** At 40 tenants, the largest is **38%** of daily bytes scanned and sets your capacity ceiling; the smallest twenty are **3%** of bytes combined and generate a disproportionate share of the **file count**, because each writes small commits into its own partitions. So the big tenant drives the compute and network curves, and the small tenants drive the curve that actually binds. **The mean tenant does not exist**, and a chargeback model built on averages bills the wrong population for the wrong resource.

**Hard part 2 — the platform's own consumption is real and someone must own it.** A2.L3's four jobs rewrite **12% of the table per day** and produce zero rows any user asked for. That is not attributable to a query, so you have exactly three honest options:

1. **Attribute maintenance by write volume.** Write amplification is caused by ingest, so a tenant with 60% of the daily logical change carries 60% of the rewrite. Defensible, and it makes the freshness conversation self-correcting — a team asking for a shorter batch interval sees the rewrite cost land on their line.
2. **Publish it as a platform tax, as a named line with a number.** Fine for orphan sweeps and metadata compaction, which are genuinely per-platform.
3. **Leave it unattributed.** This is what most platforms do, and it is the option that loses the CFO room, because the answer to "who pays for the background process constantly rewriting files that were already written" becomes "it is included" — which the room correctly hears as *you have not looked*.

Set a target and monitor it: **unattributable share below 10% of daily bytes.** At 30% unattributable you cannot answer the only question a governance conversation asks, and the platform's growth becomes something that happens to you rather than something someone requested.

The caveat, said first: **attribution is not fairness.** Bytes scanned measures consumption, not value, and a tenant reading 38% of the bytes may be producing most of the organisation's revenue. Say that out loud when you present it, because the failure mode of a good chargeback model is a manager using it as a ranking.`,
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'four ways a capacity plan is technically right and operationally useless',
      md: `Each of these has a specific tell, and each is a check the desk fails you for.

**It reports a size instead of a date.** "We will need 227 TB" has no trigger. Nobody can act on it, nobody diaries it, and it is indistinguishable from a plan that says nothing. The output is *month 20, the catalog* — and then a size.

**It averages utilisation across components.** "We are at 70% overall" is the arithmetic mean of five numbers in five different units, which is not a quantity. The comfortable components do not lend capacity to the binding one; only the earliest saturation date matters, and the ledger exists so the reader can check you ruled the others out.

**It has no growth term, or one blended term.** A projection without growth is a snapshot in a plan's clothes, and it fails the \`headroom\` check even when today's numbers are exact. One blended rate is nearly as bad: data growth at 6%/month and query growth at 4%/month drive different curves, and the network curve multiplies them — blending hides which lever moves which ceiling.

**It offers only purchases.** 280,500 of the 1.55M entries are a merge deficit. Raising compaction throughput by 8% removes that term entirely; buying catalog capacity treats a rate imbalance as a size problem and pays for it every year forever. **A plan that names the binding component and not the knob has done half the work** — and the half it skipped is the half that costs nothing.

Then the caveat to volunteer before anyone asks: **the deficit term is the softest number in the model.** It assumes today's merge throughput holds, while the file count it has to work through is itself growing. If that assumption breaks, the deficit is not linear and month 20 becomes month 16 — which is exactly why the leading indicator on the dashboard is *backlog slope* and not entry count (A2.L4).`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — five curves, five units, one date; then who caused it',
      height: 76,
      nodes: [
        { id: 'st', x: 2, y: 2, w: 30, h: 9, label: 'storage · bytes', sub: '227 TB of 400 TB · 57%', color: '#3EF2A4' },
        { id: 'cp', x: 35, y: 2, w: 30, h: 9, label: 'compute · inst-h/h', sub: '46.1 of 60 · 77% · QUERY growth', color: '#3EF2A4' },
        { id: 'nw', x: 68, y: 2, w: 30, h: 9, label: 'network · bytes/day', sub: '4,484 TB of 6,000 · 75% · both terms', color: '#3EF2A4' },
        { id: 'ing', x: 2, y: 15, w: 30, h: 9, label: 'ingest · bytes/day', sub: '3.24 TB of 8 TB · 40%', color: '#3EF2A4' },
        { id: 'cat', x: 35, y: 15, w: 63, h: 9, label: 'catalog · manifest entries — 1,545,000 of 1,200,000 · 129%', sub: '1,265,000 steady-state + 280,500 from the merge deficit', color: '#FB7185' },
        { id: 'date', x: 2, y: 28, w: 96, h: 9, label: 'the deliverable: the catalog binds in month 20 — headroom 20 months', sub: 'not a size, a date and a named component; the comfortable four do not lend capacity to the one that binds', color: '#F97316' },
        { id: 'knob', x: 2, y: 41, w: 46, h: 9, label: 'lever A: change a knob', sub: 'merge 4,800 → 5,200/day deletes 280,500 entries', color: '#A3E635' },
        { id: 'buy', x: 52, y: 41, w: 46, h: 9, label: 'lever B: buy capacity', sub: 'pays for a rate imbalance every year, forever', color: '#FBBF24' },
        { id: 'attr', x: 2, y: 54, w: 96, h: 9, label: 'then: who caused it? per-query bytes, files, instance-hours, principal, table → grouped by tenant and day', sub: 'top tenant 38% of bytes sets compute and network; the smallest 20 are 3% of bytes and drive the file count that binds', color: '#22D3EE' },
        { id: 'tax', x: 2, y: 67, w: 96, h: 9, label: 'and the platform\'s own 12%/day of rewrite: attributed by write volume, or published as a named tax — never left unattributed', sub: 'target: unattributable share below 10% of daily bytes, because "it is included" is what loses the CFO room', color: '#A78BFA' },
      ],
      edges: [
        { from: 'st', to: 'date' },
        { from: 'cp', to: 'date' },
        { from: 'nw', to: 'date' },
        { from: 'ing', to: 'date' },
        { from: 'cat', to: 'date' },
        { from: 'date', to: 'knob' },
        { from: 'date', to: 'buy' },
        { from: 'knob', to: 'attr' },
        { from: 'buy', to: 'attr' },
        { from: 'attr', to: 'tax' },
      ],
      steps: [
        {
          caption:
            'Four of the five components are comfortable at the horizon, and each is comfortable in its own unit: bytes, instance-hours per wall-hour, bytes moved per day, bytes landed per day. None of them can be averaged with another.',
          active: ['st', 'cp', 'nw', 'ing'],
        },
        {
          caption:
            'The fifth is counted in manifest entries and it is over budget, with two terms: steady-state bytes divided by target file size, plus an accumulated creation-versus-merge deficit that is linear in months and independent of data volume.',
          active: ['cat'],
        },
        {
          caption:
            'So the plan outputs a date and a component rather than a size, and the ledger is what lets a reviewer check that the other four were ruled out rather than ignored.',
          active: ['date'],
          edges: ['st->date', 'cp->date', 'nw->date', 'ing->date', 'cat->date'],
        },
        {
          caption:
            'Two levers, and they are not equivalent: raising merge throughput by eight percent removes the entire deficit term, while buying catalog capacity pays for a rate imbalance annually and forever. Name the knob, not just the ceiling.',
          active: ['knob', 'buy'],
          edges: ['date->knob', 'date->buy'],
        },
        {
          caption:
            'Then attribution, from telemetry you already emit: bytes, files and instance-hours per query, tagged with a principal and a table, grouped by tenant. The distribution is Zipf, so the largest tenant and the smallest ones stress different curves.',
          active: ['attr'],
          edges: ['knob->attr', 'buy->attr'],
        },
        {
          caption:
            'And the platform\'s own consumption gets an owner too — attributed by write volume where maintenance is caused by ingest, or published as a named tax with a number, because an unattributable platform cannot be governed or defended.',
          active: ['tax'],
          edges: ['attr->tax'],
        },
      ],
    },
    {
      type: 'isomorphism',
      title: 'capacity and chargeback ≡ two documents you have already defended',
      pairs: [
        {
          os: 'a cloud cost-allocation tagging policy',
          osLine:
            'Untagged spend is the line item nobody can defend, so the mature answer is a tagging standard, an untagged-share target, and a monthly report by owner. Nobody argues that untagged spend is free.',
          llm: 'per-tenant attribution from query telemetry',
          llmLine:
            'Identical structure with a better signal, because bytes scanned per query is more precise than most tags: it is per-request rather than per-resource. The untagged-share target becomes an unattributable-share target, and 10% is a defensible line to hold.',
        },
        {
          os: 'a capacity plan with a named first bottleneck',
          osLine:
            'The credible part was never the forecast. It is knowing which limit binds first and roughly when, so that monitoring points at the right graph and the purchase has a date rather than a mood.',
          llm: 'first_limit and headroom',
          llmLine:
            'Exactly the two checks the desk grades, and headroom fails on omission for the reason the analogy makes obvious: a plan that outputs a size has no trigger, and a trigger is the only part anyone will act on eleven months from now.',
        },
        {
          os: 'a noisy-neighbour policy in a shared cluster',
          osLine:
            'You size for the loudest workload and quota the rest, because the distribution of demand is never uniform and the mean tenant is a construct.',
          llm: 'Zipf tenants across five curves',
          llmLine:
            'With one twist worth stating: the loud tenant and the expensive tenant are different tenants here. The largest drives compute and network; the twenty smallest drive the file count that actually binds, and a quota on bytes scanned does nothing about that. (→ tablespace T6 for per-tenant isolation in a row store.)',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Your 24-month plan shows storage at 57% of ceiling, compute 77%, network 75%, ingest 40%, and manifest entries at 129% of budget with the crossing in month 20. A colleague suggests reporting "roughly 70% utilised with two years of runway". What is wrong, and what do you report instead?',
          options: [
            'Nothing much — averaging across components is a reasonable summary for a non-technical audience, and the detail belongs in an appendix',
            'The average is not a quantity: five components in five different units cannot be combined, and the comfortable four do not lend capacity to the one that binds. Report the catalog as the first limit with 20 months of headroom, show the ledger so the other four are visibly ruled out, and name the cheap lever — 280,500 of the 1.55M entries are a merge deficit that 8% more compaction throughput removes entirely',
            'The plan should be re-based on a longer horizon, since a 24-month window makes every component look tight',
            'Utilisation is the wrong frame entirely; the plan should report absolute sizes for each component and let the reader judge',
          ],
          correct: [1],
          explanation:
            'Averaging utilisation across bytes, instance-hours and manifest entries produces a number with no unit and no meaning, and its practical effect is to hide the only fact that mattered — a component over budget with a date attached. The report a capacity plan owes is a date and a named component, backed by a ledger that shows the ruling-out. The second half is what separates a good plan from a correct one: a large part of the binding term is a rate imbalance rather than data volume, so the cheapest fix is throughput rather than a purchase, and a plan that offers only purchases has skipped the free half of the work. A longer horizon does not change which curve binds first; reporting raw sizes without ceilings leaves the reader to compute utilisation themselves, which is the analysis you were asked for.',
        },
        {
          q: 'Finance asks who is responsible for the platform\'s growth. Your telemetry attributes 71% of daily bytes scanned to named tenants; the remaining 29% is background maintenance and untagged jobs. What is the defensible position?',
          options: [
            '71% attributed is good coverage, and background maintenance is genuinely a platform cost that should not be charged to anyone',
            'A 29% unattributable share is the problem, not a footnote: attribute maintenance by write volume, since write amplification is caused by ingest and a tenant with 60% of daily change carries 60% of the 12%-of-table daily rewrite, publish genuinely per-platform work such as orphan sweeps as a named tax with a number, tag the untagged jobs, and hold the residue under 10% — because the only alternatives when nobody caused it are buying more or rationing everyone equally',
            'Charge the unattributable 29% pro rata across tenants by their attributed share, which is simple, defensible and requires no new telemetry',
            'Report the 71% and note that the remainder is a known limitation of the telemetry, to be improved when the platform adds per-job tagging',
          ],
          correct: [1],
          explanation:
            'The purpose of attribution is not accounting neatness, it is being able to answer the governance question at all — and "nobody in particular" leaves you with two bad instruments, both of which penalise well-behaved tenants. Attributing maintenance by write volume is defensible because the causal chain is real: ingest configuration determines rewrite volume, so the team asking for a shorter batch interval sees the cost land on their line, which makes the freshness conversation self-correcting. Calling maintenance an unchargeable platform cost is exactly the answer the CFO room treats as fatal — "it is included" means nothing is included, it is metered or amortised, and you have not looked. Pro rata allocation is worse than it looks: it charges the tenant who reads a lot for rewrite volume caused by the tenant who writes a lot, so it produces confident numbers with the causality inverted. And deferring to future tagging leaves the largest single line unowned in the meeting where ownership is being assigned.',
        },
        {
          q: 'A team\'s plan states current usage precisely for all five components and concludes "we have sufficient capacity". The desk fails the headroom check even though every present-day number is exact. Why?',
          options: [
            'Because the plan did not use the desk\'s tolerance bands, so the numbers cannot be graded',
            'Because a projection with no growth term is a snapshot wearing a plan\'s clothes: every figure that matters is a growth projection, and the question asked was how many months of headroom exist before the first ceiling binds — which is a date, and a plan whose output is a size has no trigger anyone can act on',
            'Because "sufficient capacity" is a qualitative claim and the desk requires percentages of ceiling for each component',
            'Because the plan omitted the retention multiplier, which is what makes the storage figure wrong',
          ],
          correct: [1],
          explanation:
            'The check is designed to fail this specific case: today\'s numbers being right is not evidence about the future, and the deliverable was a date. Two distinct omissions are graded — no growth term at all, and growth modelled but headroom left unstated — because both leave the plan without the one output a reader can diarise. The tolerance bands are how correct answers are accepted, not a submission format. Missing the retention multiplier is a real and common error, but it fails the storage check rather than the headroom check, and it would be a wrong size rather than a missing date. And "sufficient capacity" is not merely vague: it is unfalsifiable, which means nobody will ever be able to tell whether the plan was right.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: growth models, Zipf tenants, and the discipline of naming the binding constraint',
      md: `On the estimation discipline, **Douglas Hubbard's *How to Measure Anything*** is still the standard reference for giving decision-makers calibrated ranges instead of false points, and it is the right answer to "the deficit term is the softest input" — you state the range and the mechanism rather than pretending to a point estimate. Pair it with **the SRE workbook on capacity planning**, whose central discipline is the same as this desk's: forecast demand per resource in that resource's own unit, and never aggregate across units.

For the constraint framing, **Goldratt's *The Goal*** is unfashionable and exactly right about the one thing this lesson turns on: capacity added anywhere other than the binding constraint produces no improvement whatsoever. That is why \`first_limit\` is the check with the most weight, and why the ledger belongs in the document.

On tenant distributions, the empirical literature on **Zipf and heavy-tailed workloads** is worth reading once properly — the practical consequence is that sizing to the mean is guaranteed to be wrong at both ends simultaneously, and the two ends stress different resources. The tenancy desk in A1 makes this a graded submission; here it is the input to chargeback.

For chargeback specifically, the FinOps literature is mostly vendor-adjacent, but two ideas transfer cleanly: **showback before chargeback** (publish attribution for a quarter before anyone is billed, because the first month of data is always wrong and the arguments it triggers are the debugging), and **unit-cost metrics** — cost per query class, per tenant, per thousand rows served — which are what make a growing total legible rather than alarming. Notice that both of those are counts divided by counts, which is the form this course has insisted on throughout: the rate is yours to supply and no lesson here will state one.

Next: **A2.L6**. Capacity answers what the platform needs while it works. The remaining question is what happens when it does not — and the most common answer given for that, time travel, lives in the same metadata tree it would have to recover from.`,
    },
  ],
}

export default lesson
