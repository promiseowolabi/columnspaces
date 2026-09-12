import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c7.l1',
  slug: 'shredding-nested-data',
  trackId: 'c7',
  index: 1,
  title: 'Shredding Nested Data',
  minutes: 18,
  hook: 'Four orders with a nullable list of items produce a column holding 2 values and 5 level pairs. The levels are longer than the data, and without them the records cannot be put back together.',
  exercise: 'quiz',
  takeaway: {
    number: '2 values, 5 slots',
    claim:
      'A nested column records a level pair for every slot the schema could have held, not for every value present — so the level stream, not the data, is what deep nesting actually costs you.',
  },
  blocks: [
    {
      type: 'prose',
      md: `C1.L4 established that absence has to be recorded somewhere, and that Parquet records it as a **definition level** — an integer per value saying how deep the value is defined. For a flat nullable column that mechanism is a run-length-encoded bitmap and it is nearly free. This lesson is the general case it was a degenerate instance of.

The problem is that real tables are not flat. An order has line items. An event has a properties object. A user has a list of addresses, each of which has an optional postcode. Columnar storage requires that every leaf becomes one contiguous run of values, so a nested record has to be taken apart on write and put back together on read — and put back together *exactly*, including the difference between an empty list and a missing one.

That is the whole subject. Two integers per slot, called the **repetition level** and the **definition level**, are sufficient to reconstruct any nested record from its flat columns without reading any other column. The encoding is from the Dremel paper, Parquet adopted it wholesale, and it is the reason you can project one leaf out of a deeply nested schema and pay for only that leaf.

The reason it deserves a lesson rather than a paragraph: **absent has three different meanings in a nested schema, and they are not interchangeable.**`,
    },
    {
      type: 'prose',
      md: `## The example, small enough to redo by hand

Take a schema with exactly the shape that causes trouble: a nullable list of records, with an optional field inside the record.

\`\`\`text
message Order {
  required int64 order_id;
  optional group items (LIST) {          // the list itself may be null
    repeated group list {                // one entry per element
      required group element {
        required int64 sku;
        optional int32 discount_bps;     // may be absent within an element
      }
    }
  }
}
\`\`\`

Two numbers fall straight out of the schema, before you have seen any data.

- **Max repetition level** for a leaf = the number of \`repeated\` fields on its path. Here that is 1 (\`list\`). So \`R\` is 0 or 1, one bit.
- **Max definition level** for a leaf = the number of \`optional\` *or* \`repeated\` fields on its path. For \`discount_bps\`: \`items\` (optional) + \`list\` (repeated) + \`discount_bps\` (optional) = **3**. So \`D\` is 0…3, two bits.

For \`sku\`, which is required, max \`D\` is 2 — \`items\` and \`list\` — and max \`R\` is still 1. And for \`order_id\`, required at the top level, both maxima are 0, which means **no levels are stored at all**. That is the first useful fact: level cost is a property of the path, not of the table.

Now four records:

\`\`\`text
1001  items = [ {sku 7, discount 250}, {sku 9, discount null} ]
1002  items = []            <- present, empty
1003  items = null          <- absent entirely
1004  items = [ {sku 4, discount 0} ]
\`\`\``,
    },
    {
      type: 'code',
      filename: 'the discount_bps column, in full',
      lang: 'text',
      chips: ['maxD 3 · maxR 1', '5 slots', '2 values'],
      code: `slot  record  what it is                        R   D   value stored
────  ──────  ────────────────────────────────  ──  ──  ────────────
 1     1001   first element, discount present    0   3   250
 2     1001   second element, discount NULL      1   2   —
 3     1002   items present but empty            0   1   —
 4     1003   items itself is NULL               0   0   —
 5     1004   first element, discount present    0   3   0

values : [250, 0]
D      : [3, 2, 1, 0, 3]
R      : [0, 1, 0, 0, 0]

-- and the sku column, same records, maxD = 2 because sku is required:
values : [7, 9, 4]
D      : [2, 2, 1, 0, 2]
R      : [0, 1, 0, 0, 0]

-- and order_id, required at the top level:
values : [1001, 1002, 1003, 1004]
D      : (none written)
R      : (none written)`,
    },
    {
      type: 'prose',
      md: `## Read the levels, not the values

Three things in that table are the entire mechanism.

**\`R = 0\` means "this slot starts a new record."** Every other value of \`R\` says which repeated field the value is repeating at — here there is only one, so \`R = 1\` means "another element of the list I am already inside." That is why slot 2 is the only \`R = 1\` in the column: it is the second item of order 1001. A reader that wants record boundaries never looks at the data; it counts zeros in the repetition-level stream. This is also why you can find the *n*th record in a nested column without decoding a single value.

**\`D\` says how far down the path the record got before it stopped being defined**, and the three failures produce three different numbers:

| \`D\` | meaning | what the row actually looked like |
|---|---|---|
| 3 | fully defined | the discount exists and is stored |
| 2 | **the field is null** | the item exists, \`discount_bps\` does not |
| 1 | **the list is empty** | \`items\` exists and has zero elements |
| 0 | **the list is null** | there is no \`items\` field on this order |

Those middle two are the ones that get conflated, and conflating them is a correctness bug rather than a cost. "No discounts were applied to this order" (D = 2 on one item), "this order has no line items" (D = 1) and "we never received line-item data for this order" (D = 0) are three different business facts, and an average over them gives three different answers.

**A value is stored only when \`D\` equals the maximum.** Five slots, two values. The slots are what the schema could have held; the values are what it did hold. Which gives the arithmetic anchor: at 2 bits of \`D\` plus 1 bit of \`R\`, this column costs **3 bits per slot** before run-length encoding, and slots outnumber values whenever lists are short or fields are sparse. On a column that is mostly absent, the level stream *is* the column.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — one nested record in, three flat columns out, and back again from the levels alone',
      height: 80,
      nodes: [
        { id: 'rec', x: 2, y: 2, w: 96, h: 9, label: '4 orders · items is a nullable list · discount_bps is optional inside it', sub: 'one record shape, three leaves, three different level budgets', color: '#E879F9' },
        { id: 'col1', x: 2, y: 14, w: 30, h: 11, label: 'order_id', sub: 'required, top level · 4 values · 0 levels', color: '#94A3B8' },
        { id: 'col2', x: 35, y: 14, w: 30, h: 11, label: 'items…sku', sub: 'maxD 2 · maxR 1 · 3 values', color: '#A3E635' },
        { id: 'col3', x: 68, y: 14, w: 30, h: 11, label: 'items…discount_bps', sub: 'maxD 3 · maxR 1 · 2 values', color: '#FBBF24' },
        { id: 'lv', x: 2, y: 28, w: 96, h: 10, label: 'D = 3, 2, 1, 0, 3    R = 0, 1, 0, 0, 0', sub: 'five slots, two values — the level stream is longer than the data it describes', color: '#5CA8FF' },
        { id: 'd3', x: 2, y: 41, w: 23, h: 10, label: 'D = 3', sub: 'defined · value stored', color: '#3EF2A4' },
        { id: 'd2', x: 27, y: 41, w: 23, h: 10, label: 'D = 2', sub: 'field null, item exists', color: '#FB7185' },
        { id: 'd1', x: 52, y: 41, w: 23, h: 10, label: 'D = 1', sub: 'list present, zero elements', color: '#FB7185' },
        { id: 'd0', x: 77, y: 41, w: 21, h: 10, label: 'D = 0', sub: 'no items field at all', color: '#FB7185' },
        { id: 'rzero', x: 2, y: 54, w: 46, h: 10, label: 'count the zeros in R', sub: 'record boundaries without decoding a value', color: '#22D3EE' },
        { id: 'rebuild', x: 52, y: 54, w: 46, h: 10, label: 'rebuild the tree from levels alone', sub: 'no other column has to be read', color: '#22D3EE' },
        { id: 'cost', x: 2, y: 67, w: 96, h: 9, label: 'the bill: 3 bits per slot before RLE, and slots outnumber values', sub: 'so on a sparse or shallow-list column the levels are the column, not the overhead on it', color: '#A78BFA' },
      ],
      edges: [
        { from: 'rec', to: 'col1' },
        { from: 'rec', to: 'col2' },
        { from: 'rec', to: 'col3' },
        { from: 'col3', to: 'lv' },
        { from: 'lv', to: 'd3' },
        { from: 'lv', to: 'd2' },
        { from: 'lv', to: 'd1' },
        { from: 'lv', to: 'd0' },
        { from: 'd3', to: 'rzero' },
        { from: 'd0', to: 'rebuild' },
        { from: 'rzero', to: 'rebuild' },
        { from: 'rebuild', to: 'cost' },
      ],
      steps: [
        {
          caption:
            'Four orders, one nested schema. Every leaf becomes its own contiguous run of values, which means the record structure has to be recorded somewhere else — because the values alone cannot say which order they belonged to.',
          active: ['rec'],
        },
        {
          caption:
            'The level budget is read off the schema before any data exists: repeated fields on the path set max R, optional-or-repeated fields set max D. order_id is required at the top level, so it carries no levels at all.',
          active: ['col1', 'col2', 'col3'],
          edges: ['rec->col1', 'rec->col2', 'rec->col3'],
        },
        {
          caption:
            'The discount column comes out as five level pairs and two values. That is not a rounding error in the encoding — it is the point. A slot exists for every position the schema permitted, whether or not a value landed there.',
          active: ['lv'],
          edges: ['col3->lv'],
        },
        {
          caption:
            'And the definition level distinguishes the three meanings of absent that people conflate: the field is null, the list is empty, or the list itself is missing. Three different business facts, three different numbers, one integer stream.',
          active: ['d3', 'd2', 'd1', 'd0'],
          edges: ['lv->d3', 'lv->d2', 'lv->d1', 'lv->d0'],
        },
        {
          caption:
            'Reconstruction needs nothing else. Count zeros in the repetition stream for record boundaries, use the definition level to decide how much of the path to build, and take a value only where D hit its maximum.',
          active: ['rzero', 'rebuild'],
          edges: ['d3->rzero', 'd0->rebuild', 'rzero->rebuild'],
        },
        {
          caption:
            'The cost is a count you can put in a plan: two bits of definition level plus one of repetition per slot, run-length encoded, on a stream whose length is set by list lengths rather than by value counts.',
          active: ['cost'],
          edges: ['rebuild->cost'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '2 integers',
          label: 'per slot is enough to rebuild any nested record',
          hint: 'Repetition and definition levels. No other column has to be read, which is what makes projecting a single deep leaf cheap.',
        },
        {
          value: '5 slots / 2 values',
          label: 'in the worked discount_bps column',
          hint: 'Four orders, one two-element list, one empty list, one null list. Slots are what the schema allowed; values are what arrived.',
        },
        {
          value: '3 meanings',
          label: 'of absent, at D = 2, 1 and 0',
          hint: 'Field null, list empty, list null. Collapsing any two of them changes an aggregate, and no engine will warn you.',
        },
        {
          value: '0 levels',
          label: 'for a required leaf at the top level',
          hint: 'Level cost is a property of the path, not the table. Every optional or repeated ancestor you add widens the level stream for every leaf beneath it.',
        },
      ],
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'What the Parquet specification requires of nested schemas',
      systems: ['parquet'],
      sources: [
        'https://github.com/apache/parquet-format/blob/master/LogicalTypes.md',
        'https://raw.githubusercontent.com/apache/parquet-format/master/src/main/thrift/parquet.thrift',
      ],
      md: `Three durable facts from \`LogicalTypes.md\`, all of which change the arithmetic above:

- **\`LIST\` must annotate a three-level structure**: an outer group annotated \`LIST\` containing a single repeated group named \`list\`, containing a single field named \`element\`. The outer level's repetition — \`optional\` or \`required\` — is what decides whether the list itself can be null; the \`element\` repetition decides whether elements can be null. That is why the worked example needs three levels to keep "empty list" and "null list" apart: **a bare \`repeated\` field cannot express a null list at all**, because repeated fields have no null.
- **\`MAP\` is the same shape** with a repeated \`key_value\` group, a \`required\` key and an optional-or-omitted value. So a map costs the same level budget as a list of pairs, because that is what it is.
- The spec's backward-compatibility section documents **five rules** for reading two-level and mis-named list structures written by older writers, and states plainly that new writers should always produce the three-level form. If you inherit files from a decade-old pipeline, the level values you compute by hand may not match what a reader infers — the schema shape, not the data, is what changed.

Also worth knowing before you argue about it: the spec notes that a repeated field which is *neither* annotated \`LIST\`/\`MAP\` nor contained in one "should be interpreted as a required list of required elements." A schema that omits the annotation is not schemaless; it has committed to non-nullability by accident.`,
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the flattened-in-SQL trap',
      md: `The most common way this mechanism turns into a wrong number has nothing to do with encoding. It is that **unnesting a list multiplies rows, and every aggregate downstream of the unnest is now computed over a different population.**

Work the example. Four orders; three line items across them. \`SELECT count(*) FROM orders\` is 4. \`SELECT count(*) FROM orders, UNNEST(items)\` is 3 — order 1002 and order 1003 vanish entirely, because an empty list and a null list both unnest to zero rows. Sum an order-level column such as \`shipping_fee\` after that unnest and you have double-counted every order with two items and dropped every order with none.

Two habits that cost nothing:

- **State the grain of every result out loud.** "This is one row per line item" and "this is one row per order" are different tables that look identical in a notebook.
- **Use an outer unnest when the absence is meaningful**, and then check which of D = 1 and D = 0 you are looking at. If your pipeline cannot distinguish "no items" from "no data about items", it will eventually report a real revenue drop as a data-quality issue, or the reverse.`,
    },
    {
      type: 'isomorphism',
      title: 'levels ≡ two structures you have already implemented',
      pairs: [
        {
          os: 'a parenthesis depth counter',
          osLine:
            'You can reconstruct an entire tree from a linear token stream plus one integer per token saying how deep it sits. No pointers, no back-references, single pass.',
          llm: 'the definition level',
          llmLine:
            'Identical trick, one integer per slot, and the same consequence: the stream is self-describing, so a reader can rebuild structure without a second pass or a sibling column.',
        },
        {
          os: 'a CSR sparse-matrix row pointer',
          osLine:
            'Values are packed densely and a separate integer array says where each row starts. The structure array is often larger than the value array on sparse data — and nobody calls that overhead.',
          llm: 'the repetition level',
          llmLine:
            'Same division of labour with a different encoding: zeros in the R stream delimit records the way row pointers delimit rows. And on short lists, same surprise about which array dominates.',
        },
        {
          os: 'a LEFT JOIN that produced no match',
          osLine:
            'Reviewers know to ask whether a null in the result means "no matching row", "matched a row whose column was null", or "the join key was null". Three different bugs.',
          llm: 'D = 0, 1 and 2',
          llmLine:
            'Exactly the same three questions, moved into the storage layer and answered by an integer. The engine will not conflate them; your SQL will.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'For the schema in this lesson, a record has items = [] (an empty list). What levels does the discount_bps column store for that record, and why does it store anything at all?',
          options: [
            'Nothing is stored — an empty list contributes no slots to any leaf column',
            'One slot with R = 0 and D = 1: the list is defined but nothing below it is, and the slot must exist so that reconstruction can tell an empty list apart from a null one and from a list whose element had a null discount',
            'One slot with R = 0 and D = 0, the same as a null list, since both produce no values',
            'One slot with R = 1 and D = 3, with a zero value substituted for the missing discount',
          ],
          correct: [1],
          explanation:
            'Every record contributes at least one slot to every leaf, because reconstruction walks the level streams in lockstep with record boundaries — a record that produced no slot would be invisible. D = 1 records that the path got as far as items and stopped, which is precisely what distinguishes an empty list (D = 1) from an absent one (D = 0) and from a present element with a null field (D = 2). Substituting a zero is the semantic break that C7.L3 costs at eleven days of wrong revenue.',
        },
        {
          q: 'A schema is changed by wrapping twelve existing scalar columns in one optional struct, so queries can say properties.x instead of properties_x. Nothing else changes. What happens to storage?',
          options: [
            'Nothing measurable — a struct is a schema annotation and does not exist on disk',
            'Every one of the twelve leaves gains an optional ancestor, so each one now carries a definition level it did not carry before: twelve level streams appear, each one bit per row, plus the per-column page overhead they arrive with',
            'Storage halves, because the struct lets the twelve columns share one validity structure',
            'Storage roughly doubles, because struct fields are stored twice — once in the parent and once in the child',
          ],
          correct: [1],
          explanation:
            'Level cost is a property of the path from root to leaf, so adding one optional ancestor adds one to max D for every leaf beneath it. Columns that previously stored no levels at all now store a stream, which is cheap per row and paid twelve times, on every file, forever. The struct is emphatically not free-on-disk, and it is not shared either: Parquet has no shared validity across leaves — that is an Arrow in-memory idea, and even there the struct keeps its own bitmap separate from its children. The point is not that the change is wrong, it is that "purely cosmetic schema change" is not a category that exists in a columnar format.',
        },
        {
          q: 'A revenue model reads discount_bps out of a nested order table and reports total discount per order. Line-item data started arriving late for roughly 4% of orders. Which framing should you take into the review?',
          options: [
            '"Discounts are down 4%; the pricing team should investigate."',
            '"Three of our absences mean different things and the model treats them as one. Orders with a null items list are being counted as orders with zero discount, so the denominator is right and the numerator is wrong — I want the null-list count reported alongside the total before anyone reads the trend."',
            '"We should backfill the missing line items so the numbers line up."',
            '"The nested schema is the problem; flattening the table would prevent this class of bug."',
          ],
          correct: [1],
          explanation:
            'The correct move is to name the weakness of your own number before the room finds it, and here the weakness is exactly identifiable: D = 0 rows are entering an average as zeros. Reporting the absent-list count next to the total makes the analysis falsifiable rather than merely confident. Backfilling fixes this instance and leaves the class of bug alive; blaming nesting is misdirected, because flattening does not remove the distinction between "no items" and "no data" — it removes your ability to see it, since a flat table has no level to carry it.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: Dremel, and the two other ways to store a tree',
      md: `**Melnik et al., "Dremel: Interactive Analysis of Web-Scale Datasets" (VLDB 2010)** is the primary source and still the clearest. Section 4 gives the record-shredding and assembly algorithms as a finite state machine over the level streams, and it is worth reading with the worked example above in hand — the FSM is what a reader actually runs. The follow-up, **"Dremel: A Decade of Interactive SQL Analysis at Web Scale" (VLDB 2020)**, is a retrospective by the same lineage and is candid about which of the original bets aged well.

**Twitter's "Dremel made simple with Parquet" (2013)** is the canonical walkthrough of levels for people who bounce off the paper, and the level tables in it use the same shape of example. If the levels above did not click, read that next.

For the alternative designs: **Google's Capacitor**, **ORC's** nested encoding (a length stream per repeated field rather than a repetition level, which makes some operations easier and record boundaries harder), and **Arrow's** offsets-based list layout (C7.L4) are three different answers to the same question. The Arrow one is instructive precisely because it is *not* levels: offsets give O(1) random access to the *n*th list, which levels do not, at the cost of not being a self-describing byte stream you can append to.

**\`LogicalTypes.md\`** in \`parquet-format\` is the specification for \`LIST\` and \`MAP\`, including the five backward-compatibility rules for structures older writers produced. Read it before you write a schema you intend to keep for five years.

**→ tablespace T6** for how a row store handles the same nested data with a document type, and what it gives up. This course does not re-derive that.

Next: **C7.L2**, where the schema is not declared at all, and the choice is between a text blob that cannot be pruned and a shredded column that is a schema decision in disguise.`,
    },
  ],
}

export default lesson
