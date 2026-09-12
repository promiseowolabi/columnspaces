import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'a1.l2',
  slug: 'the-layout-design-document',
  trackId: 'a1',
  index: 2,
  title: 'The Layout Design Document',
  minutes: 19,
  hook: 'Six fields on one page. One of them is a promise, one of them is the class you are abandoning, and one of the four checks that grades it has no tolerance band at all.',
  exercise: 'desk+quiz',
  artifact: 'layout-design',
  takeaway: {
    number: '99.976% ceiling, 4,138× exposure',
    claim:
      'A promised pruning ratio is bounded above by 1 − (f·N + 1) ÷ N and its downside is 1 ÷ (1 − r), so promising 99.99% where the arithmetic allows 99.976% is not optimism, it is a wrong answer with a good number attached.',
  },
  blocks: [
    {
      type: 'prose',
      md: `**Six fields.** A layout design document is one page and it holds exactly six things:

\`\`\`text
partition key        day(order_ts)
sort key             tenant_id, order_ts
row-group size       128Ki rows
promised pruning     per CLASS: dashboard 99.97% · rollup 97.99% · needle 99.99%
the starved class    rollup — 2.82 GiB read per query, 61 files, accepted at 96 runs/day
the monitor          clustering depth, alarmed at d > 2
\`\`\`

Five of those are choices. The fourth is a **promise**, and it is the only field in the document that somebody can hold you to, which is why the other five exist to make it defensible. The fifth is the field that gets skipped and is the actual deliverable. The sixth is what stops the promise decaying silently.

\`layout-desk\` grades four checks — \`prunes_target\`, \`file_count_sane\`, \`worst_query_stated\` and \`no_false_negatives\` — and three of them are graded in bands. **The fourth has no tolerance whatsoever**, because a physical layout is allowed to change your bill and is never allowed to change your answer. Get \`prunes_target\` wrong by a point and the desk tells you which term you dropped. Get \`no_false_negatives\` wrong by any margin at all and you have shipped a correctness bug that reports as a cost saving.`,
    },
    {
      type: 'prose',
      md: `## Field 4 — the promise, and where its ceiling comes from

There is one formula and every number on the page comes out of it. C2's pruning model:

\`\`\`text
r  =  1 − d × (f × N + 1) ÷ N

N  candidate row groups — the ones this class COULD have read
f  selectivity — the fraction of rows the predicate matches
d  clustering depth — 1.0 when the loader writes in key order, higher when it stops
\`\`\`

The \`+1\` is the boundary row group: a range predicate always straddles one extra group. That single term is why ratios asymptote below 1.0, and it is the term people drop.

Run \`layout-desk\`'s worked mix — 24,000 candidate row groups, three classes, perfectly clustered:

| class | f | r | row groups read | files | bytes read | exposure if order fails |
|---|---|---|---|---|---|---|
| dashboard | 2e-4 | **99.9758%** | 6 | 1 | 36.0 MiB | **4,138×** |
| rollup | 2e-2 | **97.9958%** | 481 | 61 | **2.82 GiB** | 49.9× |
| needle | 1e-7 | **99.9958%** | 2 | 1 | 44.0 MiB | 23,943× |

Four readings of that table, all of them things the desk will grade you on.

**A ratio is per class, not per table.** The mix-weighted average here is 99.6%, and "this table prunes 99.6%" is a true sentence containing no information — it is an average over classes, and the average is exactly what hides the class that gets nothing.

**Round the promise DOWN.** \`prunes_target\` grades in a band of ±1.5 points of ratio, so 97.99% and 98.0% are the same answer to it. \`no_false_negatives\` has zero tolerance, so promising **98.0%** where the arithmetic yields **97.9958%** fails outright: to deliver it you would have to skip a row group the statistics cannot prove is empty. The rounding you learned in school is a correctness bug here, and it fails in exactly one direction.

**The exposure is the other half of the promise.** The downside of a ratio is 1 ÷ (1 − r). The dashboard's 99.976% commits you to a **4,138× multiple** if physical order stops holding. That is not a scare figure, it is what the number means: you have promised to read 1/4,138th of the candidate set, so the worst case is the whole thing. A promise never travels without its exposure, which is why field six is a monitor and not a comment.

**The best-served class is not the one you designed for.** The model ranks best by ratio and worst by *bytes read*, and on this mix that makes the **needle** the best-served class — it has the highest ratio — while the class the design was actually chosen for, the dashboard at 70% of the mix, is second. Meanwhile the starved class is the **rollup**, and it is starved despite having a perfectly respectable 98.0%, because 98.0% of 24,000 row groups is still 481 of them.`,
    },
    {
      type: 'prose',
      md: `## Field 5 — the starved class, ranked by bytes and not by ratio

This is the field that fails most submissions, and it fails in three distinct ways, all of which \`worst_query_stated\` catches separately.

**Omitted entirely.** A table has exactly one physical order, so the design necessarily abandons a class. Leaving it out fails the check even when your ratio for the class you designed for is perfect, because a promise with no named loser is not a design document — it is a description of the happy path.

**Named, but the wrong class.** The instinct is to name the class with the worst *ratio*. On this mix that instinct points at the rollup and happens to be right; change the candidate-set sizes and it stops being right, because **a class with a poor ratio over a small candidate set is cheap and a class with a good ratio over a huge one is not.** Rank by bytes read. The needle class prunes 99.9958% and is still not free — it reads 44.0 MiB, more than the dashboard's 36.0 MiB, because its projection is 22 MiB per row group against the dashboard's 6 MiB.

**Named, with no response.** The caveat is three parts: the class, the number it actually gets, and what happens to it. The third part is one of exactly three things — a second table physically ordered for it, a secondary mechanism that matches its predicate shape, or **"nothing, deliberately, and here is why that is acceptable"**. All three pass. A named loser with no stated response is an acknowledgement rather than a decision, and the reader cannot tell whether you weighed it or merely noticed it.

## Field 6 — the monitor, because the promise decays without an error

Every ratio on that page assumed **d = 1.0**. Clustering depth is not a constant you chose; it is a property of what an upstream loader is doing today, and nobody in your design review controls it. Watch what one variable does to the entire document:

| d | dashboard | rollup | rollup files | rollup bytes | weighted |
|---|---|---|---|---|---|
| 1.0 | 99.9758% | 97.9958% | 61 | 2.82 GiB | 99.6% |
| 2.0 | 99.9517% | 95.9917% | 121 | 5.64 GiB | 99.2% |
| 4.0 | 99.9033% | 91.9833% | **241** | **11.28 GiB** | 98.3% |

Note what breaks and what does not. The headline ratios barely move — 99.98% to 99.90% looks like nothing on a slide. The **bytes quadruple**, and the file count on the starved class goes from 61 to 241, which blows through a 200-file-per-query ceiling and fails \`file_count_sane\` on a design that was inside every constraint on the day it shipped. Nothing errors. Nothing gets slower in a way anyone attributes correctly. The invoice moves about twelve hours after the depth does.

So the monitor is not on cost. **It is on d**, because d leads the bill and latency never moves at all. That is the argument C2.L6 made and it is the reason field six exists.

## Field 2 and 3 — the two file counts that \`file_count_sane\` grades

The check grades two independent numbers, and confusing them is how a design acquires a target file size it can never reach.

\`\`\`text
partition ceiling  =  daily ingest ÷ target file size
                   =  25 GB ÷ 512 MB  =  48.8 partitions per day

files per query    =  ceil(row groups read ÷ 8 row groups per file)
                   =  ceil(481 ÷ 8)  =  61 for the rollup class
\`\`\`

The first says your partition scheme may write into at most **48 partitions a day** if you want 512 MB files, and writing into 400 of them instead produces a permanent average of 59.6 MiB per file. **No compaction policy fixes that** — it is not a backlog, it is what the scheme produces every day forever. The second is planning cost, it is invisible on a bytes-scanned dashboard, and C2.L5 measured it becoming 61% of query time.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '99.9758%',
          label: 'the provable ceiling for the dashboard class',
          hint: '1 − (2e-4 × 24,000 + 1) ÷ 24,000 at perfect clustering. Promising 99.99% needs a skip that is not a proof, so no_false_negatives fails it with zero tolerance.',
        },
        {
          value: '4,138×',
          label: 'exposure carried by that promise',
          hint: '1 ÷ (1 − r). You have promised to read one 4,138th of the candidate set, so the downside of the assumption failing is the whole set.',
        },
        {
          value: '2.82 GiB',
          label: 'the starved class, per query',
          hint: 'The rollup class at 97.9958% pruning over 24,000 row groups — 481 of them, 61 files. A good-looking ratio over a large candidate set is the most expensive query on the platform.',
        },
        {
          value: '241 files',
          label: 'what the starved class touches at d = 4',
          hint: 'Up from 61 with no change to the design and no error anywhere. This is the number that breaks a 200-file ceiling, and depth moves about twelve hours before the invoice does.',
        },
      ],
    },
    {
      type: 'diagram',
      caption: 'fig 1 — six fields, four checks, and the one with no tolerance band',
      height: 76,
      nodes: [
        { id: 'pk', x: 1, y: 2, w: 32, h: 9, label: '1 · partition key', sub: 'day(order_ts) — cuts the file list', color: '#FBBF24' },
        { id: 'sk', x: 35, y: 2, w: 30, h: 9, label: '2 · sort key', sub: 'tenant_id, order_ts — cuts bytes', color: '#FBBF24' },
        { id: 'rg', x: 68, y: 2, w: 31, h: 9, label: '3 · row-group size', sub: '128Ki rows, 8 per file', color: '#FBBF24' },
        { id: 'promise', x: 1, y: 15, w: 48, h: 9, label: '4 · the promise, per class', sub: 'r = 1 − d(fN + 1)/N → 99.9758%', color: '#22D3EE' },
        { id: 'ceiling', x: 51, y: 15, w: 48, h: 9, label: 'its ceiling and its exposure', sub: 'max provable at d = 1 · downside 1/(1 − r) = 4,138×', color: '#22D3EE' },
        { id: 'starved', x: 1, y: 28, w: 48, h: 10, label: '5 · the starved class', sub: 'rollup: 2.82 GiB, 61 files, ranked by BYTES', color: '#FB7185' },
        { id: 'monitor', x: 51, y: 28, w: 48, h: 10, label: '6 · the monitor', sub: 'clustering depth d, alarmed before the invoice', color: '#3EF2A4' },
        { id: 'doc', x: 12, y: 42, w: 76, h: 10, label: 'the layout design document', sub: 'one page, six fields, every number redoable from f, N and d', color: '#A78BFA' },
        { id: 'banded', x: 1, y: 56, w: 48, h: 9, label: 'three checks in bands', sub: 'prunes_target ±1.5 pts · file_count_sane · worst_query_stated', color: '#A3E635' },
        { id: 'absolute', x: 51, y: 56, w: 48, h: 9, label: 'one check absolute', sub: 'no_false_negatives — every skip is a proof', color: '#FB7185' },
        { id: 'verdict', x: 8, y: 67, w: 84, h: 8, label: 'so: round the promise down, never up', sub: '98.0% fails where the arithmetic yields 97.9958% — a bill may change, an answer may not', color: '#FBBF24' },
      ],
      edges: [
        { from: 'pk', to: 'promise' },
        { from: 'sk', to: 'promise' },
        { from: 'rg', to: 'ceiling' },
        { from: 'promise', to: 'ceiling' },
        { from: 'promise', to: 'starved' },
        { from: 'ceiling', to: 'monitor' },
        { from: 'starved', to: 'doc' },
        { from: 'monitor', to: 'doc' },
        { from: 'doc', to: 'banded' },
        { from: 'doc', to: 'absolute' },
        { from: 'absolute', to: 'verdict' },
      ],
      steps: [
        {
          caption:
            'Three physical choices first, and they do different jobs: partitioning cuts the list of files a planner must consider, sorting cuts the bytes inside the files it still has to open, and the row-group size sets the granularity of every skip.',
          active: ['pk', 'sk', 'rg'],
        },
        {
          caption:
            'The promise is derived rather than chosen: selectivity and candidate-set size give the ratio, and the boundary row group — the plus one — is why no ratio ever reaches 1.0 no matter how well the table is sorted.',
          active: ['promise'],
          edges: ['pk->promise', 'sk->promise'],
        },
        {
          caption:
            'Two numbers travel with it. The provable ceiling at perfect clustering, which is the most any correct planner could achieve, and the exposure of one over one minus the ratio, which is what the promise costs you if it fails.',
          active: ['ceiling'],
          edges: ['rg->ceiling', 'promise->ceiling'],
        },
        {
          caption:
            'Then the two fields everybody skips. The starved class, ranked by bytes read rather than by ratio, with a stated response; and a monitor on clustering depth, because the promise decays without anything erroring.',
          active: ['starved', 'monitor'],
          edges: ['promise->starved', 'ceiling->monitor'],
        },
        {
          caption:
            'Six fields make a page that fits in front of a reviewer, and its distinguishing property is that every figure on it can be recomputed from three inputs the reviewer can challenge individually.',
          active: ['doc'],
          edges: ['starved->doc', 'monitor->doc'],
        },
        {
          caption:
            'Three of the four checks grade in bands, because a layout model is a model. The fourth grades with zero tolerance, because a skip is a proof and an unprovable skip returns the wrong answer rather than a bigger bill.',
          active: ['banded', 'absolute'],
          edges: ['doc->banded', 'doc->absolute'],
        },
        {
          caption:
            'Which produces the one rule from this lesson that will save you a production incident: round a promised ratio down, never up, because the check that catches an over-promise does not have a tolerance to absorb it.',
          active: ['verdict'],
          edges: ['absolute->verdict'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'segfault',
      title: 'no_false_negatives is not a performance check',
      md: `The other three checks ask whether your model is good. This one asks whether your design can return a wrong answer, and it fails for two distinct reasons.

**The promise exceeds what the candidate set can prove.** Delivering 99.99% on 24,000 row groups when the arithmetic ceiling is 99.9758% means skipping at least one group the statistics cannot rule out. The engine will not do that, so what actually happens is you miss the number — but if you *implement* it, by hand-maintaining a skip list or by trusting a filter you did not derive, the query returns fewer rows and every downstream number is quietly wrong. Zero tolerance is deliberate: the ratio itself is graded in a band because it is a model, and this is graded absolutely because it is a correctness property.

**The mechanism cannot prove the skip.** Min-max in the footer and zone maps in the manifest are written *in the same commit as the data they describe*, which makes them conservative by construction — the statistic cannot be tighter than the data. Two mechanisms are not:

- **An external index** is maintained beside the data rather than with it, so a write that lands without an index update makes a skip unprovable.
- **Cached statistics** are stale by construction, so a skip decided from them is a guess with a good hit rate rather than a proof.

Both fail the check regardless of how good your ratio is, and the desk's language for it is worth memorising: *this is not a pruning design, it is a correctness risk with a good pruning number.* The same failure applies to a mechanism that is fine in principle but written asynchronously — if the statistics are not committed with the data, there is a window in which a skip is decided from a statistic the data has already contradicted.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'Field 6 exists as a vendor function, and it is the monitor to copy',
      systems: ['snowflake'],
      sources: [
        'https://docs.snowflake.com/en/sql-reference/functions/system_clustering_depth',
        'https://docs.snowflake.com/en/sql-reference/functions/system_clustering_information',
      ],
      md: `The sixth field is not a bespoke metric you have to invent. **Snowflake ships \`SYSTEM$CLUSTERING_DEPTH\`**, documented as computing the average depth of a table according to specified columns or its defined clustering key, with two properties stated directly in the documentation: the average depth of a populated table **is always 1 or more**, and **the smaller the average depth, the better clustered** the table is with respect to those columns. \`SYSTEM$CLUSTERING_INFORMATION\` returns the fuller picture, including an overlap histogram.

Two details make it the right thing to copy into your own monitor rather than merely an interesting function.

**It takes arbitrary columns, not only the declared clustering key.** So you can ask for the depth of the columns your *starved* class filters on, which turns field five from an assertion into a measurement. That is exactly the diagnostic you want when someone claims a query is slow for no reason.

**It takes an optional predicate**, so you can ask for depth over only the value range you actually query — which matters because a table can be well clustered overall and badly clustered in the last three days, and the last three days are what the dashboard reads.

Read the documentation's example outputs as a *shape* rather than as measurements — they are Snowflake's illustrative values on Snowflake's data, not anything measured here or by you. The shape is the point: the same table reports a low single-digit depth on its clustering key and an order of magnitude more on a different column pair. That is the "one physical order" constraint quantified by a vendor function, and it is the strongest available evidence that field five of your document describes something real.

If your platform does not expose the number, you can compute the same thing from footers: for a sample of files, count overlapping min-max ranges on the sort key. It is a nightly query, and it is the leading indicator for every ratio on your page.`,
    },
    {
      type: 'desk',
      desk: 'layout-desk',
      brief:
        'Submit the layout design: partition key, sort key, row-group size, a promised pruning ratio PER CLASS, the starved class with its ratio and your response to it, the mechanism the skip is proved by, and whether its statistics are written in the same commit as the data. Four checks, all taught above. prunes_target — a ratio per class, derived from 1 − d(fN + 1)/N, graded in a band of ±1.5 points of ratio; a table-level average fails because the average is what hides the class that gets nothing. file_count_sane — two numbers: partitions written per day against the ceiling of daily ingest ÷ target file size, and files touched per query as ceil(row groups read ÷ 8). worst_query_stated — the starved class ranked by BYTES READ rather than by ratio, with its number and one of three responses: a second table, a matching secondary mechanism, or nothing deliberately. no_false_negatives — an ABSOLUTE with no tolerance band: a promise above the ceiling that perfect clustering allows fails outright, and so does a mechanism whose statistics are not written with the data. Round every promised ratio DOWN; 98.0% fails where the arithmetic yields 97.9958%.',
    },
    {
      type: 'isomorphism',
      title: 'a layout design ≡ two documents you already write',
      pairs: [
        {
          os: 'a covering index you never have to maintain',
          osLine:
            'An index answers a query without touching the base table, and you pay for it on every write, forever, in a separate budget somebody eventually notices.',
          llm: 'min-max statistics in the footer',
          llmLine:
            'The same skip, written in the same commit as the data and therefore free of maintenance — which is exactly why it is a proof and why an external index is not.',
        },
        {
          os: 'an SLO with an error budget and a named blast radius',
          osLine:
            'A stated target plus what happens when it is missed. The second half is what makes it a commitment rather than an aspiration.',
          llm: 'the promised ratio and its exposure',
          llmLine:
            '99.976% is the target; 4,138× is the blast radius if clustering stops holding. Quoting the first without the second is quoting an availability number with no incident plan.',
        },
        {
          os: 'a schema migration with a rollback',
          osLine:
            'Nobody signs off the forward path alone. The reviewer asks what happens if it is wrong, and how you would know.',
          llm: 'the monitor on clustering depth',
          llmLine:
            'The forward path is the sort key; the rollback is knowing d has moved to 4 and the starved class now touches 241 files, about twelve hours before the invoice says so.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Your candidate set is 24,000 row groups and the dashboard class has selectivity 2e-4. The arithmetic gives 99.9758% pruning. Finance would like a round number for the slide, so you write 99.99%. What have you done?',
          options: [
            'Nothing material — 99.99% and 99.9758% are within a quarter of a point of each other, and the desk grades ratios in a band anyway',
            'Failed no_false_negatives outright: 99.99% is above the ceiling that perfect clustering allows, so delivering it requires skipping at least one row group that could contain a match — and that check has no tolerance band while prunes_target does',
            'Overstated the saving by about 0.02%, which will show up as a small variance against the budget',
            'Nothing, provided the monitor on clustering depth is in place to catch it if the ratio drifts',
          ],
          correct: [1],
          explanation:
            'The two checks have deliberately different tolerances and this is the case that separates them. prunes_target grades in a band of ±1.5 points of ratio because a layout model is a model; no_false_negatives is absolute because the ceiling is not an estimate — it is the matching row groups plus the boundary group the range straddles, and there is nothing else to skip. So a promise above it is not an optimistic estimate, it is a commitment to skip blocks that cannot be proved empty, which returns fewer rows rather than a bigger bill. The variance framing in option three is the specific error: it treats a correctness property as a cost estimate. And a monitor on depth cannot help, because the promise was already unachievable at d = 1.',
        },
        {
          q: 'A design promises 99.98% pruning on the dashboard class, backed by a nightly job that computes statistics into a side table the planner consults. Everything else in the document is correct. How does layout-desk grade it, and why?',
          options: [
            'It passes: the ratio is derived correctly and a side table is a legitimate place to keep statistics',
            'no_false_negatives fails, because the statistics are not written in the same commit as the data they describe — so there is a window in which a skip is decided from a statistic the data has already contradicted, which makes it a correctness risk with a good pruning number',
            'file_count_sane fails, because consulting a side table adds a request per query that the file-count arithmetic does not include',
            'It passes with a warning, since the nightly job makes the statistics at most 24 hours stale and pruning degrades gracefully',
          ],
          correct: [1],
          explanation:
            'The mechanism check is not about the data structure, it is about whether the statistic is guaranteed to be at least as conservative as the data. Min-max in a footer and zone maps in a manifest are written with the data, so they cannot be tighter than what they describe. An externally maintained structure can be, the moment a write lands before the job runs, and the failure mode is a skipped block that held a match — a wrong answer, not a slower one. "At most 24 hours stale" is precisely the problem restated: staleness in a pruning statistic does not degrade gracefully, it inverts from a proof into a guess with a good hit rate. The file-count objection is real but minor and is not what this check grades.',
        },
        {
          q: 'You must choose which class to name as the starved one. Class A prunes 97.99% over 24,000 row groups and reads 2.82 GiB per query at 96 runs a day. Class B prunes 99.9958% and reads 44.0 MiB per query at 120 runs a day. Which do you name, and what makes the argument defensible in front of a budget holder?',
          options: [
            'Class B, because 44.0 MiB per query over 120 runs is more total volume than a class that runs only 96 times',
            'Class A, ranked by bytes read: 2.82 GiB against 44.0 MiB is about a 66× difference per query and 271 GiB against 5.2 GiB per day, so it is the most expensive query on the platform despite a respectable-looking ratio over a large candidate set',
            'Class A, because its ratio is the lowest of the three and the lowest ratio is by definition the starved class',
            'Neither — with both classes above 97% pruning the design has no meaningful loser, and the honest statement is that the layout serves the whole mix',
          ],
          correct: [1],
          explanation:
            'Rank by bytes read, never by ratio, and then multiply by frequency to get the line item: 2.82 GiB × 96 is about 271 GiB a day against 44.0 MiB × 120, which is about 5.2 GiB — a fiftyfold difference in the number a budget holder is actually paying for. Option three reaches the same answer by the wrong route, and the route matters: a poor ratio over a small candidate set is cheap, so ranking by ratio will point at the wrong class as soon as the candidate sets differ, and layout-desk fails a submission that names the wrong one even though it named something. Option one inverts the arithmetic. Option four is the failure the-principal rebuts on sight, because a single physical order guarantees a loser exists whether or not the document contains it.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the promise, the proof, and the papers behind both',
      md: `**On the ceiling.** The \`+1\` boundary term is the discrete version of a very old result: a range predicate over a sorted domain touches the matching blocks plus the partial one at each end. It is why the interesting question about a layout is never "how good can pruning get" but "what is the candidate set", and why reducing N — by partitioning, or by a smaller table — beats improving f. The **Parquet page index** documentation is the place to see the mechanism at its finest granularity: column indexes give per-page min-max so the skip unit drops below the row group, which lowers the effective N for exactly the classes this lesson's arithmetic starves.

**On the proof.** Read the **Parquet Thrift definition** for what a footer actually guarantees, then the **Iceberg spec** for what a manifest adds — per-file lower and upper bounds, null counts, and crucially the fact that they are written in the same commit as the data files. That co-commit is the whole reason zone maps are a proof, and it is the property an external index gives up. The **Parquet bloom filter** documentation is the honest counter-example: a bloom filter can produce false positives and never false negatives, which is why it is a legal pruning mechanism and why a structure with the opposite error profile would not be.

**On multi-dimensional order.** The one physical order constraint is real but it has a well-studied escape hatch that partially relaxes it: **space-filling curves** — Z-order and Hilbert order — trade a worse ratio on the first column for a usable ratio on several. The classic reference is **Morton (1966)** for the curve and the modern practice is in Delta and Iceberg's clustering options. It does not remove the tradeoff; it redistributes it, and the honest way to present it in a design document is as *three mediocre ratios instead of one excellent one and two terrible ones.* If your mix has one dominant class, do not reach for it.

**On the monitor.** → \`tablespace T4.L3\` covers B-tree fragmentation, which is the same phenomenon with a different name and forty more years of operational literature behind it. The transferable insight is that fragmentation metrics are leading indicators and query time is a lagging one.

Next: **A1.L3** takes the other half of the pair. This page promised a ratio; the sizing model turns that ratio into bytes, files, metadata and an ingest rate — and the desk that grades it fails you for omitting the growth term even when your point estimate is perfect.`,
    },
  ],
}

export default lesson
