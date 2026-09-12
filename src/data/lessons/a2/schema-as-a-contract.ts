import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'a2.l2',
  slug: 'schema-as-a-contract',
  trackId: 'a2',
  index: 2,
  title: 'Schema as a Contract',
  minutes: 18,
  hook: 'A revenue model was wrong for eleven days and every pipeline stayed green, because the change was mechanically compatible and semantically a lie. The format cannot tell the difference. The contract is the thing that can.',
  exercise: 'room',
  takeaway: {
    number: '1 new column, 11 days',
    claim:
      'A change of meaning gets a new column and a new contract version, never a redefinition — because the redefinition that arrived as a compatible change ran wrong for 11 days with zero failed jobs, and the null rate that would have caught it moved on day 1.',
  },
  blocks: [
    {
      type: 'prose',
      md: `A2.L1 established what the catalog is authoritative about: **which files are in the table.** Here is what it has no opinion about at all — **what the columns mean.** That gap is not a bug in any format. It is the boundary of what a mechanical guarantee can cover, and it is where the most expensive incident in Column Week lives.

Read INC-4 again as a platform owner rather than as a puzzle:

> Upstream added a nullable column, \`discount_applied\`, and renamed the old one. Mechanically a compatible change; every pipeline stayed green. The model reads \`discount_applied\`, gets null for older files and 0 after a downstream coalesce, and has been under-reporting discounts for eleven days.

Count what the platform did right. Schema version moved 7 → 8, cleanly. Zero ingest jobs failed. Old files stayed readable. Every mechanical guarantee the format offers was honoured **exactly as specified**. And mean revenue per order moved from 84 to 91 — an **8.3% overstatement** — in a number that goes into a board pack.

So the failure is not technical, and this is the sentence to be able to say in a review: **schema evolution is a guarantee about readers, which is precisely what makes it dangerous for consumers.** Adding a nullable column is safe for anything that opens the file. It is unsafe for anything that *interprets* it, because null-then-coalesced-to-zero is a value, and a value is what a model consumes.

The fix is not more validation on the ingest path. It is a contract, and a contract is four rules and one register of who is listening.`,
    },
    {
      type: 'prose',
      md: `## The four rules, and the one thing each of them prevents

**Rule 1 — the schema is published as a versioned artifact, and the version is a number consumers can pin and assert on.** Not a wiki page, not the current table state. A document with an owner, a version integer, and per column: the name, the type, the **unit**, the nullability, the valid range, and one sentence of *meaning*. The unit and the meaning are the two fields that would have caught INC-4, and they are the two nobody writes down. A schema without units is why somebody eventually divides by a hundred twice.

**Rule 2 — additive changes are compatible by default, and that is the whole point of the default.** Adding a nullable column, widening a type where the widening is lossless, adding a partition spec: these need a version bump and a note, not a negotiation. Make the cheap path genuinely cheap or people will route around the process, and a process that is routed around is worse than none because it produces false confidence.

**Rule 3 — a change of MEANING requires a new column, never a redefinition.** This is the load-bearing rule and it is one sentence long. If \`revenue\` starts excluding refunds, it is not \`revenue\` with a footnote; it is \`revenue_net_refunds\`, additive, alongside the old one, with the old one marked deprecated and a retirement date. If a code list gains a value that changes how existing values should be read, that is a new column too.

The reason this rule is worth an argument: **a redefinition is indistinguishable from correct behaviour at every layer that can check anything.** Types match. Nulls are legal. Row counts are normal. Jobs are green. The only detector is a human noticing that a number moved, which in INC-4 took eleven days and happened at month-end.

**Rule 4 — consumers are notified before a version is retired, and "notified" means a mechanism, not a message.** The consumer room's rebuttal to announcing changes on a channel is the whole argument: *"a message is not a contract. My pipeline does not read the channel, and the person who was watching it has left."* So: a register of consumers per dataset — for a mature platform this is a real list with real names, say **14 consumers across 6 teams** — a deprecation flag readable by machines, and a retirement window with a stated floor. **Two versions or 90 days, whichever is longer**, is a defensible floor because it survives a quarter-long project and one person's holiday.

Then the honest caveat, said first: **the contract does not stop anybody.** An upstream team can still redefine a column in place, and nothing in the storage layer will refuse it. Which is why the contract ships paired with a detector, and the detector is the subject of A2.L4: the null rate in INC-4 moved on **day 1 of 11**.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '11 days',
          label: 'INC-4 ran wrong before anyone noticed',
          hint: 'A semantic change delivered as a compatible one. Detection came from a human at month-end, which is a detection method with a latency measured in reporting cycles.',
        },
        {
          value: '0',
          label: 'ingest jobs that failed',
          hint: 'Every mechanical guarantee was honoured. This is why job-status monitoring is structurally unable to see this class of incident — there is nothing wrong with the jobs.',
        },
        {
          value: '8.3%',
          label: 'overstatement in mean revenue per order',
          hint: '84 to 91. Small enough to look like business performance, large enough to matter in a board pack, which is the worst possible size for an error.',
        },
        {
          value: 'day 1 of 11',
          label: 'when the null rate on the new column moved',
          hint: 'The detector existed in the telemetry from the first hour. Nobody was alerting on data shape, so the signal was present and unread for ten more days.',
        },
      ],
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'What Iceberg guarantees about schema change — read the list and notice what is absent',
      systems: ['iceberg'],
      sources: [
        'https://iceberg.apache.org/docs/latest/evolution/',
        'https://iceberg.apache.org/spec/',
      ],
      md: `Iceberg tracks columns by a **unique field id** rather than by name or position, which is why add, drop, rename, reorder and (lossless) type-widening are **metadata-only** operations: no data file is rewritten, and old files remain correct because the ids in the file still resolve to the right columns. That is a genuinely strong property and C7.L3 measures it from the file's side.

Now read the documented guarantees as a *set*:

- adding a column never reads existing values from another column;
- dropping a column does not change values in any other column;
- updating or renaming a column does not change values in another column;
- reordering columns does not change the values associated with a column name or id.

Every one of them is of the form **"no other column's values change."** They are guarantees about *mechanics*, and they are exactly the right guarantees for a reader. **None of them is about meaning**, and none of them can be, because the format has no representation for what a column means — a field id and a type are the whole vocabulary.

So INC-4 is not a case of a format failing to do its job. It is a case of a team taking the format's guarantee as covering a question the format never claimed to answer. The mechanical layer says "your reader will not break". The contract layer has to say "and the number still means what your model thinks it means", because nothing else in the stack is even attempting that sentence.

One practical consequence for your runbook: because rename is metadata-only and cheap, a rename plus an add is the *easiest* thing in the world for an upstream team to ship on a Friday. Cheap operations need social controls precisely because they have no technical friction.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the classifier that decides whether a change needs a new column',
      height: 76,
      nodes: [
        { id: 'req', x: 2, y: 2, w: 96, h: 9, label: 'an upstream team proposes a schema change', sub: 'the only question that matters: can an existing consumer read this and be wrong?', color: '#F97316' },
        { id: 'add', x: 2, y: 15, w: 30, h: 9, label: 'additive', sub: 'new nullable column · lossless widening', color: '#3EF2A4' },
        { id: 'rem', x: 35, y: 15, w: 30, h: 9, label: 'removal / narrowing', sub: 'drop, tighten a type, drop a value', color: '#FBBF24' },
        { id: 'sem', x: 68, y: 15, w: 30, h: 9, label: 'change of MEANING', sub: 'same name, different definition', color: '#FB7185' },
        { id: 'v', x: 2, y: 28, w: 30, h: 9, label: 'version bump + note', sub: 'compatible by default · no negotiation', color: '#3EF2A4' },
        { id: 'dep', x: 35, y: 28, w: 30, h: 9, label: 'deprecate, then retire', sub: '2 versions or 90 days, whichever is longer', color: '#FBBF24' },
        { id: 'newcol', x: 68, y: 28, w: 30, h: 9, label: 'a NEW column', sub: 'never a redefinition of the old one', color: '#FB7185' },
        { id: 'reg', x: 2, y: 41, w: 96, h: 9, label: 'the consumer register: 14 consumers across 6 teams, machine-readable, notified by mechanism and not by message', sub: 'a channel announcement is not a contract — the pipeline does not read the channel, and the person who watched it has left', color: '#A78BFA' },
        { id: 'gap', x: 2, y: 54, w: 46, h: 9, label: 'the caveat, said first', sub: 'a contract stops nobody — storage will accept the redefinition', color: '#94A3B8' },
        { id: 'det', x: 52, y: 54, w: 46, h: 9, label: 'so it ships with a detector', sub: 'null-rate + distribution drift per column (A2.L4)', color: '#22D3EE' },
        { id: 'out', x: 2, y: 67, w: 96, h: 9, label: 'INC-4 with both in place: the change is a new column, or the null rate alerts on day 1 instead of the finance team noticing on day 11', sub: 'contract makes semantic change explicit; the detector catches the cases where somebody did it anyway', color: '#F97316' },
      ],
      edges: [
        { from: 'req', to: 'add' },
        { from: 'req', to: 'rem' },
        { from: 'req', to: 'sem' },
        { from: 'add', to: 'v' },
        { from: 'rem', to: 'dep' },
        { from: 'sem', to: 'newcol' },
        { from: 'v', to: 'reg' },
        { from: 'dep', to: 'reg' },
        { from: 'newcol', to: 'reg' },
        { from: 'reg', to: 'gap' },
        { from: 'reg', to: 'det' },
        { from: 'gap', to: 'out' },
        { from: 'det', to: 'out' },
      ],
      steps: [
        {
          caption:
            'Every proposed change gets classified by one question, and it is not "will this break a reader" — the format already answers that. It is "can an existing consumer read this successfully and draw a wrong conclusion".',
          active: ['req'],
        },
        {
          caption:
            'Additive changes are compatible by default and take the cheap path deliberately: a version bump and a note. Make this genuinely cheap, or teams route around the process and you get false confidence instead of no process.',
          active: ['add', 'v'],
          edges: ['req->add', 'add->v'],
        },
        {
          caption:
            'Removals and narrowings are not emergencies but they do have a clock: deprecate, publish a retirement date, and hold a floor of two versions or ninety days so the window survives a quarter-long project and one person going on leave.',
          active: ['rem', 'dep'],
          edges: ['req->rem', 'rem->dep'],
        },
        {
          caption:
            'And the load-bearing rule, one sentence long: a change of meaning gets a new column rather than a redefinition, because a redefinition passes every automated check in the stack and is detectable only by a human noticing a number moved.',
          active: ['sem', 'newcol'],
          edges: ['req->sem', 'sem->newcol'],
        },
        {
          caption:
            'All three paths terminate at the register, which is what turns notification from a courtesy into a mechanism: a real list of consumers per dataset, a machine-readable deprecation flag, and a retirement window with a stated floor.',
          active: ['reg'],
          edges: ['v->reg', 'dep->reg', 'newcol->reg'],
        },
        {
          caption:
            'State the weakness before the room finds it: a contract has no enforcement in the storage layer, so an upstream team can still redefine a column in place and nothing will refuse it.',
          active: ['gap'],
          edges: ['reg->gap'],
        },
        {
          caption:
            'Which is why the contract ships paired with a shape detector rather than alone — and with both, INC-4 either never happens or alerts on day one out of eleven, from a signal that was already in the telemetry the whole time.',
          active: ['det', 'out'],
          edges: ['reg->det', 'gap->out', 'det->out'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'three schema changes that pass every automated check and are wrong',
      md: `Worth keeping in the runbook as examples, because each one has a different tell.

**The rename-plus-add.** INC-4 exactly: old column renamed, new column added, both operations metadata-only and legal. Consumers reading by name follow the new column and get nulls for history; consumers reading the old name get a column that no longer receives writes. The tell is **null rate on the new column and write rate on the old one**, and both move on day one.

**The silently widened code list.** \`status\` gains a seventh value. The type is unchanged, the column is not null, nothing is added or dropped, and every downstream \`CASE WHEN\` now has an unhandled branch that quietly falls into \`ELSE\`. No schema-level artefact records it, which is why the contract has to carry the **valid range or value set per column** and not only the type. The tell is **distribution drift** — a new category appearing at 2% of rows.

**The unit change.** Amounts move from major units to minor units, or from local currency to a reporting currency, and the column type stays numeric. This one is the most expensive and the most preventable, because the contract field that catches it — **unit** — costs one line to write and is missing from nearly every schema registry entry in existence. The tell is a distribution shift by a suspiciously round factor.

None of these three is caught by type checking, row counts, job status or a code review that does not know who the consumers are. All three are caught by the contract plus one of the three shape detectors in A2.L4.`,
    },
    {
      type: 'prose',
      md: `## Before you open the room: the four numbers the consumer will ask for

The consumer room is graded on your dossier, and it fires objections by predicate. Four can fire here, and you should know which is which before you walk in — including the two this lesson does not fully teach.

| the objection | what fires it | the answer that survives |
|---|---|---|
| **no schema contract** (severity 3) | \`schemaContract\` is not true | the four rules above, with rule 3 said as one sentence: a change of meaning gets a new column |
| **freshness gap** (severity 3) | your p99 staleness exceeds the freshness SLA you recorded | the *curve*, not a no: interval versus file count, and let them choose the point |
| **no query SLO** (severity 2) | \`querySloDefined\` is not true | a p95 per workload class with the ad-hoc class fenced by quota — A2.L4 |
| **no quality alerting** (severity 2) | \`qualityAlerting\` is not true | alerts on data shape rather than job status — A2.L4 |

The freshness one deserves its arithmetic here, because it is a severity 3 and it is the objection where most people concede ground for no reason. Suppose the business asked for **300 s** and your measured p99 staleness is **360 s**. Do not answer "we will optimise". Answer with the mechanism and its price:

\`\`\`text
files created/day  =  commits/day × partitions/commit × writers
at 300 s:  288 × 6 × 3   =   5,184 files/day
at  60 s: 1,440 × 6 × 3  =  25,920 files/day    (5× the metadata, same bytes)
\`\`\`

That is the whole answer: *your requirement is buyable, here is the exchange rate, and the currency is manifest entries and compaction throughput — pick a point on the curve.* The consumer's own rebuttal tells you it works: *"you brought me the curve instead of a no. I will take the middle of it and stop asking for seconds."*

And if two severity-2 objections fire because A2.L4 has not happened yet, that is survivable and it is honest — the dossier persists, so you come back after L4 and L7 with a fuller one. Being wounded twice in a room you re-enter is a better outcome than fabricating a query SLO you cannot support.`,
    },
    {
      type: 'room',
      room: 'the-consumer',
      artifact: 'platform-runbook',
      brief:
        'Tunde Bakare runs analytics and ML on top of whatever you build, and he does not care about your file layout. Before you go in, put four things in the dossier. schemaContract — true only if you can state the four rules, and the one he is listening for is that a change of meaning requires a new column rather than a redefinition; "the table format supports schema evolution" is a mechanical answer to a semantic question and it wounds you, while "we announce changes on the platform channel" is fatal, because his pipeline does not read the channel. stalenessP99Sec and freshnessSlaSec — both of them, honestly, because the objection fires on p99 exceeding the SLA and the surviving answer is the interval-versus-file-count curve with the choice handed back to him, not a promise to optimise. querySloDefined and querySloP95Sec — a p95 per workload class with the ad-hoc class quota-fenced rather than promised; if you have not done A2.L4 yet, expect this severity-2 to fire and answer it with the class structure rather than inventing a number. qualityAlerting — alerting on row-count deltas, null-rate drift and freshness per partition rather than job status, because a green pipeline delivering wrong data is the failure that actually happened for eleven days. The room is deterministic: change one field in the dossier and a different objection appears, so you can come back after L4 and see exactly which number bought you the survive.',
    },
    {
      type: 'isomorphism',
      title: 'a schema contract ≡ compatibility disciplines you already keep',
      pairs: [
        {
          os: 'protobuf field numbers',
          osLine:
            'Fields are identified by number, so renaming is free and reusing a retired number is catastrophic. The style guides all say the same thing: never change the meaning of an existing field, add a new one and deprecate the old.',
          llm: 'Iceberg field ids and rule 3',
          llmLine:
            'The identical mechanism and the identical discipline layered on top of it. Ids make rename cheap; the contract is what stops cheap rename from becoming silent redefinition. If your team already refuses to reuse a proto field number, they already agree with this lesson.',
        },
        {
          os: 'a versioned HTTP API with a deprecation window',
          osLine:
            'You do not change what a field means in v1. You ship v2, run both, publish a sunset date, and know which clients are still on v1 — because you have a register of them, not a mailing list.',
          llm: 'the versioned dataset contract',
          llmLine:
            'Same three parts: version, overlap period, consumer register. The difference is that an API client fails loudly against a broken contract, and a data consumer produces a plausible number instead — so the data version needs a detector as well as a version.',
        },
        {
          os: 'a database migration reviewed for lock behaviour',
          osLine:
            'Nobody ships an ALTER without asking what it locks and for how long, because the cost is obvious and immediate. Reviews catch it because the failure is loud.',
          llm: 'a metadata-only schema change',
          llmLine:
            'The inverse hazard, and the reason this needs a written rule: the change is instant, free, rewrites nothing, and locks nothing — so it attracts none of the scrutiny an ALTER gets, while being capable of an error that runs for eleven days. Cheapness is the risk factor here. (→ tablespace T4 for the row store\'s side of migration cost.)',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'An upstream team needs to change `revenue` to exclude refunds. They point out that the type is unchanged, no consumer will fail to read it, and the format handles the change with no rewrite. What do you require, and what is the argument?',
          options: [
            'Accept it with a schema version bump and an announcement, since the change is mechanically compatible and blocking it would make the platform an obstacle',
            'Require a new column — revenue_net_refunds — additive alongside the old one, with the old one deprecated and given a retirement date, because a redefinition is indistinguishable from correct behaviour at every layer that can check anything: types match, nulls are legal, row counts are normal, jobs stay green, and the only detector left is a human noticing a number moved',
            'Accept it but require a backfill of history under the new definition, so the column is internally consistent across all files',
            'Require that all 14 consumers explicitly sign off before the change lands, since they are the ones affected',
          ],
          correct: [1],
          explanation:
            'This is rule 3 and it is the lesson. The reason it is a rule rather than a judgement call is asymmetry of detection: an additive column that a consumer ignores costs a little storage and nothing else, while a redefinition costs a wrong number for as long as it takes a human to notice, which in INC-4 was eleven days and landed at month-end. Backfilling is worse than it looks — it makes the series internally consistent and silently restates history, so every dashboard that was correct last week is now different with no version to point at. Sign-off from every consumer sounds rigorous but converts a one-line rule into a coordination project, and processes that expensive get bypassed; the whole point of making additive changes cheap in rule 2 is to keep the expensive path narrow enough that people actually use it.',
        },
        {
          q: 'Your consumer says a column changed meaning upstream last quarter and their model silently degraded for eleven days, and asks what stops that on your platform. Which answer survives the room?',
          options: [
            '"The table format supports schema evolution, so changes are handled safely and old files stay readable."',
            '"Schemas are published as a versioned contract: additive changes are compatible by default, a change of meaning requires a new column rather than a redefinition, and consumers are notified before a version is retired — and because a contract enforces nothing in storage, it ships with null-rate and distribution alerting, which in your incident would have fired on day one of eleven."',
            '"We announce all schema changes on the platform channel a week before they land, and we now require review on upstream schema pull requests."',
            '"We pin your pipeline to a fixed snapshot, so upstream changes cannot reach you until you choose to move."',
          ],
          correct: [1],
          explanation:
            'The surviving answer names the rule that would have prevented the specific incident, then volunteers the weakness of its own control and attaches the detector that covers it — which is the caveat-first habit the rooms grade. The first option answers a semantic question with a mechanical guarantee, which is what wounds you: the format handled the change perfectly and the model was still wrong. Announcements are fatal in this room for a reason worth quoting — a message is not a contract, the pipeline does not read the channel, and the person watching it has left; review helps only if reviewers know which consumers exist, which is what the register is for. Pinning a snapshot trades a wrong answer for a stale one and moves the problem to whoever eventually unpins.',
        },
        {
          q: 'Your recorded freshness SLA is 300 s and your measured p99 staleness is 360 s, so the consumer room will fire its severity-3 freshness objection. What do you bring?',
          options: [
            'A commitment to close the gap by optimising the pipeline this quarter',
            'The exchange rate: staleness is the batch interval plus commit time, and files created per day is commits × partitions × writers — 5,184/day at a 300 s interval against 25,920/day at 60 s, the same bytes and five times the manifest entries — so they choose the point on the curve and the cost lands in compaction throughput and planning',
            'An explanation that 300 s is unrealistic for a columnar platform on object storage and a request to renegotiate the requirement',
            'A larger compute allocation for the ingest jobs, since more parallelism reduces end-to-end staleness',
          ],
          correct: [1],
          explanation:
            'The consumer is not asking to be told no or to be told yes; they are asking whose requirement it is to spend against. Handing over the curve makes it theirs, and it is the answer the room explicitly rewards. It is also the honest mechanism: freshness and file count are one dial seen from two ends, and the price of seconds is metadata that the catalog and every query plan then pay for. "We will optimise" is a hope attached to someone else\'s roadmap with no mechanism and no number. Declaring the requirement unrealistic after the architecture was chosen is fatal — their models are built on that figure and you are telling them at the design review. More compute for ingest does not help, because staleness is set by the commit interval rather than by how fast a batch is processed.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: contracts, and the literature on meaning versus mechanism',
      md: `The best writing on this is not from the data-platform world. **Postel's robustness principle and the decades of argument against it** are the right frame: being liberal in what you accept is exactly what turns a semantic change into a silent one, and the modern consensus in protocol design — visible in **protobuf's style guidance on never repurposing a field** and in **Rich Hickey's "Spec-ulation" talk** on growth versus breakage — lands precisely on rule 3. Hickey's formulation is the one to steal for a review: you may only *require less* and *provide more*; anything else is a new thing with a new name.

For the practice, read **Andrew Jones's *Data Contracts*** for the organisational machinery — ownership, registers, retirement — and treat the tooling chapters as perishable. Then read the **Iceberg evolution documentation** with the question this lesson asks: which of these guarantees is about meaning? The answer is none of them, and the docs are honest about their own scope, which is more than most vendor documentation manages.

On detection rather than prevention, the transferable literature is **statistical process control**: Shewhart charts and the ARL (average run length) framing, which is the right way to think about "day 1 of 11". You are choosing a detection latency and a false-positive rate, and the reason to state it that way is that A2.L4 has to defend the alert budget to people who will be woken by it.

Sibling course: **→ vectorspace L4** for embedding-model versioning, which is the same problem with a worse failure mode — the model changes meaning and there is no column to compare against. **→ tablespace T4** for migration cost in a row store, where the same change is loud, slow and reviewed, which is instructive about why the cheap version is more dangerous.

Next: **A2.L3**. The contract governs what the table means. Three background jobs govern whether it stays queryable, and each of them needs a budget stated in counts — because a maintenance job with no budget is an unbounded bill with a cron entry.`,
    },
  ],
}

export default lesson
