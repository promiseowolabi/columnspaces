import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c6.l3',
  slug: 'skew-is-the-runtime',
  trackId: 'c6',
  index: 3,
  title: 'Skew Is the Runtime',
  minutes: 18,
  hook: 'The mean partition holds exactly 15,000 rows under every distribution the lab measures, while the largest holds 17,489 in one and 227,801 in another. Only one of those two numbers knows anything about your data, and it is not the one on the dashboard.',
  exercise: 'lab+quiz',
  takeaway: {
    number: '15,000 rows',
    claim:
      'The mean partition size is arithmetic — rows divided by partitions — so it cannot respond to the distribution at all; the maximum is the runtime, and adding workers makes the ratio worse rather than better.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Hash partitioning distributes **keys** evenly. It does not distribute **rows** evenly, and rows are what the work is made of.

That sentence is the whole lesson, and everything below is it measured. A good hash spreads distinct key values across partitions to within a few percent — that part works, and it is why nobody suspects it. But every row carrying the same key value must land in the same partition, by definition, or the join is wrong. So one value that holds 40% of the rows takes 40% of the table with it to exactly one partition, and no amount of extra parallelism can divide it further.

**The largest partition is the runtime.** Not the average, not the total: the largest. A job over 32 workers where 31 finish in a second and one runs for a minute takes a minute. And the average is not merely a poor proxy for that — it is *arithmetically incapable* of being one, which is the part worth internalising.`,
    },
    {
      type: 'prose',
      md: `## The mean cannot move, and it is the number every dashboard shows

\`The Skew Lab\` builds 480,000 rows over 4,096 distinct keys and routes them with \`hash(key) % 32\` — the same 32 partitions the Warehouse model uses, so the ratio it reports means the same thing there. Five distributions over the same rows and the same keys; only the shape changes. Every number below is measured by SQL over the real values.

| distribution | hottest key's share | mean rows/partition | max rows/partition | max ÷ mean | byte skew |
|---|---|---|---|---|---|
| uniform | 0.0% | 15,000 | 17,489 | **1.17×** | 1.17× |
| zipf-ish tail | 1.6% | 15,000 | 22,080 | **1.47×** | 1.47× |
| one key at 5% | 6.5% | 15,000 | 45,052 | **3.00×** | 3.00× |
| one key at 20% | 21.2% | 15,000 | 113,244 | **7.55×** | 7.55× |
| one key at 45% | 45.8% | 15,000 | 227,801 | **15.19×** | 15.18× |

Read the third column first. **15,000 rows, five times, to the row.** It is not approximately flat and it is not flat by luck: it is 480,000 ÷ 32, and neither term depends on the data. A capacity model built on the mean is not conservative or optimistic about skew — it is *silent* about it, because nothing in its arithmetic can hear the question.

Now read the fourth column. The largest partition goes from 17,489 rows to 227,801 — a factor of 13 — on identical row and byte totals. **Byte skew tracks row skew at 15.18× against 15.19×**, and that agreement is engineered: the fixture's keys are fixed width and the payload width varies per row independently of the key, so byte totals are identical across every level and the max is the only thing that can move. If they had disagreed, the explanation would have been the strings, and you would have learnt nothing about partitioning.

Two rows of that table exist to stop over-claiming, and they matter as much as the headline:

- **The uniform control is 1.17×, not 1.00×.** 4,096 keys do not divide evenly into 32 buckets, so a hash partitioning has an *irreducible floor* above 1. "Skew factor 1.0 when uniform" is a claim no real system meets, and quoting a target of 1.0 in a review makes everything else you say suspect.
- **A long tail alone is 1.47×, and survivable at this cardinality.** The most popular key in the tail level holds 1.6% of the rows — half a fair share of 1/32. This is what stops "skew" from meaning "any non-uniformity". The thing that ends shuffles is a *single key above the fair-share line*, because a key bigger than a fair partition cannot be balanced by any assignment that keeps it whole.`,
    },
    {
      type: 'ducklab',
      lab: 'skew-lab',
    },
    {
      type: 'prose',
      md: `## The reflex that makes it worse

Ask anyone what to do about a job where one worker is the bottleneck and the answer is "add workers". Do it and re-measure. The lab re-runs the worst distribution at **4× the parallelism — 128 buckets instead of 32**:

\`\`\`
32 buckets    mean 15,000   max 227,801   ratio 15.19×
128 buckets   mean  3,750   max 221,591   ratio 59.09×
\`\`\`

**The ratio got four times worse and the busiest partition barely moved** — 221,591 rows against 227,801, about 97% of what it was. Both halves of that are the same fact: the mean fell in proportion to the partition count, because it always does, and the hot key did not split, because it cannot. You bought 96 more workers and 96 of them are waiting on the one that was already the problem.

This is why "the cluster is undersized" is the most expensive wrong diagnosis in distributed analytics. It is also why **max ÷ mean is the alert and neither number alone is**: at 32 partitions the mean says 15,000 and the max says 227,801, and only the pair of them says "one worker is doing fifteen times its share".`,
    },
    {
      type: 'prose',
      md: `## Salting, and what it costs

The only structural fix is to stop keeping the hot key whole. Split it across \`S\` sub-partitions, and then — because matching rows must still meet — **replicate the other side of that key into all \`S\` of them**:

\`\`\`
key 7:  1,800 left rows, 3 right rows, S = 4
  left rows   → round-robin over 4 buckets      450 each
  right rows  → copied into ALL 4 buckets       3 × 4 = 12 copies
every (left, right) pair still meets exactly once, in exactly one bucket
\`\`\`

Split the wrong side and you replicate 1,800 rows instead of 3. Replicate *both* sides and every pair is produced \`S\` times and the join is silently wrong.

Measured on the worst distribution, with the heavy hitter split across 8 sub-partitions:

\`\`\`
max ÷ mean       15.19×  →  2.64×        (5.8× better)
busiest max      227,801 →  39,544 rows
build side       4,096   →  4,103 rows   (+7 copies: 1 heavy key × (8 − 1))
unskewed levels  unchanged, byte for byte — no key crosses the fair-share line
\`\`\`

Three things in those four lines are the reason this is taught as a trade rather than a fix.

**It does not reach 1×, and the lab does not claim it does.** Splitting a key that holds share \`s\` across \`S\` buckets bounds its contribution at \`s/S\`, and those sub-partitions still carry ordinary traffic on top. The measured 2.64× is close to that floor. A fix that improves a ratio by 5.8× and stops there is the normal outcome; anyone promising 1.0× has not built one.

**The bill lands on the other side of the join, and it is countable.** 4,096 build rows become 4,103 — seven extra rows, materialised and counted rather than multiplied out in prose. That is trivial here because the heavy hitter's other side is one row per key. It is *not* trivial when the other side is large, which is exactly the trap: each additional bucket costs one more copy of the other side, so past \`heavy / light\` buckets you are moving more bytes than you are moving rows out of the way.

**Salting is the only knob, and the two bills pull in opposite directions.** Forge lab 06 grades this as a policy rather than a preference, and the two degenerate answers both fail:

\`\`\`
never salt                          bytes 1.00×  pass     skew  6.4× bound  FAIL
salt every heavy key everywhere     skew 1.4× mean pass   bytes 1.24× band  FAIL
\`\`\`

The passing rule is one sentence: **salt the keys that blow the bound, by the fewest buckets that clears it, splitting the side that is actually big and replicating the side that is not.** The reference solution lands at **1.01× on bytes with a worst single plan of 1.05×** while holding every graded case under a bound of 3× the average partition, worst case **1.8× the mean**.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — 480,000 rows, five shapes, one number that cannot move',
      height: 74,
      nodes: [
        { id: 't', x: 22, y: 2, w: 56, h: 8, label: '480,000 rows · 4,096 keys · 32 partitions', sub: 'identical totals in every distribution', color: '#A78BFA' },
        { id: 'mean', x: 2, y: 14, w: 40, h: 9, label: 'mean = 15,000 rows', sub: '480,000 ÷ 32 — identical in all five', color: '#94A3B8' },
        { id: 'max', x: 46, y: 14, w: 52, h: 9, label: 'max = 17,489 → 227,801 rows', sub: 'the only number that knows the data', color: '#FB7185' },
        { id: 'lvl', x: 2, y: 26, w: 96, h: 9, label: 'max ÷ mean: 1.17 · 1.47 · 3.00 · 7.55 · 15.19', sub: 'uniform · tail · 5% · 20% · 45% — byte skew tracks at 15.18', color: '#FBBF24' },
        { id: 'more', x: 2, y: 38, w: 46, h: 9, label: 'the reflex: 4× the workers', sub: '128 buckets · ratio 59.09 · max still 221,591', color: '#FB7185' },
        { id: 'salt', x: 52, y: 38, w: 46, h: 9, label: 'the fix: split the hot key 8 ways', sub: '15.19 → 2.64 · max 39,544 rows', color: '#3EF2A4' },
        { id: 'cost', x: 2, y: 50, w: 96, h: 9, label: 'the bill: build side 4,096 → 4,103 rows', sub: '+7 copies per heavy key, and the floor stays above 1×', color: '#22D3EE' },
        { id: 'alert', x: 22, y: 62, w: 56, h: 9, label: 'so alert on max ÷ mean', sub: 'the mean was flat through the entire incident', color: '#A3E635' },
      ],
      edges: [
        { from: 't', to: 'mean' },
        { from: 't', to: 'max' },
        { from: 'mean', to: 'lvl' },
        { from: 'max', to: 'lvl' },
        { from: 'lvl', to: 'more' },
        { from: 'lvl', to: 'salt' },
        { from: 'salt', to: 'cost' },
        { from: 'cost', to: 'alert' },
        { from: 'more', to: 'alert' },
      ],
      steps: [
        {
          caption:
            'One fixture: 480,000 rows over 4,096 fixed-width keys, routed to 32 partitions. Five distributions share the identical row and byte totals, so every difference that follows is caused by the shape and by nothing else.',
          active: ['t'],
        },
        {
          caption:
            'The mean is 15,000 rows in all five, to the row, because it is 480,000 divided by 32 and neither term can respond to the data. The maximum ranges from 17,489 to 227,801 on those same totals.',
          active: ['mean', 'max'],
          edges: ['t->mean', 't->max'],
        },
        {
          caption:
            'As a ratio: 1.17 uniform, 1.47 for a long tail with no hot key, then 3.00, 7.55 and 15.19 as one key crosses and then dwarfs the fair-share line. Byte skew tracks row skew at 15.18, because the keys are fixed width by design.',
          active: ['lvl'],
          edges: ['mean->lvl', 'max->lvl'],
        },
        {
          caption:
            'Add workers and it gets worse: at 128 buckets the mean falls to 3,750 while the hot partition still holds 221,591 rows, so the ratio becomes 59.09 and the job is no faster. The hot key cannot be divided by buying hardware.',
          active: ['more'],
          edges: ['lvl->more'],
        },
        {
          caption:
            'Splitting the heavy hitter across 8 sub-partitions takes the ratio to 2.64 and the busiest partition to 39,544 rows — a 5.8× improvement that stops well above 1×, because a key split S ways still contributes share/S plus ordinary traffic.',
          active: ['salt'],
          edges: ['lvl->salt'],
        },
        {
          caption:
            'And it is charged for on the other side of the join: 4,096 build rows become 4,103, one extra copy per sub-partition per heavy key. Cheap here, ruinous if the other side is large — which is why the policy is the fewest buckets that clears the bound.',
          active: ['cost'],
          edges: ['salt->cost'],
        },
        {
          caption:
            'The monitoring conclusion generalises to anything partitioned: alert on max over mean, because the maximum is the runtime and the mean was flat through the entire incident, on every dashboard, the whole time.',
          active: ['alert'],
          edges: ['cost->alert', 'more->alert'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '15,000',
          label: 'mean rows per partition, in every distribution',
          hint: '480,000 ÷ 32, measured five times and identical to the row. The mean is arithmetic over constants of the fixture, so it cannot report skew even in principle.',
        },
        {
          value: '1.17× → 15.19×',
          label: 'max ÷ mean, uniform to a 45% hot key',
          hint: 'Measured by SQL over the real values. The floor is above 1 because 4,096 keys do not divide evenly into 32 buckets, and a long tail alone only reaches 1.47×.',
        },
        {
          value: '59.09×',
          label: 'the same job at 4× the parallelism',
          hint: '128 buckets: the mean falls to 3,750 while the busiest partition still holds 221,591 of its original 227,801 rows. Adding workers moves the denominator, not the problem.',
        },
        {
          value: '+7 rows',
          label: 'what salting cost on the build side',
          hint: 'One heavy key across 8 sub-partitions means 7 extra copies of its other side: 4,096 build rows become 4,103. Materialised and counted, not estimated.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'segfault',
      title: 'correctness never gets a tolerance — and the honest way to state a scope limit',
      md: `Forge lab 06 has a shape it cannot handle, and what it does about that is the most transferable thing in the lab.

**The limit.** A key that is heavy on **both** sides cannot be bounded by a one-sided split. Splitting the left side replicates the right side into every one of that key's buckets, so no bucket can get below \`min(left(k), right(k))\`. The only bounded plan is a **grid split** — \`s × t\` buckets costing \`s · t\` copies — which this lab does not ask for.

**What the harness does about it.** It does not quietly widen the band. It computes, per plan, whether the bound is *provably reachable*: enough distinct keys for hashing to behave, and a busiest key whose indivisible minimum is small enough that several could share a partition and still fit. Then:

- the **balance** bound is enforced only where it is provable. Running the reference solution: **551 of the 800 storm plans**. On the other 249, the key distribution itself defeats any hash-placed router, and the harness says so in its own pass message rather than in a footnote.
- **correctness is enforced on all 800, with no allowance whatsoever.** 302,982 output pairs, multiset-exact, through the partitioned path and through the plan the planner chose. And where a hand-built case falls outside the stated scope, the harness reports **HARNESS BUG against itself** and fails, because a grader that is itself wrong would silently excuse a wrong answer.

That asymmetry is the model for your own numbers. **A cost claim gets a band and a stated scope; a correctness claim gets neither.** A shuffle that loses a pair has not made the job cheaper — it has made the answer wrong, and nothing in the system will tell you.`,
    },
    {
      type: 'prose',
      md: `## The incident, and what was on the dashboard

Column Week's third drill is this lesson arriving at 03:00. A nightly join between \`events\` and \`accounts\` has crept from 8 minutes to 51. The plan is unchanged. Both tables grew normally. Cluster utilisation during the run averages **14%**. The telemetry:

- **mean partition bytes: flat at 4 GB** for the entire 24-point window
- **max partition bytes: 9 GB rising to 128 GB**
- **workers idle: 20% rising to 86%**
- **spill bytes: 0 for ten points, then rising to 74 GB**

Every wrong answer on that card is something a competent engineer says in a real meeting. "The cluster is undersized — look at the mean partition size" fails because the mean is flat by construction. "Network bandwidth saturated" fails because utilisation is 14%. "Double the cluster" leaves the large partition on one worker (and, measured above, makes the ratio worse). "More memory per worker" stops the spill and leaves the partition single-threaded — it converts a slow job into a slightly less slow job, which is the most seductive of the four because it *does* improve something.

The two-part fix is the one this lesson prices: split the hot key, and **alert on max ÷ mean**, because the mean was flat throughout and no threshold on it could ever have fired.

One more thing to take from the shape of that incident: **it crept.** The hot key did not appear overnight; an account's share of the rows grew until it crossed the fair-share line, and the job's runtime followed the maximum rather than the total. That is why the ratio belongs on a dashboard next to cost, and why a step change in it is a schema-and-distribution question rather than a capacity one.`,
    },
    {
      type: 'isomorphism',
      title: 'max ÷ mean ≡ three ratios you already trust more than an average',
      pairs: [
        {
          os: 'p99 latency versus mean latency',
          osLine:
            'Nobody has reported a service healthy on its mean since about 2013, because the user experience is set by the tail and the mean hides it.',
          llm: 'max partition versus mean partition',
          llmLine:
            'Identical statistics, identical mistake, and worse: the mean here is rows ÷ partitions, so it cannot move with the distribution at all — it is not even a lagging indicator.',
        },
        {
          os: 'static partitioning versus a work queue',
          osLine:
            'You stopped hand-sharding parallel loops the day one shard took four times as long. A queue turns an unpredictable distribution into a granularity choice.',
          llm: 'morsels versus a skewed hash partition',
          llmLine:
            'C4.L5 exactly, one layer out — with one difference that matters: a morsel can always be made smaller, and a single hot key cannot be split at all without replicating its counterpart.',
        },
        {
          os: 'a hot shard in a sharded key-value store',
          osLine:
            'One celebrity account, one shard, and resharding does not help because the unit of placement is the key. The fix is a composite key or a dedicated path.',
          llm: 'a heavy hitter in a hash exchange',
          llmLine:
            'The same fix under a different name: salting is a composite key chosen at plan time, and its cost is replicating the other side into every sub-bucket.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A partitioned join over 32 workers has a max ÷ mean partition ratio of 15. A colleague proposes moving to 128 workers, arguing that each partition will then hold a quarter as much. What actually happens, and what is the number that settles it?',
          options: [
            'The ratio falls to about 3.75 and the job finishes roughly 4× sooner, since partition size scales inversely with worker count',
            'The ratio rises to about 59 and the busiest partition barely changes — measured, 227,801 rows becomes 221,591 — because the mean falls with the partition count while a single key cannot be divided at all',
            'The ratio is unchanged, since it is a property of the key distribution rather than of the parallelism',
            'The ratio improves only if the engine re-hashes with a different seed at the higher worker count',
          ],
          correct: [1],
          explanation:
            'The mean is rows ÷ partitions, so raising the partition count divides the denominator and improves nothing in the numerator: the hot key still lands in exactly one partition, whole. The lab measures it — 32 buckets give a mean of 15,000 with a max of 227,801 (15.19×); 128 buckets give a mean of 3,750 with a max of 221,591 (59.09×), so the busiest worker retained 97% of its work while the cluster grew fourfold. The ratio is not invariant either, which is why quoting it without the partition count is meaningless. Re-hashing moves the hot key to a different partition and changes nothing about its size.',
        },
        {
          q: 'You are about to salt a heavy hitter that holds 30% of a 200-million-row fact table. The other side of that key holds 40 million rows. What is the correct assessment?',
          options: [
            'Split the fact side across 32 sub-partitions and replicate the 40 million rows into each — the balance is what matters and replication is cheap relative to the fact table',
            'This is the case one-sided salting cannot fix: the key is heavy on both sides, so every bucket carries at least the smaller side\'s 40 million rows, and only a grid split — s × t buckets at s · t copies — bounds it. Say so, and price the grid, rather than reporting a balanced plan that moves several times the table',
            'Split the 40-million-row side instead, since splitting the smaller side always produces fewer copies',
            'Salting is unnecessary at 30%; a 30% hot key is within normal variation for a hash partitioning',
          ],
          correct: [1],
          explanation:
            'Replicating the smaller side into every bucket has a floor: no bucket can get below min(left, right) for that key, so with 40 million rows on the light side, 32 buckets would move 1.28 billion row-copies — several times the whole table — to achieve balance that still is not achieved. This is precisely the scope limit forge lab 06 documents rather than papers over: a key heavy on both sides needs a grid split, and the harness only enforces its balance bound where it is provably reachable, on 551 of 800 plans, while enforcing correctness on all 800. Splitting the smaller side replicates the bigger one, which is the same mistake as broadcasting a fact table. And 30% on one key is not variation: the uniform control in the lab measures 1.17× and a long tail alone reaches only 1.47×.',
        },
        {
          q: 'You have to justify one monitoring change to a platform team whose dashboards are already crowded. Which do you ask for, and how do you defend it in one sentence?',
          options: [
            'Mean partition size per exchange, because it is the simplest capacity signal and correlates with data growth',
            'Max ÷ mean partition size per exchange, because the maximum is the runtime and the mean is rows ÷ partitions — so in the incident that motivated this, the mean sat flat at 4 GB while the max went from 9 GB to 128 GB and idle workers went from 20% to 86%',
            'Cluster CPU utilisation, because a skewed job shows up as low utilisation and that is the cheapest signal to collect',
            'Total bytes shuffled per job, because skew increases the bytes that have to cross the exchange',
          ],
          correct: [1],
          explanation:
            'The ratio is the only one of these that can fire on this failure. The mean is arithmetically incapable of moving with the distribution, so no threshold on it can ever alert. Utilisation does move — 14% in the incident — but it is ambiguous: an idle cluster looks the same whether the cause is skew, a serial stage, or a small job, so it diagnoses nothing on its own and pages on everything. Total bytes shuffled is the trap answer here, because skew does not change it: partitioning moves both sides once regardless of distribution, which is exactly why a shuffle can be perfectly within its byte budget and take six times as long. Bringing the specific incident numbers — flat 4 GB mean against a 9 GB to 128 GB max — is what turns the request from a preference into an argument.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: forty years of skew, and why it keeps being rediscovered',
      md: `**DeWitt, Naughton, Schneider and Seshadri, "Practical Skew Handling in Parallel Joins" (VLDB 1992)** is the paper this lesson is a re-derivation of, and it is worth reading for how little has changed: it names the two skew families (partition skew and the data skew that causes it), and its answers — sampling to find heavy hitters, then treating them specially — are what a modern engine's skew join hint does.

**Kwon, Balazinska, Howe and Rolia, "SkewTune: Mitigating Skew in MapReduce Applications" (SIGMOD 2012)** is the operational counterpart: it detects the straggler *at runtime* and re-partitions its remaining work, which is the design you actually want because it needs no prior statistics. Read it next to **Spark's Adaptive Query Execution skew-join documentation**, which is the same idea shipped as a configuration flag, and note what both need in order to work: a way to split a partition's remaining input, which is easy for one side and hard when both sides are heavy.

For the sampling side, **Cormode, Muthukrishnan et al. on heavy hitters** is the standard reference and the reason a planner can find a hot key cheaply. Forge lab 06 hands you exact counts precisely so that the *policy*, not the estimation, is what you have to get right.

On the theoretical floor, **the "3-way join" and worst-case-optimal join literature (Ngo, Porat, Ré, Rudra)** is where the grid-split intuition comes from formally: when both sides of a key are large, no partitioning of one side can bound the work, and the product structure of the output is the reason.

Siblings: **C4.L5** derives the same maximum-versus-mean argument in the single-node scheduler, where morsel-driven parallelism solves it because a morsel can always be cut smaller. **C2.L2** shows the same distribution ruining partition pruning, where the pruning ratio looks excellent and the bytes barely move.`,
    },
  ],
}

export default lesson
