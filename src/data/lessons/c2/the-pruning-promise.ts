import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c2.l6',
  slug: 'the-pruning-promise',
  trackId: 'c2',
  index: 6,
  title: 'The Pruning Promise',
  minutes: 19,
  hook: 'A promised pruning ratio is also a stated downside: promise 99.5% and you have promised a 200× multiplier if physical order stops holding. Say both numbers, or neither is credible.',
  exercise: 'desk+quiz',
  artifact: 'layout-design',
  takeaway: {
    number: '200×',
    claim:
      'The downside of a promised pruning ratio is 1 ÷ (1 − r), so a 99.5% promise commits you to a 200× exposure — which is why the promise ships with a named starved query and a clustering-depth monitor rather than on its own.',
  },
  blocks: [
    {
      type: 'prose',
      md: `This lesson turns C2 into the artifact you leave the track holding: a **layout design**. One page, four fields, and it is graded — the layout desk checks \`prunes_target\`, \`file_count_sane\`, \`worst_query_stated\` and \`no_false_negatives\`, which are exactly the four things this track has been building toward.

Start with the thing that makes it a design document rather than a description. **A pruning ratio stated in advance is a promise**, and a promise has a downside that is pure arithmetic:

\`\`\`
if the promised ratio is r, and physical order stops holding,
the bytes multiply by  1 ÷ (1 − r)

r = 0.90   →   10×
r = 0.95   →   20×
r = 0.99   →  100×
r = 0.995  →  200×
\`\`\`

Read that table twice, because it inverts an intuition. **The better the ratio you promise, the larger the crater when the promise fails.** A design promising 99.5% pruning is a design in which one upstream change to write order multiplies the biggest line in the scan budget by two hundred. C0.L1's fixture measured the collapse directly — 39.8× on an identical query, from write order alone — and Column Week's first drill is that collapse arriving as a bill twelve hours after clustering depth moved.

This is why a pruning ratio never travels alone. It travels with the query it starves, and with the monitor that catches it moving. Those are three of the desk's four checks, and the fourth is the one that says a layout may change your bill and must never change your answer.`,
    },
    {
      type: 'prose',
      md: `## First: what "pruning ratio" is a ratio of

Be precise, because a vague version of this number is unfalsifiable and therefore worthless in a review. The layout designer's model defines it exactly as:

> row groups skipped ÷ row groups the class could have read

Three properties of that definition matter.

**It is per query class, never per table.** A table-level pruning ratio is a weighted average over query classes, and averages hide the class that gets nothing. The same design in the layout designer's model prunes 99.3% for the dashboard class and **0.0%** for the needle class. "This table prunes 94%" is a true sentence containing no information.

**It is a ratio of blocks, not of bytes.** Blocks are what a planner decides about. Bytes follow from blocks times projection, and keeping them separate is what lets you attribute a regression to layout rather than to somebody adding a column to a dashboard tile.

**It is bounded above by selectivity and below by clustering.** A useful model to promise from, with clustering depth \`d\` (C0.L4's metric — how many blocks a typical value's range overlaps), a predicate covering fraction \`f\` of the domain, and \`N\` blocks:

\`\`\`
blocks read   ≈  d × (f × N + 1)
pruning ratio ≈  1 − d × (f × N + 1) ÷ N

N = 15,259 blocks, f = 1/90 (one day of ninety):
  d = 1  →  read ~170 blocks  →  98.9% pruned
  d = 9  →  read ~1,528       →  90.0% pruned
\`\`\`

Depth is a straight multiplier on the bytes. That is the single most useful thing to know when the bill moves and nothing in your code changed — and it is why depth, not the ratio, is the thing to alarm on: it moves first.`,
    },
    {
      type: 'prose',
      md: `## The measured shape of the trade

The layout designer prices five query classes against **one** physical design, over a grid of every design the reader can express: 4 partition keys × 6 sort keys × 5 row-group sizes = **120 designs**. Files are always eight row groups, so shrinking a row group buys finer pruning *and* multiplies the footers every query must open — the two effects the row-group knob has to be judged on together.

Here is the conventional, competent, obvious design — day partitions, sorted by \`tenant_id\`, 128Ki-row groups — priced across the mix:

| class | bytes one pass | pruned | files touched | starvation |
|---|---|---|---|---|
| dashboard | 116.5 MiB | 99.3% | 51 | 6.5× |
| tenant-audit | 6.56 GiB | 80.2% | 1,278 | **21.7×** |
| region-rollup | 11.44 GiB | 67.5% | 403 | 4.6× |
| needle | 71.19 GiB | 0.0% | 1,278 | 9.8× |
| analyst (ad-hoc) | 59.31 GiB | 7.4% | 1,186 | 1.1× |

**Starvation** is measured as a ratio — bytes this class scans here, divided by the fewest bytes it could scan under *any* design in the grid — and the model is explicit about why: in absolute bytes the answer would be a constant forever, because the ad-hoc class projects the widest payload and therefore scans the most under every design. The ratio asks the question that teaches: *relative to the best you could have done for this class, how badly does this design treat it?*

Which produces the finding worth carrying. The worst-served class here is **not** the one reading the most bytes. The needle scans 71 GiB and the tenant audit scans 6.5 GiB, but the audit is **21.7× off its own achievable best** while the needle is 9.8× off. If you name your starved query by absolute bytes you will name the wrong one, defend the wrong thing, and be corrected in the room.

And the ad-hoc class at starvation 1.1 is the tell: it is already almost as well served as it can ever be, and its best case anywhere in the 120-design grid is still **54.05 GiB** — the largest bill in the mix at its own optimum. That is a computed fact rather than an opinion, and it is what makes "this class needs a quota, not a layout" a defensible sentence rather than a shrug.`,
    },
    {
      type: 'prose',
      md: `## What a promise costs, in the only two designs that keep it

Give the design two targets, both counts: the dashboard class must come in under **128 MiB** per pass, and the **worst-served class** must stay under **5 GiB**. The conventional design above passes the first (116.5 MiB) and fails the second (6.56 GiB) — competent, conventional, and it abandons a class.

Sweep all 120. **Exactly two designs satisfy both**, and they differ only in row-group size:

| design | dashboard | worst class | files touched by the dashboard |
|---|---|---|---|
| day / \`tenant_id\` / 32Ki rows | 82.5 MiB | tenant-audit, 4.54 GiB | **168** |
| day / \`tenant_id\` / 8Ki rows | 84.4 MiB | tenant-audit, 4.27 GiB | 639 |

The smaller row group reads **more** bytes (84.4 against 82.5 MiB) while touching **3.8× the files**. Finer pruning did not win: the footer tax overtook the pruning gain, which is C2.L5's arithmetic showing up as a measured crossing rather than a warning. That crossing is what \`file_count_sane\` exists to catch, and it is the reason the desk grades file count separately instead of folding it into bytes.

Now the price of the promise, which is the sentence that makes a design review honest. The design that *minimises* the dashboard bill is tenant partitions sorted by \`ts\` at 8Ki rows, and it gets the dashboard to **17.9 MiB** — 4.6× better than the 82.5 MiB above. It also leaves the needle class at **71.5 GiB**, 9.8× off that class's best.

So the shipped design gives up **4.6× on the headline query** to keep the starved one under a ceiling. That is not a compromise to apologise for; it is the deliverable. Write it down as a line in the document, because a layout recommendation with no named loser is not a recommendation — it is a preference with numbers attached.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — from 120 priced designs to one page somebody signs',
      height: 76,
      nodes: [
        { id: 'grid', x: 2, y: 2, w: 30, h: 9, label: '120 designs priced', sub: '4 partition × 6 sort × 5 row group', color: '#A3E635' },
        { id: 'mix', x: 35, y: 2, w: 30, h: 9, label: 'against 5 query classes', sub: 'one physical order for all of them', color: '#A3E635' },
        { id: 'two', x: 68, y: 2, w: 30, h: 9, label: '2 satisfy both targets', sub: 'day / tenant_id / 32Ki', color: '#22D3EE' },
        { id: 'p1', x: 2, y: 15, w: 46, h: 9, label: '1 · the promised ratio', sub: 'per class, from clustering depth', color: '#3EF2A4' },
        { id: 'p2', x: 52, y: 15, w: 46, h: 9, label: '2 · the file count', sub: '168 files, not 639 — the footer tax', color: '#3EF2A4' },
        { id: 'p3', x: 2, y: 28, w: 46, h: 9, label: '3 · the starved query, named', sub: 'tenant-audit, 21.7× off its best', color: '#FBBF24' },
        { id: 'p4', x: 52, y: 28, w: 46, h: 9, label: '4 · the correctness line', sub: '0 false negatives, ever', color: '#FBBF24' },
        { id: 'doc', x: 20, y: 41, w: 60, h: 9, label: 'the layout design', sub: 'four fields · what the desk grades', color: '#A78BFA' },
        { id: 'cav', x: 20, y: 54, w: 60, h: 9, label: 'the caveat, said first', sub: '99.5% promised means 200× exposed', color: '#FB7185' },
        { id: 'mon', x: 20, y: 66, w: 60, h: 8, label: 'so it ships with a depth monitor and a trigger', sub: 'alarm at depth 4 · re-sort the affected partitions', color: '#3EF2A4' },
      ],
      edges: [
        { from: 'grid', to: 'mix' },
        { from: 'mix', to: 'two' },
        { from: 'two', to: 'p1' },
        { from: 'two', to: 'p2' },
        { from: 'p1', to: 'p3' },
        { from: 'p2', to: 'p4' },
        { from: 'p3', to: 'doc' },
        { from: 'p4', to: 'doc' },
        { from: 'doc', to: 'cav' },
        { from: 'cav', to: 'mon' },
      ],
      steps: [
        {
          caption:
            'Price the whole design space against the whole query mix rather than tuning one query. A table has exactly one physical order, so this is a constrained allocation problem and not a search for a best answer.',
          active: ['grid', 'mix'],
          edges: ['grid->mix'],
        },
        {
          caption:
            'Two targets — a bill for the headline class and a ceiling for whichever class ends up worst — leave exactly two of the 120 designs standing, and they differ only in row-group size.',
          active: ['two'],
          edges: ['mix->two'],
        },
        {
          caption:
            'Field one is the promised pruning ratio, stated per query class and derived from clustering depth rather than hoped for. Field two is the file count, which is where the smaller row group loses on both bytes and footers at once.',
          active: ['p1', 'p2'],
          edges: ['two->p1', 'two->p2'],
        },
        {
          caption:
            'Field three names the starved class by starvation ratio, not by absolute bytes — the class reading the most bytes is usually not the one being treated worst, and getting that backwards means defending the wrong thing.',
          active: ['p3'],
          edges: ['p1->p3'],
        },
        {
          caption:
            'Field four is the line that is not negotiable: the layout may change the bill and must never change the answer. Every skip is a proof, which is why forge lab 02 grades false negatives pass/fail and the pruning ratio only in a band.',
          active: ['p4'],
          edges: ['p2->p4'],
        },
        {
          caption:
            'Four fields make one page — and then you say the weakness out loud before the room finds it: a 99.5% promise is a 200× exposure to a write-order change made by somebody who has never seen this document.',
          active: ['doc', 'cav'],
          edges: ['p3->doc', 'p4->doc', 'doc->cav'],
        },
        {
          caption:
            'Naming it converts an estimate into two deliverables: the design, and the monitor that defends it. Clustering depth with an alarm and a re-sort trigger, because depth moves half a day before the invoice does.',
          active: ['mon'],
          edges: ['cav->mon'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## The four fields, and the arithmetic each one needs

**1 · \`prunes_target\` — the promised ratio, per class.** Blocks skipped ÷ blocks the class could have read, computed from clustering depth and predicate selectivity, quoted per query class with the measurement method named. Promise the ratio you can compute, not the one you would like: the desk grades in a band, and a band is generous to an honest model and unforgiving of a round number with no derivation behind it.

**2 · \`file_count_sane\` — the file arithmetic.** Two numbers. Partitions actively written per day, checked against C2.L5's ceiling of daily ingest ÷ target file size — 25 GB/day ÷ 512 MB is about 48, and a scheme exceeding it produces permanently small files that no compaction can fix. Then files touched per query class, which is the number that turned into 61% of query time in Column Week's second incident. The 32Ki-versus-8Ki result above is this check doing its job: two designs both meeting the byte targets, one touching 3.8× the files.

**3 · \`worst_query_stated\` — the named loser, with its ratio.** Which class this design treats worst, measured against the best that class could have had, and what you are doing about it. Three legitimate answers: give it a bloom filter (C2.L4 — the only mechanism in this track that does not consume the physical order, at roughly 10.5 bits per value for 1%), give it its own copy of the data with a different order and say what that costs to keep consistent, or give it a **quota** and stop pretending a layout was ever going to serve it. The ad-hoc class is the quota case, and the model proves it rather than asserting it: its best achievable bill anywhere in the grid is still the largest in the mix.

**4 · \`no_false_negatives\` — the correctness line.** The layout is allowed to change your bill and never your answer. Every skip must be a proof, which forge lab 02 grades with zero tolerance while grading pruning ratio only in a band, and whose harness audits *itself* on the same rule — it fails with \`HARNESS BUG\` if its own reference planner would skip a block holding a match. Carry that standard up to the design level. If your design achieves its ratio through a mechanism that can be stale, incomplete or maintained beside mutable data, then it is not a pruning design, it is a correctness risk with a good pruning number: state the mechanism and where its statistics come from.

**And the fifth thing, which is not a check but is why the four survive contact:** the monitoring. Clustering depth per sort-key column with an alarm; pruning ratio per class as a time series against the promise; files touched per query and average file size; compaction backlog *slope*. Plus the trigger — what happens when depth crosses the alarm, who runs it, and how long it takes — because a monitor with no attached action is a graph nobody reads.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '2 of 120',
          label: 'designs that satisfy both targets',
          hint: 'Swept over the full grid: 4 partition keys × 6 sort keys × 5 row-group sizes. The conventional design is not one of the two.',
        },
        {
          value: '21.7×',
          label: 'starvation of the worst class under the conventional design',
          hint: 'Tenant-audit, measured against the fewest bytes that class could scan under any design in the grid. It is not the class reading the most bytes.',
        },
        {
          value: '4.6×',
          label: 'given up on the headline query to keep the promise',
          hint: '82.5 MiB against the 17.9 MiB a dashboard-optimal design achieves. That gap is the deliverable, not an apology.',
        },
        {
          value: '200×',
          label: 'exposure created by promising 99.5%',
          hint: '1 ÷ (1 − r). The stronger the promise, the bigger the multiplier when physical order stops holding — which is why the promise ships with a monitor.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'analogy',
      title: 'model the habit: say the caveat first, in one sentence',
      md: `The most valuable professional move in this course costs one sentence, and this is the C2 version of it, verbatim:

> "The promise is 99.5% pruning on the dashboard class, and it assumes the loader keeps writing in tenant order inside each day partition. If that stops, the ratio goes to zero and this line multiplies by two hundred — one over one minus the ratio — so the design ships with a clustering-depth alarm on \`tenant_id\` at depth 4 and a re-sort job for the affected partitions. The class this design starves is the tenant audit, at 4.54 GiB a pass, which is 15× off what a tenant-partitioned design would give it; we chose that because the audit runs twelve times a day and the dashboard runs sixty-four."

Notice what that does. It hands the room the hole before they dig for it, so they stop digging. It quantifies the risk, which is what gets the monitor funded rather than argued about. It names the loser and the reason, so the tradeoff reads as a decision instead of an oversight. And every number in it is either arithmetic the listener can redo or a measurement with a stated source.

Withhold it and somebody finds it anyway — later, holding an invoice, and the conversation is no longer about the layout.`,
    },
    {
      type: 'desk',
      desk: 'layout-desk',
      brief:
        'Produce the artifact: partition key, sort key, row-group size, the pruning ratio you promise, and the worst-query caveat. The desk grades in bands rather than against one right answer, and it checks four things this track taught the arithmetic for — prunes_target (a ratio you derived, per class), file_count_sane (partitions written per day against ingest ÷ target file size, and files touched per query), worst_query_stated (the starved class named with its ratio and your response to it) and no_false_negatives (the layout changes the bill, never the answer). A design with a perfect pruning number and no named loser fails, because every physical order privileges some predicates and starves others.',
    },
    {
      type: 'isomorphism',
      title: 'a layout design ≡ documents you already write',
      pairs: [
        {
          os: 'an SLO with an error budget',
          osLine:
            'A number you commit to, an agreed consequence when it is missed, and a measurement everyone accepts. Without the measurement it is a wish.',
          llm: 'a promised pruning ratio',
          llmLine:
            'Identical structure: the ratio is the objective, clustering depth is the leading indicator, and the re-sort trigger is what you spend the budget on.',
        },
        {
          os: "a capacity plan's named first bottleneck",
          osLine:
            'The credible part is not the forecast, it is knowing which limit you hit first and roughly when.',
          llm: 'the named starved query',
          llmLine:
            'Same credibility mechanism. A design that cannot say which class it treats worst has not been analysed, only chosen.',
        },
        {
          os: 'one clustered index per table in a row store',
          osLine:
            'A constraint every reader already accepts without complaint, and plans schemas around.',
          llm: 'one physical order per table',
          llmLine:
            'The same constraint, priced in bytes scanned instead of in seek counts — and the reason C2 ends in an allocation decision rather than a tuning tip. (→ tablespace T7.L1 for the row store\'s side of it.)',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'You present a layout design promising 99% pruning on the dashboard class. The CFO asks what the risk is. Which answer is defensible?',
          options: [
            '"Low — 99% is conservative for a well-clustered table, and we can re-cluster if it drifts."',
            '"The promise is 99%, so the exposure is 1 ÷ (1 − 0.99) = 100× on that line if physical order stops holding, which an upstream loader change can cause without touching anything we own. That is why the design ships with a clustering-depth alarm and a re-sort trigger, and why the audit class is named at 4.54 GiB a pass as the class we chose to starve."',
            '"We will commit to 90% instead of 99% to build in a safety margin."',
            '"There is no risk to the bill — pruning is handled by the engine and the statistics are always correct."',
          ],
          correct: [1],
          explanation:
            'The exposure is arithmetic, not judgement: a ratio r has a downside of 1 ÷ (1 − r), so a stronger promise is a bigger crater and the promise is only credible when the multiplier is stated alongside it with a monitor attached. Dropping to 90% is still an unmonitored promise with a 10× downside and buys nothing except a worse number. And the last answer is precisely the belief C0.L4 dismantled — the statistics stay correct while becoming uninformative, which is why nothing errors and the bill moves anyway.',
        },
        {
          q: 'Two designs both meet your byte targets. Design A uses 32Ki-row groups: 82.5 MiB for the dashboard, 168 files touched. Design B uses 8Ki-row groups: 84.4 MiB, 639 files touched, and its worst class comes in slightly better at 4.27 GiB against 4.54 GiB. Which ships?',
          options: [
            'B — the finer row group prunes more precisely and its starved class is measurably better off',
            'A — it reads fewer bytes and touches 3.8× fewer files; the smaller row group already lost the pruning-versus-footer trade, and file count is the cost that scales planning while being invisible to a bytes-scanned dashboard',
            'B, because a smaller row group gives the planner more opportunities to skip',
            'Either — the difference is within noise, so pick by operational convenience',
          ],
          correct: [1],
          explanation:
            'B loses on the metric it was supposed to win: finer row groups mean more footers per query, and here the metadata tax exceeded the extra pruning, so B reads more bytes *and* enumerates 3.8× the files. Both meet the ceiling on the starved class, so the tie-break is the cost that grows with the table and does not show up in scan volume — files touched, which C2.L5 watched become 61% of query time. Calling it noise ignores that the file-count gap is a factor of nearly four and compounds as the table grows.',
        },
        {
          q: 'A design document states: "the table will achieve 95% pruning." What is the first question a principal engineer asks?',
          options: [
            '"Which compression codec are you assuming?"',
            '"On which query class, measured how — and which class does that starve? A table-level ratio is a weighted average over classes, so a design can average 95% while pruning 0% for the lookup queries, and the class that gets nothing is the one that will page somebody."',
            '"What row-group size does that assume?"',
            '"Is 95% achievable, or should we say 90% to be safe?"',
          ],
          correct: [1],
          explanation:
            'A pruning ratio without a query class attached is unfalsifiable, and the average is precisely where the failure hides: the layout designer\'s model shows one design pruning 99.3% for the dashboard and 0.0% for the needle on the same physical order. So the review question is always class-scoped, and it comes paired with the starved-class question because a table has one physical order and something must lose. Row-group size and codec are real inputs, but they are refinements of a number that has not yet been made meaningful.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: layout selection is index selection, and it is still hard',
      md: `The formal version of what this track did by hand is **data-skipping-oriented layout selection**. Start with **Sun, Fu, Kandula et al., "Fine-grained Partitioning for Aggressive Data Skipping" (SIGMOD 2014)** and its successor work on **skipping-oriented partitioning**: given a workload of predicates, choose a blocking of rows that maximises skipped blocks. The formulation is the useful part — it makes explicit that the objective is defined *relative to a query workload*, so a layout is only optimal against a distribution of queries you have written down. Which is exactly why the artifact demands a query mix and not a table.

For multi-column clustering, **Z-ordering and Hilbert curves** are the standard answer and a partial one: a space-filling curve gives moderate clustering on several columns instead of excellent clustering on one. Read the arithmetic before adopting it, because "moderate on four columns" loses to "excellent on one" whenever the workload is dominated by a single predicate — and it usually is.

And the honest lineage: this is **index selection**, which the database community has been at since **Chaudhuri and Narasayya's AutoAdmin (VLDB 1997)**. That problem is NP-hard in its general form, which is why every real system ships heuristics plus measurement rather than an optimiser, and why the professional deliverable is a *documented decision with a named loser* instead of a proof. **Idreos et al. on database cracking and adaptive indexing** is the other branch — build the layout incrementally from the queries that actually arrive — and it is worth knowing because it reframes the whole thing: if you cannot predict the workload, stop trying to choose a layout up front and let the workload choose it, at the cost of unpredictable first-query latency.

For the operational half, the leading-indicator argument generalises past this subject: **the SRE literature on leading versus lagging indicators** is the right frame for why clustering depth belongs on a dashboard next to spend, and why an invoice is the worst possible detector of a layout regression.

Where this artifact goes next: the layout design is one of the four things you finish the course holding, and it is the document **the-principal** room attacks — the objections are predicates over the numbers you just wrote, so a missing starved-class line loses the room for a reason this lesson would have covered. **A1** picks it up as a design deliverable, and **C3** is where you find out what a "file" and a "row group" actually are on disk, byte by byte.

Next: **C3** opens the footer. You have been reasoning about statistics and file counts as abstractions; now read the bytes that hold them.`,
    },
  ],
}

export default lesson
