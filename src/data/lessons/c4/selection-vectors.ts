import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c4.l2',
  slug: 'selection-vectors',
  trackId: 'c4',
  index: 2,
  title: 'Selection Vectors',
  minutes: 14,
  hook: 'Two chained predicates over 131,072 rows: 0 values copied, and the second comparison is evaluated 89,618 times instead of 131,072. The filter never touched a row — it wrote down positions.',
  exercise: 'quiz',
  takeaway: {
    number: '0 copies, or exactly 53,259',
    claim:
      'A selection vector filters by addressing positions instead of moving values, so chaining predicates costs zero copies — and the moment more than about two operators read the survivors, copying them once becomes the cheaper answer.',
  },
  blocks: [
    {
      type: 'prose',
      md: `A filter that copies the surviving values into a new array has paid for the filter twice: once to test, once to move. And it has thrown away information the next operator needed — *which* rows survived — so the next filter has to work on a batch whose positions no longer line up with any other column.

The alternative is one line of data structure and a different way of thinking:

\`\`\`
values   [ 7,  3, NULL,  9,  4 ]
v > 3    Sel [0, 3, 4]        <- no values copied
v < 9    Sel [0, 4]           <- narrowed, same positions
gather   [ 7, 4 ]             <- copied ONCE, at the very end
\`\`\`

A **selection vector** is a list of the positions in this batch that are still alive. Not values, not rows: positions. Everything else in C4 follows from that one substitution, and so does the reason it is safe.

The measured consequence, from the \`batch-machine\` model on 131,072 rows at a vector width of 2,048: **89,618 rows survive the first predicate, 53,259 survive both, and the number of values copied while addressing is 0.** Turn compaction on and it is exactly **53,259** — one copy per survivor, never one per row. That pair of numbers is the whole tradeoff, and this lesson is about when each is right.`,
    },
    {
      type: 'prose',
      md: `## Positions are not rows, and the difference is load-bearing

Position 4 of a batch is position 4 in *every* column of that batch. That is the property that makes a position list composable and a value list not:

- **Two filters on two different columns compose without a copy.** Filter column A, hand the surviving positions to the filter on column B. B reads \`b[pos]\` for each surviving position; it never needs A's values and never needs a materialised row.
- **The second predicate is evaluated only over survivors.** In the model, comparisons at width 2,048 total **220,690** — that is 131,072 for the first predicate plus 89,618 for the second, not 262,144. The 41,454 comparisons you did not do are the rows the first predicate had already killed.
- **The aggregate can consume two columns by position** and never assemble the pair. That is C4.L3.

Forge lab 03 pins four invariants on every selection you produce, and grades them everywhere in the suite:

1. **strictly increasing** — row order survives, so \`gather\` is a single forward pass rather than a random walk
2. **every position is < the batch length** — a position indexes *this* batch and no other
3. **the output is a subset of the input** — a filter narrows; it may never resurrect a row an earlier predicate killed
4. **an empty selection means nothing survived** — it does not mean "no filter"

The lab's \`selection_vector\` check reports what enforcing those buys: **192 three-deep chains over 17,552 row-positions, of which 1,410 survived (8.0%), and 141 chains selected nothing at all** and stayed empty through filter, gather and aggregate. It also checks that AND commutes — filtering A then B gives the same positions as B then A — and that re-applying a predicate to its own output changes nothing.`,
    },
    {
      type: 'prose',
      md: `## The check that proves the copy was unnecessary rather than merely expensive

The interesting half of \`selection_vector\` is not the invariants. It is this equivalence, run on every one of those 192 chains:

\`\`\`
compose:              filter(b, p2, s1)                       -> s2
materialise-then-map: filter(gather(b, s1), p2, all_rows(..))  -> local
                      local.map(|l| s1[l])                     -> mapped
                      assert mapped == s2
\`\`\`

Read it slowly, because it is the argument for the whole design. The right-hand side is the naive engine: copy the surviving values of column B into a dense array, filter that array, then translate the local positions back through the first selection. The left-hand side never copies anything. **If those two ever disagree, the selection vector is not carrying position information faithfully, and late materialization is unsafe in your engine** — which would make every optimisation built on it a wrong answer waiting for the right data.

They agree on all 192 chains, and the harness says why that matters in its own pass message: composition equalling materialise-then-map is *"the proof that the intermediate copy is unnecessary, not merely expensive."*

That is the difference between a performance argument and a correctness one, and it is the reason this course grades fast paths as equivalences.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — one batch, two predicates, and the single place a value is copied',
      height: 62,
      nodes: [
        { id: 'v0', x: 2, y: 2, w: 18, h: 9, label: 'v[0] = 7', sub: 'position 0', color: '#A78BFA' },
        { id: 'v1', x: 21, y: 2, w: 18, h: 9, label: 'v[1] = 3', sub: 'position 1', color: '#A78BFA' },
        { id: 'v2', x: 40, y: 2, w: 18, h: 9, label: 'v[2] = NULL', sub: 'position 2', color: '#A78BFA' },
        { id: 'v3', x: 59, y: 2, w: 18, h: 9, label: 'v[3] = 9', sub: 'position 3', color: '#A78BFA' },
        { id: 'v4', x: 78, y: 2, w: 20, h: 9, label: 'v[4] = 4', sub: 'position 4', color: '#A78BFA' },
        { id: 's1', x: 2, y: 15, w: 96, h: 9, label: 'after v > 3  ->  Sel [0, 3, 4]', sub: 'three positions written; zero values moved; NULL is not comparable, so it is gone', color: '#3EF2A4' },
        { id: 's2', x: 2, y: 27, w: 96, h: 9, label: 'after v < 9  ->  Sel [0, 4]', sub: 'the second predicate was evaluated over 3 positions, not 5 — survivors only', color: '#3EF2A4' },
        { id: 'gath', x: 2, y: 39, w: 46, h: 9, label: 'gather -> [7, 4]', sub: 'the ONE copy: contiguous values, in selection order, at the end', color: '#22D3EE' },
        { id: 'agg', x: 52, y: 39, w: 46, h: 9, label: 'or aggregate by position', sub: 'no copy at all — the tuple (key, value) is never assembled', color: '#FBBF24' },
        { id: 'bad', x: 2, y: 51, w: 96, h: 9, label: 'gather() BETWEEN two filters = you materialised for nothing', sub: 'the copy is exactly the cost the selection vector existed to remove', color: '#FB7185' },
      ],
      edges: [
        { from: 'v0', to: 's1' },
        { from: 'v3', to: 's1' },
        { from: 'v4', to: 's1' },
        { from: 's1', to: 's2' },
        { from: 's2', to: 'gath' },
        { from: 's2', to: 'agg' },
        { from: 'gath', to: 'bad' },
      ],
      steps: [
        {
          caption:
            'One column of one batch, five positions. A null sits at position 2, and three-valued logic means it satisfies nothing except IS NULL — which is a semantics rule, not an optimisation.',
          active: ['v0', 'v1', 'v2', 'v3', 'v4'],
        },
        {
          caption:
            'The first predicate writes the positions that survived: [0, 3, 4]. Nothing was copied and nothing moved, so every other column of this batch is still addressable by the same numbers.',
          active: ['s1'],
          edges: ['v0->s1', 'v3->s1', 'v4->s1'],
        },
        {
          caption:
            'The second predicate reads through that list, so it is evaluated three times rather than five. Scaled up on the lab column, that is 89,618 comparisons instead of 131,072 — the difference is the rows already dead.',
          active: ['s2'],
          edges: ['s1->s2'],
        },
        {
          caption:
            'Only now is a value copied, and only if something downstream genuinely needs contiguous values — returning rows to a client, or feeding an operator that cannot consume positions. Two copies here; 53,259 on the lab column.',
          active: ['gath'],
          edges: ['s2->gath'],
        },
        {
          caption:
            'And an aggregate does not need even that: keys and values are two columns of the same batch, so a position indexes both, and the aggregate folds values into groups without a row ever existing. That is late materialization in one sentence.',
          active: ['agg'],
          edges: ['s2->agg'],
        },
        {
          caption:
            'The mistake the design makes visible: calling gather between two filters. You have paid the copy the selection vector removed, and the second filter now works on positions that no longer index the other columns of the batch.',
          active: ['bad'],
          edges: ['gath->bad'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## Address or compact: a real tradeoff, decided by consumer count

Addressing is not free. Every operator that reads a surviving row through the selection pays an **indirection** — load the position, then load the value — and it pays it again for every consumer. Compaction pays a gather **once** (a lookup and a copy per survivor) and then every consumer reads a dense array.

So the arithmetic is not about selectivity at all. It is about how many operators read the survivors:

| aggregate expressions reading the batch | addressing | compacting | winner |
|---|---|---|---|
| 1 (\`count(*)\`) | 646,242 | 699,565 | **addressing**, by 53,323 |
| 2 (\`+ sum(v)\`) | 806,019 | 806,083 | a tie in all but name — **64 operations apart** |
| 4 (\`+ min(v), max(v)\`) | 1,125,573 | 1,019,119 | **compacting**, by 106,454 |

The crossover sits at about two consumers, and the model puts it there by construction: addressing costs one lookup per survivor per consumer, compaction costs one lookup plus one copy per survivor, total. Below two, the copy is waste; above two, the indirection is.

**Which means an engine cannot answer this statically.** The right choice depends on the *plan* — how many expressions consume the filter's output — and a good engine decides per operator, not per query. It is the same shape of decision as the vector width in C4.L1: a mechanism with a computable crossover and no universally correct setting.

There is a second representation choice underneath it, with its own arithmetic. A selection vector costs 4 bytes per **surviving** row; a validity-style **bitmap** costs 1 bit per row whether or not it survived. Over a 131,072-row vector that is 16,384 bytes for the bitmap, fixed, against 4 × survivors for the position list — so the position list is smaller below **1 in 32 rows surviving, 3.125% selectivity**, and larger above it. Lab 03 pins \`Sel\` as \`Vec<u32>\` deliberately, and says why: a selective predicate is the common case in analytics. That is a defensible default, not a law, and a filter that keeps 80% of rows is exactly where it is the wrong one.`,
    },
    {
      type: 'callout',
      variant: 'segfault',
      title: 'an empty selection is not "no selection"',
      md: `The single most common way a batched engine returns wrong answers, and forge lab 03 grades it in three separate checks.

An empty selection means **no rows survived the previous operator.** Read it as "no filter was applied, therefore all rows", and:

- the filter after it resurrects every row in the batch, so a chain of ANDs quietly becomes something else
- \`gather\` produces values for rows a predicate already rejected
- the aggregate creates a **group with count 0** — a row in someone's report describing an empty set

The lab checks each of those explicitly. It runs a filter over an empty input selection under all eight predicate shapes and requires empty out; it finds the **141 chains of 192** that killed every row and pushes them through filter, gather and aggregate to confirm nothing comes back; and its aggregate hand cases include "empty selection over a full batch" with the reason attached: *"nothing was selected, so no group exists — not even one with count 0."*

The reason this bug is so persistent is that the two states are represented identically in most APIs — a length-zero list — and the difference between them is a convention you have to hold. If your engine has an \`Option<Sel>\` where \`None\` means "all rows", make sure the empty vector cannot be produced by the same code path, because the day it is, the query returns more rows than the predicate allows and nothing raises an error.`,
    },
    {
      type: 'callout',
      variant: 'info',
      title: 'why "strictly increasing" is a correctness rule and not tidiness',
      md: `Order is the one thing a selection vector must preserve, and three things depend on it:

- **\`gather\` is a forward pass.** A monotone position list means the copy walks memory in one direction, which is the difference between a sequential read and a random one at every level of the hierarchy. An unordered list would still produce the right values, in the wrong order.
- **Composition is a subset relation.** Checking that filter's output ⊆ its input is cheap when both are sorted, and the invariant "positions never move" is what lets a later operator on a *different column* use the same numbers.
- **Row order is semantically visible.** \`LIMIT\` without \`ORDER BY\`, window functions and any client that consumes a result stream all observe the order in which rows come out. A filter that reorders its survivors turns "arbitrary but stable" into "changes when the plan changes".

The lab's error message for a violated ordering names all of this at once, and it is worth borrowing as a code comment in your own engine: *"row order is the one thing a selection vector must preserve, and gather, composition and late materialization all assume a forward pass."*`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '0',
          label: 'values copied while addressing',
          hint: 'Two chained predicates over 131,072 rows, modelled: rowCopies stays 0 through the entire filter chain. The copy only happens if you ask for it.',
        },
        {
          value: '53,259',
          label: 'copies when you compact instead — exactly one per survivor',
          hint: 'Never one per row. Compaction gathers through the selection once, then every downstream consumer reads a dense array.',
        },
        {
          value: '89,618',
          label: 'evaluations of the second predicate, not 131,072',
          hint: 'The second comparison runs only over rows the first one kept. Total comparisons at width 2,048: 220,690 rather than 262,144.',
        },
        {
          value: '141 of 192',
          label: 'graded chains where nothing survived at all',
          hint: 'Forge lab 03\'s selection_vector check. Those chains have to stay empty through filter, gather and aggregate — the empty selection is the edge case, not the exception.',
        },
      ],
    },
    {
      type: 'isomorphism',
      title: 'a selection vector ≡ three indirections you already trust',
      pairs: [
        {
          os: 'an index scan\'s rowid list',
          osLine:
            'The index gives you row identifiers, and the heap fetch happens later — sometimes not at all, if the index covers the query. Nobody copies the table to filter it.',
          llm: 'Sel, then gather',
          llmLine:
            'Positions first, values later, and often never: an aggregate over positions is the covering-index case of vectorised execution.',
        },
        {
          os: 'a boolean mask versus fancy indexing',
          osLine:
            'A mask costs one bit per element regardless of how many pass; an index array costs one entry per element that passes. Which is smaller is arithmetic on selectivity, and libraries carry both.',
          llm: 'bitmap versus position list',
          llmLine:
            'Break-even over a 131,072-row vector is 3.125% selectivity: 16,384 bytes fixed against 4 bytes per survivor. Lab 03 picks positions because analytics filters are usually selective.',
        },
        {
          os: 'a slice versus a clone',
          osLine:
            'Passing a view means the callee reads through your memory; passing a copy means it reads its own. One is cheaper once and dearer per read, and the crossover is the number of readers.',
          llm: 'address versus compact',
          llmLine:
            'Exactly the same crossover, and the model puts it at two consumers: 646,242 against 699,565 with one reader, 1,125,573 against 1,019,119 with four.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A profiler shows your filter output is read by four aggregate expressions — count(*), sum(v), min(v) and max(v). Someone proposes removing the selection vector for this operator and copying survivors into a dense batch instead. Is that right, and why?',
          options: [
            'No — the selection vector is always cheaper, since copying survivors is pure overhead the design exists to remove',
            'Yes — addressing costs one indirection per survivor per consumer while compaction costs one lookup plus one copy per survivor once, so past roughly two consumers the copy amortises: the model has 1,125,573 operations for addressing against 1,019,119 for compacting at four consumers',
            'Yes, but only because four expressions means four passes over the data, which a selection vector cannot support',
            'No — compaction changes which rows are aggregated, so the two are not interchangeable',
          ],
          correct: [1],
          explanation:
            'This is a genuine tradeoff with a computable crossover, not a best practice. With one consumer, addressing wins by 53,323 modelled operations; with two it is a 64-operation tie; with four, compaction wins by 106,454. Neither choice changes the answer — the model asserts identical results in both modes — so the decision belongs to the planner, which knows how many expressions consume the operator\'s output. The tempting wrong answer is option 1, because "avoid the copy" is the slogan the selection vector is usually taught with, and it is only true while the survivors are read once.',
        },
        {
          q: 'Forge lab 03 checks that composing two filters gives the same positions as materialising the intermediate column, filtering that, and mapping local positions back through the first selection. Why is that framed as a correctness check rather than a performance one?',
          options: [
            'Because materialising is faster, so the composed path must be proven not to be slower',
            'Because if the two disagree, the selection vector is not carrying position information faithfully — which makes late materialization unsafe and turns every optimisation built on it into a wrong answer that depends on the data',
            'Because SQL requires that intermediate results be materialisable on request',
            'Because the composed path can produce positions out of order, and the check catches that',
          ],
          correct: [1],
          explanation:
            'The materialise-then-map path is the naive engine, and it is the reference. The composed path is the optimisation. If they ever differ, the position bookkeeping is broken, and everything downstream — the aggregate that consumes two columns by position, the compressed path, the gather at the end — is reading the wrong rows while reporting success. The lab runs the comparison on all 192 chains and states the conclusion in its pass message: composition equalling materialise-then-map is the proof that the intermediate copy is unnecessary rather than merely expensive. Ordering is checked too, but separately, by the strictly-increasing invariant.',
        },
        {
          q: 'A filter on a low-selectivity predicate keeps 80% of a 131,072-row vector. Your engine represents survivors as a Vec<u32> of positions. What is the honest assessment?',
          options: [
            'Fine — a position list is the standard representation and 4 bytes per row is negligible',
            'The representation is working against you: 4 bytes per survivor is about 419 KB against a bitmap\'s fixed 16,384 bytes, and every downstream read pays an indirection to avoid copies you were going to make anyway — below roughly 3.125% selectivity positions win, above it a mask does',
            'You should push the predicate into the scan so that no selection vector is needed at all',
            'The problem is the vector width, not the representation — widen it and the position list amortises',
          ],
          correct: [1],
          explanation:
            'Position lists are sized by survivors and bitmaps by rows, so the crossover is pure arithmetic: 1 bit per row versus 32 bits per survivor gives break-even at 1 in 32 rows, or 3.125%. At 80% selectivity a position list is roughly 26× the bitmap and the indirection buys almost nothing, because nearly every row will be read anyway — this is the case where compaction or a mask is right. Lab 03 chooses Vec<u32> and says why: a selective predicate is the common case in analytics. That is a defensible default with a named failure mode, which is different from a law. Widening the vector changes nothing about bytes per survivor.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: positions as a first-class data structure',
      md: `The best single survey is **Abadi, Boncz, Harizopoulos, Idreos and Madden, "The Design and Implementation of Modern Column-Oriented Database Systems" (2013)**. Its section on vectorised execution treats the selection vector as a representation choice with consequences rather than as an implementation detail, and it is where the bitmap-versus-position-list discussion is laid out properly, including the hybrid engines that carry both and switch on measured selectivity.

For the mechanics at the instruction level, **Polychroniou, Raghavan and Ross, "Rethinking SIMD Vectorization for In-Memory Databases" (SIGMOD 2015)** is the paper on how a selective filter is actually implemented on a wide machine — selective loads and stores, and why a branchless comparison plus a compaction step beats a branch. It is also the honest source on when the gather that a position list implies is the expensive part, which is the loss case C4.L3 develops.

If you want the shape in a library rather than a paper, read **Apache Arrow's compute kernels**: \`filter\` and \`take\` are exactly the two operations in this lesson — a mask-driven compaction and a position-driven gather — and Arrow's decision to expose both, with different cost characteristics, is the same admission this lesson makes.

Cross-links rather than re-derivations: **C1.L5** already showed why filtering dictionary codes evaluates a predicate once per distinct value instead of once per row — this lesson is about what the filter *returns*, not what it compares. **C4.L3** takes position lists to their conclusion, an aggregate that never assembles a tuple, and names the three cases where that loses.

Next: **C4.L3** — late materialization, and the query that answers itself without ever building a row.`,
    },
  ],
}

export default lesson
