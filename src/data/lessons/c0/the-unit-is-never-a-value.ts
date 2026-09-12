import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c0.l2',
  slug: 'the-unit-is-never-a-value',
  trackId: 'c0',
  index: 2,
  title: 'The Unit Is Never a Value',
  minutes: 14,
  hook: 'You cannot read one number off a disk. Everything about columnar performance follows from what the smallest readable unit actually is.',
  exercise: 'quiz',
  takeaway: {
    number: '4 levels',
    claim:
      'A columnar file is file → row group → column chunk → page, and each level exists to make a different decision skippable.',
  },
  blocks: [
    {
      type: 'prose',
      md: `C0.L1 gave you a formula and a bill. This lesson gives you the reason the formula works, and it starts with a fact that sounds pedantic and turns out to govern everything: **you cannot read one value.**

Storage hands you blocks. A request goes out, a block comes back, and the block is the unit whether you wanted one byte of it or all of it. So the real question is never "how many values does my query need" — it is **"how many blocks contain them, and how few blocks could contain them instead."** Layout is the practice of arranging data so that the answer to the second question is small.

Row stores and column stores make the same request to the same hardware. The difference is entirely in what got packed into the block.`,
    },
    {
      type: 'prose',
      md: `## Four levels, each one a decision

Open any modern columnar file — Parquet, ORC, a proprietary equivalent — and you find the same four-level nesting. It looks like bureaucracy. It is actually four different skip opportunities:

| level | what it is | what it lets you skip |
|---|---|---|
| **file** | one object in storage | whole files, from the catalog, before opening anything |
| **row group** | a horizontal slice — *all* columns for some range of rows | ranges of rows, using per-group statistics |
| **column chunk** | one column's values within one row group, stored contiguously | entire columns, via projection |
| **page** | the smallest independently decodable unit inside a chunk | fine-grained ranges, and it bounds decode work |

The nesting is what makes projection *physical* rather than a filter applied late. A column chunk is a **contiguous byte range** at a known offset. Reading three columns of sixty means issuing reads for three byte ranges and never touching the other fifty-seven. That is the whole trick, and it is why C0.L1's 19× projection factor is available without any cleverness: it is a consequence of where the bytes were placed.

Note carefully that **row groups cut across all columns.** They have to: reassembling a row requires taking the nth value from every column chunk, which only works if every chunk in a group covers the same rows. This is why pruning is decided per row group and never per column — a fact worth holding on to, because implementing it wrong produces impossible-looking pruning ratios, and forge lab 02 grades exactly this.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — one file, four levels, three reads',
      height: 70,
      nodes: [
        { id: 'file', x: 2, y: 2, w: 96, h: 8, label: 'orders.parquet', sub: 'one object · footer at the end', color: '#A3E635' },
        { id: 'rg0', x: 2, y: 16, w: 30, h: 9, label: 'row group 0', sub: 'ts: Jan–Mar', color: '#94A3B8' },
        { id: 'rg1', x: 35, y: 16, w: 30, h: 9, label: 'row group 1', sub: 'ts: Apr–Jun', color: '#94A3B8' },
        { id: 'rg2', x: 68, y: 16, w: 30, h: 9, label: 'row group 2', sub: 'ts: Jul–Sep', color: '#22D3EE' },
        { id: 'ck_ts', x: 68, y: 30, w: 30, h: 8, label: 'chunk: order_ts', sub: 'contiguous bytes', color: '#3EF2A4' },
        { id: 'ck_rg', x: 68, y: 40, w: 30, h: 8, label: 'chunk: region', sub: 'contiguous bytes', color: '#3EF2A4' },
        { id: 'ck_rev', x: 68, y: 50, w: 30, h: 8, label: 'chunk: net_revenue', sub: 'contiguous bytes', color: '#3EF2A4' },
        { id: 'ck_rest', x: 68, y: 60, w: 30, h: 8, label: '57 other chunks', sub: 'never requested', color: '#FB7185' },
        { id: 'pages', x: 2, y: 40, w: 40, h: 18, label: 'pages inside one chunk', sub: 'smallest decodable unit · bounds decode work', color: '#A78BFA' },
        { id: 'footer', x: 2, y: 30, w: 40, h: 8, label: 'the footer', sub: 'schema + offsets + statistics', color: '#FBBF24' },
      ],
      edges: [
        { from: 'file', to: 'footer', label: 'read the end first' },
        { from: 'footer', to: 'rg2', label: 'statistics say: only this one' },
        { from: 'rg2', to: 'ck_ts' },
        { from: 'rg2', to: 'ck_rg' },
        { from: 'rg2', to: 'ck_rev' },
        { from: 'rg2', to: 'ck_rest', label: 'skipped by projection' },
        { from: 'ck_ts', to: 'pages', label: 'decode page by page' },
      ],
      steps: [
        {
          caption:
            'A columnar reader opens the file by seeking to the END. The footer holds the schema, every chunk\'s byte offset, and the statistics — so the reader learns what it can avoid before it reads any data at all.',
          active: ['file', 'footer'],
          edges: ['file->footer'],
        },
        {
          caption:
            'Row groups are horizontal slices covering all columns for a range of rows. Per-group statistics on order_ts let the planner discard groups 0 and 1 outright: their maximum timestamp is older than the predicate, so no row inside them can match.',
          active: ['rg0', 'rg1', 'rg2', 'footer'],
          edges: ['footer->rg2'],
        },
        {
          caption:
            'Inside the surviving group, each column is a contiguous byte range at a known offset. The reader issues three range requests — one per projected column — and the other fifty-seven chunks are never named, never requested, never paid for.',
          active: ['ck_ts', 'ck_rg', 'ck_rev', 'ck_rest'],
          edges: ['rg2->ck_ts', 'rg2->ck_rg', 'rg2->ck_rev', 'rg2->ck_rest'],
        },
        {
          caption:
            'Within a chunk, pages are the smallest independently decodable unit. They bound how much CPU a partial read costs: you decode the pages you need rather than the whole column. This is the level most people never configure and occasionally should.',
          active: ['pages'],
          edges: ['ck_ts->pages'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## The row-group size dial has two edges

Row group size is the one layout parameter that reliably gets set wrong, in both directions, for the same reason: people optimise the edge they have recently been burned by.

**Make row groups smaller** and statistics get finer, so pruning gets sharper. In the C0.L1 lab, the fixture at 20,480 rows per group produces 25 groups, and a seven-day window lands in exactly one of them — 96% skipped. Cut the group size to 2,048 and you get 245 groups: the same window now touches 3 of them, 98.8% skipped, and the scan reads about half as many bytes.

**But** every row group multiplies metadata. Statistics exist *per column per row group*, so 200 groups over 45 columns is 9,000 statistics entries in the footer instead of 900. The planner reads and evaluates all of them before touching data. Push this far enough and planning dominates execution — which is Column Week's second incident, where a table with 1.4M live files spends most of its time deciding what to read.

**And** compression works within a chunk, so smaller chunks mean smaller dictionaries and shorter runs. A dictionary rebuilt every 10,000 rows compresses worse than one amortised over 100,000.

So the dial trades **pruning precision** against **metadata volume and compression efficiency**, and the optimum depends on how selective your real predicates are. There is no default that is right; there is only a default that is common. C2 makes this a designed decision, and the pruning lab lets you find the crossover on data you control.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '4',
          label: 'levels of skip in one file',
          hint: 'File, row group, column chunk, page. Each one exists to make a different decision avoidable.',
        },
        {
          value: '25 → 245',
          label: 'row groups when you cut group size 10×',
          hint: 'Measured on the course fixture: 500k rows at 20,480 per group is 25 groups; at 2,048 it is 245. Ask for a size the engine cannot honour and it will round to its vector width.',
        },
        {
          value: '45 × N',
          label: 'statistics entries in the footer',
          hint: 'Per column, per row group. 45 columns across 200 groups is 9,000 entries the planner evaluates before reading data.',
        },
        {
          value: '1',
          label: 'row groups a 7-day window touched',
          hint: 'Out of 25, on the clustered fixture. The same window on the shuffled fixture touched all 25.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the mistake that produces impossible pruning ratios',
      md: `Pruning is decided **per row group**, using the statistics of the *predicate's* column. A common implementation error is to test each projected column's own statistics and skip chunks independently — which reports spectacular pruning and returns wrong answers, because you have dropped the \`region\` values belonging to rows whose \`order_ts\` you kept.

Row groups cut across all columns precisely so that the nth value of every chunk belongs to the same row. Break that alignment and you have not built a fast scan, you have built a shredder. Forge lab 02's \`no_false_negatives\` check exists to catch this, and it is the check that catches the most people.`,
    },
    {
      type: 'isomorphism',
      title: 'the four levels ≡ things you already tune',
      pairs: [
        {
          os: 'a filesystem block',
          osLine:
            'You cannot read one byte off a disk; you read a block. Reading 1 byte and 4 KiB cost the same.',
          llm: 'a page',
          llmLine:
            'The smallest independently decodable unit. Requesting one value costs the page that holds it, plus the decode.',
        },
        {
          os: 'a partition in a batch job',
          osLine:
            'A unit of work you can schedule, skip or retry independently. Too many and the scheduler is the bottleneck.',
          llm: 'a row group',
          llmLine:
            'A unit you can prune independently. Too many and the planner is the bottleneck — same curve, different layer.',
        },
        {
          os: 'a covering index',
          osLine:
            'Chosen in advance, maintained on every write, and it answers a query without touching the table.',
          llm: 'a column chunk',
          llmLine:
            'Not chosen and not maintained: every column is already its own contiguous range, so every projection is covered by construction.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A table is stored with 45 columns and 100,000 rows per row group. You reduce row group size to 10,000. What has definitely got worse?',
          options: [
            'Pruning precision — larger groups always prune better',
            'Metadata volume and compression efficiency: statistics are per column per row group, so the footer grows roughly 10×, and dictionaries and runs are rebuilt 10× more often over shorter spans',
            'Nothing — smaller row groups are strictly better for analytics',
            'Projection, because more row groups means more column chunks to skip',
          ],
          correct: [1],
          explanation:
            'Finer groups improve pruning precision, which is why people do it. The costs are that the planner must read and evaluate ten times the statistics before reading any data, and that compression has ten times less data over which to amortise a dictionary or a run. Projection is unaffected: the number of columns you skip does not depend on how the rows are grouped.',
        },
        {
          q: 'Why can a columnar reader satisfy a three-column projection without reading the other columns at all?',
          options: [
            'It reads everything and discards the unwanted columns after decoding',
            'Because each column\'s values for a row group are stored as a contiguous byte range at an offset recorded in the footer, so the reader issues range requests only for the columns it wants',
            'Because the compression dictionary lets it reconstruct only the needed columns',
            'Because the query planner rewrites the query to avoid the other columns',
          ],
          correct: [1],
          explanation:
            'Projection is physical, not logical. The footer records where each column chunk begins and how long it is, so unwanted columns are never named in a request. A row store cannot do this at any level of cleverness, because its unit of storage interleaves all columns of a row.',
        },
        {
          q: 'A colleague proposes skipping column chunks independently based on each chunk\'s own min/max statistics, to prune more aggressively. What happens?',
          options: [
            'Pruning improves with no downside — this is how zone maps are meant to work',
            'It returns wrong results: row groups align all columns to the same rows, so dropping one column\'s chunk while keeping another\'s breaks the correspondence between values and rows',
            'Nothing changes, because chunk statistics are identical within a row group',
            'It only fails for nullable columns',
          ],
          correct: [1],
          explanation:
            'The nth value of every chunk in a row group belongs to the same row. Skip region\'s chunk but keep order_ts\'s and the values no longer line up — you have silently corrupted the result. Pruning must be a row-group-level decision made on the predicate column\'s statistics, then applied to every projected chunk in the surviving groups.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the layout, specified',
      md: `The authoritative description of the four-level nesting is the **Apache Parquet format specification** — read the sections on row groups, column chunks and pages, then read the Thrift definition of the footer metadata, which is where the statistics live. **Apache ORC's specification** makes the same decomposition with different names (stripes, streams, row index entries) and a more aggressive built-in index, which is a useful contrast: two formats, the same physics, different bets about how much metadata is worth carrying.

For the reasoning behind grouping rows at all — rather than storing each column as one enormous stream — the relevant lineage is **PAX** (Ailamaki et al., "Weaving Relations for Cache Performance", VLDB 2001), which argued for column organisation *within* a page-sized unit to keep reconstruction cheap. Modern row groups are that argument at file scale.

For the layer beneath this one — why the page is the unit of I/O at all, and what random versus sequential access costs — **tablespace T0.L1 and T0.L2** derive it from the hardware up. This lesson assumes it; that course proves it.`,
    },
  ],
}

export default lesson
