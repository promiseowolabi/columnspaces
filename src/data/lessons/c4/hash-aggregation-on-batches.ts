import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c4.l4',
  slug: 'hash-aggregation-on-batches',
  trackId: 'c4',
  index: 4,
  title: 'Hash Aggregation on Batches',
  minutes: 17,
  hook: 'Forge lab 03 plants a group key at exactly one row of one batch, and 32 of its 80 multi-batch queries are graded on whether that group survives. A hash table that belongs to the batch loses it silently.',
  exercise: 'quiz',
  takeaway: {
    number: '1 batch',
    claim:
      'The hash table is the state of the query, not of the batch — so a key appearing in exactly one batch is still a group, an empty batch creates none at all, and the table\'s size is set by distinct keys rather than by rows, which is what makes GROUP BY the operator that runs out of memory.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Filters shrink a batch and forget it. An aggregate has to remember.

That difference is the whole subject of this lesson, and it shows up as one word in a signature — \`&mut\`:

\`\`\`
aggregate_batch(table: &mut GroupTable, keys, vals, sel)
\`\`\`

The table is a **parameter**, not a return value, because it is the state of the *query*. Batch 0 discovers key 7; batch 63 finds key 7 again; that is one group with one running aggregate. Get this wrong and the failure is not a crash, it is a report that is missing rows.

The mechanism itself is three lines. For every position in the selection: read the group key at that position, find or insert its entry in the table, fold the value at that position into it. No tuple is assembled — keys and values are two columns of the same batch, so a position indexes both (C4.L3).

Everything hard about batched aggregation is in the accounting around those three lines. Forge lab 03's \`aggregate_correct\` check runs **10 hand cases and 80 multi-batch queries over 1,008 batches, 48 of them partial final batches, producing 277 groups** — and it plants a key at exactly one row so that **32 of those 80 queries** contain a group that exists in one batch and nowhere else. The \`storm\` check then accumulates **225 groups across 2,000 batches** where **1,219 of the batches selected nothing at all.**`,
    },
    {
      type: 'prose',
      md: `## Two ways to batch an aggregate, and the property they share

**Fold into one shared table.** Every batch updates the same map. Simple, and the memory high-water mark is the number of distinct keys.

**Aggregate each batch separately, then merge.** Each batch produces partial aggregates; a final pass merges them. Lab 03 gives you the operation and states its contract: \`Agg::merge\` combines two aggregates over **disjoint row sets**, and the lab's comment says why it exists — *"it is the operation that makes batching possible at all: a partial aggregate per batch, merged at the end, with the same answer as one pass over everything."*

The shared property is what matters: the aggregate must be **mergeable**, i.e. associative and commutative over disjoint inputs. Which is true of more things than people expect and false of a few that matter:

| aggregate | mergeable? | what you must carry |
|---|---|---|
| \`count\`, \`sum\`, \`min\`, \`max\` | yes | the value itself |
| \`avg\` | yes | \`(sum, count)\` — **never** the average, which does not merge |
| \`stddev\`, \`var\` | yes | count, mean and a sum of squared deviations |
| \`count(distinct)\` | no, exactly | the whole key set — or a sketch, and then it is an estimate |
| \`median\`, percentiles | no, exactly | the whole distribution, or a t-digest / KLL sketch |

That table is not trivia. **Mergeability is what decides whether an operator can be parallelised, batched or distributed at all** — the same property, checked three times at three scales. A \`GROUP BY\` with \`avg\` parallelises across cores and across nodes; the same query with an exact \`count(distinct)\` per group does not, which is why it is the query that falls over first and why every engine ships an approximate version. **→ C6** is where this merge crosses a network.`,
    },
    {
      type: 'prose',
      md: `## Grouping on codes rather than strings

C1.L5 already established the encoding payoff — a predicate evaluated once per distinct value instead of once per row — and this lesson does not re-derive it. What changes here is not the comparison. It is **the table**.

Group a 2,000,000-row column with 8 distinct regions:

- **On strings.** Each row hashes a string, which means walking its bytes; each hash collision compares with \`memcmp\`; each key stored in the table is a pointer plus, usually, a copy of the string bytes so the table owns its keys.
- **On dictionary codes.** Each row hashes a \`u32\` — one multiply and a shift — collisions compare as integers, and the table's key is 4 bytes. The dictionary translation back to strings happens **once per group, at the end**: 8 string operations for the whole query.

The consequence that matters operationally is the third one. A hash table's behaviour is decided by whether it fits in cache, and its size is \`distinct_keys × (key_width + state_width)\`. Narrowing keys from a 16-byte string reference to a 4-byte code shrinks the table by more than the arithmetic suggests, because it moves the working set across a cache boundary rather than making each probe marginally cheaper.

Lab 03's \`dict_aggregate\` implements this and its instruction is the sentence worth keeping: **tally the selected rows per code, then merge \`run_agg(entries[c], tally[c])\` for every code — "a per-code count is a run length that is not contiguous."** Aggregation on codes is run-length aggregation with the runs scattered. The lab's \`compressed_path\` check reports the ratio this produces on its corpus: **4,512 predicate evaluations covering 340,664 rows — 75.5 rows per evaluation.**

And the limit, stated where it belongs rather than discovered later: **dictionary codes are local to a block.** Region \`'EMEA'\` may be code 3 here and code 6 in the next file, so a table keyed on codes is only valid within one dictionary's scope. Grouping on codes across blocks requires a shared dictionary or a translation step on the way into the table, and maintaining a global dictionary under concurrent writes is its own cost (C1.L5). An engine that ignores this returns wrong groups, not slow ones.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — one table, many batches, and the group that exists in exactly one of them',
      height: 66,
      nodes: [
        { id: 'b0', x: 2, y: 2, w: 30, h: 9, label: 'batch 0', sub: 'keys 1, 2, NULL · sel = [0, 2]', color: '#A78BFA' },
        { id: 'b1', x: 35, y: 2, w: 30, h: 9, label: 'batch 1', sub: 'predicate killed every row · sel = []', color: '#FB7185' },
        { id: 'b2', x: 68, y: 2, w: 30, h: 9, label: 'batch 7 (partial)', sub: 'key 999999, at one row only', color: '#FBBF24' },
        { id: 'tab', x: 2, y: 15, w: 96, h: 10, label: 'ONE GroupTable, for the whole query', sub: 'entry(keys[pos]).or_insert(zero).add(vals[pos]) — 277 groups over 1,008 graded batches', color: '#3EF2A4' },
        { id: 'g1', x: 2, y: 29, w: 23, h: 9, label: 'NULL', sub: 'a group, and it sorts first', color: '#22D3EE' },
        { id: 'g2', x: 27, y: 29, w: 23, h: 9, label: 'key 1', sub: 'seen in 4 batches', color: '#22D3EE' },
        { id: 'g3', x: 52, y: 29, w: 23, h: 9, label: 'key 2', sub: 'count 12, nulls 3', color: '#22D3EE' },
        { id: 'g4', x: 77, y: 29, w: 21, h: 9, label: 'key 999999', sub: 'count 1', color: '#FBBF24' },
        { id: 'phantom', x: 2, y: 42, w: 96, h: 9, label: 'batch 1 contributed NO group — not even one with count 0', sub: 'a group that exists with count 0 is a row in a report describing an empty set', color: '#FB7185' },
        { id: 'spill', x: 2, y: 54, w: 96, h: 9, label: 'table larger than the budget: partition by hash, spill partitions', sub: 'every row of a group hashes to the same partition, so partitions never have to be merged with each other', color: '#A3E635' },
      ],
      edges: [
        { from: 'b0', to: 'tab' },
        { from: 'b1', to: 'tab' },
        { from: 'b2', to: 'tab' },
        { from: 'tab', to: 'g1' },
        { from: 'tab', to: 'g2' },
        { from: 'tab', to: 'g3' },
        { from: 'tab', to: 'g4' },
        { from: 'b1', to: 'phantom' },
        { from: 'tab', to: 'spill' },
      ],
      steps: [
        {
          caption:
            'Three batches of one query, each with its own selection. Batch 0 has survivors, batch 1 has none, and batch 7 is a partial final batch that happens to hold the only occurrence of one group key.',
          active: ['b0', 'b1', 'b2'],
        },
        {
          caption:
            'All three fold into the same table, because the table is the state of the query. This is why it is passed by mutable reference rather than returned: a key seen in batch 0 and again in batch 63 is one group with one running aggregate.',
          active: ['tab'],
          edges: ['b0->tab', 'b1->tab', 'b2->tab'],
        },
        {
          caption:
            'The output has one entry per distinct key, including the NULL key, which SQL treats as a group of its own and which sorts before every non-null key. Null values inside a group are counted but never summed, and absent min or max is not zero.',
          active: ['g1', 'g2', 'g3'],
          edges: ['tab->g1', 'tab->g2', 'tab->g3'],
        },
        {
          caption:
            'Key 999999 appears at exactly one row of one batch, and it is still a group with count 1. Any implementation whose table lives and dies with a batch, or that only emits keys seen more than once, loses it — and loses it silently.',
          active: ['g4'],
          edges: ['tab->g4'],
        },
        {
          caption:
            'Batch 1 selected nothing, so it must contribute nothing: no group, not even an empty one. In the lab storm 1,219 of 2,000 batches are in this state, which makes the empty selection the common case rather than the exception.',
          active: ['phantom'],
          edges: ['b1->phantom'],
        },
        {
          caption:
            'And the operational limit: the table grows with distinct keys, not with rows, so a high-cardinality GROUP BY is the operator that exhausts memory. The fix is radix partitioning by hash — every row of a group lands in one partition, so partitions spill and are processed independently.',
          active: ['spill'],
          edges: ['tab->spill'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## The edge cases that carry the grade

Every one of these is a hand case in \`aggregate_correct\`, with the lab's own reason attached. They are worth reading as a checklist against your own aggregate, in any language.

**A key that appears in exactly one batch.** Graded in 32 of 80 queries, with the key planted at the last row half the time — so it lands in a partial final batch, which is where an off-by-one in a batched loop lives. The failure modes this catches are real designs: a table created inside the batch loop; a per-batch table whose results are finalised and overwritten rather than merged; a "seen in every batch" optimisation someone added to prune noise.

**An empty selection.** No group, not even with count 0. The lab's reason: *"a phantom group with count == 0 is a row in someone's report that does not exist."*

**A NULL group key.** A group, and it sorts first. \`Option\`'s own ordering puts \`None\` before every \`Some\`, which is exactly SQL's \`GROUP BY\` behaviour.

**A group whose values are all NULL.** \`count 2, nulls 2, sum 0, min and max absent.\` The lab spells out why this is subtle: *"absent is not 0, and a sum of 0 is not a min of 0."* Two different facts, one of which is a number and the other of which is the absence of one.

**i64 extremes in one group.** Two \`i64::MAX\` values must report \`18446744073709551616\`, which is why \`Agg::sum\` is \`i128\`. An \`i64\` accumulator reports \`-2\`, silently. This course ranks a silently wrong aggregate with a false negative: both are answers you cannot tell are wrong from the outside.

**A selection that skips rows of the same group.** Four rows of one group, only two selected: sum 3, not 303. An aggregate that walks the batch instead of the selection includes rows a predicate rejected.`,
    },
    {
      type: 'callout',
      variant: 'segfault',
      title: 'the table that belongs to the batch',
      md: `The bug looks like tidiness. Someone writes an operator that is a pure function of its input — batch in, groups out — because that is good design in every other context. Then the merge step is written as "collect all the per-batch results", and one of these three things happens:

- results are put into a map keyed by group, and each batch's entry **overwrites** the previous one instead of merging: every group reports only its last batch
- results are concatenated into a list and the consumer assumes group keys are unique, so a key present in twelve batches becomes twelve rows in the output
- an empty batch produces an empty group with \`count 0\`, which merges into a real group harmlessly *and* appears as a standalone row when no other batch contained that key

None of the three raises an error. All three produce a report where the totals look approximately right, because most groups appear in most batches and only the rare keys are wrong. The rare keys are usually the interesting ones — a new tenant, a new region, a failing device — which is the reason lab 03 plants a single-occurrence key rather than trusting the random data to produce one.

The invariant to hold on to: **the aggregate's output is a function of the whole query's input, not of any batch.** If your operator is going to be pure, then its state has to be an explicit accumulator threaded through the batches, and the merge has to be the aggregate's own \`merge\`, not a map insert.`,
    },
    {
      type: 'prose',
      md: `## When the table does not fit

The hash table's size has nothing to do with how many rows you scanned. It is:

\`\`\`
table bytes  ≈  distinct_keys × (key_width + state_width)
\`\`\`

So a 40-billion-row scan grouped by \`region\` (8 keys) needs a table measured in bytes, while a 100-million-row scan grouped by \`user_id\` (30 million keys) needs, at a 4-byte code plus a 40-byte state,

\`\`\`
30,000,000 × 44 B  ≈  1.32 GB
\`\`\`

per aggregation, before any per-thread duplication. If the operator's memory budget is smaller than that, there are exactly two honest responses, and "buy more memory" is the third one people reach for.

**Radix-partition and spill.** Hash the key, take the top *k* bits, and route each row to one of 2^k partitions. Because every row of a group has the same hash, **every row of a group lands in the same partition** — so partitions can be written to disk and aggregated one at a time with no cross-partition merge at the end. This is the aggregation twin of the GRACE hash join, and the arithmetic is the same: choose *k* so that one partition's table fits in the budget.

**Pre-aggregate, then merge.** Give each thread (or each batch) a small fixed-size table and let it absorb the skewed keys — which in real data is most of the rows — then merge into the global table. It reduces the traffic into the shared structure by whatever the local hit rate is, and it degrades gracefully: with all-distinct keys the local table thrashes and you are back to the shared path.

Two consequences worth saying out loud in a design review:

- **\`GROUP BY\` is a blocking operator.** It cannot emit its first row until it has seen its last input row, which makes it the most memory-intensive thing in most plans, and the reason a query that streams happily can fall over when someone adds a grouping column.
- **High-cardinality grouping is the shape where vectorised execution has the least to offer.** Every mechanism in C4 amortises per-row overhead, and none of them changes the fact that 30 million distinct keys means 30 million random probes into a structure larger than cache. The bound there is the memory system, which is C4.L5.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'What a production engine does when the group table exceeds memory, and what it will not do',
      systems: ['duckdb'],
      sources: ['https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads.html'],
      md: `DuckDB's performance guide is unusually direct about this operator class, and the durable content is the taxonomy rather than any number.

It names **blocking operators** — "operators [that] cannot output a single row until the last row of their input has been seen" — and lists them: **grouping (\`GROUP BY\`), joining, sorting and windowing.** It states that these "require their entire input to be buffered, and are the most memory-intensive operators in relational database systems", that larger-than-memory processing is supported for all of them, and that the mechanism is **spilling to disk** into a temporary directory configured by \`temp_directory\`.

Then it names the limits, which is the part worth quoting in a design review:

- if **multiple blocking operators appear in the same query**, an out-of-memory exception is still possible "due to the complex interplay of these operators"
- some aggregate functions — it names \`list()\` and \`string_agg()\` — **do not support offloading to disk**
- aggregates that use sorting are **holistic**: they need all inputs before aggregation can start, and complex intermediate states cannot yet be offloaded

Read that list against the mergeability table earlier in this lesson and it is the same distinction arriving as an operational constraint: the aggregates that spill cleanly are the ones whose state is small and mergeable, and the ones that cannot are the ones whose state is the input. That is not a product limitation to be worked around; it is the shape of the problem, and any engine that claims otherwise is holding the whole distribution somewhere.

What this does *not* tell you is what your query will do, on your cardinality, with your memory budget. The number that decides it is one you can compute before you run anything: distinct keys × (key width + state width), per concurrent aggregation.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '32 of 80',
          label: 'graded queries containing a key seen in exactly one batch',
          hint: 'Forge lab 03 plants key 999999 at a single row — at the last row half the time, so it lands in a partial final batch.',
        },
        {
          value: '277',
          label: 'groups over 1,008 batches, group for group exact',
          hint: 'Compared per group rather than on totals, because two groups wrong in opposite directions leave the total looking correct.',
        },
        {
          value: '0',
          label: 'groups an empty selection may create',
          hint: 'Not even one with count 0. In the storm, 1,219 of 2,000 batches selected nothing, so this is the common case rather than the exception.',
        },
        {
          value: '1.32 GB',
          label: 'table for 30M distinct keys at 44 B per entry',
          hint: 'Sized by distinct keys, never by rows. Below the budget it stays in memory; above it you radix-partition and spill, or pre-aggregate per thread.',
        },
      ],
    },
    {
      type: 'isomorphism',
      title: 'a batched hash aggregate ≡ three patterns you already use',
      pairs: [
        {
          os: 'a MapReduce combiner',
          osLine:
            'The combiner is a partial reducer that runs on the mapper\'s output, and it is only legal because the reduction is associative and commutative. Give it an average instead of a (sum, count) and it silently returns nonsense.',
          llm: 'per-batch partial aggregates',
          llmLine:
            'Identical requirement, one machine down: Agg::merge is only valid over disjoint row sets, and avg must carry sum and count rather than the average it will eventually report.',
        },
        {
          os: 'string interning',
          osLine:
            'Replace repeated strings with small integer handles so comparison is an integer compare and the table of live objects is small enough to keep hot.',
          llm: 'grouping on dictionary codes',
          llmLine:
            'The same trick with the same caveat: a handle is only meaningful inside the scope that issued it, so codes from two different blocks are two different namespaces and must be translated before they meet.',
        },
        {
          os: 'external merge sort',
          osLine:
            'When the input exceeds memory you do not fail, you partition into runs that fit, process them independently, and combine. Choosing the run size is arithmetic on the budget, not a heuristic.',
          llm: 'radix partitioning and spilling',
          llmLine:
            'Same structure, and one detail makes it easier: every row of a group shares a hash, so partitions never need to be merged with each other — only sized so one table fits.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Your batched aggregate is written as a pure function — batch and selection in, groups out — and the driver collects the per-batch results into a map keyed by group. Tests pass on a 3-batch fixture. What will production show?',
          options: [
            'Nothing wrong: collecting per-batch results into a map keyed by group is the standard shape for a parallel aggregate',
            'Group values that reflect only the last batch containing each key, because inserting into the map overwrites rather than merges — and the groups most likely to be wrong are the rare ones a single batch produced, which are usually the interesting ones',
            'Duplicate group keys in the output, which the client will deduplicate',
            'An out-of-memory error, since one map per batch multiplies the state by the batch count',
          ],
          correct: [1],
          explanation:
            'Purity is not the problem; the merge is. A map insert keyed on group is a last-writer-wins operation, whereas combining aggregates requires the aggregate\'s own merge — count and sum added, min and max compared, and nulls carried separately. The damage is proportional to how spread out a key is: a key in every batch shows the last batch\'s numbers, a key in one batch happens to be correct, and totals look plausible throughout. A 3-batch fixture with dense keys will not catch it, which is precisely why forge lab 03 plants a key at exactly one row and grades 32 of its 80 queries on it.',
        },
        {
          q: 'A query grouping 100 million rows by user_id (about 30 million distinct) is failing with out-of-memory. A colleague proposes increasing the vector size from 2,048 to 32,768 "so there are fewer batches and less overhead". What do you say?',
          options: [
            'Agree — fewer batches means less per-batch overhead, which is where the memory is going',
            'The vector size is unrelated: the table is sized by distinct keys, roughly 30M × 44 B ≈ 1.32 GB, so the answers are radix-partitioning by hash and spilling, or pre-aggregating per thread — and a wider vector may make it worse by increasing the number of in-flight intermediates',
            'Switch the group key to a string so the hash table can use variable-length keys and stay smaller',
            'Add a filter to reduce the number of rows scanned, since table size scales with rows',
          ],
          correct: [1],
          explanation:
            'Nothing about the vector width appears in distinct_keys × (key_width + state_width). Vector size governs per-batch overhead amortisation (C4.L1), which is a cost question, not a capacity one. The real answers are the two standard ones: partition by the high bits of the hash so that every row of a group lands in one partition and partitions can be spilled and aggregated independently, or absorb the skewed keys in a small per-thread table before touching the shared one. Reducing rows scanned helps the scan bill but not the table, unless the filter also removes distinct keys — grouping 1 million rows by 30 million possible ids still only materialises the keys present.',
        },
        {
          q: 'Which of these aggregates cannot be computed exactly by merging per-batch state, and what does that imply for the plan?',
          options: [
            'avg — because dividing sums per batch loses precision, so it must be computed in one pass',
            'count(distinct) and median — their exact state is the input itself rather than a fixed-size summary, so they cannot be merged from bounded per-batch state, which is why they block, spill worst, and ship with approximate variants',
            'min and max — they need a total order over the whole input, which a batch cannot provide',
            'sum — because integer overflow depends on the order values are added in',
          ],
          correct: [1],
          explanation:
            'Mergeability is the property that lets an operator be batched, parallelised across cores, and distributed across nodes — the same test at three scales. count, sum, min, max and stddev all have fixed-size mergeable state; avg does too, as long as you carry (sum, count) rather than the average, which is the classic mistake but not an accuracy-in-one-pass issue. Exact distinct counts and exact percentiles need the key set or the distribution, so their state grows with the input, which is why they are the operators that exhaust memory and why HyperLogLog and t-digest exist: both trade exactness for a bounded, mergeable state. Sum is order-independent in i128 here, and overflow is handled by choosing a wide enough accumulator, which the lab grades.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: aggregation as the operator that decides your memory budget',
      md: `**Graefe, "Query Evaluation Techniques for Large Databases" (ACM Computing Surveys, 1993)** is still the best single treatment of hash aggregation together with its spilling machinery. Read the sections on hash-based aggregation and on partitioning: the argument that a group's rows all share a hash and therefore never need cross-partition merging is made there, and it is the reason spilling an aggregate is easier than spilling a sort.

For the parallel side, **Leis, Boncz, Kemper and Neumann, "Morsel-Driven Parallelism" (SIGMOD 2014)** builds the aggregation operator this lesson describes — thread-local pre-aggregation feeding a shared table, with partitioning to keep the merge cheap — and measures the tradeoff between local table size and merge traffic. It is also the paper C4.L5 leans on, so reading it once serves both lessons.

For the aggregates that cannot merge exactly, go to the primary sources rather than the blog posts: **Flajolet, Fusy, Gandouet and Meunier, "HyperLogLog" (2007)** for cardinality, and **Dunning and Ertl on the t-digest** for percentiles. Both are worth reading specifically for how they define the error they accept — an approximate answer with a stated bound is a professional artifact; an approximate answer without one is a bug.

On the encoding side, **Abadi, Madden and Ferreira (SIGMOD 2006)** covers grouping on encoded values, and **C1.L5** has the version of that argument this course teaches. Do not re-derive it; the delta in this lesson is the table, not the comparison.

Next: **C4.L5** closes the track by putting a ceiling on all of it — what SIMD actually buys, why morsel-driven parallelism beats static partitioning under skew, and why the biggest win in this course is still the first one.`,
    },
  ],
}

export default lesson
