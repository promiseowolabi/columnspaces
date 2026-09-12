import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'a1.l6',
  slug: 'migration-and-coexistence',
  trackId: 'a1',
  index: 6,
  title: 'Migration and Coexistence',
  minutes: 18,
  hook: 'The design review approves the new platform. Nobody approves the two quarters of running both, which is where the cost actually is — and the data movement is about 5% of it.',
  exercise: 'quiz',
  takeaway: {
    number: '5% of a migration is the data',
    claim:
      'Moving 180 TB is about 2 of the 37 engineer-months in a realistic migration; the rest is 32 engineer-months of human work on pipelines, dashboards and access, plus 6 months of running two platforms at once — so the schedule is a cost line, and every month of slip is another duplicate platform-month.',
  },
  blocks: [
    {
      type: 'prose',
      md: `You are not building greenfield. There is a working system, it has consumers, and the interesting number in your proposal is not the new platform's cost — it is the cost of holding both for two quarters while you prove the new one is equivalent.

Here is the decomposition, on a realistic case: **180 TB across the tables that matter, 40 pipelines, 120 dashboards, 6 consuming teams.**

\`\`\`text
data movement        write and verify the copy job         ~2  engineer-months
                     (180 TB moved once — a bounded,
                      one-off byte count)
human work           40 pipelines × 0.5                    20  engineer-months
                     120 dashboards × 0.05                  6
                     access model, governance, lineage      3
                     enablement and consumer support        3
parallel running     6 months × both platforms              6  duplicate
                                                              platform-months
                     + 0.5 FTE reconciliation for 6 months   3  engineer-months
─────────────────────────────────────────────────────────────────────────────
total                                                      37  engineer-months
                                                          +  6 duplicate
                                                             platform-months
of which data movement                                    ~5%
\`\`\`

Redo it with your own counts — the pipeline and dashboard multipliers are the two you should argue about, and they are the two nobody puts in the slide. **The point of the arithmetic is the shape, not the total: the movement is the part everybody plans and the smallest term, and the parallel run is the part nobody costs and the term that grows every time the date slips.**

That gives you the sentence to open with, before anyone asks: *"the migration is 37 engineer-months and six duplicate platform-months; the data movement is about two of them, so the schedule risk is the cost risk."* A month of slip is not a month of delay. It is another duplicate platform-month plus another half-FTE of reconciliation, and it is the only line item that scales with your own project management.`,
    },
    {
      type: 'prose',
      md: `## Three cutover strategies, and what each one is bad at

**Dual-write.** Every producer writes to both platforms. The cutover is a config flip, both systems are current, and rollback is trivial. What it is bad at: **there is no atomic commit across two systems**, so a partial write is not an error, it is a divergence — and divergence is silent. You have also doubled the number of write paths that must stay correct through every schema change for the whole coexistence window, which is exactly when the schema is changing most. Cost shape: touches every producer, and the failure mode is discovered by a consumer rather than by a monitor.

**Backfill-then-cut.** Copy history, then move writers at a watermark. One write path is authoritative at any moment, so the correctness argument is much simpler. What it is bad at: **the tail.** Backfilling 180 TB takes days, during which the source keeps changing, so you need either a freeze (which nobody grants) or a catch-up pass that must converge faster than the source produces change. Rollback means backfilling in the other direction, so the rollback window is a design input rather than an afterthought. Cost shape: concentrated risk at one moment, on a date, in public.

**Shadow-read.** Writes are fed to both (or the new platform is fed from the old), reads continue to be served by the old system, and the new one answers the same queries in the background so results can be compared on the real query mix at the real concurrency. What it is bad at: **it doubles read cost for the length of the window** and it needs a comparison harness plus a tolerance policy, because a large fraction of the differences it surfaces will be legitimate — floating-point summation order, timestamp precision, null ordering, late-arriving rows. Cost shape: the most expensive to run and the only one that produces evidence.

In practice the shipped plan is a *combination*, and saying so is the sign you have done this before: **backfill the history, dual-write or feed the tail, shadow-read to prove equivalence, cut over with a stated rollback window, then decommission on a date with a named owner.** Decommission is a line in the plan, not a consequence of the cutover — the parallel run continues until somebody deliberately ends it, and an unnamed decommission date is how a two-quarter coexistence becomes a permanent second platform.`,
    },
    {
      type: 'prose',
      md: `## Proving equivalence: why a spot check is worth almost nothing

Here is the arithmetic that ends the "we validated it, we checked a few hundred rows" conversation.

Take 2 billion rows and a divergence of 0.1% — **2 million wrong rows**, which is a serious, funding-losing defect. Sample 100 rows at random:

\`\`\`text
P(sample contains at least one bad row)
  = 1 − (1 − 0.001)^100
  = 1 − 0.999^100
  ≈ 0.095
\`\`\`

**A passing 100-row spot check has about a 90% chance of missing a two-million-row error.** Push the sample to 1,000 rows and you are still at ~63% detection; to get past 95% you need roughly 3,000 randomly sampled rows *and* the errors must be uniformly distributed, which they never are. Real migration defects are **localised**: one day's partition dropped, one hour shifted by a timezone conversion, one column silently coerced, one late-arriving batch never replayed. A uniform random sample is the worst possible instrument for finding a defect that lives in one partition.

So compare **per partition**, and compare aggregates rather than rows:

| check | catches | misses | cost |
|---|---|---|---|
| row count per partition | dropped or duplicated batches, missing days, double-loads | any error that preserves cardinality | often metadata-only — the cheapest real check you have |
| \`sum\`, \`min\`, \`max\` per additive column per partition | value corruption, unit changes, timezone shifts, type coercion, sign errors | two rows swapped between partitions of the same total | one scan of those columns |
| distinct count or a hash of the key column per partition | row-level identity divergence | little, but it is order-sensitive and expensive | full scan, and needs a deterministic hash |
| 100-row spot check | ~9.5% of a 0.1% divergence | almost everything | trivial, which is why it is popular |

Three rules make the comparison mean something. **Compare as of a watermark**, not as of "now", or late-arriving rows guarantee mismatches you will spend a week chasing. **State a tolerance and its reason**: summing doubles is order-dependent, so exact equality on a float aggregate is a test that fails for a reason unrelated to your migration — compare at a relative tolerance, or cast to decimal and compare exactly. And **compare query results, not only tables**: a dashboard can be wrong while both tables are right, because SQL dialects differ on null ordering, integer division, implicit casts and timestamp precision. That is precisely the class of defect shadow-read exists to find, and the class that table-level checks cannot see.

The deliverable is one line in the plan: *"equivalence means row counts and additive aggregates matching per partition across all 730 partitions as of watermark W, with a stated float tolerance, plus the top 20 consumer queries producing matching results under shadow-read for 14 days."* That sentence is falsifiable. "We validated the data" is not.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '37 + 6',
          label: 'engineer-months plus duplicate platform-months',
          hint: '32 engineer-months of human work, 3 of reconciliation, about 2 of data movement, and six months of paying for two platforms at once. Every month of schedule slip adds another duplicate platform-month and another half-FTE.',
        },
        {
          value: '~5%',
          label: 'share of the migration that is moving bytes',
          hint: 'The one-off copy is bounded, well understood and the part every plan covers in detail. It is also the smallest term, which is why migrations overrun on human work rather than on throughput.',
        },
        {
          value: '9.5%',
          label: 'chance a 100-row spot check finds a 0.1% divergence',
          hint: '1 − 0.999^100. On a 2-billion-row table a 0.1% divergence is 2 million wrong rows, and a passing spot check has about a 90% chance of missing it entirely.',
        },
        {
          value: '730',
          label: 'per-partition comparisons instead of one global one',
          hint: 'Migration defects are localised — a dropped day, a shifted hour, a coerced column. A per-partition count and additive aggregate finds a defect confined to one partition; a global total can hide it entirely.',
        },
      ],
    },
    {
      type: 'diagram',
      caption: 'fig 1 — two systems, one watermark, and the gate that lets you cut',
      height: 78,
      nodes: [
        { id: 'old', x: 2, y: 2, w: 30, h: 9, label: 'the working system', sub: '180 TB · 40 pipelines · 120 dashboards', color: '#94A3B8' },
        { id: 'new', x: 68, y: 2, w: 30, h: 9, label: 'the new platform', sub: 'approved on a design, unproven on your data', color: '#FBBF24' },
        { id: 'back', x: 2, y: 15, w: 30, h: 10, label: '1 · backfill history', sub: 'a bounded one-off copy: ~2 engineer-months of the 37', color: '#A3E635' },
        { id: 'tail', x: 35, y: 15, w: 30, h: 10, label: '2 · feed the tail', sub: 'dual-write or CDC — no atomic commit across two systems', color: '#FB923C' },
        { id: 'shadow', x: 68, y: 15, w: 30, h: 10, label: '3 · shadow-read', sub: 'real query mix, real concurrency, doubled read cost', color: '#22D3EE' },
        { id: 'gate', x: 2, y: 29, w: 96, h: 11, label: 'the equivalence gate: row counts AND additive aggregates per partition, as of watermark W, with a stated float tolerance', sub: 'a 100-row spot check finds a 0.1% divergence about 9.5% of the time — and real defects live in one partition, not uniformly', color: '#A78BFA' },
        { id: 'queries', x: 2, y: 44, w: 46, h: 10, label: 'plus results, not just tables', sub: 'null ordering, integer division, implicit casts, timestamp precision', color: '#22D3EE' },
        { id: 'roll', x: 52, y: 44, w: 46, h: 10, label: 'plus a stated rollback window', sub: 'the old system stays fed and writeable until it closes', color: '#FB7185' },
        { id: 'cut', x: 2, y: 58, w: 46, h: 9, label: '4 · cut over', sub: 'a config change, not an event', color: '#3EF2A4' },
        { id: 'decom', x: 52, y: 58, w: 46, h: 9, label: '5 · decommission, on a date, with an owner', sub: 'unnamed = a permanent second platform', color: '#3EF2A4' },
        { id: 'cost', x: 2, y: 70, w: 96, h: 8, label: 'and the cost line the plan is actually judged on: 6 duplicate platform-months + 0.5 FTE of reconciliation, growing with every month of slip', sub: 'the data movement was 5% — the schedule is the budget, which is why the decommission date has a named owner rather than a hope', color: '#FBBF24' },
      ],
      edges: [
        { from: 'old', to: 'back' },
        { from: 'back', to: 'tail' },
        { from: 'tail', to: 'shadow' },
        { from: 'new', to: 'shadow' },
        { from: 'shadow', to: 'gate' },
        { from: 'gate', to: 'queries' },
        { from: 'gate', to: 'roll' },
        { from: 'queries', to: 'cut' },
        { from: 'roll', to: 'cut' },
        { from: 'cut', to: 'decom' },
        { from: 'decom', to: 'cost' },
      ],
      steps: [
        {
          caption:
            'Start from the honest starting position: a working system with consumers on one side, and on the other a platform approved on the strength of a design rather than on any measurement taken against your own data.',
          active: ['old', 'new'],
        },
        {
          caption:
            'Backfill first, because it is the one part of the project that is genuinely a bounded byte count — and note that it is about two of the thirty-seven engineer-months, which is why a plan organised around it is organised around the wrong term.',
          active: ['back'],
          edges: ['old->back'],
        },
        {
          caption:
            'Then the tail, which is the hard part of backfill-then-cut: the source keeps changing while you copy, and if you feed both systems instead, remember that no commit is atomic across two of them, so a partial write is a silent divergence rather than an error.',
          active: ['tail'],
          edges: ['back->tail'],
        },
        {
          caption:
            'Shadow-read is the only strategy that produces evidence rather than confidence: the same queries, the real mix, the real concurrency, compared rather than eyeballed — bought at the price of doubled read cost for the length of the window.',
          active: ['shadow'],
          edges: ['tail->shadow', 'new->shadow'],
        },
        {
          caption:
            'The gate is where most migrations quietly fail, because sampling is the wrong instrument: counts and additive aggregates per partition as of a watermark, with a tolerance stated for float summation order rather than discovered during the review.',
          active: ['gate'],
          edges: ['shadow->gate'],
        },
        {
          caption:
            'Two things the table-level gate cannot see, so they are separate gates: consumer query results, where dialect differences make a dashboard wrong while both tables are right, and a rollback window during which the old system stays fed and writeable.',
          active: ['queries', 'roll'],
          edges: ['gate->queries', 'gate->roll'],
        },
        {
          caption:
            'Only then is cutover a configuration change rather than an event — and decommission is its own step with a date and an owner, because a coexistence window that nobody deliberately ends becomes a second platform you operate forever.',
          active: ['cut', 'decom'],
          edges: ['queries->cut', 'roll->cut', 'cut->decom'],
        },
        {
          caption:
            'Which puts the real cost line where the room can see it: duplicate platform-months plus reconciliation labour, both scaling directly with the schedule, and neither of them the data movement everyone spent the meeting discussing.',
          active: ['cost'],
          edges: ['decom->cost'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the four costs a migration plan routinely omits, all in the same direction',
      md: `**The parallel run is a purchase, not an overlap.** For the whole coexistence window you are paying for two platforms. On consumption shapes that is double the scan volume on any workload you have duplicated for comparison; on instance or capacity shapes it is two sets of provisioned capacity, and the second one cannot be released until decommission. This term is proportional to the *schedule*, which means it is the line item your own project management controls and the one most likely to grow.

**The consumers set the timeline, not the platform team.** Two quarters is not a technical estimate; it is the slowest of six teams finding capacity to revalidate their own dashboards. You can compress your work and you cannot compress theirs, so the schedule risk sits outside your span of control and must be stated that way in the plan.

**Both systems keep evolving.** The coexistence window is not a freeze. New columns arrive, semantics change, a new consumer appears — and every change must now be made twice, in two dialects, with equivalence re-proved. The tax scales with window length × change rate, and it is the reason a six-month window is not twice as expensive as a three-month one.

**Rollback has an RPO.** If you cut over and revert two weeks later, what happens to the writes that landed only on the new platform? Either the old system was kept fed (a cost you must name) or the rollback loses data (a risk you must name). "We can roll back" without one of those two sentences behind it is not a rollback plan.

State all four before the review finds them. The reward is not virtue: a quantified parallel-run cost is the strongest argument you have for a *shorter* window, and a named consumer-side dependency is how the timeline becomes a shared commitment rather than your personal exposure.`,
    },
    {
      type: 'callout',
      variant: 'analogy',
      title: 'model the habit: the plan, said out loud in ninety seconds',
      md: `> "The weakness first: the six-month window is the slowest of six consuming teams finding capacity to revalidate, not our engineering estimate. That is the largest risk in the plan and it is outside my control, so I have priced it — every extra month is one more duplicate platform-month plus half an FTE of reconciliation, and I would rather cut scope than extend the window.
>
> The shape: about thirty-seven engineer-months and six duplicate platform-months. Roughly two of the thirty-seven are moving the 180 TB. The rest is forty pipelines, a hundred and twenty dashboards, the access model and enablement — human work, which is why this project overruns on people rather than on throughput.
>
> How we cut: backfill history, feed the tail with CDC, shadow-read for fourteen days on the top twenty consumer queries, then a config change. Equivalence means row counts and additive aggregates matching per partition across all 730 partitions as of a watermark, with a stated tolerance on float sums because summation order differs between engines and that difference is not a defect. We are not spot-checking rows: on two billion rows, a hundred-row sample finds a two-million-row divergence about nine percent of the time, and real defects live in one partition rather than everywhere.
>
> The rollback window is thirty days, during which the old system stays fed and writeable — that is a cost and it is in the number. Decommission is the fifteenth of the month after that, and it has a named owner, because a coexistence window nobody ends is a second platform we operate forever."

Notice which sentence does the most work. Naming the consumer dependency converts your largest uncontrolled risk into a shared, quantified commitment — and it does it before anyone in the room can offer it as a criticism.`,
    },
    {
      type: 'isomorphism',
      title: 'a migration ≡ three things you have already shipped',
      pairs: [
        {
          os: 'a blue/green deployment',
          osLine:
            'Two environments, traffic shifted deliberately, rollback by pointing back. Everyone accepts that you pay for both during the overlap and that the overlap ends on a date.',
          llm: 'the coexistence window',
          llmLine:
            'Same structure with one extra problem: the two environments hold *state*, so "point back" only works if the old one was kept current — which is a cost you must name rather than a property you get free.',
        },
        {
          os: 'a database schema change with an expand/migrate/contract sequence',
          osLine:
            'Add the new shape, dual-write, backfill, verify, switch readers, remove the old shape. The contract step is the one teams skip, and skipping it leaves permanent complexity.',
          llm: 'backfill · dual-write · shadow-read · cut · decommission',
          llmLine:
            'Identical five steps at platform scale, and the same step gets skipped: decommission without a date and an owner is how a migration becomes a permanent second platform. → tablespace T0.L2 for the movement cost model underneath the backfill.',
        },
        {
          os: 'a canary release with a comparison metric',
          osLine:
            'A small share of traffic to the new version, with an agreed metric and an agreed threshold decided *before* the release rather than argued about during it.',
          llm: 'shadow-read with a stated equivalence gate',
          llmLine:
            'The gate has to be written down first for the same reason: after you see the diffs, every tolerance you choose looks like a rationalisation, including the correct ones.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A migration proposal shows a 6-month timeline and a cost built from storage, compute and the one-off data transfer. Finance asks what the migration itself costs. What is missing, and why does its absence understate the total so badly?',
          options: [
            'A contingency percentage on the transfer estimate, since large copies routinely take longer than planned',
            'The parallel-run and human-work terms: six months of paying for both platforms, roughly 0.5 FTE of reconciliation across the window, and about 32 engineer-months rewriting 40 pipelines and revalidating 120 dashboards. The transfer is about 5% of the total, and the omitted terms scale with the schedule — so a month of slip is a real, computable increase rather than a delay',
            'The new platform\'s exit cost, which should be included in the migration total rather than quoted separately',
            'Nothing material — data transfer, storage and compute are the direct costs, and internal engineering time is already funded through headcount',
          ],
          correct: [1],
          explanation:
            'The transfer is the smallest and best-understood term; the parallel run and the human work are the largest and the ones that grow. Treating engineering time as already funded is the specific error that makes migrations look cheap in a business case and expensive in delivery — 32 engineer-months is real capacity that other work does not get, and the reconciliation half-FTE exists for as long as the window does. Contingency on the wrong term does not help. Exit cost is a genuine and separate figure that belongs in the build-or-buy memo (A1.L7) as renewal leverage, not folded into the migration line.',
        },
        {
          q: 'Before cutting over a 2-billion-row table across 730 daily partitions, a team reports: "we sampled 500 random rows from each system and they all matched." How much assurance is that, and what should the gate be instead?',
          options: [
            'Strong assurance — 500 random rows from a uniform population is a statistically valid sample of the whole table',
            'Almost none against the defects that actually occur: a 0.1% divergence is 2 million wrong rows and a 500-row sample misses it about 61% of the time, and real migration defects are localised — one dropped day, one timezone-shifted hour, one coerced column — which random sampling is the worst instrument for. The gate should be row counts and additive aggregates per partition as of a watermark, with a stated float tolerance, plus shadow-read on the top consumer queries',
            'Insufficient only because the sample was too small; increasing it to 50,000 rows would make the check sound',
            'Sufficient for data but not for performance, so the remaining work is a load test rather than more validation',
          ],
          correct: [1],
          explanation:
            'Two independent problems compound. The statistical one: 1 − 0.999^500 ≈ 0.39, so a passing sample of that size misses a two-million-row divergence most of the time. The structural one is worse and is not fixed by a bigger sample — defects concentrate in partitions, and a per-partition count plus additive aggregate detects a single missing day with certainty and near-zero cost, often from metadata alone. Comparing as of a watermark matters because late-arriving rows otherwise produce mismatches unrelated to the migration, and the float tolerance matters because summation order differs legitimately between engines. Performance validation is necessary too, and it is a different gate from correctness.',
        },
        {
          q: 'You must feed the new platform during coexistence. Dual-write from every producer, or CDC from the old platform into the new one? Which reasoning is sound?',
          options: [
            'Dual-write, because both systems stay current and cutover becomes a config flip — the correctness risk is manageable with retries in each producer',
            'CDC, because it makes the new platform an exact replica and removes the need for an equivalence gate before cutover',
            'Either is defensible, and the deciding factor is where the divergence risk lands: dual-write has no atomic commit across two systems, so a partial write is a silent divergence and every producer must be modified and kept correct through the schema changes that happen during the window; CDC keeps one authoritative write path and concentrates the risk in one component you can monitor, at the price of inheriting the source\'s replication lag and its update-heavy write pattern on the target',
            'Dual-write, because CDC applies changes as updates, and update-heavy workloads on a columnar target are always prohibitively expensive',
          ],
          correct: [2],
          explanation:
            'The choice is a placement of risk, and naming where the risk lands is the analysis the room wants. Dual-write multiplies the surfaces that must remain correct exactly when the schema is moving, and it fails silently because no cross-system commit exists — retries do not fix a partial write that was never atomic. CDC narrows the failure surface to one monitorable pipeline but hands you the source\'s lag in your freshness arithmetic and an update-heavy stream on the target, whose real cost is change locality rather than change rate (A1.L5). Nothing removes the equivalence gate: a replica proves rows were shipped, not that consumer queries produce the same answers, which is where dialect differences live. And update-heavy is expensive at 100× or roughly 1× depending on locality, so "always prohibitive" is folklore rather than arithmetic.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: coexistence as the normal state',
      md: `**The transferable literature is not about data platforms.** The strongest material on this problem is the expand/migrate/contract pattern from schema evolution and the *branch by abstraction* technique from continuous delivery — both are about running two implementations behind one interface while state moves, and both insist the contract step gets an owner. **Kleppmann's *Designing Data-Intensive Applications*** chapter on dataflow and derived data is the clearest treatment of "the same data in two systems" as a steady state rather than a transition, which is the mental model that makes coexistence plannable instead of heroic.

**For the equivalence problem specifically**, the reference practice is GitHub's \`scientist\` pattern: run both code paths, return the old result, record the comparison, and *expect* legitimate mismatches so that a tolerance policy is part of the design rather than a concession. Applied to a migration, that is exactly shadow-read, and the discipline it enforces is writing the acceptance threshold down before you have seen the diffs.

**For the sampling argument**, any introductory treatment of detection probability in acceptance sampling gives you the formula, but the more useful reference is the software-testing literature on *fault localisation*: defects cluster, so tests that partition the input space beat tests that sample it uniformly. A per-partition aggregate comparison is a partitioned test; a random row sample is not.

**On the table-format side**, read the migration procedures your format actually offers before designing a copy: Iceberg documents both **snapshot** (a metadata-only shadow table over existing files) and **add_files** style in-place adoption, and Delta and Hive have equivalents. When they apply, the backfill term shrinks toward zero — and since the backfill is only ~5% of the project, notice that this does not rescue a schedule. It is still worth doing, because bytes not moved are also bytes not verified.

Next: **A1.L7** puts a number on the thing this lesson has been circling. Once you can cost the migration and the parallel run, you can cost the decision itself — three platform shapes over 36 months with labour in engineer-months, and a memo that ends on what a proof-of-concept would have to measure to change your mind.`,
    },
  ],
}

export default lesson
