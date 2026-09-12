import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c7.l2',
  slug: 'json-and-the-schema-you-did-not-declare',
  trackId: 'c7',
  index: 2,
  title: 'JSON and the Schema You Did Not Declare',
  minutes: 17,
  hook: 'A JSON column stored as text is one byte range per row group and zero pruning. Shred four fields out of it and you get statistics that skip files — until one row arrives with a string where the timestamp was.',
  exercise: 'quiz',
  takeaway: {
    number: '4 fields',
    claim:
      'Shredding the handful of JSON paths your queries actually filter on buys real pruning, and it converts a flexible column into a schema decision that breaks quietly when the shape drifts.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Somewhere in every analytical platform there is a column that holds JSON. It is called \`properties\`, or \`payload\`, or \`attributes\`, or \`raw\`. It exists because at the moment it was created nobody could enumerate the fields, and because the producer wanted to ship without a schema review.

C7.L1 handled nesting where the shape is *declared*: you know there is a list of items and that discount is optional, so the writer can compute level budgets from the schema. This lesson is the case where the shape is a property of the data rather than of the table, and it changes the economics completely.

There are exactly two physical strategies, and both of them are wrong in a way you should be able to say out loud.

**Store it as text.** One variable-length binary column. Writes are trivial — no parsing, no type inference, no schema negotiation. Reads are a scan: the engine fetches the whole column chunk, parses each document, and extracts the path you asked for. Min/max statistics exist but describe the *bytes of the serialised document*, which answers no question anyone asks. Pruning is zero. Projection is zero — you cannot read one field of a blob without reading the blob.

**Shred it into typed columns.** Pull \`event_type\` out as a \`string\` column, \`event_ts\` out as a \`timestamp\`, and now the format's whole machinery applies to them: per-chunk min/max, dictionary encoding on the low-cardinality one, and a projection that reads two byte ranges instead of the whole document. Writes get expensive — parse, type-check, route — and something worse than expensive happens the first time the shape drifts.

Neither is the answer. **The answer is both**, which is now the format's answer too.`,
    },
    {
      type: 'prose',
      md: `## What the blob actually costs you

Price the difference as a count rather than a feeling. Take 2 billion events, an average document of 400 bytes with four fields anyone ever filters on, and the ordinary dashboard query \`WHERE event_type = 'signup' AND event_ts >= <yesterday>\`.

\`\`\`text
stored as text
  raw bytes            2e9 x 400 B          = 800 GB
  compressed at ~5x    (repetitive keys)    ≈ 160 GB
  bytes a filtered dashboard query must read:
    every row group that could contain yesterday, which is
    all of them unless the table is partitioned or sorted on
    something correlated with event_ts        ≈ 160 GB
  pruning ratio                              0%
  fields decoded to answer a 2-field query    all of them

shredded: event_type, event_ts, user_id, country as real columns
  those four columns compressed            ≈ 6 GB   (est.)
  the remaining blob                       ≈ 155 GB (est.)
  bytes the same query must read:
    event_type + event_ts chunks of surviving row groups
    at, say, 1% surviving                  ≈ 0.06 GB
  pruning ratio                             ~99%
  and the blob is never touched
\`\`\`

The compression figures are order-of-magnitude estimates — your documents' key repetition sets them, and the codec bench in C1.L1 shows how wide that range is. **The ratio between the two read paths is not an estimate.** It is the difference between "read a column" and "read the table", and it is the same mechanism C0.L1 measured on flat columns: you cannot project or prune inside an opaque value.

Note the asymmetry that makes this an engineering decision rather than an obvious one. Shredding four fields cost roughly 4% more storage and bought a ~2,600× reduction in bytes scanned for the dashboard. Shredding *all* forty fields would cost far more storage, produce forty sparse columns most of which are null on most rows, and buy nothing for the queries you actually run. **Shred the predicates, not the payload.**`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'How Parquet and Iceberg now specify semi-structured columns',
      systems: ['parquet', 'iceberg'],
      sources: [
        'https://github.com/apache/parquet-format/blob/master/VariantShredding.md',
        'https://github.com/apache/parquet-format/blob/master/LogicalTypes.md',
        'https://iceberg.apache.org/spec/',
      ],
      md: `The "store both" answer is now written down. Parquet's \`VARIANT\` logical type annotates a group with a required \`metadata\` binary field and a \`value\` binary field; the shredded form adds a \`typed_value\` field beside \`value\`:

\`\`\`text
optional group event (VARIANT(1)) {
  required binary metadata;
  optional binary value;               -- whatever was not shredded
  optional group typed_value {         -- the shredded fields
    required group event_type { optional binary value;
                               optional binary typed_value (STRING); }
    required group event_ts   { optional binary value;
                               optional int64  typed_value (TIMESTAMP(true, MICROS)); }
  }
}
\`\`\`

The parts that matter for a design decision, straight from \`VariantShredding.md\`:

- **The two fields together encode one value**, and the four combinations are all meaningful: both null means *missing*; \`value\` set and \`typed_value\` null means *present, any type including null*; \`value\` null and \`typed_value\` set means *present and of the shredded type*; both set means *a partially shredded object*. Writers must not produce the last case unless the value is an object.
- **Pruning is conditional on the shape not having drifted.** The spec's Data Skipping section is explicit: statistics on a \`typed_value\` column may be used for file, row-group or page skipping **when the corresponding \`value\` column is always null**, because only then is every value known to be of the shredded type. One row that arrives as a string where you shredded a timestamp populates \`value\`, and comparisons against that column stop being safe to skip on.
- **Files may disagree with each other.** The spec states that different files may contain conflicting shredding schemas, and that "it may not be possible to infer or specify a single shredded schema that would allow all Parquet files for a table to be read without reconstructing the value as a Variant." That is the cost of flexibility, in the specification's own words.
- **Reads must be by name, not position.** \`metadata\`, \`value\` and \`typed_value\` are resolved by name and are not assigned field IDs — which is the one place in an ID-based table format where names are load-bearing (C7.L3).

On the Iceberg side, \`variant\` arrived in **format version 3** as a semi-structured type that is neither primitive nor nested, with the encoding delegated to the Parquet project. Its manifest bounds for a variant are themselves variants: an object keyed by normalised JSON paths such as \`$['location']['latitude']\`, and the spec requires that **bounds must not be written for a field with mixed types** — so a field that holds integers and one \`"n/a"\` gets no bounds at all. Shredding is not supported in Avro or ORC.`,
    },
    {
      type: 'prose',
      md: `## The honest cost: a shredded column is a schema decision wearing a flexibility costume

Read the specification's own conditions again and the trade becomes plain. Shredding buys pruning **while the data conforms to the type you guessed**. The moment it does not, three things happen, in this order and usually over weeks:

1. **The fallback path silently activates.** The odd value lands in \`value\` instead of \`typed_value\`. Nothing errors. The row is still readable and still correct.
2. **Skipping stops being valid for that column.** Once \`value\` is not always null, the engine can no longer assume every value has the shredded type, so comparisons against \`typed_value\` cannot safely skip. The performance you designed the layout around quietly reverts to the blob case — for the files that contain the drift.
3. **Files stop agreeing.** New files may be written with a different shredding schema than old ones. A reader that wants one logical column across both has to reconstruct the variant, which is the expensive path you shredded to avoid.

Say the consequence out loud, because it is the sentence that belongs in a design review: **you chose a JSON column so you would not have to declare a schema, and then you declared one anyway — in the writer's shredding configuration, where nobody reviews it and no consumer can see it.** The flexibility did not disappear; it moved from the table definition, which is versioned and visible, into the physical layout, which is neither.

Which yields three obligations if you shred:

- **Version the shredded set like a contract.** It is a schema. Publish it, and treat adding or removing a shredded path as a change with consumers, not as a tuning knob. A2 does exactly this for declared schemas; the shredded set deserves the same handling and rarely gets it.
- **Alert on the fallback.** The count of rows where \`value\` is non-null for a shredded field is a data-quality metric with a threshold, and it moves on the first day of drift — the same signal Column Week's \`silent-schema-change\` incident had available and nobody watched.
- **Do not promise pruning you cannot keep.** If you told a room that dashboards read 0.06 GB instead of 160 GB, and the shape drifts, the number changes without anybody deploying anything. Quote the pruning ratio *with* the condition attached.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the same JSON column, three physical layouts, and the one condition that revokes the fast path',
      height: 70,
      nodes: [
        { id: 'src', x: 2, y: 2, w: 96, h: 9, label: '2e9 events · ~400 B of JSON each · queries filter on 2 of ~40 fields', sub: 'nobody could enumerate the fields when the column was created, and that has not changed', color: '#E879F9' },
        { id: 'text', x: 2, y: 14, w: 30, h: 11, label: 'stored as text', sub: 'cheap write · 0% pruning', color: '#FB7185' },
        { id: 'shred', x: 35, y: 14, w: 30, h: 11, label: 'shredded to typed_value', sub: 'prunable · a schema decision', color: '#3EF2A4' },
        { id: 'both', x: 68, y: 14, w: 30, h: 11, label: 'value AND typed_value', sub: 'the partially shredded object', color: '#FBBF24' },
        { id: 'blob', x: 2, y: 28, w: 46, h: 10, label: '≈160 GB read for a 2-field filter', sub: 'you cannot project inside an opaque value', color: '#FB7185' },
        { id: 'prn', x: 52, y: 28, w: 46, h: 10, label: '≈0.06 GB read, ~99% pruned', sub: 'per-chunk min/max on 4 real columns', color: '#3EF2A4' },
        { id: 'drift', x: 2, y: 41, w: 96, h: 10, label: 'one row arrives with a string where the timestamp was', sub: 'it lands in value, not typed_value — nothing fails, nothing is logged, the row still reads correctly', color: '#FBBF24' },
        { id: 'revoke', x: 2, y: 54, w: 46, h: 10, label: 'skipping is no longer valid', sub: 'the spec allows it only while value is all-null', color: '#FB7185' },
        { id: 'answer', x: 52, y: 54, w: 46, h: 10, label: 'shred the predicates, version the set', sub: 'and alert on the fallback count from day one', color: '#A78BFA' },
      ],
      edges: [
        { from: 'src', to: 'text' },
        { from: 'src', to: 'shred' },
        { from: 'src', to: 'both' },
        { from: 'text', to: 'blob' },
        { from: 'shred', to: 'prn' },
        { from: 'both', to: 'drift' },
        { from: 'drift', to: 'revoke' },
        { from: 'revoke', to: 'answer' },
      ],
      steps: [
        {
          caption:
            'Two billion events, four hundred bytes of JSON each, and a dashboard that filters on two fields out of roughly forty. This is the most common shape in any event platform, and it is the shape the format was worst at until recently.',
          active: ['src'],
        },
        {
          caption:
            'Stored as text the write path is trivial and the read path is a full scan: statistics describe the bytes of the serialised document, which answers no predicate anybody writes, so the pruning ratio is exactly zero.',
          active: ['text', 'blob'],
          edges: ['src->text', 'text->blob'],
        },
        {
          caption:
            'Shred the two filtered fields into real typed columns and the whole apparatus from C2 applies again — per-chunk minima and maxima, dictionary encoding, and a projection that touches two byte ranges instead of every document.',
          active: ['shred', 'prn'],
          edges: ['src->shred', 'shred->prn'],
        },
        {
          caption:
            'So the engineering answer is both at once: a value field for whatever was not shredded and a typed_value field for what was. Parquet writes them side by side, and their four null combinations carry four distinct meanings.',
          active: ['both'],
          edges: ['src->both'],
        },
        {
          caption:
            'Then the shape drifts. One producer sends a date string where you shredded a microsecond timestamp. It lands in the fallback field, no job fails, and the row reads back correctly — which is exactly why nobody notices.',
          active: ['drift'],
          edges: ['both->drift'],
        },
        {
          caption:
            'And the fast path is revoked by specification, not by bug: statistics on the shredded column may only be used for skipping while the fallback is always null. The pruning ratio you promised changes with no deployment.',
          active: ['revoke'],
          edges: ['drift->revoke'],
        },
        {
          caption:
            'Which leaves three obligations rather than a recommendation: shred only the paths that appear in predicates, version that set as a published contract, and alert on the fallback count — it moves on day one of the drift.',
          active: ['answer'],
          edges: ['revoke->answer'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '0%',
          label: 'pruning on a JSON column stored as text',
          hint: 'Statistics describe the serialised bytes of the document, not the fields inside it. No predicate on a JSON path can skip a row group.',
        },
        {
          value: '4 of ~40',
          label: 'fields worth shredding in a typical event payload',
          hint: 'The ones that appear in WHERE clauses. Shredding all forty costs storage on sparse columns and buys nothing the queries use.',
        },
        {
          value: '4 combinations',
          label: 'of value and typed_value, all meaningful',
          hint: 'Both null is missing; value only is present-any-type; typed_value only is present-and-typed; both is a partially shredded object.',
        },
        {
          value: '1 row',
          label: 'of drift is enough to revoke skipping on that column',
          hint: 'The Parquet shredding spec permits skipping on typed_value only while the paired value column is always null. One off-type value populates it.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the query that looks free and is not',
      md: `\`SELECT count(*) FROM events WHERE json_extract(payload, '$.plan') = 'enterprise'\` is a full table scan of the payload column with a JSON parse per row, and it will be reported in a dashboard as a slow query rather than as an expensive one. Two things hide the cost:

- **The predicate looks selective.** It is — on rows. It is not selective on *bytes*, because selectivity only reduces work if it can be evaluated against metadata before the bytes are fetched, and no statistic in the file knows anything about \`plan\`.
- **The parse is per row and invisible.** C4 spent a track establishing that batched execution over typed columns is a different machine from row-at-a-time. A JSON extract puts you back on the old machine, per document, and no amount of vectorisation in the engine helps because the work is inside an opaque value.

The tell in a query profile is C0.L5's: bytes scanned close to the table's compressed size on a query that returned four rows. If you see that shape on a JSON column, the fix is a layout change — shred the path, or add a materialised typed column beside the blob — not a rewrite of the SQL.

And state the caveat when you propose it: shredding \`plan\` helps this query and every future query on \`plan\`, and does nothing at all for the next field somebody filters on. You are buying one predicate at a time.`,
    },
    {
      type: 'isomorphism',
      title: 'shredding ≡ decisions you have already made under another name',
      pairs: [
        {
          os: 'a generated column with an index, over a JSONB field',
          osLine:
            'Postgres users extract the hot path into a stored generated column and index that, precisely because you cannot index inside an opaque document usefully. Everyone accepts it as a schema commitment.',
          llm: 'a shredded typed_value column',
          llmLine:
            'The same move one layer over, with per-chunk statistics playing the part of the index. Same commitment, but usually made in a writer config rather than in DDL — so nobody reviews it.',
        },
        {
          os: 'a schemaless document store with secondary indexes',
          osLine:
            'You get write flexibility, and then you add an index per query pattern and discover that the set of indexes is your schema, enumerated by hand and drifting from the documents.',
          llm: 'the shredded field set',
          llmLine:
            'Identical structure and identical failure: the set of shredded paths is the real schema, it is not versioned with the table, and consumers cannot see it.',
        },
        {
          os: 'a cache with an unmonitored miss path',
          osLine:
            'It works beautifully until the hit rate quietly falls, and because the miss path is correct rather than broken, the only symptom is cost.',
          llm: 'the value fallback field',
          llmLine:
            'A correct, silent, slow path that is entered by data rather than by deploy — which is why the fallback count is the metric to alert on, not the error rate.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A JSON payload column is shredded on event_ts as an int64 timestamp. Three weeks later, one upstream service begins sending event_ts as an ISO date string. What is the state of the table?',
          options: [
            'Ingest fails for those rows and they are quarantined, so the table is unaffected',
            'Rows still read back correctly — the off-type values land in the value field — but the engine may no longer use typed_value statistics to skip data for the affected files, so a dashboard slows down with no code or config change anywhere',
            'The typed_value column is corrupt and the affected files must be rewritten before queries are correct',
            'The values are coerced to timestamps on write, so the only risk is a parsing error on malformed dates',
          ],
          correct: [1],
          explanation:
            'This is the shredding design working exactly as specified: the fallback field exists so that an off-type value is stored losslessly rather than rejected. The consequence is in the skipping rule — statistics on a shredded column may be used for file, row-group or page skipping only while the paired value column is always null, because only then is the type known for every row. Nothing is corrupt and nothing is quarantined; correctness is preserved and the cost model is not, which is the hardest class of regression to attribute because no change was deployed.',
        },
        {
          q: 'A team proposes shredding all 38 fields found in a JSON payload column, "so every future query is fast". What is the strongest objection?',
          options: [
            'It will not work, because Parquet limits the number of shredded fields per variant column',
            'Most of those fields appear in no predicate and are null on most rows, so you pay write cost and per-column footer overhead across every file for statistics nobody consults — and you have quietly turned the entire payload into a declared schema, which means every future producer change is now a schema change on your table',
            'Shredding is only valid for scalar fields, so nested objects in the payload cannot be shredded at all',
            'It is the right call: storage is the cheapest term in the model, so shredding everything strictly dominates',
          ],
          correct: [1],
          explanation:
            'Two costs compound. The footer cost is the one from C3.L1 — statistics entries scale as row groups times leaf columns, and each entry quotes real minimum and maximum values — so 38 sparse leaves multiply the metadata on every file the loader writes, including files nothing queries. The larger cost is organisational: the whole reason the column was JSON was to absorb producer change without a schema review, and shredding all of it puts that change back in the review path while leaving it invisible in the table definition. Nested objects and arrays can be shredded (the spec defines both), and there is no per-column limit at issue here; the fourth option ignores that the scan bill, not storage, is usually the larger line.',
        },
        {
          q: 'You are asked in a design review to defend "shredding four fields cuts our dashboard scan from about 160 GB to about 0.06 GB". Which answer survives the room?',
          options: [
            '"Those are measured numbers from our production cluster, so the improvement is confirmed."',
            '"The ratio comes from projection and pruning, which are mechanisms I can show you — but it holds only while every value of those four fields matches the type we shredded, and the format only permits skipping while the fallback field is empty. So I want two things in the proof of concept: the pruning ratio on our real query mix, and the count of rows landing in the fallback per field per day. If that second number is not zero, the first number is not what I quoted."',
            '"It is a conservative estimate; the real improvement will be larger once caching warms up."',
            '"We should not commit to a figure until we have run a full benchmark against the alternatives."',
          ],
          correct: [1],
          explanation:
            'The habit being graded is naming the weakness of your own analysis before the room finds it, and then saying what a proof of concept would have to measure to confirm it. The mechanism is defensible and the conditional is real and specific: the skipping rule is written into the shredding specification, so the promise has an expiry condition that lives in the data rather than in the code. Claiming the figures are measured when they are modelled is the one answer that destroys your credibility permanently; invoking caching swaps a count for a clock; and refusing to give a number is the failure mode this whole course exists to fix.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: variant encodings, and the systems that got here first',
      md: `**\`VariantEncoding.md\` and \`VariantShredding.md\`** in \`parquet-format\` are the primary sources and are short enough to read in a sitting. The shredding document's reconstruction pseudocode is the part worth typing out — it makes the four-way null table concrete, and the table of INVALID cases at the end tells you exactly which writer bugs to expect from an immature implementation.

For the lineage: **Snowflake's original paper, "The Snowflake Elastic Data Warehouse" (SIGMOD 2016)**, describes automatic type inference over semi-structured data and the columnar extraction of frequently-occurring paths — the idea this lesson calls shredding, shipped commercially roughly a decade before it was standardised in an open format. **Google's Dremel retrospective (VLDB 2020)** covers the same tension from the other side. Reading the two together is a good corrective to the belief that open formats lead.

On the engine side, the interesting comparison is between **ClickHouse's approach to dynamic paths in its JSON type** and the Parquet variant model, because they make different bets about where the type lives — in the column's own metadata versus in a per-value tag. Both are defensible; they fail differently, and the failure mode is the thing to compare.

For the practical detection side, **Iceberg's variant bounds** are worth reading in the spec: bounds are stored as a variant keyed by normalised JSON paths, and must be omitted for a field with mixed types. That rule *is* a drift detector — a field that loses its bounds has changed shape — and almost nobody monitors it.

**→ tablespace T6** for the document-store view of the same problem, and why a schemaless write path always regrows a schema somewhere. Do not re-derive it here.

Next: **C7.L3**, where the schema is declared, changes anyway, and every existing file has to be reinterpreted — including one change that is mechanically legal and eleven days expensive.`,
    },
  ],
}

export default lesson
