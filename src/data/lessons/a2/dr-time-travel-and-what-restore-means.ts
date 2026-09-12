import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'a2.l6',
  slug: 'dr-time-travel-and-what-restore-means',
  trackId: 'a2',
  index: 6,
  title: 'DR, Time Travel, and What Restore Means',
  minutes: 20,
  hook: 'Time travel is the answer everybody gives and it is not a backup, because it lives in the same metadata tree it would have to recover from. An RPO resting on it has one failure domain where the plan claimed two — and a restore nobody has run is a document, not a plan.',
  exercise: 'desk+quiz',
  takeaway: {
    number: '1 domain, not 2',
    claim:
      'Time travel reads the same manifest tree an incident destroys, so an RPO leaning on it has 1 failure domain where you believed you had 2 — and the RTO it hides is a file count divided by a measured rate: 1.2M manifest entries at 20,000/min is 60 minutes before a single byte moves.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Ask a platform team for their recovery plan for a lakehouse table and you get one of two answers. The first is "the object store is eleven nines durable." The second is "we have time travel." Both are true statements and neither is a backup, and the reason is the same in both cases: **they protect against the failure you are not having.**

Object durability protects against media loss. It does not protect against a region, an account, an expiry job with the wrong retention, or an operator deleting the wrong prefix — and those are the events that produce a recovery conversation.

Time travel is more interesting, and it is the one worth arguing about carefully, because it is genuinely excellent at what it does. Rolling back a bad commit, comparing yesterday's numbers with today's, reproducing a query as of a snapshot: all real, all valuable, all things a backup cannot do as cheaply. And then the structural fact:

**Time travel is a read of the same manifest tree that the incident took out.**

Enumerate what actually destroys a metadata tree, and notice how many of the entries are your own jobs:

- a bad commit that lands (schema, partition spec, or a delete with a wrong predicate);
- a catalog migration that goes sideways, or two catalogs writing one table (A2.L1);
- **an expiry job with the wrong retention** — which is A2.L3's job 2, running unattended;
- **an orphan sweep whose path comparison broke** — job 3, whose documented failure mode is deleting live files;
- a deletion with the wrong prefix, by a human, at 3am.

Four of those five take the recovery path out *with* the table, because the recovery path is a query against the thing that just changed. So the sentence for the review, and it is the one the DR desk is built around: **an RPO that rests on time travel has one failure domain where you believed you had two.**

That is not an argument against time travel. It is an argument that it belongs in a different row of the document — under *rollback of a bad commit*, where it is the best tool available, and not under *recovery*, where it is a single point of failure wearing a second point of failure's clothes.`,
    },
    {
      type: 'prose',
      md: `## RPO and RTO for a table that is a manifest tree

Both objectives are durations, because that is what an RPO and an RTO are. Everything that *costs* is a count, and the RTO is a count divided by a rate **you measured** — an RTO asserted without a measured restore rate is a wish with a unit attached.

**The RPO is two terms, and the second is the one people drop.**

\`\`\`text
RPO = replication interval + the commit in flight
    = 15 min + 5 min                              =  20 min
    = 4 commits at a 5-minute interval
bytes at risk = 800 GB/day × 20 ÷ 1,440           =  11.1 GB
\`\`\`

You lose the replication window *and* the commit in flight: the last replicated snapshot is up to one interval old, and rows written since the last commit were never in a snapshot at all. Express it three ways — minutes, commits, bytes — because minutes are what the business agrees to, commits are what the table actually moves in, and bytes are what makes it arguable.

**The RTO is dominated by a term nobody has ever timed.** Two scenarios, same table, and the difference is the point:

\`\`\`text
metadata-only loss (the common one)
  coordination: detect, page, decide, cut over        30 min
  re-register 1,200,000 manifest entries
    at a measured 20,000 entries/min                  60 min
  data:                                                0 min
  RTO                                                 90 min   — metadata is 67%

full region loss
  coordination                                        30 min
  metadata                                            60 min
  re-materialise 160 TB at 200 GB/min                800 min
  RTO                                                890 min ≈ 14.8 h
\`\`\`

Read the first scenario again: **two thirds of the recovery is metadata, and its size is a file count, not a byte count.** Which connects this lesson to A2.L5 in a way that is easy to miss — the merge deficit that pushed you to 1.55M entries did not only move your catalog ceiling to month 20, it also added about **15 minutes to your RTO**, permanently, and nothing in a storage-oriented DR plan would ever show that.

**Then count your domains honestly, because this is where plans inflate.**

| you have | data domains | metadata domains |
|---|---|---|
| one region, time travel as the story | 1 | **1** |
| cross-region file copies, same catalog | 2 | **1** — the files are in two regions and the table is in one |
| cross-region copies with their own catalog | 2 | 2 |
| plus manifests exported outside the tree | 2 | **3** |

The middle row is the most common real configuration and it is the one that reads as protected. Lose the catalog and your second copy is *an unnamed pile of Parquet*: every byte present, nothing to say which files are in the table, which is precisely the "restore of files with no manifest tree" that the desk calls a bucket rather than a table.

**And the evidence.** Drills completed: a count, and zero is a real answer that fails the check outright. Two more conditions that are easy to fake and the desk grades explicitly: did any drill exercise **metadata loss** rather than only failing over to a healthy replica, and what **fraction of the real manifest entries** did it restore? A drill on a toy table measures the procedure and not the rate — and since the RTO is a count divided by a rate, that evidence supports the runbook and not the number.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '20 min',
          label: 'RPO = 15 min replication + the 5-minute commit in flight',
          hint: 'Four commits, about 11.1 GB at an 800 GB/day ingest rate. Quote all three units: minutes for the business, commits for the table, bytes to make it arguable.',
        },
        {
          value: '67%',
          label: 'of a 90-minute RTO that is metadata, not data',
          hint: '1.2M manifest entries at a measured 20,000/min is 60 minutes before any byte moves. The term is a file count, so the small-file problem is also a recovery-time problem.',
        },
        {
          value: '1',
          label: 'metadata domain in the most common "protected" configuration',
          hint: 'Cross-region file copies pointing at the same catalog: the files are in two regions and the table is in one. Lose the catalog and the copy is an unnamed pile of Parquet.',
        },
        {
          value: '0 drills',
          label: 'is the answer that fails the check on its own',
          hint: 'Every first restore discovers at least one credential, quota or ordering dependency that no design review finds. The count that makes this check pass is 1 — and it has to include metadata loss.',
        },
      ],
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'What the formats actually promise about history — and where they say it ends',
      systems: ['iceberg', 'delta'],
      sources: [
        'https://iceberg.apache.org/docs/latest/maintenance/',
        'https://iceberg.apache.org/spec/',
        'https://raw.githubusercontent.com/delta-io/delta/master/PROTOCOL.md',
      ],
      md: `**Iceberg.** Each write creates a snapshot; *"snapshots can be used for time-travel queries, or the table can be rolled back to any valid snapshot"*, and snapshots *"accumulate until they are expired by the \`expireSnapshots\` operation."* The maintenance docs are explicit about the boundary in both directions: *"expiring old snapshots removes them from metadata, so they are no longer available for time travel queries"*, and *"data files are not deleted until they are no longer referenced by a snapshot that may be used for time travel or rollback."*

Read that pair as one sentence about your recovery window: **the history you can travel to is exactly the retention window your own expiry job enforces, and the files behind it are deletable the moment it closes.** Set the window to seven days (A2.L3) and you have chosen a seven-day rollback horizon, whether or not anybody wrote that down as a decision.

**Delta.** The same model expressed as a log: commits are numbered files, readers reconstruct state by replaying actions, and \`VACUUM\` removes files no longer referenced by the retained history. Checkpoints exist so the replay does not require reading the whole log, which is why *listing the log directory* is on the critical path of both a normal read and a recovery.

**Two architectural facts to take away, neither of them version-specific.**

First: **rollback and recovery are different operations with different failure assumptions.** Rollback assumes the tree is intact and you want an earlier state of it. Recovery assumes the tree is not intact. Both specs support the first extremely well and neither claims to be the second, and no vendor documentation for either format offers itself as a backup product — that inference is added by readers, which is exactly the failure this lesson exists to name.

Second: **your snapshot retention window is simultaneously your rollback horizon, your erasure deadline component (A2.L7) and part of your storage multiple (A2.L3).** One number, three documents, usually three different owners, and typically nobody has reconciled them. Reconciling them is a half-hour of work and it is the most valuable half hour in this track.

Treat mechanisms as durable and property names as perishable; verify against your own version before either goes in a runbook.`,
    },
    {
      type: 'desk',
      desk: 'dr-desk',
      brief:
        'Submit the plan and defend all five checks with the arithmetic above. rpo — the window is the replication interval PLUS the commit in flight: 15 + 5 = 20 minutes, which is 4 commits and about 11.1 GB at 800 GB/day. Dropping the in-flight commit is the standard error and it makes your RPO look one interval better than it is. rto — a count divided by a rate you measured: 30 minutes of coordination plus 1.2M manifest entries at 20,000 per minute is 90 minutes for a metadata-only loss, of which metadata is 67%; add 160 TB at 200 GB/min and it is about 890 minutes for a region loss. If your entry-restore rate is a guess, say so, because the whole RTO is that rate. metadata_path — the reason this desk exists: state how the manifest TREE is rebuilt, not how the files come back. A plan resting on time travel fails here even with cross-region copies, because time travel is a read of the tree the incident destroyed; export manifests to a store that cannot be taken with the tree, or give the replica its own catalog. cross_region — a copy is only a copy if it is in another failure domain, and copies pointing at the same catalog give the DATA two domains and the TABLE one. tested — drills completed is a count and zero fails outright; a drill that only fails over to a healthy replica tests the network rather than the 67% of the RTO you have never run, and a drill covering under 10% of the real manifest entries supports the runbook rather than the number. Objectives are graded in bands, generously, because they are quoted in whole minutes — but three of the five checks fail on OMISSION no matter how good the two durations are.',
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'a restore that has never been tested is a document, and here is what the first one always finds',
      md: `The desk fails a plan with zero drills outright, and the justification is empirical rather than moralistic: **every first restore discovers at least one dependency that no design review finds.** The recurring five, so you can look for them before they look for you:

**A credential nobody rotated.** The restore path uses an identity that is used for nothing else, so its expiry is invisible until the one moment it matters.

**A quota in the destination.** Re-registering 1.2M manifest entries is 1.2M catalog writes, which is a request rate your catalog has never seen from one client — the throttle turns a 60-minute term into an afternoon (A2.L1's failure mode 3, arriving during the incident rather than during the 09:00 refresh).

**An ordering dependency.** The catalog must be restored to the same point in time as the data. Restore metadata at 03:00 and files at 04:00 and you get a table whose manifests reference files that do not exist and files that nothing references — intact bytes, self-consistent metadata, unqueryable table. This is the failure that convinces people DR is hard, and it is purely a sequencing bug.

**A rate nobody had measured.** "20,000 entries a minute" is either a measurement or the entire RTO is fiction. The first drill's real deliverable is that number, which is why a drill on a toy table is worth less than it looks: it validates the procedure and tells you nothing about the rate.

**A decision nobody owns.** Coordination is 30 minutes in the model and it is the term most often understated, because it contains *deciding to fail over* — which at 3am, with partial information, is a judgement about whether the primary is coming back. Write the decision criteria and the name of the person who owns the call into the runbook, because that is the part of the RTO that does not respond to engineering.

Then the caveat to volunteer: **our RTO is a model whose largest term is a rate measured once, on one drill, at 12.5% coverage.** State it that way and the room helps you fund the bigger drill. Assert 90 minutes flat and you own it.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — one failure domain wearing two, and the count that sets the RTO',
      height: 76,
      nodes: [
        { id: 'inc', x: 2, y: 2, w: 96, h: 9, label: 'what actually destroys a metadata tree', sub: 'bad commit · catalog migration · two catalogs · expiry with the wrong retention · orphan sweep with a broken path match · wrong prefix at 3am', color: '#FB7185' },
        { id: 'tt', x: 2, y: 15, w: 46, h: 9, label: 'time travel', sub: 'a READ of that same tree — excellent for rollback', color: '#FBBF24' },
        { id: 'dur', x: 52, y: 15, w: 46, h: 9, label: 'object durability', sub: 'protects media, not regions, accounts or operators', color: '#94A3B8' },
        { id: 'dom', x: 2, y: 28, w: 96, h: 9, label: 'so count domains: files in 2 regions + one catalog = DATA 2, METADATA 1', sub: 'lose the catalog and the second copy is an unnamed pile of Parquet — a bucket, not a table', color: '#A78BFA' },
        { id: 'rpo', x: 2, y: 41, w: 46, h: 9, label: 'RPO = 15 + 5 = 20 min', sub: '4 commits · 11.1 GB at 800 GB/day', color: '#22D3EE' },
        { id: 'rto', x: 52, y: 41, w: 46, h: 9, label: 'RTO = 30 + 60 + 0 = 90 min', sub: '1.2M entries ÷ 20,000/min — metadata is 67%', color: '#22D3EE' },
        { id: 'fix', x: 2, y: 54, w: 96, h: 9, label: 'the second domain, built deliberately: manifests exported outside the tree, and a replica with its OWN catalog', sub: 'metadata domains 1 → 3, and the recovery path stops being a query against the thing that broke', color: '#3EF2A4' },
        { id: 'drill', x: 2, y: 67, w: 96, h: 9, label: 'then the evidence: 2 drills including METADATA loss, 150,000 of 1.2M entries restored — 12.5% coverage', sub: 'and the caveat said first: the largest term in our RTO is a rate measured once, at one eighth of production scale', color: '#F97316' },
      ],
      edges: [
        { from: 'inc', to: 'tt' },
        { from: 'inc', to: 'dur' },
        { from: 'tt', to: 'dom' },
        { from: 'dur', to: 'dom' },
        { from: 'dom', to: 'rpo' },
        { from: 'dom', to: 'rto' },
        { from: 'rpo', to: 'fix' },
        { from: 'rto', to: 'fix' },
        { from: 'fix', to: 'drill' },
      ],
      steps: [
        {
          caption:
            'Start from the failure list rather than from the feature list, and notice that four of the six entries are operations your own platform performs unattended every day — including two of the four maintenance jobs from the previous lesson.',
          active: ['inc'],
        },
        {
          caption:
            'Now place the two answers people offer against that list. Time travel is a read of the tree the incident destroyed, and object durability protects media rather than regions, accounts or operators. Both are real; neither covers this list.',
          active: ['tt', 'dur'],
          edges: ['inc->tt', 'inc->dur'],
        },
        {
          caption:
            'Which turns the plan into a counting exercise: cross-region file copies behind a single catalog give the data two independent domains and the table exactly one, which is the configuration that reads as protected and is not.',
          active: ['dom'],
          edges: ['tt->dom', 'dur->dom'],
        },
        {
          caption:
            'The RPO is the replication window plus the commit in flight, quoted three ways — minutes for the business, commits because that is the unit the table moves in, and bytes because that is what makes it arguable.',
          active: ['rpo'],
          edges: ['dom->rpo'],
        },
        {
          caption:
            'The RTO is a count divided by a measured rate, and for a metadata-only loss two thirds of it is re-registering manifest entries before a single byte moves — so the file count from the capacity plan is also a recovery-time input.',
          active: ['rto'],
          edges: ['dom->rto'],
        },
        {
          caption:
            'The fix is to build the second domain on purpose: export manifests to a store that cannot be taken along with the tree, and give the replica its own catalog, which takes metadata domains from one to three.',
          active: ['fix'],
          edges: ['rpo->fix', 'rto->fix'],
        },
        {
          caption:
            'And then the evidence, because two durations with no drill behind them are a document: drills that exercised metadata loss specifically, the fraction of real entries restored, and the honest note that the dominant term is a rate measured once.',
          active: ['drill'],
          edges: ['fix->drill'],
        },
      ],
    },
    {
      type: 'isomorphism',
      title: 'time travel ≡ three things everybody already knows are not backups',
      pairs: [
        {
          os: 'RAID',
          osLine:
            'Survives a disk. Does not survive an accidental delete, a filesystem bug or a fire, because the redundancy is inside the same failure domain as the mistake. Nobody has argued otherwise since about 1995.',
          llm: 'snapshot history in the live metadata tree',
          llmLine:
            'The identical relationship one layer up: it survives a bad commit and does not survive the expiry job, the catalog migration or the wrong prefix. The reason the argument still happens here is that the feature is newer, not that the logic is different.',
        },
        {
          os: 'an array-level snapshot on the same array',
          osLine:
            'Instant, cheap, wonderful for rollback, and the first thing a storage vendor will tell you is that it is not a backup because it shares the controller, the pool and the blast radius.',
          llm: 'time travel as the RPO story',
          llmLine:
            'Same sentence, same reason, and the same fix: the copy has to leave the domain. Export the manifests outside the tree, give the replica its own catalog, and the count of metadata domains goes from one to three.',
        },
        {
          os: 'a fire drill',
          osLine:
            'The plan on the wall is not the deliverable. The deliverable is that people have walked it once, which is when you discover the door that is locked and the assembly point in a car park that is now a building site.',
          llm: 'a restore drill covering metadata loss',
          llmLine:
            'Exactly the same epistemics, plus a number: the drill is the only source for the entries-per-minute rate that two thirds of your RTO is computed from. A plan never walked is a document, and the desk grades it as one.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A DR plan states: "RPO 5 minutes, since the table commits every 5 minutes and we retain 7 days of snapshots for time travel. RTO 30 minutes to fail over to the replicated bucket in our second region." Both numbers are arithmetically plausible. What is the risk you must state, and what does the plan actually have?',
          options: [
            'The RPO is optimistic by one replication interval, and once corrected to 20 minutes the plan is sound',
            'The RPO rests on time travel, which is a read of the same manifest tree an incident destroys — and four of the likely destroyers are the platform\'s own jobs — so the plan has one metadata domain where it claims two; the RTO also omits re-registering 1.2M manifest entries, which at 20,000/min is 60 minutes on its own and two thirds of a metadata-only recovery',
            'The 7-day snapshot window is too short for a defensible RPO and should be extended to 30 days to widen the recovery horizon',
            'The plan is adequate for data loss but should add cross-region replication for the compute layer so queries can run during a regional outage',
          ],
          correct: [1],
          explanation:
            'Two independent failures are stacked here and both are structural rather than arithmetic. The RPO is not merely optimistic, it is inapplicable to the failure that matters: a bad commit, a catalog migration, an expiry job with the wrong retention or an orphan sweep with a broken path comparison takes the recovery path out along with the table, so the second domain the plan believes it has does not exist. The RTO omits the largest term for a metadata-only loss, and that term is a file count divided by a measured rate rather than anything to do with bytes. Correcting the RPO to 20 minutes is necessary and insufficient — it fixes the number and leaves the domain count at one. Extending retention buys a longer rollback horizon inside the same domain, which is more of the thing that does not help, and it raises the storage multiple and your erasure deadline as side effects. Compute replication addresses availability during an outage, not recovery from a destroyed tree.',
        },
        {
          q: 'Your capacity work (A2.L5) shows manifest entries growing to 1.55M at the horizon, 280,500 of which come from a creation-versus-merge deficit. What does that fact do to your DR plan, and why would a storage-oriented plan never show it?',
          options: [
            'Nothing: entry count affects query planning and catalog capacity, not recovery, which is bounded by how fast bytes can be copied',
            'It lengthens the RTO, because the metadata term is entries divided by a measured restore rate — 1.55M at 20,000/min is about 78 minutes against 60 for 1.2M — so the merge deficit buys you roughly 15 extra minutes of recovery time permanently, and a byte-oriented plan cannot see it because the data volume did not change',
            'It shortens the RTO, since more files can be restored in parallel across more workers',
            'It affects only the RPO, because more files per commit means more data at risk in the replication window',
          ],
          correct: [1],
          explanation:
            'The metadata term of a recovery is a count of things to re-register, so anything that inflates file count inflates recovery time — and the merge deficit inflates file count with no change in bytes held, which is exactly why a plan written in terabytes is blind to it. This is the same structural point the capacity desk makes about the catalog binding before the disk, arriving in a second document: one operational decision about commit interval and compaction throughput moves a capacity date, a planning cost, a chargeback line and an RTO simultaneously. Parallelism can raise the rate, which is a good reason to measure the rate under the parallelism you would actually have in an incident, but it does not make more entries cheaper than fewer. And the RPO is set by the replication interval plus the commit in flight, which the file count does not enter.',
        },
        {
          q: 'Your team replicates all data files to a second region on a 15-minute schedule, and both regions\' tables are registered in the same central catalog. An auditor asks how many independent failure domains the platform has. What is the honest answer?',
          options: [
            'Two, since the data exists independently in two regions and the catalog is a small, highly available managed service',
            'Data two, metadata one — the files are in two regions and the table is in one, so losing the catalog leaves a complete second copy that nothing can name; the fix is a replica with its own catalog, or exporting manifests to a store that cannot be taken with the tree, either of which takes metadata to two',
            'Two, because the catalog can be rebuilt from the data files by scanning storage and re-inferring the table',
            'One, because a 15-minute replication schedule means the second region is never consistent enough to serve as a domain',
          ],
          correct: [1],
          explanation:
            'Domains must be counted per layer, and the layer people forget is the one that decides what a table is. Bytes in two regions plus one catalog is a configuration that reads as protected and fails to the same single event, which is why the desk grades cross-region copies without an independent catalog as a fail: the copy buys durability without buying recoverability. The third option is the tempting engineering answer and it is a much bigger claim than it sounds — inferring a table from a prefix is the Hive-era membership model the formats abandoned, it cannot distinguish live files from orphans or from files a snapshot expired, and it silently resurrects deleted rows, which is a compliance event as well as a correctness one. Replication lag is a real RPO term and does not reduce the domain count; a 15-minute-old independent copy is still an independent copy.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the backup literature is old, correct, and mostly unread by data teams',
      md: `The strongest reading here is not new. **The 3-2-1 rule** and the distinction between *redundancy* and *backup* were settled in storage administration decades ago, and every argument in this lesson is that argument applied to a manifest tree. **Titman's and the wider systems-administration corpus on restore testing** is worth reading precisely because it is unglamorous: the recurring finding across decades is that backup success rates are high and *restore* success rates are much lower, for exactly the five reasons in the callout above.

For the failure-domain reasoning, **"Failure Trends in a Large Disk Drive Population" (Pinheiro et al., FAST 2007)** and the follow-up literature on correlated failures make the quantitative case that independence is a property you have to construct rather than assume — which is the same claim as "a copy behind the same catalog is not a domain". Pair it with the postmortem literature on **control-plane outages**: the recurring shape is that the data plane survived and the thing that told you what the data plane contained did not.

On the specific mechanics, read **Iceberg's maintenance page on \`expireSnapshots\`** and **Delta's \`VACUUM\` semantics** with one question in mind: what is the *earliest* state I can return to, and which unattended job decides that? The answer is your retention window, and it is simultaneously your rollback horizon, part of your storage multiple (A2.L3) and a term in your erasure deadline (A2.L7). One number, three documents.

For the human term in the RTO, **the SRE literature on incident command** is the right reference for the thirty minutes labelled *coordination*. It is the term least responsive to engineering, the term most often understated, and the only one where the mitigation is a named person and a written decision criterion rather than a faster copy path.

And the honest note this course keeps making: **none of the rates in this lesson are ours.** Twenty thousand entries a minute and 200 GB a minute are placeholders for measurements you must take on your own system, in a drill, at a coverage fraction you state. That is what makes the number defensible, and it is what a proof-of-concept has to produce for any platform you are evaluating.

Next: **A2.L7**, the last lesson in the course. Everything you have measured becomes one page you would actually want at 3am, and then the handoff to the capstone — where all of it is defended in five rooms.`,
    },
  ],
}

export default lesson
