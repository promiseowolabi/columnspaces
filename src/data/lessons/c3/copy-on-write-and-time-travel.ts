import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c3.l4',
  slug: 'copy-on-write-and-time-travel',
  trackId: 'c3',
  index: 4,
  title: 'Copy-on-Write and Time Travel',
  minutes: 21,
  hook: 'Three rows change. Forty-nine thousand one hundred and fifty-two rows get rewritten, read first and then written back, and the originals stay on disk until something deletes them. Every number in that sentence is measured in the tab.',
  exercise: 'lab+quiz',
  artifact: 'layout-design',
  takeaway: {
    number: '16,384×',
    claim:
      'A three-row update against 16k-row files rewrites 49,152 rows for a byte amplification of about 16,384× — and the only real lever on that is file size, which buys the reduction back in file count, footer bytes and metadata entries.',
  },
  blocks: [
    {
      type: 'prose',
      md: `A Parquet file cannot be edited in place. Not "should not" — cannot. The values are encoded and compressed inside pages, the pages are sized in the chunk metadata, the chunk offsets are recorded in a footer at the end, and every one of those numbers moves if a single value changes length. So the unit of change is not the row, and it is not the page. **The unit of change is the file.**

That single physical fact produces the entire copy-on-write model, and the model is worth stating as an algorithm because the snapshot lab performs exactly these five steps over real Parquet files:

1. lay the table out as N data files, each holding a contiguous key range — the layout a partitioned, clustered table produces;
2. find which files hold the affected rows, **using those files' own footer statistics**;
3. **rewrite every affected file in full**, reading every row of it first, because there is no way to change three rows inside one;
4. leave the originals on disk. The old file list is still a valid, complete, readable table — that is what time travel *is*;
5. expire: delete the files the new snapshot no longer references, watch the storage come back, and watch the old snapshot stop being readable.

Nothing in that list is clever. The arithmetic in step 3 is what makes it a design constraint rather than an implementation detail.`,
    },
    {
      type: 'prose',
      md: `## The amplification, measured

The snapshot lab lays out **262,144 rows** across four layouts — 1, 4, 16 and 64 files, spanning a factor of 64 in file size — and runs the *same* three-row update against each. The three target rows sit at 10%, 50% and 90% of the key space on purpose: three rows landing in one file is the lucky case, and a lab that only measured the lucky case would understate the problem.

At the reference layout — **16 files of 16,384 rows** — the measured result is:

\`\`\`text
rows changed         3
files affected       3            (located from footer statistics: 0 missed, 0 false positives)
rows rewritten       3 x 16,384 = 49,152
row amplification    49,152 / 3  = 16,384x
byte amplification   bytes written / (3 x bytes-per-row) ≈ 16,384x
bytes read           every byte of all three affected files, in full
\`\`\`

**16,384×.** And the read side is the half people forget when they price an update: a copy-on-write engine does not have the original rows in memory. It must read every row of every affected file before it can write them back — the lab's rewrite reads from the *old Parquet file*, not from the source table, precisely so that this cost is real rather than asserted. Bytes read and bytes written come out within 10% of each other, because the rewrite is a copy with three cells altered.

Two things stay exactly right while all that happens, and the lab asserts them as correctness rather than cost:

- **exactly 3 rows differ** between the two snapshots, in every layout. Amplification is a bill, not a bug.
- **0 files holding a target row were missed** by the footer statistics. A file excluded by its own statistics that actually held a target row would be a false negative — the one thing C2 says a layout may never do.

Now the storage. After the commit, both file sets are on disk: the thirteen untouched originals, the three replacements, **and the three superseded originals**. On the one-file layout, retaining one previous snapshot **more than doubles the table's storage** (measured storage overhead above 1.8×). That is not a leak. That is what time travel is made of, and it is the honest way to describe the feature: *you are paying for a second copy of everything a retained snapshot still needs.*`,
    },
    {
      type: 'prose',
      md: `## The counter-argument, also measured: shrink the files

If the amplification comes from file size, shrink the files. The lab measures that direction too, because a lab that only showed amplification falling would be an argument for one-row files.

| layout | rows/file | files affected by 3 rows | rows rewritten | direction of travel |
|---|---|---|---|---|
| 1 file | 262,144 | 1 | 262,144 | the whole table, to change three rows |
| 4 files | 65,536 | 3 | 196,608 | three quarters of the table |
| **16 files** | **16,384** | **3** | **49,152** | the reference: 16,384× |
| 64 files | 4,096 | 3 | 12,288 | amplification down by 4× again |

Amplification falls **monotonically** as file size falls — the lab asserts monotonicity across all four layouts rather than just comparing the ends — and the retained-snapshot storage overhead falls with it, from over 1.8× on the one-file layout to under 1.2× on the finest. So far this is an argument for small files.

And here is the bill, measured in the same run:

- **live file count rises** by more than 10× from coarsest to finest;
- **footers to read on every plan rises with it** — the lab reports the number of footers it had to read to locate three rows, which is one per file, and that count *is* the argument for manifests;
- **footer bytes across the live file set rise**, because per-file overhead is paid per file;
- **total bytes on disk for the same rows rise**, though only slightly at this scale (under 1.2× from coarsest to finest).

Read those two lists together and the shape is C2's dial again, pointed at writes instead of reads. **The byte penalty for small files is small; the count penalty is not.** Files are the unit of metadata, metadata is enumerated per query, and C2.L5 watched that turn into 61% of query time. So the answer to "how big should files be" is not "small" — it is a crossover between update cost and planning cost, and both sides of it are numbers you can now measure rather than argue about.

Which is also why the honest sentence about copy-on-write is not "it is expensive". It is: **copy-on-write is the right default when your updates are rare or arrive in batches large enough to fill files, and the wrong default when they are frequent and scattered.** Frequent and scattered is what merge-on-read exists for, and C5 builds one.`,
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'what this lab is, and what a real table format adds — stated in full, not in a footnote',
      md: `**Neither Iceberg nor Delta runs in duckdb-wasm.** So the snapshot lab does not claim to be either. It performs the copy-on-write **algorithm** by hand over real Parquet files that DuckDB writes and reads in your tab. Every byte count is \`file_size_bytes\` from a real footer; the update is verified by reading both snapshots back; expiry is *performed*, so "the storage comes back and time travel stops working" is an observation rather than a claim.

What a real format adds, named so the gap is not hidden:

- **Manifests.** Step 2 here reads every file's footer to find three rows. Iceberg reads a manifest list and then manifests, so file selection costs a couple of reads instead of N. The lab reports the footer-read count exactly so that cost is visible — it is the reason manifests exist (C3.L3).
- **An atomic commit.** Here the "snapshot" is a list held in a variable. A real format swaps a single pointer, so a reader never sees a half-committed file set. **Nothing in this lab provides that.**
- **Snapshot isolation and conflict detection.** Two writers touching the same file here would silently clobber each other. A real format detects the conflict at commit time and fails the loser.
- **Schema and partition evolution**, field ids, and hidden partitioning — none of which exists here.
- **Merge-on-read as the whole other branch:** position deletes, equality deletes, or deletion vectors, which move the cost from the write to every subsequent read. This lab measures only the copy-on-write side, so it does not get to claim anything about the tradeoff between the two beyond naming it.
- **Expiry and orphan cleanup as maintenance jobs with retention policies.** Expiry happens here, but by this module — not by a catalog that knows which snapshots a reader might still be holding.

What transfers completely: the amplification arithmetic, the read side of the rewrite, the fact that superseded files occupy storage until something deletes them, and the direction of the file-size tradeoff. Those are properties of immutable files, not of any particular format.`,
    },
    {
      type: 'ducklab',
      lab: 'snapshot-lab',
    },
    {
      type: 'prose',
      md: `## What time travel keeps alive, and what expiry reclaims

Time travel sounds like a feature and behaves like a retention policy. Three precise statements, in the order they matter operationally.

**A snapshot is a file list, so reading an old snapshot requires nothing special.** The lab demonstrates this directly: after the update, querying the *old* file set returns the three pre-update values, with no engine feature involved — the old list is still a complete, readable table. That is the whole trick, and it is why time travel costs nothing at read time.

**The cost is storage, and it is exactly the superseded set.** A file stays on disk while any retained snapshot still references it. The measured overhead is the ratio of everything-on-disk to what a fresh reader sees: over **1.8×** for one retained snapshot on the one-file layout, under **1.2×** on the 64-file layout. Retain thirty days of snapshots on a table with a daily full rewrite and the arithmetic is not subtle.

**Expiry reclaims exactly those bytes, and it is destructive.** The lab performs the deletion and then re-reads the sizes: on-disk falls to exactly the live snapshot's size, and the old snapshot becomes unreadable. If it were *still* readable after its files were deleted, the lab flags that as an anomaly, because it would mean expiry freed nothing. So expiry is not tidying — it is the moment a recovery option stops existing, which makes the retention window a **risk decision** and not a storage-optimisation setting.

State it in a review as one sentence with both numbers: *"we retain seven days of snapshots, which on this table's rewrite rate costs about X× the live size, and after expiry the recovery path for an accidental delete is restore-from-backup rather than time travel."*`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'Retention as configuration: Iceberg\'s expiry policy and Delta\'s tombstones',
      systems: ['iceberg', 'delta'],
      sources: [
        'https://iceberg.apache.org/spec/',
        'https://raw.githubusercontent.com/delta-io/delta/master/PROTOCOL.md',
      ],
      md: `**Iceberg** makes the retention rules a documented algorithm rather than a single number. The snapshot retention policy is configured by \`min-snapshots-to-keep\`, \`max-snapshot-age-ms\` and \`max-ref-age-ms\`, globally and per snapshot reference (branch or tag), and the evaluation is specified step by step: start with an empty retain set; drop refs other than \`main\` that are older than \`max-ref-age-ms\`; add every branch and tag's referenced snapshot; walk each branch's ancestors, retaining until a snapshot is both older than \`max-snapshot-age-ms\` **and** not among the first \`min-snapshots-to-keep\`; expire everything else. Two consequences engineers get wrong: **the \`main\` branch reference never expires**, and a single long-lived tag pins every file its snapshot needs, indefinitely.

The spec is also explicit about deletion safety: *"A data file must not be deleted from the file system until the last snapshot in which it was listed is garbage collected."* And it notes why removal is tracked per-snapshot rather than computed: finding the true last reference requires diffing multiple snapshots, so implementations record what a snapshot deleted and delete those files when that snapshot expires.

For time travel by timestamp, Iceberg tells implementations to resolve against the \`snapshot-log\` rather than the snapshot parent lineage, because the two can disagree — \`current-snapshot-id\` can be set to an arbitrary snapshot, so ancestry is not a reliable clock.

**Delta** expresses the same idea as MVCC plus tombstones. A commit records \`remove\` actions for files that leave the table; a \`remove\` stays in the table state as a **tombstone** until it expires, and only then may the physical file be deleted. The protocol states the reason for the delay directly: it *"allows concurrent readers to continue to execute against a stale snapshot of the data."* Physical deletion is the \`vacuum\` command's job, after a user-specified retention period, documented with a **default of 7 days**. Delta also gates this: under \`catalogManaged\`, data-file cleanup such as VACUUM and metadata cleanup are **prohibited unless the catalog explicitly permits the client to run them**, which is the strongest available statement that maintenance is an owned operation rather than background housekeeping.

Verify the constants against your own version; the *shape* — retention is a policy, expiry is destructive, and a retained reference pins files — is durable.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — three rows in, 49,152 rows out, and two copies on disk until something deletes one',
      height: 70,
      nodes: [
        { id: 'upd', x: 2, y: 2, w: 30, h: 9, label: 'update 3 rows', sub: 'at 10%, 50% and 90% of the key space', color: '#FB923C' },
        { id: 'locate', x: 35, y: 2, w: 30, h: 9, label: 'read 16 footers to find them', sub: 'the exact cost a manifest removes', color: '#22D3EE' },
        { id: 'three', x: 68, y: 2, w: 30, h: 9, label: '3 files selected', sub: '0 missed · 0 false positives', color: '#22D3EE' },
        { id: 'rewrite', x: 2, y: 15, w: 96, h: 10, label: 'rewrite all three IN FULL: 3 × 16,384 = 49,152 rows, read first and written back', sub: 'row amplification 16,384× · byte amplification ≈ 16,384× · bytes read ≈ bytes written', color: '#FB7185' },
        { id: 's1', x: 2, y: 30, w: 46, h: 10, label: 'snapshot 1 remains a complete table', sub: 'querying the old file list returns the 3 old values', color: '#5CA8FF' },
        { id: 's2', x: 52, y: 30, w: 46, h: 10, label: 'snapshot 2 = 13 originals + 3 rewrites', sub: 'same row count · exactly 3 rows differ', color: '#5CA8FF' },
        { id: 'disk', x: 2, y: 44, w: 46, h: 10, label: 'both sets on disk until expiry', sub: 'one retained snapshot: over 1.8× storage on the 1-file layout', color: '#FBBF24' },
        { id: 'exp', x: 52, y: 44, w: 46, h: 10, label: 'expiry reclaims exactly the superseded bytes', sub: 'and snapshot 1 stops being readable — that is the risk decision', color: '#A78BFA' },
        { id: 'dial', x: 2, y: 58, w: 96, h: 9, label: 'the only real lever: file size. 64 × 4k rows cuts the rewrite 4×', sub: 'and raises live files 10×+, footers read per plan, footer bytes, and total bytes for the same rows', color: '#3EF2A4' },
      ],
      edges: [
        { from: 'upd', to: 'locate' },
        { from: 'locate', to: 'three' },
        { from: 'three', to: 'rewrite' },
        { from: 'rewrite', to: 's1' },
        { from: 'rewrite', to: 's2' },
        { from: 's1', to: 'disk' },
        { from: 's2', to: 'exp' },
        { from: 'disk', to: 'dial' },
        { from: 'exp', to: 'dial' },
      ],
      steps: [
        {
          caption:
            'Three rows, deliberately spread across the key space rather than clustered, because three rows landing inside one file is the lucky case and measuring only the lucky case would understate what an update costs.',
          active: ['upd'],
        },
        {
          caption:
            'Finding them means reading every file\'s footer statistics — sixteen footers to locate three rows. That count is reported on purpose: it is precisely the work a manifest list exists to remove, and it grows with the file count.',
          active: ['locate', 'three'],
          edges: ['upd->locate', 'locate->three'],
        },
        {
          caption:
            'Then the rewrite, which is the whole lesson: three files read in full and written back in full, 49,152 rows for three changed ones, with bytes read and bytes written landing within ten percent of each other.',
          active: ['rewrite'],
          edges: ['three->rewrite'],
        },
        {
          caption:
            'Two snapshots now exist and both are ordinary, readable tables. The old list still returns the pre-update values with no special engine feature involved, which is exactly what makes time travel free at read time.',
          active: ['s1', 's2'],
          edges: ['rewrite->s1', 'rewrite->s2'],
        },
        {
          caption:
            'Free at read time, paid for in storage: the superseded files stay until something deletes them, and retaining a single previous snapshot more than doubles the table on the one-file layout.',
          active: ['disk'],
          edges: ['s1->disk'],
        },
        {
          caption:
            'Expiry reclaims exactly those bytes and destroys the old snapshot in the same act. The retention window is therefore a decision about how long you want a recovery option, not a storage tuning knob.',
          active: ['exp'],
          edges: ['s2->exp'],
        },
        {
          caption:
            'And the only lever on the amplification is file size, which is a physical layout decision rather than an engine setting — and it sells the reduction back to you in file count, footers read per plan and metadata bytes.',
          active: ['dial'],
          edges: ['disk->dial', 'exp->dial'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '49,152 rows',
          label: 'rewritten to change 3',
          hint: '3 affected files × 16,384 rows each, measured at the reference layout. Every one of those rows is read out of the old file and written back into a new one.',
        },
        {
          value: '16,384×',
          label: 'byte amplification of a three-row update',
          hint: 'Bytes written divided by rows changed times bytes per row. The row amplification is the same figure, because the rewrite is a copy with three cells altered.',
        },
        {
          value: '1.8×',
          label: 'storage while one previous snapshot is retained (1-file layout)',
          hint: 'Measured as everything-on-disk divided by what a fresh reader sees. It falls below 1.2× on the 64-file layout, which is the same tradeoff seen from the storage side.',
        },
        {
          value: '10×+',
          label: 'more live files, and footers read per plan, at the finest layout',
          hint: 'The price of the lower amplification. The byte penalty for small files is small; the count penalty is not, and planning scales with count.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'segfault',
      title: 'the update that looks like a query and prices like a backfill',
      md: `\`\`\`sql
-- a GDPR erasure request, or a single corrected order.
UPDATE orders SET status = 'voided' WHERE order_id = 131072;
\`\`\`

One row. On a copy-on-write table with 512 MB files, that statement reads a 512 MB file and writes a 512 MB file. Ten such requests scattered across the key space, submitted as ten separate statements, is **ten gigabytes of read and ten of write** — for ten rows.

Three consequences worth designing around before somebody discovers them:

- **Batch scattered updates into one commit.** Ten requests in one statement touch each affected file once instead of once per request. The same ten as ten commits also produce ten snapshots, ten metadata files and ten manifest lists.
- **On a consumption-priced platform, an update is a scan plus a write of the same magnitude**, and it is invisible on a dashboard that only graphs query volume. C0.L5's rule applies exactly: the optimisation and the pricing shape have to match.
- **Erasure requests are the pathological workload for copy-on-write** — legally mandated, individually tiny, arbitrarily scattered, and non-negotiable. If you have them, you need either a merge-on-read path (C5) or a physical layout that clusters the deletable rows together, and either way you should decide it before the first request arrives rather than after.`,
    },
    {
      type: 'isomorphism',
      title: 'copy-on-write ≡ three copy-on-write systems you already run',
      pairs: [
        {
          os: 'copy-on-write pages after fork()',
          osLine:
            'A write to one byte copies a whole page, because the page is the unit the hardware can protect and remap. Amplification is bounded by the page size, and that is why page size is a system-wide design decision.',
          llm: 'a copy-on-write table',
          llmLine:
            'Identical mechanism with the file as the page, and a page size of 16,384 rows instead of 4 KiB — which is why the amplification is four orders of magnitude instead of a small factor.',
        },
        {
          os: 'a container image layer',
          osLine:
            'Changing one file in a base layer writes a new layer; the old bytes stay until a prune. Storage grows with retained history, not with the size of the change.',
          llm: 'a retained snapshot',
          llmLine:
            'The superseded files are the previous layer, expiry is the prune, and the storage overhead is measurable — over 1.8× for one retained snapshot on the coarsest layout.',
        },
        {
          os: 'VACUUM in a row store',
          osLine:
            'Old row versions accumulate until a background job decides no transaction can still need them. Skip it and storage grows without bound while nothing errors.',
          llm: 'snapshot expiry',
          llmLine:
            'Same job, same failure mode, and one extra sting: expiry is the moment a recovery option disappears, so its schedule is a risk decision and belongs in a runbook rather than in a config default. (C3.L5 gives it a budget.)',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A compliance workflow submits about 200 single-row erasure requests a day against a copy-on-write table of 512 MB files, one statement per request. Storage is growing faster than ingest and the platform bill has a large write line item. Which analysis and fix hold up?',
          options: [
            'Statistics are not locating the rows efficiently, so the engine is scanning too much; adding a bloom filter on the id column will fix both the read and the write cost',
            'Each request rewrites whole files, so ~200 requests a day is on the order of 100 GB read and 100 GB written for 200 rows, and each commit also retains the superseded files until expiry. Batch the requests into one commit per period, shorten the retention window deliberately, and evaluate merge-on-read or a layout that clusters deletable rows — this workload is the pathological case for copy-on-write',
            'Increase the target file size so fewer files are affected per request',
            'The growth is snapshot metadata rather than data, so expiring old metadata files will recover the storage',
          ],
          correct: [1],
          explanation:
            'Do the multiplication before reaching for a mechanism: one row per statement at 512 MB files is a 512 MB read plus a 512 MB write, so a couple of hundred requests a day is a backfill-sized workload disguised as maintenance — and every commit leaves the superseded file on disk until expiry, which is where the storage growth comes from. A bloom filter locates rows more cheaply and does nothing whatsoever about the rewrite, which is the actual cost. Raising the target file size runs the wrong way: the snapshot lab measures amplification falling monotonically as files get smaller, so bigger files make each erasure more expensive, not less. And the metadata is real but tiny next to a hundred gigabytes of rewritten data. The fixes that work are batching (touch each file once per period instead of once per request), an explicit retention decision, and moving the workload onto a delete-file mechanism, which is exactly what C5 builds.',
        },
        {
          q: 'Reading the snapshot lab\'s results, an engineer concludes: "amplification falls monotonically as files get smaller, so we should cut the target file size to a quarter." What does the same run of that lab say about the cost of that change?',
          options: [
            'Nothing — the lab only measures the update path, so the change is free on the read side',
            'The reduction is real and it is sold back in counts: live files rise more than 10×, footers read per plan rise with them (one per file), footer bytes across the live set rise, and total bytes for the same rows rise slightly. Planning scales with file count, so this trades update cost for the cost C2.L5 watched become 61% of query time',
            'Smaller files compress better within each chunk, so the byte total falls and only the amplification changes',
            'The change is safe because the lab shows storage overhead from retained snapshots falling as files shrink',
          ],
          correct: [1],
          explanation:
            'The lab is built so it cannot be read as an argument for one-row files: it asserts amplification falling AND the counts rising, in the same run, on screen at the same time. The byte penalty at this scale is modest — under 1.2× from coarsest to finest — but the count penalty is more than 10×, and counts are what planning pays. Compression moves the wrong way rather than the right one: a dictionary amortised over fewer rows is worse, which C2.L1 priced. The retained-snapshot overhead genuinely does fall, and that is a real benefit, but naming only the benefit is how a change ships with an unnamed loser. The professional answer states the crossover: shrink files until the update cost is tolerable and stop before planning cost becomes the larger line.',
        },
        {
          q: 'Your platform retains 30 days of snapshots. An analyst accidentally overwrites a table, and the restore succeeds via time travel. A month later the same mistake happens and the restore fails. What is the most likely cause, and what should the runbook have said?',
          options: [
            'The second overwrite corrupted the metadata tree, so no snapshot could be resolved',
            'The snapshot that held the good data had been expired, and expiry deletes the files a superseded snapshot referenced — so the recovery option ceased to exist on a schedule. The runbook must state that after the retention window the recovery path is restore-from-backup, and that retention is a risk decision with a measurable storage price',
            'Time travel only works for appends, not for overwrites, so the first restore succeeded by coincidence',
            'The catalog pointer had moved more than once, and time travel can only go back one commit',
          ],
          correct: [1],
          explanation:
            'Expiry is destructive by design, and the snapshot lab performs it rather than describing it: after the superseded files are deleted, the on-disk total falls to exactly the live snapshot size and the old snapshot is no longer readable — the lab treats it as an anomaly if the old snapshot still reads, because that would mean nothing was freed. So a retention window is a statement about how long a recovery option exists, and the failure arrives silently on a timetable nobody watched. Both formats make this configuration rather than behaviour: Iceberg through min-snapshots-to-keep and max-snapshot-age-ms, Delta through tombstone expiry and VACUUM. The other options misdescribe the mechanism — time travel is just reading an older file list, it works for any operation, and it reaches as far back as retained snapshots go rather than one commit.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the other branch of the tradeoff, and the numbers that pick between them',
      md: `Everything in this lesson is one half of a two-sided design. The other half is **merge-on-read**: instead of rewriting a file to change three rows, write a small file that says "these rows are gone" and let every subsequent reader apply it. Iceberg's spec has three generations of that mechanism and reading them in order is instructive: **position delete files** (mark a row by file path plus ordinal position), **equality delete files** (mark rows by column value, applied to older files in the same partition), and **deletion vectors** in v3 — a Roaring bitmap per data file, stored in a Puffin blob, with at most one per data file per snapshot, explicitly introduced because it is more efficient at execution time than position delete files. Delta arrives at the same place from the other side with its own \`deletionVectors\` feature and the same Roaring bitmap format. When two independent formats converge on the same structure, the structure is the physics.

The cost model is the RUM conjecture again: **Athanassoulis et al., "Designing Access Methods: The RUM Conjecture" (EDBT 2016)** — read overhead, update overhead and memory, pick two. Copy-on-write buys zero read overhead with enormous update overhead; merge-on-read buys the reverse; compaction is how you move along the curve, and **O'Neil et al., "The Log-Structured Merge-Tree" (1996)** plus **Dayan, Athanassoulis and Idreos on Monkey** are where the policy side was worked out properly. **C5** builds a delta store and a merge with \`read_amp_bounded\` and \`write_amp_budget\` graded in bands, which is that curve made gradeable.

For the mechanics of write amplification as a first-class metric, the flash literature is the best-calibrated source — it has been measuring "bytes written to media per byte written by the application" for two decades, and the vocabulary transfers exactly.

For the operational half, read **Iceberg's "Snapshot Retention Policy"** and the maintenance procedures next to each other, then read **Delta's VACUUM and metadata-cleanup sections**. The thing to notice is that both specifications describe expiry as an *algorithm over policy*, not a button — and both are moving toward the catalog authorising it, which is a strong hint about where this responsibility belongs in your own platform.

Next: **C3.L5**. Compaction, expiry and orphan cleanup are not optimisations you get to defer. They are three jobs with a budget, and a table that does not run them degrades on a schedule nobody chose.`,
    },
  ],
}

export default lesson
