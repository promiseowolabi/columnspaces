import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c4.l3',
  slug: 'late-materialization',
  trackId: 'c4',
  index: 3,
  title: 'Late Materialization',
  minutes: 15,
  hook: 'Forge lab 03\'s storm scans 37,915 rows through two chained predicates and materialises exactly 4,871 values — one per survivor, once per batch, at the end. The other 33,044 rows were never assembled into anything.',
  exercise: 'lab+quiz',
  takeaway: {
    number: '4,871 of 37,915',
    claim:
      'Late materialization means values are copied once per survivor rather than once per row — and it stops paying when you project many columns, when selectivity is high, or when a position means a random seek into a compressed chunk rather than an offset into a resident array.',
  },
  blocks: [
    {
      type: 'prose',
      md: `A row is a convenience for humans. An aggregate does not need one.

Take a query the dashboard runs every ten minutes: filter on a time window, filter on a status, group by region, sum an amount. Four columns. The row-store answer assembles \`(ts, status, region, amount)\` for every candidate row and then throws most of it away. The column-store answer never assembles anything:

1. filter \`ts\` → a list of surviving **positions**
2. filter \`status\` at those positions → a shorter list of positions
3. for each surviving position, fold \`amount[pos]\` into the group named by \`region[pos]\`

Step 3 is the one worth staring at. \`region\` and \`amount\` are two columns of the same batch, so **one position indexes both** — and the pair \`(region, amount)\` is never written down. There is no tuple, no struct, no row. **Late materialization** is the name for deferring the copy until something genuinely needs contiguous values, and for a great many analytical queries the answer is *never*.

Forge lab 03's \`storm\` check runs this exact shape 2,000 times and reports the count that matters: **37,915 rows scanned, 4,871 survived two chained predicates (12.8%), and 4,871 values materialised** — and materialisation happened *once per batch, at the end*. Values copied equals survivors, not rows, and the ratio is the selectivity of the query rather than a property of the engine.`,
    },
    {
      type: 'code',
      filename: 'the aggregate that never builds a row — forge lab 03, src/vectorized.rs',
      lang: 'rust',
      chips: ['two columns, one position', 'no tuple', 'graded: aggregate_correct'],
      code: `/// \`keys\` and \`vals\` are two columns of the SAME batch, so a position indexes
/// both. That is late materialization in one sentence: the row (key, value) is
/// never assembled.
pub fn aggregate_batch(
    table: &mut GroupTable,        // state of the QUERY, not of the batch
    keys:  &[Option<i64>],         // e.g. region codes
    vals:  &[Option<i64>],         // e.g. amount
    sel:   &Sel,                   // positions surviving every predicate
) {
    for &pos in sel {
        table.groups
             .entry(keys[pos as usize])          // group key, read by position
             .or_insert(Agg::zero())
             .add(vals[pos as usize]);           // value, read by position
    }
}

// Note what is NOT here:
//   * no Vec<Row> and no (key, value) pair written to memory
//   * no gather() call — gather exists for the ONE place you need contiguous
//     values, and calling it here would copy 4,871 values to read them once
//   * no work at all when \`sel\` is empty, which is 1,219 of the storm's 2,000
//     batches: no rows selected means no groups touched
//
// And the cost, as a count rather than a clock: \`sel.len()\` map lookups and
// \`sel.len()\` accumulator updates. Rows in the batch do not appear in that
// expression.`,
    },
    {
      type: 'prose',
      md: `## What the lab actually grades, by check id

This lesson is forge lab 03's home. Five checks, and each one pins a different half of the claim:

- **\`filter_matches_scalar\`** — the batched filter selects exactly what a row-at-a-time reference selects, over nine column families and all eight predicate shapes: **17 hand cases and 10,648 batches, 136 of them partial final batches**, 30,688 rows scanned and 10,863 survivors. It also pins \`gather\`'s contract separately: over \`all_rows\` it is the identity, over an empty selection it is empty.
- **\`selection_vector\`** — positions compose (C4.L2): **192 three-deep chains**, of which **141 selected nothing at all** and had to stay empty through filter, gather *and* aggregate.
- **\`aggregate_correct\`** — groups exact across batch boundaries: **10 hand cases and 80 multi-batch queries over 1,008 batches (48 partial finals), 277 groups**, and **32 of those queries had a group key appearing in exactly one batch**. That is C4.L4.
- **\`compressed_path\`** — the encoded fast paths equal decode-then-execute: **4,512 predicate evaluations covering 340,664 rows, 75.5 rows per evaluation**, plus five columns declaring 23,884,901,906 rows that neither side ever expanded.
- **\`storm\`** — 2,000 seeded batches through the whole pipeline at once, with the numbers in the opening paragraph.

One design decision in \`aggregate_batch\` deserves a sentence, because it is what makes late materialization work across batch boundaries: **\`table\` is a parameter, not a return value.** Each batch folds into the same table. A per-batch partial aggregate merged at the end would also work — \`Agg::merge\` is given for exactly that, over disjoint row sets — and it is the same operation that makes a distributed \`GROUP BY\` possible when the merge has to cross a network (**→ C6**).`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — four columns, two predicates, one aggregate, and no row anywhere',
      height: 72,
      nodes: [
        { id: 'q', x: 8, y: 2, w: 84, h: 8, label: 'select region, sum(amount) where ts in window and status = paid', sub: 'four columns touched · one group-by · zero rows assembled', color: '#A78BFA' },
        { id: 'cts', x: 2, y: 14, w: 23, h: 9, label: 'ts', sub: 'predicate 1', color: '#22D3EE' },
        { id: 'cst', x: 27, y: 14, w: 23, h: 9, label: 'status', sub: 'predicate 2', color: '#22D3EE' },
        { id: 'cam', x: 52, y: 14, w: 23, h: 9, label: 'amount', sub: 'aggregated', color: '#22D3EE' },
        { id: 'crg', x: 77, y: 14, w: 21, h: 9, label: 'region', sub: 'group key', color: '#22D3EE' },
        { id: 's1', x: 2, y: 26, w: 96, h: 9, label: 'Sel after the time window', sub: 'positions only — no values copied out of ts, and the other three columns are untouched', color: '#3EF2A4' },
        { id: 's2', x: 2, y: 38, w: 96, h: 9, label: 'Sel after status = paid  ->  4,871 of 37,915 rows (12.8%)', sub: 'the second predicate read status only at the surviving positions', color: '#3EF2A4' },
        { id: 'agg', x: 2, y: 50, w: 46, h: 9, label: 'fold amount[pos] into group region[pos]', sub: '225 groups accumulated across batch boundaries · 0 tuples built', color: '#FBBF24' },
        { id: 'mat', x: 52, y: 50, w: 46, h: 9, label: 'materialise: 4,871 values', sub: 'once per batch, at the end, and only for what a client will see', color: '#22D3EE' },
        { id: 'loss', x: 2, y: 62, w: 96, h: 9, label: 'where it loses: many projected columns · high selectivity · scattered positions', color: '#FB7185' },
      ],
      edges: [
        { from: 'q', to: 'cts' },
        { from: 'cts', to: 's1' },
        { from: 's1', to: 's2' },
        { from: 'cst', to: 's2' },
        { from: 's2', to: 'agg' },
        { from: 'cam', to: 'agg' },
        { from: 'crg', to: 'agg' },
        { from: 's2', to: 'mat' },
        { from: 'mat', to: 'loss' },
      ],
      steps: [
        {
          caption:
            'A dashboard query over four columns. A row store would assemble every candidate record and discard most of the bytes; a column store need not assemble anything at all, and this is the sequence in which it does not.',
          active: ['q', 'cts', 'cst', 'cam', 'crg'],
        },
        {
          caption:
            'The time-window predicate reads only the ts column and produces positions. Nothing has been copied, and status, amount and region have not been touched — projection and late materialization are the same economy applied at two granularities.',
          active: ['s1'],
          edges: ['q->cts', 'cts->s1'],
        },
        {
          caption:
            'The status predicate reads status at the surviving positions and narrows the same list. In the lab storm this leaves 4,871 of 37,915 rows, and the second column was never read for the 33,044 rows already eliminated.',
          active: ['s2', 'cst'],
          edges: ['s1->s2', 'cst->s2'],
        },
        {
          caption:
            'Now the aggregate. Region and amount are two columns of the same batch, so one position indexes both, and each survivor folds a value into a group without the pair ever being written to memory. 225 groups, accumulated across batch boundaries in one table.',
          active: ['agg', 'cam', 'crg'],
          edges: ['s2->agg', 'cam->agg', 'crg->agg'],
        },
        {
          caption:
            'Materialisation happens once, at the end, and only for values something outside the engine will see: 4,871 copies, equal to the number of survivors. The ratio to rows scanned is the query\'s selectivity, not a property of the engine.',
          active: ['mat'],
          edges: ['s2->mat'],
        },
        {
          caption:
            'And the honest half: three situations invert this. Projecting a dozen columns means a dozen scattered gathers; high selectivity means you were going to copy nearly everything anyway; and a position that means "row 4,912 of a compressed page" is a seek, not an offset.',
          active: ['loss'],
          edges: ['mat->loss'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## Three places late materialization loses

Column stores are usually sold on this technique, so the useful thing to know is where it stops paying. All three cases are computable in advance, which means they are design inputs rather than surprises.

**1. Many projected columns.** Late materialization defers *one* copy per column. Project twelve columns and you have twelve gathers, each of them a scattered pass over a different array, each of them touching cache lines it will not reuse. Compact once instead and every subsequent read is sequential. The crossover is the same one as C4.L2's — one indirection per survivor per consumer against one copy per survivor total — and with twelve consumers it is not close. This is why \`SELECT *\` with a filter is the query shape where late materialization has the least to offer, and it is the shape that appears most often in ad-hoc work.

**2. High selectivity.** At 12.8% survival the copies you avoid are 87% of the batch. At 90% survival you avoid 10% of the copies, and you pay an indirection on every read to do it. Above roughly two consumers, or above roughly a third selectivity, the arithmetic tips toward materialising early and reading dense arrays. The predicate that keeps almost everything is the predicate that makes positions pure overhead.

**3. Random access back into chunks — the one that bites in production.** In the lab a position is an offset into a resident \`&[Option<i64>]\`, so a gather is a memory read. In a real engine a position may mean *row 4,912 of a column chunk that is dictionary-encoded, bit-packed and compressed at page granularity*. Resolving it means finding the page, decompressing it if it is not already decoded, and following a dictionary indirection per value. Now count pages instead of values:

\`\`\`
row group          131,072 rows
page               8,192 rows        ->  16 pages per column chunk
survivors          12.8%, scattered uniformly
pages touched      all 16            ->  late materialization saved ZERO page reads
survivors clustered into 2 pages
pages touched      2                 ->  it saved 14 page reads out of 16
\`\`\`

**So the payoff of late materialization is a clustering property, not an execution property.** It is C2 arriving inside the execution engine: the same physical ordering that made zone maps prune is what makes a position list resolve to a handful of pages instead of all of them. If your survivors are scattered, you will read every page either way, and the only thing deferring the copy bought you was an indirection per value.

Say the caveat before the room does: *the lab's counts are for positions into resident arrays, so they cannot show case 3 at all. What the real thing adds is page location, decompression and dictionary indirection per gathered value — and that is precisely where late materialization can go from a win to a loss.*`,
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the two ways this goes wrong in code, both graded',
      md: `**Calling \`gather\` between two filters.** The lab's own comment on \`gather\` names it: *"Calling it between two filters is the mistake this lab exists to make visible: the copy is the cost you removed by having a Sel in the first place."* It is easy to do by accident, because the second filter's signature happily accepts a dense array — and then it produces positions into *that* array, which no longer index any other column of the batch. The code compiles, the shapes line up, and the answers are wrong in a way that depends on selectivity.

**Aggregating without honouring the selection.** \`aggregate_correct\` includes a hand case built for this: four rows of one group, values 1, 100, 2, 200, with only positions 0 and 2 selected. The answer is sum 3 and max 2. An aggregate that walks the batch instead of the selection reports sum 303 and max 200 — it has silently included rows a predicate rejected. There is no error, no warning, and the number is plausible, which is the worst combination available. It is also the reason the check compares group by group rather than comparing totals: a total can be right while two groups are wrong in opposite directions.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '4,871 / 37,915',
          label: 'values materialised versus rows scanned (storm)',
          hint: 'One copy per survivor, once per batch, at the end of the chain. The ratio is the query\'s selectivity — 12.8% here — not an engine constant.',
        },
        {
          value: '1,219 of 2,000',
          label: 'graded batches where the selection survived nothing',
          hint: 'An empty selection must produce no values and no groups. In the storm it happens on more than half the batches, which is why it is the edge case that carries the grade.',
        },
        {
          value: '225',
          label: 'groups accumulated across batch boundaries',
          hint: 'One GroupTable per query, not per batch. A key seen in batch 0 and batch 7 is one group with one running aggregate.',
        },
        {
          value: '16 → 2',
          label: 'pages a gather touches, scattered versus clustered',
          hint: '131,072-row row group, 8,192-row pages, 12.8% selectivity. Late materialization saves page reads only when the survivors are physically near each other — which is a C2 layout property.',
        },
      ],
    },
    {
      type: 'isomorphism',
      title: 'late materialization ≡ deferrals you already reason about',
      pairs: [
        {
          os: 'index-only scan, then heap fetch',
          osLine:
            'If the index covers the query, the heap is never touched. If it does not, you pay a random fetch per matching row — and past a few percent selectivity the planner switches to a sequential scan for exactly that reason.',
          llm: 'positions, then gather',
          llmLine:
            'The same crossover, and the same planner decision: below a few percent the position list wins, above roughly a third of the batch you should have materialised and read dense arrays.',
        },
        {
          os: 'lazy loading, and the N+1 problem',
          osLine:
            'Deferring the fetch is free until something iterates the collection, at which point you have issued one query per element and the deferral has become the bug.',
          llm: 'a gather per projected column',
          llmLine:
            'Deferring the copy is free until twelve expressions each read the survivors through the selection. Then you have paid twelve scattered passes to avoid one copy.',
        },
        {
          os: 'a pointer into a page cache',
          osLine:
            'An offset is cheap while the page is resident and expensive the moment it is not — which is why "just keep a reference" is a claim about the cache, not about the pointer.',
          llm: 'a position into a column chunk',
          llmLine:
            'Cheap while it means an array offset, expensive when it means locate the page, decompress it, and follow a dictionary code. The lab can only show the cheap case; production supplies the other one.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'An ad-hoc query does SELECT * FROM events WHERE ts BETWEEN ... AND status = \'paid\', returning about 40% of a row group. Your engine uses selection vectors and gathers each projected column at the end. Where is the cost going?',
          options: [
            'Into the two predicates, since both must be evaluated over the whole row group',
            'Into the gathers: with 24 projected columns and 40% selectivity you are doing 24 scattered passes to avoid copies you were going to make anyway — this is the shape where compacting the survivors once and reading dense arrays is cheaper, and late materialization has almost nothing to offer',
            'Into the group table, because SELECT * forces every column into the aggregate state',
            'Into the selection vector\'s memory, which at 40% selectivity exceeds the size of the batch itself',
          ],
          correct: [1],
          explanation:
            'Late materialization defers one copy per column, so its value scales inversely with the number of projected columns and with selectivity. Twenty-four columns means twenty-four consumers of the survivor list, which is well past the roughly-two-consumer crossover, and 40% selectivity means the copies avoided are a minority of the batch. Both effects point the same way: compact once, then read dense arrays. The predicates are not the problem — the second one is evaluated only over the first one\'s survivors. And a Vec<u32> at 40% selectivity is about 1.6 bytes per row of the batch, which is real but not the dominant term.',
        },
        {
          q: 'Two tables have identical schemas, identical row counts and identical queries. One is written in event-time order; the other arrives shuffled. Both use late materialization. Why does only one of them get the benefit?',
          options: [
            'It does not depend on write order — late materialization is an execution technique and works identically on any physical layout',
            'Because positions resolve to pages: with survivors clustered into 2 of 16 pages the gather reads 2 pages, while uniformly scattered survivors at the same selectivity touch all 16 — so the deferral saves page reads only when the layout puts survivors near each other',
            'Because the shuffled table has more distinct values, so the dictionary is larger',
            'Because the shuffled table cannot use selection vectors, only bitmaps',
          ],
          correct: [1],
          explanation:
            'In a lab, a position is an array offset and a gather is a memory read. In an engine, a position may mean row 4,912 of a compressed, encoded page — so the count that matters is pages touched, not values copied. At 12.8% selectivity, uniformly scattered survivors touch every page of the chunk and the deferral saved nothing while still costing an indirection per value; clustered survivors touch two. That makes the payoff of late materialization a property of the physical layout, which is C2 reappearing inside the execution engine, and it is the reason clustering depth belongs on a dashboard rather than in a design document.',
        },
        {
          q: 'Forge lab 03\'s aggregate_correct includes a case with four rows of one group holding 1, 100, 2, 200, where only positions 0 and 2 are selected. The expected answer is sum 3 and max 2. What class of bug is that case built to catch, and why is it graded group by group rather than on totals?',
          options: [
            'Integer overflow in the accumulator, which is why sums are i128',
            'An aggregate that walks the batch instead of the selection — it silently includes rows a predicate already rejected and reports a plausible number, and per-group comparison is required because two groups can be wrong in opposite directions while the total looks correct',
            'A null-handling bug, since unselected rows behave like nulls',
            'An ordering bug, since the output must be sorted by key with NULL first',
          ],
          correct: [1],
          explanation:
            'Ignoring the selection is the aggregate-side version of "an empty selection means no filter": no error is raised, no invariant is visibly broken, and the answer is wrong in a way proportional to how selective the predicate was. Comparing totals would not catch it reliably, because one group over-counting and another under-counting can cancel; comparing group for group against a reference that groups by scanning does. The lab also grades overflow (two i64::MAX values must report 18446744073709551616 rather than -2), null semantics and key ordering — but those are separate hand cases with their own stated reasons.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the paper that named the strategies, and the one that priced them',
      md: `The canonical source is **Abadi, Myers, DeWitt and Madden, "Materialization Strategies in a Column-Oriented DBMS" (ICDE 2007)**. It is the paper that defines early and late materialization as a *strategy space* rather than a best practice, builds an analytical cost model for both, and — the part worth your evening — identifies the conditions under which early materialization wins. If you only take one thing from it, take the framing: materialisation timing is a plan decision with inputs (selectivity, number of projected columns, whether the column is fixed-width, whether the position list is sorted), and an optimiser that hard-codes one strategy is leaving the other's wins on the table.

**Stonebraker et al., "C-Store: A Column-oriented DBMS" (VLDB 2005)** is the system that made position lists a first-class citizen, and its discussion of projections and join indices is where "positions" stop being an implementation detail and become part of the physical design.

For the mechanics at the level this lesson counts, **Boncz, Zukowski and Nes (CIDR 2005)** again, and **Zukowski's thesis (2009)** for why the gather is the operation to watch: it is the one place a vectorised engine does random access, and every bound on it comes from the memory hierarchy rather than from instruction count. **C4.L5** picks that up as the ceiling.

Cross-links instead of re-derivations: **C1.L5** for why the aggregate over a run or a dictionary code never decodes at all — the extreme case of late, where the value is never materialised even once. **C2.L3** for clustering depth, which is the metric that predicts whether your positions will resolve to two pages or sixteen. **C6** for what happens to \`Agg::merge\` when the merge crosses a network.

Next: **C4.L4** — the hash table as the query's state, why grouping on dictionary codes changes the table rather than the comparison, and the group key that appears in exactly one batch.`,
    },
  ],
}

export default lesson
