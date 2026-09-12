import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'a2.l7',
  slug: 'the-runbook-and-the-on-call-surface',
  trackId: 'a2',
  index: 7,
  title: 'The Runbook and the On-Call Surface',
  minutes: 22,
  hook: 'The last page of the course is the one you would actually want at 3am: five incidents, each with the indicator that moved first, the diagnosis path, and an intervention with a stated cost. Then the handoff — your own measurements, defended in five rooms, ending on what a proof-of-concept would have to measure.',
  exercise: 'room',
  artifact: 'platform-runbook',
  takeaway: {
    number: '5 incidents, 11 days',
    claim:
      'A runbook is five incidents each with a leading indicator, a diagnosis path and an intervention priced in counts — and the erasure deadline it produces is 11 days against a 30-day obligation, because the snapshot expiry window is 7 of those days.',
  },
  blocks: [
    {
      type: 'prose',
      md: `This is the last lesson in the course, so it should be the most useful one, and the test for that is specific: **could somebody who did not build this platform use this page at 3am, while tired, to do the right thing?**

That test rules out most of what gets written down. It rules out architecture diagrams, because at 3am nobody needs to know the shape of the system, they need to know which number moved and what to do about it. It rules out prose. It rules out anything whose first instruction is *investigate*.

What survives the test is a table with four columns, one row per failure you have actually seen or modelled:

1. **the leading indicator** — the count that moves *first*, with its threshold;
2. **the diagnosis path** — two or three counts, in order, that confirm or eliminate it;
3. **the intervention** — a specific action, not a category;
4. **what the intervention costs** — because at 3am the person reading this is being asked to spend something on your behalf, and if the cost is not written down they will either freeze or spend too much.

The fourth column is the one almost every runbook omits, and it is the reason a good runbook is a *platform* artifact rather than an operations one: the interventions in this subject all cost bytes rewritten, files created, freshness given up, or somebody else's engineer-days. You already have all four of those numbers from A2.L3 through A2.L6. This lesson is where they become one page.

Column Week's five incidents are the spine, because between them they cover every layer this course taught — layout, ingest, distribution, semantics, and the substrate — and each is diagnosable from counts alone. No stopwatch, no vendor-specific telemetry.`,
    },
    {
      type: 'prose',
      md: `## The spine: five incidents, four columns

**INC-1 — pruning collapse.** *The dashboard that tripled its bill.*

- **Indicator:** clustering depth per partition, alert on a rise above 2. It moved from 1 to 9 about **12 hours** before the cost did.
- **Diagnosis:** pruning ratio (89% → 11%), then row groups read (180 → 1,620 = 9×), then daily scan volume (1.2 → 3.9 TB = 3.25×). Latency will look almost normal — a wide engine absorbs 9× the row groups — so do not use it to confirm or dismiss.
- **Intervention:** re-cluster the affected partitions on the sort column, and raise the loader-ordering defect upstream. Not bloom filters (they answer equality, not ranges) and not more partitions (that makes the file count worse and does nothing about within-file ordering).
- **Cost:** a one-off rewrite of the affected partitions — seven days of ninety is roughly **8% of the table, about 3.2 GiB on the reference table**, on top of the standing 12%/day — plus an upstream fix you do not control, which means the *interim* control is a scan quota on that dashboard rather than a promise.

**INC-2 — small-file storm.** *Ten thousand files an hour.*

- **Indicator:** files created per hour against files merged per hour, on one axis, with the **crossing** as the alert rather than the backlog level. Backlog slope positive for 24 hours is a page.
- **Diagnosis:** live file count against data volume (1.4M files, 9 TB), mean file size (240 MB → 6 MB), planning share of query time (4% → **61%**).
- **Intervention:** raise the batch interval to the largest value the freshness SLA permits, and size compaction capacity against the creation rate. The interval is the input; the file count is the consequence.
- **Cost:** **freshness, which is your consumer's number and not yours.** 5,184 files/day at a 300 s interval against 25,920 at 60 s. So this intervention requires the curve conversation from A2.L2 — and at 3am the correct move is the temporary one (raise the interval, note the SLA breach, book the conversation) rather than the permanent one.

**INC-3 — skewed shuffle.** *The one worker nobody was watching.*

- **Indicator:** **max ÷ mean** partition bytes on shuffle keys. The mean was flat all month (4 GB) while the max went 9 → 128 GB.
- **Diagnosis:** per-partition byte counts, then worker idle percentage (20% → 86%), then spill bytes. Cluster utilisation at 14% during a slow job is the signature: the work cannot be divided, so the machine is idle.
- **Intervention:** split the hot key — salt it across sub-partitions and union, or handle the heavy hitters separately. Not a bigger cluster (the large partition stays on one worker) and not more memory (that stops the spill and leaves it single-threaded).
- **Cost:** **somebody else's engineer-days**, because it is a query change in a job you may not own — call it 2–4 engineer-days including validation — plus a little extra shuffle for the union. This is the one incident whose intervention you cannot perform at 3am; the 3am action is to let it finish or kill it, and to write the ticket with the max/mean number in it.

**INC-4 — silent schema change.** *The column that started returning zero.*

- **Indicator:** null-rate and distribution drift per column. It moved on **day 1 of 11**.
- **Diagnosis:** schema version (7 → 8), null rate on the new column, then the business metric (mean revenue per order 84 → 91, an **8.3%** overstatement). Ingest job failures: **zero**, and that is expected — do not let a green pipeline end the investigation.
- **Intervention:** a new column and a contract version (A2.L2), then an explicit decision about history. Not a silent backfill: backfilling makes the series internally consistent and restates every number anybody has already quoted.
- **Cost:** a communication to **14 consumers across 6 teams**, restated figures for the affected period, and one difficult conversation about a board number. Cheap in bytes, expensive in trust — which is exactly why the detector is worth its false-positive budget.

**INC-5 — the disaggregation surprise.** *Fine on local disk, slow on the fabric.*

- **Indicator:** requests per second against bytes per request. **Never bandwidth utilisation**, which sat at 21% throughout.
- **Diagnosis:** requests/s (400 → 9,800), bytes per request (512 KB → 9 KB), then p95 (40 → 610 ms). The tell is high request rate with idle throughput.
- **Intervention:** make requests bigger and fewer — coalesce reads, raise the minimum read granularity, prefetch by column chunk — and raise outstanding-request concurrency. Not more bandwidth, which is not the constraint.
- **Cost:** configuration first, and possibly a layout change if the request pattern is a symptom of file sizing. The generalisable line for your runbook and for every POC you ever run: **measure requests/s and bytes/request, not aggregate throughput.**`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '≤ 2 pages/week',
          label: 'the on-call budget the whole design is bounded by',
          hint: '400 tables × 4 detectors is 1,600 rules; at a 2% weekly false-positive rate that is 32 pages a week and an on-call who acknowledges without reading. Tier it or it is decorative.',
        },
        {
          value: '11 of 30 days',
          label: 'erasure deadline: 1 to locate + 3 to rewrite + 7 of expiry',
          hint: 'The snapshot retention window is part of the deadline whether anyone wrote it down or not — which is why the same number appears in the storage multiple, the rollback horizon and this commitment.',
        },
        {
          value: '4 columns',
          label: 'per runbook row: indicator, diagnosis, intervention, cost',
          hint: 'The fourth is the one nearly every runbook omits, and it is the one that lets a tired person act rather than freeze — every intervention here spends bytes, files, freshness or somebody else\'s engineer-days.',
        },
        {
          value: '5 counts',
          label: 'the proof-of-concept has to produce, on your data',
          hint: 'Storage held ÷ live under restatement, object count against commit rate, the cost of updating a year-old row versus a fresh one, read amplification under continuous restatement, and what background work you cannot see.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the on-call surface: what pages, what waits, and the one job whose answer is stop',
      md: `A runbook without a paging policy is a document that competes with sleep. Three tiers, written where the on-call can see them, and a target you hold yourself to.

**Pages** — wake a human. Erasure deadline at risk. Catalog unavailable. Freshness breached on a **contract-bearing** dataset (the named list, roughly 40 of 400). Compaction backlog slope positive for 24 hours. Target **≤ 2 a week**; exceed that for a month and the thresholds are wrong, not the humans.

**Tickets** — next working day. Shape drift on a non-critical dataset. Clustering depth rising but under threshold. Storage multiple above policy. Orphan-candidate count above its sanity bound.

**Dashboard only** — nobody is notified, and every leading indicator is plotted next to the lagging symptom it predicts, so the causal link is *rendered* rather than remembered by whoever is awake.

Then three rules that are specific to this subject and are the reason a generic on-call playbook is not enough here:

**Orphan cleanup is the one job whose anomaly response is to stop.** Its documented failure mode is deleting live files — a retention interval shorter than your longest in-flight write, or a path comparison that broke because an authority changed. If the candidate list is anywhere near the size of the table, the comparison is broken, not the table. **Do not investigate while it runs.**

**Two interventions require the consumer, not just you.** Raising the batch interval spends their freshness; re-clustering changes which query is fast. At 3am do the reversible half and book the conversation; a platform team that spends a consumer's SLA unilaterally at 3am will be doing it in a design review by Thursday.

**One term of your RTO is a decision, not an engineering task.** Failing over means judging whether the primary is coming back. Write the criteria and the name of the person who owns the call, because thirty minutes of coordination does not respond to a faster copy path (A2.L6).`,
    },
    {
      type: 'prose',
      md: `## Before the steward: the four answers, each with a number

The governance half of the runbook is four answers, and every one of them is a number rather than an intention. The steward's opening tells you why: *"I will be asked these questions by someone external, and I will be repeating your answers."*

**1 · The erasure path, with a deadline that includes the retention window.** This is the severity-3 objection and the arithmetic is the answer:

\`\`\`text
locate the subject's rows across partitions           ≤ 1 day
targeted rewrite of the files holding them            ≤ 3 days   (weekly cadence, worst case)
snapshot expiry drops the superseded versions            7 days   (the A2.L3 window)
──────────────────────────────────────────────────────────────
committed erasure deadline                              11 days   against a 30-day obligation
\`\`\`

Say the mechanism, not just the total: a delete marks rows logically, a **targeted rewrite** removes them from the files that held them, and expiry then drops the versions that still reference those files. Until expiry closes, **the rows are still readable in earlier snapshots** — which is the finding the steward is hunting for, and why "we issue a DELETE and the platform handles it" is only a wounded answer rather than a fatal one. Offering time travel as an auditing benefit is the fatal one: you have described a mechanism that keeps deleted personal data recoverable and called it a feature.

**2 · Retention, per dataset class, enforced by something with a log.** Events 400 days, raw landing 90 days, snapshot window 7 days. The evidence is the expiry job's run history, not a document stating an intention — *"enforcement with a log. That is the difference between a policy and a wish."* And note the reconciliation nobody does: **that 7-day window is simultaneously your rollback horizon, a term in your storage multiple of 1.87×, and 7 of the 11 days above.** One number, three documents.

**3 · Lineage tied to a snapshot, because "as of when" is the whole question.** Column-level lineage from the catalog and the pipeline definitions, resolved **as of the snapshot the query read**. Pipeline code in version control is a wounded answer: it tells an auditor what runs now, and the question was what produced *this value*, which is a different answer every time the pipeline changed.

**4 · Residency as a cost you have computed, not a promise you have made.** The predicate is blunt: if a residency requirement applies and the design has fewer than two regions, the severity-3 fires. So put the number in: regional storage and compute per jurisdiction with the metadata layer scoped accordingly, **three regions**, each carrying its own retention multiplier — and the labour, in the unit this course uses: roughly **2 engineer-months** to build the per-region deployment and **0.5 engineer-months per region per year** to operate it, on top of the 0.25 the maintenance jobs already cost (A2.L3). Encryption is the fatal answer here, and the reason is worth memorising: encryption is not residency, because the requirement is about which jurisdiction can compel access to the bytes.`,
    },
    {
      type: 'room',
      room: 'the-steward',
      artifact: 'platform-runbook',
      brief:
        'Ingrid Halvorsen is a data protection and governance officer, she is not interested in performance, and she will be repeating your answers to somebody external. Four fields decide this room and all four are in the dossier. erasurePath — true only if you can walk the mechanism and give the deadline WITH the retention window inside it: 1 day to locate, up to 3 days for the targeted rewrite, 7 days of snapshot expiry, so 11 days against a 30-day obligation. "We issue a DELETE and the platform handles it" wounds you because a delete writes a marker and the bytes stay readable in earlier snapshots; offering time travel as an auditing advantage is fatal, because that is a mechanism for keeping deleted personal data recoverable. retentionPolicyDays — a period per dataset class enforced by an automated job whose runs are logged, because the evidence is the job history rather than the policy document; "we keep everything because storage is inexpensive" answers a cost question she did not ask and concedes that you hold liability without a reason. lineageEvidence — column-level lineage resolved as of the snapshot the query read, so the answer is reproducible for a point in time; pointing at version-controlled pipeline code tells her what runs now rather than what produced this value. residencyRequired and regions — if the requirement applies, fewer than two regions fires a severity 3, so bring the regional design and its cost in engineer-months rather than a promise, and never offer encryption, because the requirement is about which jurisdiction can compel access. The room is deterministic and reads only the dossier, so if a field is blank the objection fires on the blank — and A2.L3 and A2.L6 supply the two numbers most people are missing.',
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the page you want at 3am, and the two clocks running behind it',
      height: 76,
      nodes: [
        { id: 'page', x: 2, y: 2, w: 96, h: 9, label: 'a page arrives · budget ≤ 2 a week · the question is never "what is wrong" but "which count moved first"', sub: 'tiers written down: pages, tickets, dashboard-only — because 1,600 rules at 2% weekly false positives is 32 pages and an on-call who stops reading', color: '#F97316' },
        { id: 'i1', x: 2, y: 15, w: 30, h: 9, label: 'INC-1 depth 1 → 9', sub: '12 h before the bill · re-cluster · 8% rewrite', color: '#FB7185' },
        { id: 'i2', x: 35, y: 15, w: 30, h: 9, label: 'INC-2 created > merged', sub: 'planning 4% → 61% · raise interval · costs freshness', color: '#FB923C' },
        { id: 'i4', x: 68, y: 15, w: 30, h: 9, label: 'INC-4 null drift', sub: 'day 1 of 11 · new column · 14 consumers told', color: '#A78BFA' },
        { id: 'i3', x: 2, y: 28, w: 46, h: 9, label: 'INC-3 max ÷ mean 4 → 32', sub: 'mean flat all month · salt the key · 2–4 engineer-days, someone else\'s', color: '#22D3EE' },
        { id: 'i5', x: 52, y: 28, w: 46, h: 9, label: 'INC-5 requests/s up, bytes/request down', sub: 'fabric 21% used · coalesce reads · config first', color: '#5CA8FF' },
        { id: 'act', x: 2, y: 41, w: 96, h: 9, label: 'every row ends in an intervention WITH A COST: bytes rewritten · files created · freshness given up · engineer-days you do not own', sub: 'and two of the five spend a consumer\'s number, so at 3am you do the reversible half and book the conversation', color: '#FBBF24' },
        { id: 'gov', x: 2, y: 54, w: 96, h: 9, label: 'the governance clocks: erasure 1 + 3 + 7 = 11 days of 30 · retention 400 / 90 / 7 days, enforced by a logged job · lineage as of a snapshot · residency = 3 regions, 2 engineer-months to build', sub: 'the 7-day expiry window is your rollback horizon, 7 of the 11 erasure days, and part of a 1.87× storage multiple — one number, three documents', color: '#A3E635' },
        { id: 'cap', x: 2, y: 67, w: 96, h: 9, label: 'then the capstone: your own measurements → one recommendation → five rooms → the 5 counts a POC must produce', sub: 'the honest ending for a course taught without the cluster: not "this platform is good" but "here is what would change my mind"', color: '#3EF2A4' },
      ],
      edges: [
        { from: 'page', to: 'i1' },
        { from: 'page', to: 'i2' },
        { from: 'page', to: 'i4' },
        { from: 'page', to: 'i3' },
        { from: 'page', to: 'i5' },
        { from: 'i1', to: 'act' },
        { from: 'i2', to: 'act' },
        { from: 'i4', to: 'act' },
        { from: 'i3', to: 'act' },
        { from: 'i5', to: 'act' },
        { from: 'act', to: 'gov' },
        { from: 'gov', to: 'cap' },
      ],
      steps: [
        {
          caption:
            'The runbook opens with the paging policy rather than with the architecture, because the first decision at 3am is whether this should have woken anybody — and a budget of two pages a week is what keeps the answer meaningful.',
          active: ['page'],
        },
        {
          caption:
            'Three incidents are found by watching a shape rather than a job: clustering depth before the bill, file creation outrunning merges before planning collapses, and null-rate drift before a wrong number reaches a board pack.',
          active: ['i1', 'i2', 'i4'],
          edges: ['page->i1', 'page->i2', 'page->i4'],
        },
        {
          caption:
            'Two are found by refusing to look at an average: the maximum partition is the runtime of a distributed join, and a request-bound workload starves while aggregate bandwidth sits at a fifth of capacity.',
          active: ['i3', 'i5'],
          edges: ['page->i3', 'page->i5'],
        },
        {
          caption:
            'Every row terminates in a specific action with its price attached, because a tired person handed an action and no cost will either freeze or overspend — and two of these five spend a consumer\'s freshness or latency rather than your own budget.',
          active: ['act'],
          edges: ['i1->act', 'i2->act', 'i4->act', 'i3->act', 'i5->act'],
        },
        {
          caption:
            'Behind the incidents run the governance clocks, and they are arithmetic rather than intentions: an erasure deadline of eleven days against thirty, retention per dataset class enforced by a job with a log, lineage resolved as of a snapshot, and residency priced in engineer-months.',
          active: ['gov'],
          edges: ['act->gov'],
        },
        {
          caption:
            'Notice one number doing three jobs: the seven-day expiry window is the rollback horizon, seven of the eleven erasure days, and part of a 1.87× storage multiple — reconciling those three documents is half an hour of work and the best half hour in this track.',
          active: ['gov'],
        },
        {
          caption:
            'And then the handoff: everything you measured becomes one recommendation, defended in five rooms, ending not on a verdict about a platform but on the five counts a proof-of-concept would have to produce on your own data.',
          active: ['cap'],
          edges: ['gov->cap'],
        },
      ],
    },
    {
      type: 'prose',
      md: `## The handoff: your own numbers, five rooms, and an honest ending

The capstone is not an exam on this course. It is the document you would actually write, built from measurements you took yourself, and it has one shape:

**Your measurements, recomputed into one recommendation.** Compression from your own columns (C1), pruning from your own layout (C2), the footer and manifest arithmetic from your own files (C3), the update path from your own change rate (C5), shuffle and skew from your own joins (C6), the scan budget from your own query log (C0.L5). One recommendation — managed warehouse, engine on your own storage, or an appliance-class platform — with a three-year total in which **labour is a line and not a footnote**, and an exit cost that is computed rather than asserted.

**Then five rooms, and each one attacks a different thing you wrote.** The CFO wants cost per query, a growth term with a mechanism, and who pays for the background rewriting. The principal wants to know which query your layout is bad for. The consumer wants freshness, a contract, an SLO per class and alerting on shape. The steward wants the erasure deadline with the retention window inside it. And the vendor wants to know what would make you say no.

**And the ending, which is the only honest one available.** This course deep-dived a platform it cannot run. There is no cluster behind it, no measured VAST result in it, and every vendor figure you have read here was labelled as theirs, on their configuration, with a source. So the course does not end on a verdict. It ends on **falsifiability**: five counts a proof-of-concept has to produce, on your data, with a result stated in advance that would change your recommendation.

\`\`\`text
1  storage held ÷ live bytes across a fortnight of restatements, sampled daily
2  object or chunk count against commit rate — and whether anything enumerates it per query
3  the cost of updating a year-old row versus a row written this hour
4  read amplification under continuous restatement, in bytes and requests, start and end
5  what background work the platform does on your behalf — and which metric would move
   first if it fell behind
\`\`\`

Number five is the one this whole track earns. If the answer is "there is no background work", the follow-up is not scepticism, it is a question: *which metric would move if there were, and can I see it?* Because work inside a platform is capacity you buy and work in your runbook is engineers you staff, and those are both real costs with incomparable shapes.

The vendor room grades \`poc_undefined\` at severity 3, and it is the most important objection in the course for exactly this reason. **"Their documentation says compaction is not needed" is not an evaluation.** A list of counts and a stated exit criterion is.

That is the end of the taught material. What you should be able to do now is narrower and more useful than "understand columnar databases": you can take a workload, produce four numbers with the arithmetic visible, name the weakness of your own analysis before anyone finds it, and say precisely what measurement would change your mind. The rooms are where you find out whether that is true.`,
    },
    {
      type: 'isomorphism',
      title: 'this runbook ≡ three documents that already survive being read at 3am',
      pairs: [
        {
          os: 'an aviation checklist',
          osLine:
            'Terse, ordered, one action per line, and written for a competent person under load rather than for a beginner in a classroom. Its authority comes from having been revised after every incident, and its enemy is prose.',
          llm: 'indicator → diagnosis → intervention → cost',
          llmLine:
            'The same constraint produces the same form. The fourth column is this domain\'s addition, because unlike an aircraft procedure, most interventions here spend a resource — bytes, files, freshness or another team\'s time — and the reader must be authorised in advance to spend it.',
        },
        {
          os: 'a fire drill and an assembly point',
          osLine:
            'The plan on the wall is not the deliverable; walking it is, because that is when you find the locked door. Nobody accepts a plan that has never been executed as evidence of anything.',
          llm: 'the restore drill and its coverage fraction',
          llmLine:
            'Identical epistemics, plus one number: the drill is the only source of the entries-per-minute rate that two thirds of your RTO is derived from. Zero drills fails the check, and a drill at 12.5% coverage supports the procedure rather than the number.',
        },
        {
          os: 'a change-management record with a rollback plan',
          osLine:
            'Every change carries how it will be undone and what undoing costs, which is what makes shipping on a Friday a decision instead of a mood.',
          llm: 'interventions that spend a consumer\'s number',
          llmLine:
            'Raising the batch interval and re-clustering both change what somebody else was promised, so the runbook records the reversible half you may do immediately and the conversation that owes them the curve. A platform team that spends a consumer\'s SLA unilaterally at 3am is in a design review by Thursday.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'At 03:10 you are paged: compaction backlog slope has been positive for 24 hours, live file count is climbing, and planning share of query time has gone from 6% to 22% in two days. Ingest moved to a 60-second interval last week to meet a new freshness target. What do you do now, and what do you not do now?',
          options: [
            'Scale up the compaction cluster until the backlog clears, since merge throughput is the deficit and capacity is the direct fix',
            'Raise the batch interval to the largest value the recorded freshness SLA permits, note the breach explicitly, and book the interval-versus-file-count conversation with the consumer for the morning — because the interval is the input and the file count is the consequence, and permanently spending someone else\'s freshness at 3am is a decision you are not authorised to make alone',
            'Disable compaction until the morning so it stops competing with the query workload, then investigate with full information',
            'Partition the affected tables more finely so each query touches fewer files, reducing planning cost immediately',
          ],
          correct: [1],
          explanation:
            'This is INC-2 with the runbook\'s fourth column doing its job: the effective intervention costs freshness, freshness belongs to the consumer, and the 3am move is therefore the reversible half plus a booked conversation. Raising merge throughput is a legitimate lever and often the right permanent answer — the capacity lesson shows an 8% increase deleting an entire deficit term — but provisioning capacity in the middle of the night to absorb a rate imbalance you have not diagnosed spends money to postpone the diagnosis, and the creation rate may keep rising. Disabling compaction inverts the fix: the backlog is the problem, so pausing the only thing reducing it converts a slope into a cliff. Finer partitioning is the folklore answer and it is actively harmful here, because it reduces files per query only when the predicate matches the partition key and increases total file count unconditionally — which is the metric that is already failing.',
        },
        {
          q: 'The steward asks how a person\'s rows are erased, given they sit inside immutable files that older snapshots still reference. Which answer survives, and what is the number she is actually listening for?',
          options: [
            '"We issue a DELETE against the table and the platform handles the rest, including reclaiming the space."',
            '"A delete marks the rows logically, a targeted rewrite removes them from the files that held them, and snapshot expiry then drops the versions still referencing those files — so the deadline we commit to is 1 day to locate plus up to 3 for the rewrite plus the 7-day retention window: 11 days against a 30-day obligation."',
            '"Time travel means we retain full history, which is generally an advantage for auditability and for reconstructing what a record looked like at any point."',
            '"We encrypt per subject and destroy the key, which renders the rows unreadable without rewriting any files."',
          ],
          correct: [1],
          explanation:
            'The number she is listening for is the deadline with the retention window inside it, because that is precisely where commitments in this architecture break: the delete looks instantaneous and the bytes stay readable in earlier snapshots until expiry closes. Stating 1 + 3 + 7 shows you know which of your own unattended jobs is on the compliance critical path. The first answer is wounded rather than wrong — a delete in these formats typically writes a marker rather than removing data, and the follow-up question is whether you have tested that the rows are gone. The third is fatal and the rebuttal is the reason to memorise it: you have described a mechanism that keeps deleted personal data recoverable and presented it as a feature, which is the finding in the auditor\'s words. Crypto-shredding is a real technique and a real answer in some designs, but offered here it needs per-subject key management, a story for derived copies and aggregates, and evidence it was tested — asserted without those it is the encryption answer in a better costume, and encryption is the answer that loses the residency objection for the same reason.',
        },
        {
          q: 'A vendor\'s architecture would remove your compaction line item entirely: updates write small new chunks with metadata links and deletes are logical tombstones. How should that appear in the memo you defend in the vendor room?',
          options: [
            'As a resolved risk: if compaction is unnecessary, the compaction budget and its runbook entries can be removed from the design',
            'As a dated, sourced architectural claim about the unit of rewrite, together with the observation that logical tombstoning defers reclamation rather than removing it — plus the five counts a POC must produce on our data: storage held over live across a fortnight of restatements, object count against commit rate, the cost of updating a year-old row versus a fresh one, read amplification under continuous restatement, and which metric would move first if hidden background work fell behind',
            'As a comparison against our measured figures, showing our 3.4× write amplification would go to 1.0× on their platform',
            'As a reason to defer the compaction policy until after the platform decision, since designing a policy for an architecture we may not keep is wasted work',
          ],
          correct: [1],
          explanation:
            'The claim is credible at the mechanism level and unverified at the outcome level, and the memo has to hold both at once. Changing the unit of rewrite from a large file to a small chunk genuinely invalidates the arithmetic that produced your compaction bill, so it deserves serious treatment; logical tombstoning equally genuinely defers reclamation, so the deferred work must be measured rather than assumed absent. Option three is the specific failure the course exists to prevent — presenting a vendor\'s architectural claim as a measured result of yours — and it loses the vendor room on vendor_numbers_as_ours as well as being false. Removing the line item on the strength of documentation is worse than optimistic: it deletes the monitoring that would have told you the work moved inside the platform rather than vanished, which is a cost you buy as capacity instead of staffing as engineers. Deferring the policy leaves you with no baseline to evaluate against, which is how a POC ends in the vendor\'s benchmark instead of your counts.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the last page, and what to read after this course',
      md: `**On runbooks and the 3am reader**, the two references worth actually copying are **Atul Gawande's *The Checklist Manifesto*** for why terse beats complete, and **the SRE workbook's chapters on on-call and incident response** for the tiering and the human term in an RTO. The specific transfer to this domain is the fourth column: every intervention here spends a resource, so authorisation has to be pre-granted in writing or the on-call will freeze — which is a design decision about your team, not about your platform.

**On the governance half**, read your own jurisdiction's guidance on erasure with one question: does the deadline start at the request or at the technical completion? Then read **Iceberg's expiry semantics** (A2.L6's vendor block) and notice that your snapshot retention window sits on the critical path of a legal commitment made by someone who has probably never heard of it. That reconciliation — one number, three documents, three owners — is the highest-value half hour in this track and it requires no new technology.

**On the evaluation discipline**, the honest ending of this course has a literature: **Hubbard on measurement**, **the SRE material on error budgets** for the idea that a promise needs a stated allowance, and — most importantly — the practice of writing the exit criterion before the trial. The vendor's own closing line in the room is the argument for it: *"you have told me exactly what would make you say no, which means if you say yes I will believe it."*

**Where to go next, by what you want.** For the row store's side of every tradeoff in this course, **→ tablespace**. For the same architecture-defence discipline applied to vector search, **→ vectorspace**. For what "one place the decision happens" costs when that place must survive a partition, **→ byzantine**. And for the subject itself, the primary sources have been named throughout: the Parquet thrift definition, the Iceberg specification, Delta's PROTOCOL.md, the C-Store and MonetDB/X100 papers, the RUM conjecture, and Abadi, Boncz and Harizopoulos's *The Design and Implementation of Modern Column-Oriented Database Systems*, which remains the best single document in the field.

**And the sentence the whole course was built to make sayable.** Not "columnar storage is faster", which is a slogan, and not a benchmark you did not run. This one: *"Here are the four numbers, here is the arithmetic behind each, here is the one I trust least and why, and here is the measurement that would change my recommendation."* Say that in a room and you will not need a slide.

Go and defend it. The five rooms are waiting, they read only what you actually wrote down, and they are the same every time — which means when you survive one, you will know exactly which number bought it.`,
    },
  ],
}

export default lesson
