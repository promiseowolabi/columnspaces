import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c6.l2',
  slug: 'broadcast-or-partition',
  trackId: 'c6',
  index: 2,
  title: 'Broadcast or Partition',
  minutes: 16,
  hook: 'Broadcast moves the small side once per worker; partitioning moves both sides once. The crossover is exactly 1 + probe/small, which means the plan that was right last quarter is arithmetic away from being wrong this one.',
  exercise: 'lab+quiz',
  takeaway: {
    number: '1 + probe/small',
    claim:
      'Broadcast is cheaper on bytes moved exactly while workers are below one plus the probe-to-build ratio — so a broadcast hint has an expiry date set by two numbers, either of which somebody else can change.',
  },
  blocks: [
    {
      type: 'prose',
      md: `There are two ways to make matching rows meet, there is no third one, and the choice between them is arithmetic rather than taste.

\`\`\`
BROADCAST     send the whole small side to every worker; the big side never moves
              bytes = small × workers

PARTITION     hash both sides on the join key so rows with the same key co-locate
              bytes = small + probe
\`\`\`

Set them equal and the crossover falls out in one line. Broadcast moves no more than partitioning exactly while:

\`\`\`
small × w  ≤  small + probe
        w  ≤  1 + probe / small
\`\`\`

That is the whole decision. \`The Shuffle Planner\` computes it as a closed form rather than searching for it, and its test suite checks the closed form against a brute-force sweep over worker counts — because a crossover that is nearly right is worse than no crossover at all. The same relation solved for the other variable is the one that actually bites in production:

\`\`\`
small  ≤  probe / (w − 1)
\`\`\`

**Read that as an expiry date.** A broadcast hint added when the dimension table was 200 MiB and the cluster was 8 workers is a claim about two numbers, and both of them are owned by other people. The build side grows because somebody adds a column. The worker count grows because somebody wants the quarterly report faster. Neither event produces an error, and the plan quietly starts moving an order of magnitude more bytes than it needs to.`,
    },
    {
      type: 'prose',
      md: `## Three joins, and the arithmetic each one forces

These are the lab's three joins, all at 32 workers, with the numbers it computes. Do them by hand once — every figure below is two multiplications.

| join | build side | probe side | broadcast moves | partitioned moves | cheaper on bytes | crossover workers |
|---|---|---|---|---|---|---|
| orders ⋈ customers | 180 MiB | 42 GiB | 5.6 GiB | 42.2 GiB | **broadcast**, by 7.5× | 239 |
| events ⋈ user_profiles | 9 GiB | 64 GiB | 288 GiB | 73 GiB | **partitioned**, by 3.9× | 8 |
| clicks ⋈ campaigns | 1.6 GiB | 47 GiB | 50 GiB | 48.6 GiB | **partitioned**, by 3% | 31 |

Three things in that table are worth more than the answers.

**The first row is why the folklore exists.** A 180 MiB dimension against a 42 GiB fact is broadcast by a factor of seven and a half, and it stays broadcast until **239 workers**. Someone who has only ever worked star schemas at this ratio can spend a career saying "broadcast the small side" and never be wrong.

**The second row is why the folklore expires.** Identical shape, and the build side has grown to 9 GiB — a profile table that used to be megabytes. Now broadcast moves **288 GiB against 73 GiB**, four times the bytes, and the crossover has collapsed to **8 workers**. Nobody re-ran the arithmetic when the table grew, which is exactly how a hint outlives its justification. The tell is available for free: \`small ≤ probe / (w − 1)\` is 64 GiB ÷ 31 ≈ 2.1 GiB, and the build side is four times that.

**The third row is why you multiply instead of eyeballing.** 1.6 GiB against 47 GiB *looks* like the first row. It is 3% the other way, and its crossover is 31 workers — meaning at the 32 workers this cluster actually has, broadcast lost by a hair. A join within a few percent of the crossover is a join where both confident answers are wrong until somebody has done the sum.`,
    },
    {
      type: 'prose',
      md: `## The second question, which is not the same question

Bytes moved is a **total**. A job does not wait on a total; it waits on the worker with the most work. Those are the same number only when the work divides evenly — and a hash partitioning divides evenly only when the key is uniform, which C6.L3 will show is a stronger assumption than anyone treats it as.

So each plan has a second cost, and it is a different formula:

\`\`\`
broadcast,   busiest worker  =  small + probe / workers
partitioned, busiest worker  =  (small + probe) × max(hotShare, 1 / workers)
\`\`\`

The asymmetry is the point of this lesson. **Broadcast is skew-immune on the probe side.** The probe rows are read from the files they already live in and are never re-routed, so no key distribution can pile them onto one worker. Its skew factor is *exactly 1* by construction — every worker does the identical amount of work. Partitioning's busiest worker, meanwhile, is multiplied by \`hotShare × workers\`, which at 32 workers turns a 40% hot key into a skew factor of **12.80**.

Re-cost the third join with its key revealed — \`campaign_id\` of the always-on evergreen campaign, 40% of the rows:

\`\`\`
broadcast    busiest worker  =  1.6 GiB + 47 GiB / 32   =  3.0 GiB    skew 1.00
partitioned  busiest worker  =  48.6 GiB × 0.40         = 19.4 GiB    skew 12.80
\`\`\`

**Partitioned wins on bytes by 3% and loses on the busiest worker by 6.41×.** That is the decision flipping, and it flips on the term that decides the runtime rather than on the term that decides the total.

The hot-share threshold at which it flips is also closed form — set the two busiest-worker expressions equal:

\`\`\`
share  ≥  (small + probe / w) / (small + probe)
\`\`\`

For the three joins that threshold is **3.5%**, **15.1%** and **6.2%**. And this is where the lab refuses to let you learn the next piece of folklore: \`events ⋈ user_profiles\` has a genuinely hot key at **6%** — nearly double an even share of 1/32 — and 6% is below its 15.1% threshold, so the partitioned plan is still right on the busiest worker as well as on bytes. Of the three joins, **exactly one flips and exactly one has real skew where the plan does not change.** A reader who answers "skew means broadcast" fails the lab, by design.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — clicks ⋈ campaigns: two plans, two questions, two different winners',
      height: 70,
      nodes: [
        { id: 'j', x: 20, y: 2, w: 60, h: 8, label: 'clicks ⋈ campaigns', sub: '1.6 GiB build · 47 GiB probe · 32 workers', color: '#A78BFA' },
        { id: 'b', x: 2, y: 14, w: 46, h: 9, label: 'broadcast: 1.6 GiB × 32', sub: '50 GiB moved · each worker holds all 1.6 GiB', color: '#FBBF24' },
        { id: 'p', x: 52, y: 14, w: 46, h: 9, label: 'partitioned: 1.6 + 47', sub: '48.6 GiB moved · each worker holds its slice', color: '#22D3EE' },
        { id: 'q1', x: 2, y: 26, w: 96, h: 8, label: 'question 1 — total bytes moved: partitioned, by 3%', sub: 'crossover is 31 workers, and the cluster has 32', color: '#3EF2A4' },
        { id: 'b2', x: 2, y: 36, w: 46, h: 9, label: 'broadcast busiest worker: 3.0 GiB', sub: 'skew factor exactly 1 — the probe side never re-routes', color: '#FBBF24' },
        { id: 'p2', x: 52, y: 36, w: 46, h: 9, label: 'partitioned busiest worker: 19.4 GiB', sub: '40% hot key × 32 workers = skew factor 12.80', color: '#FB7185' },
        { id: 'q2', x: 2, y: 48, w: 96, h: 8, label: 'question 2 — busiest worker: broadcast, by 6.41×', sub: 'same statistics, different question, opposite answer', color: '#3EF2A4' },
        { id: 'flip', x: 20, y: 59, w: 60, h: 9, label: 'one join of three flips', sub: 'and one has real skew that changes nothing — so "skew means broadcast" fails', color: '#94A3B8' },
      ],
      edges: [
        { from: 'j', to: 'b' },
        { from: 'j', to: 'p' },
        { from: 'b', to: 'q1' },
        { from: 'p', to: 'q1' },
        { from: 'b', to: 'b2' },
        { from: 'p', to: 'p2' },
        { from: 'b2', to: 'q2' },
        { from: 'p2', to: 'q2' },
        { from: 'q2', to: 'flip' },
      ],
      steps: [
        {
          caption:
            'One join, three statistics: a 1.6 GiB build side, a 47 GiB probe side and 32 workers. Everything that follows is two multiplications on those three numbers, and no planner opinion is required.',
          active: ['j'],
        },
        {
          caption:
            'Broadcast sends the build side to every worker: 1.6 GiB times 32 is 50 GiB on the wire, and every worker must hold the whole 1.6 GiB in memory to probe against it. Partitioning moves each side exactly once: 48.6 GiB.',
          active: ['b', 'p'],
          edges: ['j->b', 'j->p'],
        },
        {
          caption:
            'On total bytes the partitioned plan wins by 3%, which is close enough that the crossover matters: broadcast is cheaper up to 31 workers, and this cluster has 32. One more worker next quarter does not change the answer; one fewer would have.',
          active: ['q1'],
          edges: ['b->q1', 'p->q1'],
        },
        {
          caption:
            'Now ask what the busiest worker receives, because that is what the job waits on. Broadcast: the build side plus an even 1/32 of the probe side, 3.0 GiB, with a skew factor of exactly 1 because probe rows are never re-routed by the key.',
          active: ['b2'],
          edges: ['b->b2'],
        },
        {
          caption:
            'Partitioning: the hot campaign holds 40% of the rows, so its partition receives 40% of 48.6 GiB — 19.4 GiB, a skew factor of 12.80 against the mean. Skew changed no byte total at all; it multiplied one term of one plan.',
          active: ['p2'],
          edges: ['p->p2'],
        },
        {
          caption:
            'So the two questions have opposite answers on the same statistics, and this join is the one of three where that happens. The discipline is to ask both — total bytes for the bill, busiest worker for the wall clock.',
          active: ['q2', 'flip'],
          edges: ['b2->q2', 'p2->q2', 'q2->flip'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '239 vs 8',
          label: 'crossover worker count, 180 MiB build against 9 GiB build',
          hint: 'Both from 1 + probe/small on real probe sides of 42 and 64 GiB. Same query shape; the plan that is right differs by a factor of thirty in cluster size.',
        },
        {
          value: '1.00',
          label: 'broadcast skew factor, always',
          hint: 'Every worker receives the whole build side and reads an even slice of the probe side, so the busiest and mean workers are the same number regardless of key distribution.',
        },
        {
          value: '12.80',
          label: 'partitioned skew factor at a 40% hot key over 32 workers',
          hint: 'hotShare × workers. Skew leaves the byte total untouched and multiplies only the busiest-worker term, which is why a plan can be cheaper and slower at once.',
        },
        {
          value: '1 of 3',
          label: 'joins where the decision flips once the key is known',
          hint: 'Pinned by the lab test suite. Exactly one flips and exactly one has genuine skew where the plan does not change, so "skew means broadcast" cannot pass.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'info',
      title: 'the named loser: broadcast fails on memory before it fails on bytes',
      md: `Every layout and every plan privileges something and starves something else, so name what broadcast is bad at:

- **Every worker must hold the entire build side in memory** to probe against it. The lab tracks this separately from bytes moved, and it is usually the constraint that bites first: 9 GiB per worker is a hash table that does not fit, whichever way the byte arithmetic came out. A partitioned plan holds only \`small × share\` — its slice.
- **Its cost grows with the cluster and partitioning's does not.** That is why forge lab 06 grades \`broadcast_choice\` as *strictly* fewer bytes: on an exact tie, partition. The plan whose cost is flat in worker count is the one you want to be holding when somebody adds workers next quarter. Running the harness, its case set contains **6 exact ties** among 260 graded plans, and it fails *itself* if the set contains no tie — because "strictly fewer" would otherwise not actually be graded.
- **It re-reads the build side once per worker.** On disaggregated storage that is 32 independent reads of the same bytes, which is a request-count question as well as a byte-count one (C0.L3).

And name what partitioning is bad at, which is the whole of the next lesson: the key decides the split, and a key that is not uniform hands one worker a disproportionate share.`,
    },
    {
      type: 'lab',
      lab: 'shuffle-planner',
    },
    {
      type: 'prose',
      md: `## What the lab grades, and what it cannot

Five rungs: cost both plans from the stated statistics and pick the cheaper on bytes; name the largest worker count at which broadcast is still no more expensive; re-cost the flipping join with the hot key revealed; get **both** answers right on that join; and answer the join where the key is genuinely skewed and the plan does not change.

Everything in it is a count of bytes and rows. There is no clock, no randomness and no data — the statistics are *stated*, exactly as they arrive in a planning conversation, and the whole exercise is what follows from them.

**What it does not model, and you should say so first:**

- **Filters before the join.** The costing takes the projected sizes as given. In a real plan the build side is whatever survives its predicates, and a broadcast decision made on table size rather than on post-filter size is the second most common way this goes wrong.
- **Adaptive re-planning.** Modern engines can start a partitioned shuffle, observe the actual partition sizes and switch strategy or split the hot partition at runtime. That does not remove the arithmetic — it means the engine may do it for you, on statistics it gathers rather than on the ones the catalog held.
- **The build-side memory ceiling as a hard failure.** The lab reports memory per worker; a real cluster reports an out-of-memory error, and a broadcast that does not fit is not a slow plan, it is a failed query.
- **Multi-way joins.** Three tables mean a join *order* as well as two plan choices per join, and the intermediate result sizes are estimates. This lesson's arithmetic is exact only for the two-table case; past that, the honest form is the same sum with an error bar around each intermediate cardinality.

Forge lab 06 grades the same decision in Rust against the same arithmetic, and grades it the way you should defend it: never against a stored answer. The harness recomputes \`small × workers\` against \`(left + right) × 16\` for every case, over worker counts from 1 to 4,096, with the small side on both the left and the right — and it fails itself if its case set does not flip both ways. Running the reference solution, **260 plans: 18 where broadcast moves fewer bytes, 242 where partitioning does, 6 exact ties.**`,
    },
    {
      type: 'isomorphism',
      title: 'broadcast versus partition ≡ decisions you have already made',
      pairs: [
        {
          os: 'replicating a lookup table to every application server',
          osLine:
            'Fine while the table is small and the fleet is small. The cost is the table times the fleet, and it grows when either does — which is why it is always discovered during a scale-out.',
          llm: 'a broadcast join',
          llmLine:
            'Identical arithmetic: small × workers. The crossover is where the fleet gets big enough that shipping one copy each costs more than routing the requests.',
        },
        {
          os: 'a covering index versus a sort-merge over both tables',
          osLine:
            'One puts the small thing where the big thing already is; the other reorganises both. The choice is selectivity arithmetic, not preference.',
          llm: 'broadcast versus partitioned',
          llmLine:
            'The same shape at cluster scale, with the ratio of the two sides in place of selectivity — and the same failure mode when the ratio changes and nobody re-runs the sum.',
        },
        {
          os: 'a CDN edge cache versus routing by hash',
          osLine:
            'Replicate to every edge, or send each key to the one node that owns it. Replication is even and expensive; hashing is cheap and vulnerable to hot keys.',
          llm: 'the two plans, and the skew asymmetry',
          llmLine:
            'Broadcast has a skew factor of exactly 1 and a total that scales with the fleet; partitioning has a flat total and a busiest worker multiplied by hotShare × workers.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A join has a 6 GiB build side and a 120 GiB probe side, currently running well as a broadcast on 16 workers. Capacity planning wants to move to 64 workers to cut the nightly window. What happens to this join, and what do you say in the meeting?',
          options: [
            'Nothing — broadcast cost depends on the build side, which is unchanged, so the join scales with the cluster like everything else',
            'It becomes the wrong plan: the crossover is 1 + 120/6 = 21 workers, so at 64 workers broadcast moves 384 GiB against 126 GiB, and each worker still has to hold the whole 6 GiB build side in memory',
            'It gets faster in proportion to the workers added, because each worker processes a smaller slice of the probe side',
            'It depends on the key distribution, which has to be sampled before anything can be said',
          ],
          correct: [1],
          explanation:
            'Broadcast is the one plan whose total cost is proportional to the cluster, so a scale-out is exactly the event that invalidates it. The crossover is arithmetic available before the change: 1 + probe/small = 21 workers, and the proposal is 64. At 64 workers broadcast moves 6 × 64 = 384 GiB against 6 + 120 = 126 GiB partitioned, so the plan that was three times cheaper becomes three times more expensive. The memory point matters too — 6 GiB of build side per worker is a real constraint that partitioning reduces to a slice. Sampling the key is the right instinct for the second question, but it cannot rescue a plan that has already lost the first one by 3×.',
        },
        {
          q: 'A join is 3% cheaper on total bytes as a partitioned shuffle. Sampling then reveals one key holds 35% of the rows over 32 workers. Which statement is correct?',
          options: [
            'Skew raises the total bytes moved by the partitioned plan, so broadcast is now cheaper on both counts',
            'Skew leaves both byte totals exactly unchanged and multiplies only the partitioned plan\'s busiest worker, by hotShare × workers = 11.2 — so the plan can be cheaper on the bill and much slower on the clock, and which one you optimise is a stated choice',
            'Skew always means broadcast, since broadcast has no partitioning step to be skewed',
            'The hot key should be filtered out and handled by a separate query, which is the only correct fix',
          ],
          correct: [1],
          explanation:
            'Byte totals are conservation statements: partitioning moves both sides once whatever the distribution, and broadcast moves small × workers whatever the distribution. Skew changes neither. What it changes is the busiest-worker term of the partitioned plan, multiplying it by hotShare × workers — 0.35 × 32 = 11.2 here — while leaving broadcast at a skew factor of exactly 1. So this join probably does flip on the runtime question, but "skew means broadcast" is still wrong as a rule: the lab has a join with a genuinely hot key at 6% where the threshold is 15.1% and the partitioned plan remains correct on both questions. The threshold is (small + probe/w) / (small + probe), and it is one division. Splitting the hot key out is a legitimate third option — that is salting, and C6.L3 prices it.',
        },
        {
          q: 'You inherit a warehouse where every large join carries a broadcast hint added two years ago. What is the cheapest reliable audit, given a catalog with table sizes and a known worker count?',
          options: [
            'Remove all the hints and let the optimiser decide, since modern optimisers have better statistics than the original authors did',
            'For each hinted join compute probe / (workers − 1) and compare it against the build side: any join whose build side exceeds that ratio is moving more bytes than a shuffle would, and the list is produced from catalog metadata without running a query',
            'Run each join both ways in a staging cluster and keep the faster plan',
            'Sort the joins by table size and re-examine the ten largest, since the cost of a wrong plan scales with data volume',
          ],
          correct: [1],
          explanation:
            'The crossover rearranged for the build side turns the audit into a metadata query: small ≤ probe / (w − 1) is the condition for the hint still being justified, so every hinted join can be classified from sizes you already have, with no execution and no cluster time. Removing all hints is the tempting answer and it is a change with unbounded blast radius — some of those hints are load-bearing, and the optimiser only beats the author where its statistics are current. A/B running in staging costs cluster time proportional to the number of joins and tells you about staging data volumes. Sorting by table size misses the actual risk, which is the ratio between the two sides and the worker count, not the absolute size — a huge join at a 1000:1 ratio is safely broadcast while a modest one at 4:1 is not.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: join strategies, and where the arithmetic stops being enough',
      md: `**DeWitt and Gray, "Parallel Database Systems: The Future of High Performance Database Systems" (CACM 1992)** is the clearest statement of the two strategies and of why the partitioned form is the one that scales — read it alongside **Schneider and DeWitt's 1989 SIGMOD comparison of four parallel join algorithms**, which is where the cost models in this lesson come from and which is explicit about the assumptions they need.

For where the closed form stops being enough, **"Adaptive Query Processing" (Deshpande, Ives and Raman, 2007)** surveys what engines do when the statistics turn out to be wrong mid-query, and **Spark's Adaptive Query Execution documentation** is the most widely deployed instance: it converts a partitioned join to a broadcast one at runtime once it sees the real build-side size. The lesson to take is not that the arithmetic is obsolete — it is that the engine may run it for you on better numbers, and you still have to know what it computed to review its decision.

**Neumann and Leis, "Compiling Database Queries into Machine Code" and the HyPer line of papers** are useful here for the single-node analogue: the same build-versus-probe asymmetry, priced in cache misses instead of network bytes.

Finally, **Zamanian, Binnig and Salama, "Locality-aware Partitioning in Parallel Database Systems" (SIGMOD 2015)** is the answer to the reader who asks "why not co-partition everything on the join key in the first place" — a real question with a real answer about which joins you can pre-pay for and what it costs the ones you did not anticipate.

Siblings: **C6.L1** for what does and does not cross the exchange at all, and **C2.L2** on sort keys versus partition keys, because a table already distributed on the join key needs no shuffle and that decision was made by whoever wrote the loader.`,
    },
  ],
}

export default lesson
