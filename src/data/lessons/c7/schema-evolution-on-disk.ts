import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c7.l3',
  slug: 'schema-evolution-on-disk',
  trackId: 'c7',
  index: 3,
  title: 'Schema Evolution on Disk',
  minutes: 19,
  hook: 'Adding a nullable column rewrites zero files. Renaming one rewrites zero files with field ids and silently un-deletes a column without them. And the change that cost eleven days of wrong revenue rewrote nothing at all.',
  exercise: 'quiz',
  takeaway: {
    number: '0 files, 11 days',
    claim:
      'Every schema change worth arguing about rewrites zero data files, which is exactly why a mechanically-compatible change can run wrong for eleven days before anybody notices.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Your table is 200,000 immutable files written over three years by four versions of a loader. Someone opens a pull request that adds a column. What happens to those files?

**Nothing.** That is the correct answer to almost every version of the question, and it is worth understanding precisely why, because the same property that makes evolution cheap is what makes one class of change catastrophic.

A modern table format separates two things that a warehouse traditionally fused: the **schema**, which lives in table metadata and is one JSON document, and the **data files**, which are immutable and were written under whatever schema was current at the time. A schema change writes a new metadata file and swaps a pointer — the commit from C3.L3. The files are not visited, not read, not rewritten. Reconciliation happens at read time, per file, in the reader.

So the real question is never "what does this do to my files". It is **"what does a reader do when the file it opened disagrees with the schema it was asked for?"** — and the answer depends entirely on one design decision made years before your pull request: whether columns are resolved by **id** or by **name**.

Get that right and four kinds of change are free. Get it wrong and two of the four are data corruption that no job reports.`,
    },
    {
      type: 'prose',
      md: `## The four changes, and what each one actually does

**Add a nullable column.** Free, and free in the strongest sense: the new column gets a new id that appears in no existing file, so a reader asked for it finds nothing and produces null. No file is touched. Zero bytes are written beyond the metadata document. This is the change everybody knows is safe, and it is the one this lesson ends by calling dangerous — for reasons that have nothing to do with the mechanism.

**Rename a column.** Free **with ids**: the rename changes the name in the schema and leaves the id alone, so every existing file still resolves. Catastrophic **without ids**: under name-based resolution the old files still contain the old name, so the renamed column reads as null for all history while the old name — if anyone re-adds it — resurrects the old data under a new meaning. The failure is not "a query errors"; it is "a column silently becomes empty for the past and full for the present".

**Widen a type.** Sometimes free, and the exception is the interesting part. Promoting \`int\` to \`long\` or \`float\` to \`double\` is legal because every old value is representable in the new type, so the data needs no rewrite. But the *metadata* is a different story: the bounds recorded in the manifest for that column were written in the old type's byte width and are **not** rewritten, so a reader has to infer the write-time type from the length of the bound. Four bytes where a \`long\` was expected means the file was written as an \`int\`. That is a real rule in a real specification, and it is the clearest example in this course of "free for data, not free for metadata".

**Reorder columns.** Free with ids and meaningless — ordering is a presentation property of the schema, not a physical one, because each file names or numbers its own columns. Under **position-based** resolution it is a disaster: every column shifts one seat and the reader hands you the neighbouring column's values with your column's name. Nothing is null, nothing errors, and every number is wrong.

The pattern across all four: **the format's job is to make the mechanical change safe, and it does that job well. It has no opinion whatsoever about whether the change is meaningful.**`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'What Iceberg guarantees about schema evolution, and the two failure modes it names',
      systems: ['iceberg'],
      sources: [
        'https://iceberg.apache.org/docs/latest/evolution/',
        'https://iceberg.apache.org/spec/',
      ],
      md: `Iceberg supports **add, drop, rename, update (widen) and reorder**, including inside nested structs, and states that these are **metadata changes: no data files need to be rewritten**. It then makes four guarantees explicit — that added columns never read values from another column, that dropping a column does not change values in any other column, that updating one does not change values in another, and that reordering does not change the values associated with a name.

The mechanism is one sentence: **"Iceberg uses unique IDs to track each column in a table. When you add a column, it is assigned a new ID so existing data is never used by mistake."** The docs then name the two alternatives and their specific failures:

- **Formats that track columns by name** can inadvertently *un-delete* a column if a name is reused — which violates the first guarantee.
- **Formats that track columns by position** cannot delete columns without changing the names used for each column — which violates the second.

Two details from the table spec that change how you plan a change:

- **Column projection is by field id**, and the resolution order for an id that a file does not contain is fixed: take the value from partition metadata if an identity transform exists for it; else use the table's \`schema.name-mapping.default\` to map the id onto a column in a file that has no ids; else return the column's \`initial-default\`; else return null. That last-resort null is why adding a nullable column is free, and \`initial-default\` (v3) is why adding a column with a value for historical rows is also possible without a rewrite.
- **Valid primitive promotions** are \`int\`→\`long\`, \`float\`→\`double\`, and \`decimal(P,S)\`→\`decimal(P',S)\` with \`P' > P\` (precision only, scale fixed). Format v3 adds \`date\`→\`timestamp\`/\`timestamp_ns\` — but explicitly **not** to the timezone-carrying variants — and \`unknown\`→any type.
- **Promotion does not rewrite existing bounds.** The spec gives the disambiguation table: a column now typed \`long\` whose bound is 4 bytes was written as an \`int\`; 8 bytes means it was a \`long\`. Same for \`double\`/\`float\` and \`timestamp\`/\`date\`. The byte length of the metadata is load-bearing.
- **Promotion is refused where it would change a partition value.** The spec's worked example: \`bucket[N]\` hashes \`34\` and \`34L\` identically (both to 2017239379) but \`"34"\` to −427558391, so an \`int\` source column for a bucket partition may be promoted to \`long\` and never to \`string\`.

What is **not** permitted is as informative: you may not group existing fields into a nested struct or lift them out of one, and you may not evolve a primitive into a struct. Those require a rewrite, and no metadata trick avoids it.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — 200,000 files that nobody rewrote, and the two places the reader can be wrong',
      height: 78,
      nodes: [
        { id: 'old', x: 2, y: 2, w: 96, h: 9, label: '200,000 immutable files, written over 3 years under 4 loader versions', sub: 'a schema change writes one metadata document and swaps a pointer — it visits none of them', color: '#E879F9' },
        { id: 'add', x: 2, y: 14, w: 22, h: 11, label: 'add nullable', sub: 'new id · reads as null', color: '#3EF2A4' },
        { id: 'ren', x: 26, y: 14, w: 22, h: 11, label: 'rename', sub: 'id unchanged · free', color: '#3EF2A4' },
        { id: 'wide', x: 50, y: 14, w: 22, h: 11, label: 'widen int→long', sub: 'data free · bounds are not', color: '#FBBF24' },
        { id: 'reord', x: 74, y: 14, w: 24, h: 11, label: 'reorder', sub: 'presentation only', color: '#3EF2A4' },
        { id: 'byid', x: 2, y: 28, w: 46, h: 10, label: 'resolve by field id', sub: 'names in old files never have to change', color: '#3EF2A4' },
        { id: 'byname', x: 52, y: 28, w: 46, h: 10, label: 'resolve by name or position', sub: 'a reused name un-deletes a column', color: '#FB7185' },
        { id: 'bounds', x: 2, y: 41, w: 96, h: 10, label: 'a promoted long whose bound is 4 bytes was written as an int', sub: 'the reader infers the write-time type from the byte length, because promotion does not rewrite bounds', color: '#5CA8FF' },
        { id: 'sem', x: 2, y: 54, w: 96, h: 10, label: 'mechanically compatible, semantically broken', sub: 'add discount_applied, retire the old column, coalesce null to zero — every pipeline stays green', color: '#FB7185' },
        { id: 'det', x: 2, y: 67, w: 96, h: 9, label: 'the detector fired on day 1 and nobody was subscribed: null rate per column', sub: 'a contract makes meaning explicit; distribution alerting catches the people who ignored the contract', color: '#A78BFA' },
      ],
      edges: [
        { from: 'old', to: 'add' },
        { from: 'old', to: 'ren' },
        { from: 'old', to: 'wide' },
        { from: 'old', to: 'reord' },
        { from: 'ren', to: 'byid' },
        { from: 'ren', to: 'byname' },
        { from: 'wide', to: 'bounds' },
        { from: 'byid', to: 'sem' },
        { from: 'bounds', to: 'sem' },
        { from: 'sem', to: 'det' },
      ],
      steps: [
        {
          caption:
            'Two hundred thousand immutable files, written across three years by four versions of a loader. A schema change writes exactly one new metadata document and swaps a pointer; it does not open a single data file.',
          active: ['old'],
        },
        {
          caption:
            'Which makes four kinds of change cost zero bytes of data: adding a nullable column, renaming one, widening a type within the permitted promotions, and reordering the schema. All four are metadata operations.',
          active: ['add', 'ren', 'wide', 'reord'],
          edges: ['old->add', 'old->ren', 'old->wide', 'old->reord'],
        },
        {
          caption:
            'But only under id-based resolution. Track columns by name and reusing a name resurrects deleted data; track them by position and dropping a column shifts every neighbour into the wrong seat. Both fail without an error.',
          active: ['byid', 'byname'],
          edges: ['ren->byid', 'ren->byname'],
        },
        {
          caption:
            'Widening is the case that is free for data and not for metadata: the bounds in the manifest were written in the old type width and are never rewritten, so the reader disambiguates by counting bytes — four means int, eight means long.',
          active: ['bounds'],
          edges: ['wide->bounds'],
        },
        {
          caption:
            'Now the expensive one, which the mechanism handles perfectly. Add a nullable column, stop populating the old one, and let a downstream coalesce turn its nulls into zeros. Every guarantee holds and every number is wrong.',
          active: ['sem'],
          edges: ['byid->sem', 'bounds->sem'],
        },
        {
          caption:
            'The signal existed on day one — the null rate for the new column went from nothing to a hundred percent and then decayed — and nothing was watching it. Contracts make meaning explicit; distribution alerts catch the changes made anyway.',
          active: ['det'],
          edges: ['sem->det'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## The trap: mechanically compatible, semantically broken

Column Week's fourth incident, \`silent-schema-change\`, is this lesson's actual subject. The shape:

> A revenue model has been quietly wrong for eleven days. Upstream added a nullable column, \`discount_applied\`, and retired the old one — mechanically a compatible change; every pipeline stayed green. The model reads \`discount_applied\`, gets null for older files and 0 after a downstream coalesce, and has been under-reporting discounts ever since. No job failed. No alert fired.

Every mechanism in this lesson worked. The new column got a new id. Old files legitimately do not contain it. The reader legitimately returned null. The coalesce legitimately turned null into zero, because somebody wrote that coalesce for a good reason on a different column and it is still there. Four correct behaviours compose into a wrong revenue figure.

**The change of meaning was delivered as an addition, and no layer in the stack checks meaning.** The format cannot: it has no representation for "this column means what that column used to mean". The catalog cannot: it validates types, not semantics. The pipeline cannot: it monitors job status, and the job succeeded. The consumer cannot, because the consumer was not told.

Note the shape of the failure, because it is the expensive one and it recurs in every track of this course: **green pipelines, wrong numbers.** Job-status monitoring is structurally blind to it. The four things people propose instead, and why three of them fail:

- **Backfill the new column across history** so the null rate returns to zero. Fixes this instance; leaves the class of bug entirely intact, and the next one arrives from a different producer.
- **Pin consumers to a fixed snapshot** so upstream changes cannot reach them. Trades a wrong answer for a stale one, and defers the break to whenever somebody unpins.
- **Require review on upstream schema changes.** Helps only if reviewers know which consumers exist — and the whole reason this class of change ships is that nobody does.
- **Publish schemas as versioned contracts where a change of meaning requires a new column rather than a redefinition, and alert on null-rate and distribution drift per column.** This is the durable answer, and it is two things rather than one: the contract makes semantic change explicit, and the detector catches the cases where somebody did it anyway. The null rate for \`discount_applied\` moved on day one. The signal was free; nobody was subscribed to it.

The number worth carrying: **zero files rewritten, eleven days wrong.** Those two facts are the same fact.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '0 files',
          label: 'rewritten by add, rename, widen or reorder',
          hint: 'All four are metadata operations: one new schema document and a pointer swap. The files are reconciled at read time, per file, by the reader.',
        },
        {
          value: '4 bytes vs 8',
          label: 'is how a reader learns a long used to be an int',
          hint: 'Type promotion does not rewrite manifest bounds, so the write-time type is inferred from the byte length of the stored bound. Free for data, not for metadata.',
        },
        {
          value: '11 days',
          label: 'of wrong revenue from a mechanically legal change',
          hint: 'Column Week INC-4. A nullable column added, an old one retired, a downstream coalesce turning null into zero. No job failed and no alert fired.',
        },
        {
          value: '1 day',
          label: 'is when the null-rate detector would have fired',
          hint: 'The null rate for the new column jumped on the first day of the change. The signal cost nothing to compute and nobody was subscribed to it.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'segfault',
      title: 'the changes that are not free, and are sold as if they were',
      md: `Four requests arrive regularly with the words "it's just a schema change" attached, and none of them is a metadata operation.

- **Narrowing a type** — \`long\` to \`int\`, \`decimal(18,2)\` to \`decimal(9,2)\`, \`double\` to \`float\`. Not a permitted promotion in either direction of the spec, because old values may not be representable. This requires reading every file to find out whether it is safe, which is the same cost as rewriting them.
- **Changing scale on a decimal.** Precision may widen; **scale is fixed**. \`decimal(9,2)\` to \`decimal(11,4)\` is a rewrite, because the stored unscaled integers mean something different at a different scale. This one bites finance schemas specifically.
- **Grouping existing columns into a struct** (or lifting them out). Explicitly disallowed as an evolution. \`struct<a,b,c>\` and \`struct<a, struct<b,c>>\` are not reachable from one another, and neither is \`map<string,int>\` and \`map<string,struct<int>>\`. C7.L1 explains the physical reason: the level budget of every leaf changes, so the files genuinely describe a different shape.
- **Reusing a dropped column's name for a different meaning.** Safe under id-based resolution and a live data-loss path under name-based resolution — and worse, it is safe in your table and unsafe in whatever downstream system re-derived the schema by name. Ask where else the name is resolved before you say yes.

The general rule to carry into a review: **if the change alters what an existing byte on disk means, it is a rewrite; if it alters only what that byte is called or how wide its container is, it is metadata.** Most arguments about schema evolution are people disagreeing about which of those two they are looking at.`,
    },
    {
      type: 'isomorphism',
      title: 'field ids ≡ three renaming problems you have already solved',
      pairs: [
        {
          os: 'inodes versus paths',
          osLine:
            'A file is its inode, not its name. Rename is a directory-entry edit and costs nothing; the data has no idea it happened. Reuse a path for different content and every stale reference silently points at the wrong thing.',
          llm: 'field ids versus column names',
          llmLine:
            'The same indirection with the same two consequences: rename is free, and name reuse is the one operation that silently rebinds meaning. Iceberg names exactly this failure — a reused name can un-delete a column.',
        },
        {
          os: 'protobuf field numbers',
          osLine:
            'The wire format carries numbers, not names, which is why renaming a field is a source-only change and reusing a retired number is the documented way to corrupt a rolling deploy.',
          llm: 'id-based column projection',
          llmLine:
            'Identical design and identical discipline: never reuse a retired id. Protobuf gives you a `reserved` keyword for it; a table format gives you a monotonically increasing last-column-id and expects you not to fight it.',
        },
        {
          os: 'a database migration that passes and changes a meaning',
          osLine:
            'The migration runs green, the constraint still holds, and a status enum now means something subtly different. Reviewers learn to ask "what reads this?" rather than "does it apply cleanly?"',
          llm: 'the eleven-day revenue break',
          llmLine:
            'The same lesson at table scale: mechanical compatibility is checkable and semantic compatibility is not, so the only defence is a published contract plus a distribution alert on the columns that carry money.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A 40 TB table needs a column renamed from ts to event_ts. The platform team says it is instant; a data engineer says it needs a full rewrite. Who is right?',
          options: [
            'The data engineer: the name is stored in every Parquet footer, so every file must be rewritten to stay consistent',
            'The platform team, but only because columns are resolved by field id — the rename changes the name in table metadata, leaves the id alone, and every existing file still resolves. Under name-based resolution the same operation would make the column read as null for all history',
            'Both are wrong: the rename requires rewriting only the manifests, not the data files',
            'The platform team: renames are always metadata-only in every columnar format',
          ],
          correct: [1],
          explanation:
            'The condition is the answer. Iceberg tracks each column by a unique id and projects by id, so a rename touches one JSON document and no data files — the old name is still sitting in every footer and is simply not what resolution uses. The last option is the trap worth rejecting explicitly: this is a property of the table format\'s resolution strategy, not of columnar storage, and formats that resolve by name or by position have the two failure modes Iceberg\'s own documentation names — un-deleting a column, and being unable to drop one without renaming its neighbours.',
        },
        {
          q: 'A revenue model has been under-reporting discounts for eleven days. Upstream added a nullable discount_applied column and retired the old one; the model reads null for older files, and a downstream coalesce turns that into 0. No job failed. What is the correct diagnosis, and what is the durable fix?',
          options: [
            'The table format failed to apply schema evolution to older files; the fix is to validate the format\'s evolution implementation',
            'A semantic change was delivered as a schema-compatible one. Adding a column and reading it as null-then-zero is mechanically valid and analytically wrong, and nothing in the stack checks meaning — so the fix is two things: publish schemas as contracts where a change of meaning requires a new column rather than a redefinition, and alert on per-column null-rate and distribution drift, which moved on day one',
            'The coalesce in the consuming query is the bug and the platform behaved correctly, so the consuming team owns the fix',
            'Statistics were not refreshed after the schema change, so the planner read stale values',
          ],
          correct: [1],
          explanation:
            'Every mechanism worked: a new column gets a new id, old files legitimately lack it, a reader legitimately returns null, and the coalesce legitimately maps null to zero. Four correct behaviours composing into a wrong number is the signature of a semantic break, and the format has no representation for meaning so it cannot catch one. Blaming the coalesce is technically defensible and operationally useless — it locates the bug in the last place it became visible rather than where it was introduced. The durable fix is a contract plus a detector, because the contract makes intent explicit and the detector catches the people who ignored the contract; note also that the failure shape here is green pipelines and wrong numbers, which job-status monitoring is structurally unable to see.',
        },
        {
          q: 'A finance table stores amount as decimal(9,2). A request arrives to change it to decimal(11,4) to hold four decimal places for FX conversion. What do you tell them?',
          options: [
            'Approved — decimal precision widening is a permitted promotion and costs no data rewrite',
            'This is a rewrite, not a promotion: precision may widen but scale is fixed, and the stored unscaled integers mean a different value at a different scale. It needs a new column and a migration, and the migration has to decide what the old two-decimal values mean at four decimals',
            'Approved, provided the column is not used in a partition transform',
            'Rejected outright — decimal types cannot be evolved in any way once data exists',
          ],
          correct: [1],
          explanation:
            'The permitted promotion is decimal(P,S) to decimal(P\',S) with P\' greater than P — precision only, scale unchanged — because the physical value is an unscaled integer interpreted at the type\'s scale. Change the scale and every existing integer on disk silently means one hundred times what it used to, which is the worst kind of correct-looking corruption in a table that carries money. The partition-transform caveat in the third option is a real rule and applies to a different case: it is why int may be promoted to long but not to string when the column feeds a bucket transform. Widening precision alone is genuinely free, so the fourth option is wrong too.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: resolution strategies, and where the names still matter',
      md: `Read **Iceberg's Evolution page and the table spec's "Schema Evolution" and "Column Projection" sections** side by side. The docs page gives you the four correctness guarantees in prose; the spec gives you the exact resolution order for a field id a file does not contain, the full promotion table with its v3 additions, and the disambiguation-by-byte-length rule for bounds after a promotion. The second is the one that changes how you read a manifest.

**\`schema.name-mapping.default\`** deserves a specific look, because it is the bridge for tables migrated in place from Hive: files written without field ids get their ids assigned by a name mapping stored in table properties. It is also the one place where names are load-bearing in an id-based format, so a rename plus a stale name mapping is a real way to break an otherwise-safe operation.

**Delta Lake's column mapping** is the same problem solved slightly later and slightly differently: an opt-in table property that adds ids and physical names to the schema, with an explicit protocol version bump because tables written without it cannot be read as if they had it. Comparing the two is the fastest way to see that id-based resolution is a *choice with a migration*, not a property of Parquet.

**Avro's schema resolution rules** are the ancestor of all of this — reader schema versus writer schema, with aliases as the rename mechanism — and are worth reading because Iceberg's manifests are Avro and inherit that machinery for their own evolution.

For the semantic half, which no format solves: **"Data Management Challenges in Production Machine Learning" (Polyzotis et al., SIGMOD 2017)** and the schema-validation work around TFX are the clearest treatment of distribution-level contracts, and the argument generalises far beyond ML. Column Week's \`silent-schema-change\` is the operational drill; **A2** turns it into a published contract and an alerting policy, and the \`the-consumer\` room will ask you for both.

Next: **C7.L4** closes the engine half on the boundary object — Arrow — and on the column type that stores beautifully and prunes not at all.`,
    },
  ],
}

export default lesson
