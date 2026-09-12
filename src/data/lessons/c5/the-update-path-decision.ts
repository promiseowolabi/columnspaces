import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c5.l5',
  slug: 'the-update-path-decision',
  trackId: 'c5',
  index: 5,
  title: 'The Update Path Decision',
  minutes: 20,
  hook: 'A compaction policy with no stated write-amplification number is an unbounded background bill with a cron entry. This is the page that fixes that: five numbers, one named loser, and the weakness of your own model said before the room finds it.',
  exercise: 'desk+quiz',
  artifact: 'platform-runbook',
  takeaway: {
    number: '+1.11× of a 1.60× budget',
    claim:
      'The shipped policy rewrites 1.11 bytes for every byte ingested against a stated budget of 1.60, and the headroom is deliberate: the model that produced 1.11 never rewrites a sealed file, so its write amplification is a floor and the policy must have slack on the number it underestimates.',
  },
  blocks: [
    {
      type: 'prose',
      md: `This is the lesson where C5 becomes a document somebody signs. It is one page, it has five numbers, and each one maps to a check the compaction desk grades: \`read_amp_bounded\`, \`write_amp_budget\`, \`expiry_stated\`, \`storage_stable\`, \`cost_counted\`.

Before the five numbers, the habit — because the habit is what makes the numbers survive a review. **State the weakness of your own analysis before anyone finds it**, and choose your policy so that the slack sits on the number your model is least sure about. That is not humility as a social gesture; it changes which policy you ship.

Here is the case, concretely. C5.L3's sweep left four of thirty policies satisfying read ≤ 1.02× and write ≤ 2.60×. Two of them are worth comparing:

| policy | read amp | write amp | files live | files/read | stranded rows | storage held |
|---|---|---|---|---|---|---|
| every **8** files → 256Ki-row files | **1.007×** | 2.56× | 24 | 18.4 | 349 | 402 MiB |
| every **16** files → 256Ki-row files | 1.015× | **2.11×** | 36 | 22.0 | **0** | **366 MiB** |

The first reads better. Ship the second, and the reason is the caveat: **the model's compactor never rewrites a sealed base file**, so every write-amplification figure it reports is a *floor* — a real platform must eventually purge tombstones out of sealed files, and that pass costs writes the model never charged. A policy sitting at 2.56× against a 2.60× budget has no room for the cost you know you have not counted. A policy at 2.11× has 0.49× of headroom, strands nothing, and holds 36 MiB less storage. The 0.008× of read amplification you gave up is the named loser, and you say so out loud.

That is the whole professional move, and it is available only because the weakness was named first. Now the five numbers.`,
    },
    {
      type: 'prose',
      md: `## The five line items, and the arithmetic each one needs

**1 · \`read_amp_bounded\` — the ceiling, with what it is a ratio of.** Bytes a reader touches divided by bytes the answer needs, measured over reads spread across the whole period rather than at one moment — the browser lab prices a read after *every* commit precisely because measuring the end state would grade where the last compaction happened to fall. Quote it with its two terms separated: data bytes and metadata bytes. At the shipped policy that is 1.015×, of which the metadata term is footers at 24 KiB per file opened across 22 files a read. **A ceiling with no measurement method is unfalsifiable**, which is the same failure C2.L6 named for pruning ratios.

**2 · \`write_amp_budget\` — the number that makes it a policy.** Bytes written to storage divided by bytes of logical change. At the shipped policy: 312.6 MiB ingested, 347.4 MiB rewritten by 17 compactions, so **2.11×** — every ingested byte is written 1.11 more times, forever, for as long as this table exists. Say it in that form, because "2.11×" sounds like a ratio and "we will write every byte 2.11 times" sounds like a bill, and the second one is what it is. The forge lab grades the same quantity as rows rewritten per row ingested against a band of 5.0, with the reference sentence you should be able to derive: **write amplification ≈ base rows ÷ delta rows at the trigger.**

**3 · \`expiry_stated\` — retention as a risk decision with a storage price.** Superseded files stay until something deletes them. At a 24-commit retention window the shipped policy holds 25.6 MiB of superseded bytes against 335.8 MiB live, so storage held is about **1.09× live**; C3.L4 measured over **1.8×** for a single retained snapshot on a coarse layout, so the multiple is a property of your file size and rewrite rate rather than a constant. Then the sentence that makes it a decision instead of a setting: *after the window closes, the recovery path is restore-from-backup rather than time travel.* Expiry is destructive by design, and the window is how long a recovery option exists.

**4 · \`storage_stable\` — the steady state, demonstrated rather than asserted.** Three components, and the policy is only stable if each is bounded: live bytes (grows with the business), tombstoned-but-present bytes (bounded by the compaction trigger — unless they strand, which is the 16Ki result from C5.L3), and retained superseded bytes (bounded by the expiry window). If any one of the three has no bound, storage grows without anything erroring. The check that catches an unstable policy early is not a storage graph; it is **stranded rows and compaction backlog slope**.

**5 · \`cost_counted\` — the line item, in counts.** Never a clock and never a price. What goes in the runbook:

\`\`\`text
bytes rewritten per day        and as a % of table size per day
files created/hour vs merged/hour   on one axis, with the crossing alarmed
requests per day added by compaction    (the object-store term C0.L3 priced)
files live, and mean files opened per read
storage multiple: held ÷ live
pricing SHAPE this lands on: consumption-bytes, instance, capacity, appliance
\`\`\`

C3.L5's worked example is the template: about **1.4 TB/day of rewrite on a 9 TB table, roughly 15% of the table per day, producing zero rows a user asked for.** If that number is above about 20% you are rewriting the table every five days to service an ingest configuration, and the ingest configuration is what to change (C5.L4).`,
    },
    {
      type: 'desk',
      desk: 'compaction-desk',
      brief:
        'Submit the policy: trigger threshold, target file size, expiry window, and a write-amplification budget. The desk grades five checks and this lesson taught the arithmetic for all of them. read_amp_bounded — a ceiling stated as a ratio with its measurement method and its two terms, data and metadata, separated. write_amp_budget — a number, expressed as bytes rewritten per byte ingested, with the derivation base ÷ delta-at-trigger shown; a policy with no budget fails, because it is an unbounded background bill. expiry_stated — the retention window as a risk decision, with the storage multiple it costs on this table\'s rewrite rate and the sentence about what recovery looks like after it closes. storage_stable — all three storage components bounded: live, tombstoned-but-present, and retained superseded, with stranded rows named if any are. cost_counted — bytes rewritten per day, that as a percentage of table size per day, creation rate against merge rate, requests added, and the pricing shape it lands on. Grading is in bands rather than against one right answer, and the band is generous to an honest model and unforgiving of a round number with no derivation behind it. Bring the caveat with you: if your write-amplification figure comes from a model that never rewrites sealed files, say so and leave headroom.',
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the three costs this policy does not count, named before somebody asks',
      md: `Every number on the page above comes from a model, and a model that hides its exclusions is a sales document. Three costs are missing, and all three run the same direction — upward.

**Purging tombstones out of sealed files.** The browser lab's compactor merges the pile and the open file and never touches a sealed one, so its write amplification is a **floor**. A real platform needs a second pass that rewrites sealed files to drop stranded tombstones; add it and writes rise while read amplification falls. Budget it separately, because its trigger is different — stranded row count, not file count.

**Metadata maintenance.** Every commit writes manifest or log entries, so a fast commit loop grows the metadata tree at the rate it grows the file list. Rewriting manifests is a distinct job from rewriting data (C3.L5), it has its own cadence, and its symptom is planning cost rather than storage.

**Requests, not just bytes.** On object storage, a compaction that reads 5,000 small files and writes 20 large ones is 5,020 requests plus the metadata operations around them. C0.L3's split says the request term can dominate the byte term at small object sizes, and it is invisible on a bytes-scanned dashboard.

Then the fourth thing, which is not a cost but a failure mode: **compaction can lose a race.** Iceberg's \`replace\` operation must validate at commit time that the files it is replacing are still in the table, so a compaction that overlaps a concurrent writer fails and retries. Under a heavy write rate that retry loop is real work producing no progress, and the metric that reveals it is compactions attempted against compactions committed. If your runbook has only the second number, a policy that is silently failing looks identical to a policy that has nothing to do.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'A platform that claims this line item away — and the five measurements that would test it',
      systems: ['vast-db', 'iceberg'],
      sources: [
        'https://www.vastdata.com/features/transactional-and-analytical-support',
        'https://www.vastdata.com/blog/the-data-lake-dilemma',
        'https://iceberg.apache.org/docs/latest/configuration/',
      ],
      md: `Everything above is a bill created by one physical assumption: **change is expressed by rewriting large immutable files.** So the most interesting vendor claim in this track is the one that attacks the assumption rather than the bill.

**What VAST states.** Under the heading *Self-Maintaining*, VAST's feature page describes *"Write-in-Free-Space Eliminates Compaction"*: updates *"create new 32KB columnar chunks with metadata links rather than rewriting entire files, while deletions use logical tombstoning"*, which it says *"eliminates the 'small files problem' that plagues object storage systems and removes the need for resource-intensive compaction or vacuuming operations that disrupt production workloads."* The same page describes no partitioning or sharding being required, because every compute node accesses the whole dataset directly. VAST's 2024 blog on small files makes the ingest-side version of the claim — row-by-row ingest transformed into columnar chunks, with *"eliminates unnecessary compute processes like compaction and vacuuming"* listed as a result.

**The mechanism, and the physics that would explain it.** Take the claim apart into two independent parts, because they have different consequences. First, the **unit of rewrite**: at 32 KB chunks with metadata links, "rewrite the file to change a row" is no longer the cheapest correct operation, and the 512 MB-file arithmetic that produced every number on this page — the 48-partition ceiling, the two-pass ladder, the 2.11× budget — does not carry over. Second, the **substrate**: shared-everything storage with metadata in the same namespace as data (C0.L3) means small-object metadata operations are not the same purchase they are on object storage. Both are architectural facts about a design rather than performance claims, which is why they are worth reasoning about even with no cluster to test.

**And here is the honest reading.** "No compaction" is a claim about *this* job disappearing, not about physics being repealed. Tombstoned rows still occupy space until something reclaims them; chunks still accumulate metadata; a restatement against cold data still has to go somewhere. Whether the work is *gone* or merely *moved inside the platform and off your runbook* is exactly the question a POC answers, and the difference matters commercially: work inside the platform is capacity you buy, work in your runbook is engineer-time you staff. Neither is free, and the shapes are not comparable without measurement. Nothing here is measured by this course, and no figure on that page is ours.

**Note the rot rule working in your favour**, too: VAST's own blog carries the line *"This blog post was written in 2024 and reflects product capabilities at that time. Some information may be outdated."* A vendor dating their own claim is doing what this course's \`snapshot\` field does. Treat an undated architectural claim with the suspicion it earns.

**The five measurements.** If this claim would change your design — and it would remove the entire page above — the proof-of-concept has to produce these counts, all on your data:

1. **Storage held ÷ live bytes over a fortnight of restatements**, sampled daily. If tombstoning is logical, this ratio is where the deferred work is visible.
2. **Chunk or object count growth against commit rate**, and whether anything enumerates it per query — the metadata-amplification question C2.L5 turned into 61% of query time.
3. **The cost of an update against a year-old row**, compared with one against a row written this hour. This is the stranded-tombstone case, and it is the single most diagnostic measurement in the list.
4. **Read amplification on a table under continuous restatement**, measured as bytes or requests rather than seconds, at the start and end of the window — the shape of the curve matters more than its level.
5. **What background work the platform is doing on your behalf, and how you would know it had fallen behind.** If the answer is "there is none", ask which metric would move first if there were, and whether you can see it.

Bring those five to the vendor room. \`poc_undefined\` is a severity-3 objection, and "their documentation says compaction is not needed" is not an evaluation.`,
    },
    {
      type: 'diagram',
      caption: 'fig 5 — five numbers, one named loser, and the caveat that changes which policy you ship',
      height: 76,
      nodes: [
        { id: 'trig', x: 2, y: 2, w: 30, h: 9, label: '1 · trigger', sub: 'every 16 uncompacted files', color: '#FB923C' },
        { id: 'tgt', x: 35, y: 2, w: 30, h: 9, label: '2 · target size', sub: '256Ki rows ≈ 16 MiB sealed', color: '#FB923C' },
        { id: 'exp', x: 68, y: 2, w: 30, h: 9, label: '3 · expiry window', sub: '24 commits · costs 1.09× storage', color: '#A78BFA' },
        { id: 'read', x: 2, y: 15, w: 46, h: 9, label: '4 · read ceiling 1.02× — holding at 1.015×', sub: 'data bytes and metadata bytes quoted separately', color: '#22D3EE' },
        { id: 'write', x: 52, y: 15, w: 46, h: 9, label: '5 · write budget 2.60× — spending 2.11×', sub: '312.6 MiB ingested, 347.4 MiB rewritten, 17 compactions', color: '#22D3EE' },
        { id: 'cost', x: 2, y: 28, w: 96, h: 10, label: 'the line item, in counts: bytes rewritten/day · % of table/day · created vs merged per hour · requests added · files live · held ÷ live', sub: 'C3.L5\'s template — about 1.4 TB/day on a 9 TB table, roughly 15% of the table daily, producing zero rows anybody asked for', color: '#A3E635' },
        { id: 'page', x: 20, y: 42, w: 60, h: 10, label: 'the page the compaction desk grades', sub: 'read_amp_bounded · write_amp_budget · expiry_stated · storage_stable · cost_counted', color: '#3EF2A4' },
        { id: 'cav', x: 20, y: 56, w: 60, h: 10, label: 'the caveat, said first', sub: 'this model never rewrites a sealed file, so 2.11× is a FLOOR', color: '#FB7185' },
        { id: 'mon', x: 2, y: 68, w: 96, h: 8, label: 'so the slack goes on the write axis, and the monitors are stranded rows, backlog slope, and compactions attempted vs committed', sub: 'the read-better policy at 2.56× against a 2.60× budget had no room for a cost we already knew we had not counted', color: '#FBBF24' },
      ],
      edges: [
        { from: 'trig', to: 'read' },
        { from: 'tgt', to: 'write' },
        { from: 'exp', to: 'cost' },
        { from: 'read', to: 'cost' },
        { from: 'write', to: 'cost' },
        { from: 'cost', to: 'page' },
        { from: 'page', to: 'cav' },
        { from: 'cav', to: 'mon' },
      ],
      steps: [
        {
          caption:
            'Two dials chosen from a priced grid rather than from taste: compact every sixteen uncompacted files, seal base files at 256Ki rows, which is one of only four policies in thirty that satisfies both constraints at this write rate.',
          active: ['trig', 'tgt'],
        },
        {
          caption:
            'A retention window is the third number and it is a risk decision rather than a storage setting: twenty-four commits of superseded files costs about 1.09× live storage here, and after the window recovery means restore-from-backup.',
          active: ['exp'],
        },
        {
          caption:
            'Then the pair that makes it a policy instead of a preference — a read ceiling with its measurement method, and a write budget expressed as bytes rewritten per byte ingested, both derived from the same run.',
          active: ['read', 'write'],
          edges: ['trig->read', 'tgt->write'],
        },
        {
          caption:
            'Costed as counts and never as a clock or a price: bytes rewritten per day, that as a share of the table, creation rate against merge rate, requests added, and the pricing shape all of it lands on.',
          active: ['cost'],
          edges: ['exp->cost', 'read->cost', 'write->cost'],
        },
        {
          caption:
            'Five numbers make the page the compaction desk grades, and it grades in bands — generous to a model with a derivation behind it, unforgiving of a round number that arrived by itself.',
          active: ['page'],
          edges: ['cost->page'],
        },
        {
          caption:
            'And then the sentence that earns the room: the model behind these figures never rewrites a sealed file, so its write amplification is a floor rather than a forecast, and a real tombstone-purging pass will raise it.',
          active: ['cav'],
          edges: ['page->cav'],
        },
        {
          caption:
            'Which is why the slack sits on the write axis and why the read-better policy was rejected: 2.56× against a 2.60× budget leaves no room for a cost you have already admitted you did not count.',
          active: ['mon'],
          edges: ['cav->mon'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '2.11×',
          label: 'write amplification shipped, against a 2.60× budget',
          hint: '312.6 MiB ingested and 347.4 MiB rewritten by 17 compactions, so every ingested byte is written 1.11 more times. The 0.49× of headroom is deliberate, because the model excludes rewriting sealed files.',
        },
        {
          value: '1.015×',
          label: 'read amplification, against a 1.02× ceiling',
          hint: 'Averaged over a read after every commit rather than measured at the end of the run, so the figure does not grade where the last compaction happened to fall.',
        },
        {
          value: '1.09×',
          label: 'storage held ÷ live at a 24-commit retention window',
          hint: '25.6 MiB of superseded bytes against 335.8 MiB live. C3.L4 measured over 1.8× for one retained snapshot on a coarse layout, so this multiple is a property of file size and rewrite rate rather than a constant.',
        },
        {
          value: '~15%/day',
          label: 'of the table rewritten in C3.L5\'s worked example',
          hint: 'About 1.4 TB/day on a 9 TB table, producing no rows a user asked for. Above roughly 20% you are rewriting the whole table every five days to service an ingest configuration.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'analogy',
      title: 'model the habit: the whole policy, said out loud, caveat first',
      md: `This is the C5 version of the paragraph C2.L6 taught, and it is what the compaction desk and the platform runbook are both asking for. Ninety seconds, every number redoable:

> "The weakness first: the write-amplification number I am about to give you comes from a model whose compactor never rewrites a sealed file, so it is a floor rather than a forecast — a real tombstone-purging pass will push it up, and that is why I am shipping a policy at 2.11× against a budget of 2.60× rather than the one at 2.56× that reads slightly better.
>
> The policy is: compact when sixteen uncompacted files are live, seal base files at 256Ki rows, retain superseded files for twenty-four commits. That holds read amplification at 1.015× against a ceiling of 1.02×, spends 2.11× on writes — every ingested byte written 1.11 more times, forever — and holds storage at 1.09× of live bytes. It is one of four policies out of the thirty we priced that satisfies both constraints at this write rate, and I should say that at the CDC write rate we tested, *none* of the thirty do, so if that stream lands on this table we are renegotiating one of the two numbers rather than tuning.
>
> What we give up: 0.008× of read amplification and fourteen extra files opened per read against the read-optimal policy in the region. What we buy: headroom on the axis my model underestimates, zero stranded tombstones, and 36 MiB less storage held.
>
> The bill is a standing line item, not a project: bytes rewritten per day, alarmed as a share of table size, plus files created against files merged per hour on one axis with the crossing as the alert rather than the backlog level. And expiry is a risk decision — after twenty-four commits the recovery path for an accidental delete is restore-from-backup, not time travel."

Count what that paragraph does. It hands over the hole before anyone digs for it, which stops the digging. It converts the hole into a *design choice* — the headroom — so the caveat produces a decision instead of an apology. It names the loser and the amount. It states the condition under which the whole policy is void, which is the sentence that gets you a second meeting instead of an incident. And every figure in it is either arithmetic the listener can redo or a measurement with a named source.`,
    },
    {
      type: 'isomorphism',
      title: 'a compaction policy ≡ documents you already defend',
      pairs: [
        {
          os: 'an error budget',
          osLine:
            'A stated allowance, a measurement everyone accepts, and an agreed consequence when it is spent. Without the allowance, every incident is a negotiation from zero.',
          llm: 'the write-amplification budget',
          llmLine:
            'Identical function: 2.11× spent against 2.60× allowed means an ingest change that pushes it to 2.8× is a visible, arguable event rather than a slow rise nobody attributed.',
        },
        {
          os: 'a backup retention policy',
          osLine:
            'Everyone understands that retention costs storage and that deleting a backup removes a recovery option. Nobody calls it a storage optimisation, and the window has an owner.',
          llm: 'the expiry window',
          llmLine:
            'The same document, with one extra sting: time travel lives in the same metadata tree it would have to recover from, so an RPO that leans on it has one failure domain where you believed you had two — which is what dr-desk grades.',
        },
        {
          os: 'a capacity plan with a named first bottleneck',
          osLine:
            'The credible part is not the forecast. It is knowing which limit binds first and roughly when, so that monitoring points at the right graph.',
          llm: 'stranded rows and backlog slope',
          llmLine:
            'The two leading indicators of this policy failing. Storage growth and read amplification are the lagging ones, and the invoice is worse than both — the same argument C2.L6 made for clustering depth.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Two policies both satisfy your constraints. Policy A: read 1.007×, write 2.56×, 349 stranded tombstoned rows, 402 MiB held. Policy B: read 1.015×, write 2.11×, 0 stranded, 366 MiB held. Your write budget is 2.60× and your read ceiling is 1.02×. Which ships, and on what argument?',
          options: [
            'A, because read amplification is what users experience and it is measurably better, while both policies satisfy the write budget',
            'B, because the model behind these figures never rewrites a sealed file to purge tombstones, so its write amplification is a floor and A has only 0.04× of headroom against a cost we know is uncounted. B keeps 0.49×, strands nothing and holds 36 MiB less — and the loser is stated: 0.008× of read amplification and fourteen more files opened per read',
            'A, and add a separate tombstone-purging job later if stranded rows become a problem, since 349 rows is negligible today',
            'Either — both are inside both constraints, so the choice is operational preference and not worth a paragraph in the document',
          ],
          correct: [1],
          explanation:
            'This is the lesson\'s central move: the caveat is not decoration, it decides the choice. A model that excludes rewriting sealed files reports write amplification as a floor, so a policy 0.04× under the budget is effectively already over it once the excluded pass is funded, while a policy 0.49× under has room. Preferring A on read amplification treats the two numbers as equally trustworthy when one of them is known to be an underestimate. Deferring a purge job is defensible only with a trigger and a budget attached — "later if it becomes a problem" is how stranded rows grow into the case C5.L3 measured, where no trigger setting can recover the read ceiling. And calling it preference skips the sentence that makes the document credible: every layout and every policy has a loser, and naming it is the deliverable.',
        },
        {
          q: 'A platform team reports: "compaction runs nightly and read amplification is fine." What is missing, and why does its absence show up as a cost surprise rather than an incident?',
          options: [
            'A latency SLO for the compaction job, since a nightly job that overruns its window will collide with the morning query peak',
            'A stated write-amplification budget and its cost as a count: bytes rewritten per day, that as a share of table size per day, requests added, and creation rate against merge rate. Without them the rewrite volume is whatever the current ingest configuration implies, so an unrelated change to the batch interval or partition scheme silently multiplies a background bill that no dashboard attributes to compaction',
            'A record of which engine version the compaction job runs, since defaults for target file size change between releases',
            'Nothing important — "read amplification is fine" is the outcome that matters, and the write side is background work that does not compete with user queries',
          ],
          correct: [1],
          explanation:
            'A policy with no budget is not a policy, it is a schedule, and its cost is a dependent variable: halve the batch interval and the rewrite volume rises without anything in the compaction configuration changing, which is precisely why the increase gets attributed to "the platform" rather than to the ingest ticket that caused it. Stating the budget in counts makes the collision visible in advance — C5.L4\'s compaction ladder alone consumes 3.0× write amplification at a 30-second interval, more than the 2.60× the update path was allocated. A latency SLO is worth having and measures a clock rather than a count, so it means different things on different hardware. Version drift is real and small next to an unbounded rewrite volume. And the last option is the belief this whole track exists to remove: background work is paid for in bytes, requests and capacity, and on a consumption bill it is indistinguishable from the queries it was supposed to make cheaper.',
        },
        {
          q: 'A vendor states that its architecture removes the need for compaction and vacuuming because updates write new small chunks with metadata links and deletes are logical tombstones. How should that appear in your platform memo?',
          options: [
            'As a resolved risk: if compaction is unnecessary, the compaction line item and its runbook entries can be removed from the design',
            'As a dated, sourced architectural claim about the unit of rewrite, together with the observation that logical tombstoning defers reclamation rather than removing it — so the memo states what a POC must measure: storage held over live across a fortnight of restatements, chunk count against commit rate, the cost of updating a year-old row versus a fresh one, read amplification under continuous restatement, and which metric would reveal background work falling behind',
            'As a comparison against our measured figures, showing that our 2.11× write amplification would go to 1.0× on their platform',
            'As a reason to defer the compaction policy until after the platform decision, since designing a policy for an architecture we may not keep is wasted work',
          ],
          correct: [1],
          explanation:
            'The claim is credible at the mechanism level and unverified at the outcome level, and the memo has to hold both facts at once. Changing the unit of rewrite from a large file to a small chunk genuinely invalidates the arithmetic that produced your compaction bill, which is why it deserves serious treatment rather than scepticism; logical tombstoning equally genuinely defers reclamation, which is why the deferred work has to be measured rather than assumed absent. Option three is the specific failure the VAST rule in this course exists to prevent: presenting a vendor\'s architectural claim as a measured result of yours. Removing the line item on the strength of documentation is worse — it deletes the monitoring that would have told you the work moved rather than vanished. And deferring the policy leaves you with no baseline to evaluate against, which is how a POC ends in a vendor\'s benchmark instead of your counts.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the track in one page, and where the bill goes next',
      md: `C5 in five sentences, because this is the point in the course where the write path becomes something you can defend rather than something that happens to you.

You cannot edit a compressed, statistics-annotated block, so the unit of change is the file and its cost is independent of how much you changed. Every system therefore accepts the change somewhere cheap and reconciles later, and the only interesting property of "somewhere cheap" is whether a query can see it. The reconciliation is a policy on two dials whose amplifications are opposed across the whole space — rank correlated −0.82 to −0.91, with four of thirty policies satisfying both constraints and none at all under a heavy restatement stream. The batch interval sets the file count, the freshness and the compaction rate simultaneously, and creation-versus-merge is a rate condition with no steady state when it fails. And what ships is five numbers with a named loser and a caveat stated first.

**Where to read further, by the specific thing you are trying to decide.** For the policy mathematics: **Luo and Carey's LSM survey (VLDBJ 2020)**, then **Dayan et al. on Monkey and Dostoevsky** for tiering-versus-levelling as a tunable rather than a doctrine. For the columnar delta mechanics: **Héman et al., Positional Update Handling in Column Stores (SIGMOD 2010)** and the Iceberg spec's three generations of delete files in order. For the cost frame: **the RUM conjecture (EDBT 2016)**. For write amplification as an operational discipline with mature vocabulary: the flash-endurance literature, which has measured media writes per host write for two decades and gave us the phrase "steady state" for exactly this situation.

For the maintenance-as-ownership argument, read **Iceberg's snapshot retention policy** and **Delta's VACUUM and metadata-cleanup procedures** side by side, and notice that both specifications are moving toward the *catalog* authorising maintenance rather than the client performing it. That is a strong signal about where this responsibility belongs in your own platform, and **A2** treats the catalog as exactly that control plane.

Two artifacts leave this track. The **platform runbook** now holds an ingest topology (C5.L4) and a compaction and expiry policy with a budget (this lesson) — and the rooms attack them as predicates over the numbers you wrote, so a missing write-amp figure loses \`the-cfo\` for a reason the course covered twice. The **vendor room** grades \`poc_undefined\`, which is why every vendor block in C5 ends in a list of counts rather than an opinion.

Next: **C6**. Everything in this track was measured on one machine, where the cost is bytes read and bytes written. Add a network and the dominant term becomes bytes *moved*, a join becomes the place they move, and a single skewed key becomes the runtime of the whole job no matter how many workers you buy.`,
    },
  ],
}

export default lesson
