import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'a2.l1',
  slug: 'the-catalog-is-the-control-plane',
  trackId: 'a2',
  index: 1,
  title: 'The Catalog Is the Control Plane',
  minutes: 17,
  hook: 'One component decides which files are in every table, so every query and every commit passes through it. That makes it the control plane, the availability floor and the first ceiling you will hit — and the ceiling is a file count, not a byte count.',
  exercise: 'quiz',
  takeaway: {
    number: '1 pointer, 40× files',
    claim:
      'Every read and every commit resolves through one catalog pointer, so the platform floor is the catalog\'s availability and not storage durability — and the first limit is metadata: 9 TB is 37,500 files at 240 MB and 1.5M files at 6 MB, identical bytes and forty times the entries.',
  },
  blocks: [
    {
      type: 'prose',
      md: `A2 is the half where you run this for other people. Their dashboards, their models, their month-end. The first thing to get right is not a layout or an encoding — you already know those. It is which component in the design is allowed to be unavailable.

Start from the sentence C3.L3 ended on. **A file is in the table because a manifest reached from the current snapshot says so, and the current snapshot is whatever one pointer says it is.** That pointer lives in the catalog. Which means:

- every **commit** is a compare-and-set on it — set to v+1 only if still v;
- every **query** that wants current data resolves it first, then walks the tree;
- every **maintenance job** — compaction, expiry, orphan cleanup — commits through it too;
- and every **governance answer** you will give the steward in A2.L7 is read out of it.

So the catalog is not a lookup table with a directory of names in it. It is the **control plane**: the component that decides what is true. And a control plane has one property that a storage tier does not — when it is unavailable, nothing is degraded, everything is *stopped*, because there is no answer to "which files are in this table" and therefore no legal query plan.

Do the availability arithmetic once, because it is the sentence that reframes the design review. Components in series multiply. A catalog at 99.9% in front of storage at 99.99% gives you:

\`\`\`text
0.999 × 0.9999  =  0.99890
unavailability   =  0.11% of 43,200 min/month  ≈  47 min/month
\`\`\`

Eleven nines of object durability buys you nothing against that. The table's availability is **the catalog's availability, minus a rounding error** — and most teams have never asked what their catalog's number is, because it arrived as a side effect of choosing an engine.`,
    },
    {
      type: 'prose',
      md: `## What actually breaks, in the order you will meet it

Five failure modes, and only the first is the one people plan for.

**1 · It is down, so the platform is down.** No commits, because the CAS has nowhere to land. No fresh reads, because there is no current pointer. Long-running queries that already resolved a snapshot keep running perfectly — which is a nice property of immutability and also the reason the incident is confusing for the first ten minutes: the dashboards that happen to be mid-refresh look fine.

**2 · It is slow, so every query is slow before it reads a byte.** Planning is a catalog round trip plus a manifest walk. At C2.L5's shape — 1.4M files — planning grew to **61% of query time**, and no amount of compute fixes a cost paid before the scan starts. This is the failure that gets misdiagnosed as "the warehouse is slow" and answered by buying compute.

**3 · It is throttled, so your commit rate has a ceiling nobody wrote down.** Count the operations. 400 tables committing every 5 minutes is 288 commits/table/day = **115,200 commits/day ≈ 1.3/s mean**, and commits are bursty because schedules cluster on the hour. Add 40,000 planning reads a day. If the catalog is a hosted metastore with a per-second quota, that quota is your ingest architecture's real constraint — and you will discover it as retry storms during the 09:00 refresh, not as an error page.

**4 · Two catalogs both think they own the table, and you get two linear histories.** This is the worst one, because nothing errors. Every individual write was legal; two writers just ratified through different pointers and each believes it won. The result is silent data loss with a valid-looking table on both sides. **The guarantee is exactly one compare-and-set wide, and it is only a guarantee if there is exactly one place it happens.** A job that writes Parquet into the data prefix without committing has the same shape: it produced orphans, not rows.

**5 · It is restored from a backup taken at a different moment than storage.** Restore the catalog to 03:00 and the data files to 04:00 and you have a table whose manifests are missing files that exist, plus files that exist and nothing references. That is not a corrupted table in the storage sense — every byte is intact — and it is unqueryable. A2.L6 makes this a number: at 1.2M manifest entries, re-registering metadata is **67% of the reference RTO**, and it is the term nobody has ever timed.

Notice what all five have in common. **None of them is a storage problem, and none of them is fixed by anything you learned in C1 through C7.** They are properties of one small, boring, chronically under-owned service.`,
    },
    {
      type: 'statline',
      stats: [
        {
          value: '47 min/month',
          label: 'unavailability from a 99.9% catalog in front of 99.99% storage',
          hint: '0.999 × 0.9999 = 0.99890, and 0.11% of 43,200 minutes is about 47 minutes. Series components multiply, so the platform floor is the weakest link and it is not the storage tier.',
        },
        {
          value: '40×',
          label: 'more manifest entries for identical bytes',
          hint: '9 TB at 240 MB per file is 37,500 entries; the same 9 TB at 6 MB per file is 1.5M. Storage does not notice. The catalog does, and so does every query plan.',
        },
        {
          value: '115,200',
          label: 'commits a day at 400 tables on a 5-minute interval',
          hint: '288 commits per table per day × 400 tables ≈ 1.3 compare-and-sets per second on average, bursting on the hour. If your catalog has a request quota, this is the number that meets it.',
        },
        {
          value: '61%',
          label: 'of query time spent planning at 1.4M files (C2.L5)',
          hint: 'Paid before a single data byte is read, so it is invisible to bytes-scanned dashboards and immune to larger compute. The lever is file count.',
        },
      ],
    },
    {
      type: 'prose',
      md: `## Why the first ceiling is metadata, and why that surprises people

Capacity plans are written against bytes because bytes are what finance asks about. But the platform has five demand curves (A2.L5 grades all of them), and **storage grows with data while metadata grows with file count — different curves, driven by different knobs.**

The arithmetic that makes it concrete:

\`\`\`text
entries  =  live bytes ÷ target file size     (steady state)
         +  (files created/day − files merged/day) × days   (the deficit)

files created/day  =  commits/day × partitions per commit × writers
\`\`\`

Two consequences worth saying out loud in a review:

**Halving the commit interval doubles the file count at constant data.** Nothing about the business changed. You made a freshness decision (C5.L4) and paid for it in the metadata layer. INC-2 in Column Week is exactly this: 15-minute batches to 30-second micro-batches, freshness improved *as designed*, and two weeks later planning took longer than execution at 1.4M files against 9 TB.

**A merge deficit does not saturate — it accumulates.** If ingest creates 5,184 files a day and compaction merges 4,800, the 384/day difference is not a small inefficiency; it is a linear term added to a curve that already compounds. Over 24 months that is 384 × 30.4 × 24 ≈ **280,000 entries** that have nothing to do with how much data you hold.

And the metadata layer has a *second* file count that people forget entirely: **the tree itself.** One table-metadata file and one manifest list per commit. At 288 commits/day that is 288 new metadata JSON files a day, ~105,000 a year, per table. Iceberg's default is to track the last hundred of them and not delete the rest (see the vendor block), so the untracked ones become orphans that only an orphan sweep will ever remove. A2.L3 gives that sweep a budget in counts.

So when the capacity desk asks *what breaks first*, the honest answer for most platforms on this architecture is **the catalog**, and the reason is a decision that looked like a freshness decision.`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'Where the pointer lives, and what the defaults do to your metadata count',
      systems: ['iceberg', 'delta'],
      sources: [
        'https://iceberg.apache.org/spec/',
        'https://iceberg.apache.org/docs/latest/maintenance/',
        'https://raw.githubusercontent.com/delta-io/delta/master/PROTOCOL.md',
      ],
      md: `**Iceberg, from the table specification.** *"All changes to table state create a new metadata file and replace the old metadata with an atomic swap"*, and *"an atomic swap of one table metadata file for another provides the basis for serializable isolation."* Two commit implementations are named: metastore/catalog tables move the pointer with a **check-and-put** that validates the base version is still current, and file-system tables use an atomic rename — a scheme the spec documents as **deprecated and unsafe in object stores and local file systems**, to be removed. The direction of travel is unambiguous: the catalog is where correctness lives.

**Iceberg, from the maintenance docs — the defaults that grow your metadata count.** \`write.metadata.delete-after-commit.enabled\` defaults to **false** and \`write.metadata.previous-versions-max\` defaults to **100**. The docs spell out the consequence with an example: with deletion disabled and a tracking limit of 10, *"after 100 commits, one will have 10 tracked metadata files and 90 orphaned metadata files"*, and those 90 *"can only be cleaned with an orphan file deletion procedure"* because they are already untracked. So on a streaming table with default settings, the metadata directory grows monotonically and the cleanup path for most of it is not snapshot expiry.

**Delta, from the transaction log protocol.** The same shape with a different surface: commits are contiguously numbered JSON files in \`_delta_log\`, and *"writers MUST never overwrite an existing log entry"* — a **PUT-if-absent** on an exact path both ratifies and publishes. Checkpoints plus a \`_last_checkpoint\` pointer exist because listing a log directory with ten thousand entries *"can be prohibitively expensive"*: a pointer whose entire job is to avoid a listing. Under the \`catalogManaged\` feature the catalog becomes the source of truth for whether a commit succeeded, and filesystem-based access is explicitly unsupported.

**Read that convergence as an architectural fact rather than a feature note.** Both specifications started with "the files are the table" and have moved to "the catalog says what the table is." If your platform lets any writer reach storage directly, you are running the deprecated model regardless of which format you chose. Treat mechanisms as durable and property names as perishable — check them against your own version.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — one pointer in the path of everything, and the two counts that saturate it',
      height: 76,
      nodes: [
        { id: 'q', x: 2, y: 2, w: 30, h: 9, label: 'queries', sub: '40,000/day · each resolves the pointer first', color: '#F97316' },
        { id: 'w', x: 35, y: 2, w: 30, h: 9, label: 'writers', sub: '115,200 commits/day · one CAS each', color: '#F97316' },
        { id: 'm', x: 68, y: 2, w: 30, h: 9, label: 'maintenance', sub: 'compaction · expiry · orphan sweep', color: '#F97316' },
        { id: 'cat', x: 2, y: 15, w: 96, h: 9, label: 'THE CATALOG — one pointer per table, moved by compare-and-set', sub: 'the only strong guarantee in the system, and the only component in series with every operation', color: '#FB7185' },
        { id: 'tree', x: 2, y: 28, w: 46, h: 9, label: 'metadata tree', sub: 'metadata file + manifest list per commit', color: '#5CA8FF' },
        { id: 'files', x: 52, y: 28, w: 46, h: 9, label: 'data files', sub: '9 TB · 37,500 entries at 240 MB', color: '#A3E635' },
        { id: 'ceil', x: 2, y: 41, w: 96, h: 9, label: 'ceiling 1: manifest entries = bytes ÷ file size + accumulated merge deficit', sub: 'the same 9 TB is 1.5M entries at 6 MB per file — 40× the metadata, 0 extra bytes', color: '#FBBF24' },
        { id: 'avail', x: 2, y: 54, w: 46, h: 9, label: 'ceiling 2: availability, in series', sub: '0.999 × 0.9999 ≈ 47 min/month unavailable', color: '#A78BFA' },
        { id: 'split', x: 52, y: 54, w: 46, h: 9, label: 'and the silent failure: two catalogs', sub: 'two linear histories, no error, data lost', color: '#FB7185' },
        { id: 'own', x: 2, y: 67, w: 96, h: 9, label: 'so the catalog gets an owner, an SLO, a request budget, a restore drill and exactly one write path', sub: 'and the metadata count goes on a dashboard next to bytes, because it is the curve that binds first (A2.L5)', color: '#3EF2A4' },
      ],
      edges: [
        { from: 'q', to: 'cat' },
        { from: 'w', to: 'cat' },
        { from: 'm', to: 'cat' },
        { from: 'cat', to: 'tree' },
        { from: 'cat', to: 'files' },
        { from: 'tree', to: 'ceil' },
        { from: 'files', to: 'ceil' },
        { from: 'ceil', to: 'avail' },
        { from: 'ceil', to: 'split' },
        { from: 'avail', to: 'own' },
        { from: 'split', to: 'own' },
      ],
      steps: [
        {
          caption:
            'Three populations reach the same component: readers resolving the current snapshot, writers performing a compare-and-set, and the maintenance jobs that commit like any other writer. Nothing in the platform bypasses it.',
          active: ['q', 'w', 'm', 'cat'],
          edges: ['q->cat', 'w->cat', 'm->cat'],
        },
        {
          caption:
            'From the pointer, everything else is reachable and inert: the metadata tree that names files, and the files themselves. Membership is a metadata fact, never a storage fact, which is why a file written without a commit is an orphan rather than a row.',
          active: ['tree', 'files'],
          edges: ['cat->tree', 'cat->files'],
        },
        {
          caption:
            'The first ceiling is a count of entries, and it has two terms: steady-state bytes divided by target file size, plus the accumulated difference between files created and files merged each day. Only the first term involves how much data you hold.',
          active: ['ceil'],
          edges: ['tree->ceil', 'files->ceil'],
        },
        {
          caption:
            'The second ceiling is availability, and it multiplies rather than averages: a catalog one nine weaker than storage sets the platform floor, so durability guarantees on the data plane cannot buy it back.',
          active: ['avail'],
          edges: ['ceil->avail'],
        },
        {
          caption:
            'And the failure with no error message: two catalogs that both believe they own the table produce two valid linear histories and lose whichever writer resolved through the other one. Every individual operation was legal.',
          active: ['split'],
          edges: ['ceil->split'],
        },
        {
          caption:
            'Which turns a lookup service into a platform component with an owner, a stated SLO, a request budget sized against your commit rate, a tested restore, and exactly one write path — the four things nobody assigns to a component they think of as configuration.',
          active: ['own'],
          edges: ['avail->own', 'split->own'],
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the four questions to ask about your catalog before Thursday',
      md: `None of these needs a benchmark. All four have answers you can find today, and all four have bitten a real platform.

**1 · What is its availability target, and is it in series with anything else?** If the answer is "it is part of the engine we bought", you have an availability number you did not choose and cannot state. That is fine right up until someone asks you to promise a query SLO (A2.L4), which you cannot exceed.

**2 · What is its request budget, in operations per second, and what is our commit rate?** Commits plus planning reads plus maintenance. If your mean is 1.3/s and your peak is ten times that because every schedule fires on the hour, the peak is the number that matters and schedule jitter is a one-line mitigation.

**3 · Is there exactly one write path?** Not "do we have a policy". Can a job write into the data prefix and be believed? Can a second engine commit through a different catalog? If yes, you have a correctness exposure that produces no errors, and the only detector is a reconciliation job that diffs storage against the metadata tree.

**4 · Has a catalog restore ever been performed, and was it restored to the same point in time as the data?** Metadata and data are two backup sets that must agree. Restoring them to different moments produces a table that is intact, self-consistent, and wrong — and re-registering the entries is the largest term in your RTO (A2.L6).`,
    },
    {
      type: 'callout',
      variant: 'info',
      title: 'the sentence that changes the meeting',
      md: `> "Our storage tier is eleven nines durable and our platform is 99.89% available, because the catalog is in series with every read and every write and it is 99.9%. That is about 47 minutes a month, and during those minutes nothing is slow — commits fail and no query can be planned. I would like the catalog to have an owner and a request budget, and I have costed both."

Three things happen when you say that. You have converted an invisible dependency into a named component, which is the only way it gets staffed. You have separated durability from availability, which is the distinction the room most often conflates. And you have pre-empted the version of this conversation that otherwise happens during an incident, when the honest answer is "we did not know that was a single point of failure."`,
    },
    {
      type: 'isomorphism',
      title: 'a table catalog ≡ control planes you already treat as critical',
      pairs: [
        {
          os: 'DNS',
          osLine:
            'Tiny records, trivially cheap to serve, and in the resolution path of every request. Nobody calls it a database, everybody has had an outage caused by it, and the mitigation is always ownership plus caching rather than more capacity downstream.',
          llm: 'the table catalog',
          llmLine:
            'Same position, same blast radius: a few hundred bytes that decide whether 9 TB is queryable. And the same trap — a stale cached answer is a serving of old truth, which for a table means reading a snapshot that expiry may already have deleted files from.',
        },
        {
          os: 'the Kubernetes API server and its store',
          osLine:
            'Running workloads survive its outage; nothing new can be scheduled and no state can change. Capacity planning for it is about request rate and object count, never about the size of the things it describes.',
          llm: 'commits versus in-flight queries',
          llmLine:
            'Exactly the split that makes the first ten minutes of a catalog incident confusing: queries that already resolved a snapshot complete normally, and every commit fails. Plan its capacity in operations per second and manifest entries — counts of descriptions, not bytes of data.',
        },
        {
          os: 'a git branch ref',
          osLine:
            'One file containing one hash. Objects are immutable and written before they are reachable; the only mutation in the system is moving the ref, and two people moving it without a check produces a lost commit with no error.',
          llm: 'the metadata pointer',
          llmLine:
            'The identical hazard at platform scale: two catalogs both moving their own ref give you two valid histories and silent loss. The fix is the same one git uses — the update is conditional on the base version, and there is only one place it happens.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'Your object storage is quoted at eleven nines of durability and 99.99% availability. Your tables resolve through a hosted metastore whose published availability is 99.9%. A stakeholder asks what the analytics platform\'s availability is. What do you tell them?',
          options: [
            '99.99%, since the data is the platform and storage is the durable tier',
            'About 99.89%, because the catalog is in series with every read and every commit, so the numbers multiply and the weakest link sets the floor — roughly 47 minutes a month during which commits fail and no query can even be planned',
            'It cannot be stated, because availability depends on which queries are running at the time',
            'Effectively 100%, because durability of eleven nines means the data is never lost',
          ],
          correct: [1],
          explanation:
            'Components in series multiply: 0.999 × 0.9999 = 0.99890, which is about 47 minutes of unavailability a month against 43,200. The first option makes the most common conflation in this subject — durability is about not losing bytes, availability is about being able to answer, and they are different purchases. The third answer refuses a number that is simple arithmetic. The fourth treats durability as if it covered the case where the component that tells you which files are in the table is unreachable: every byte is intact and there is no legal query plan, which is exactly why the catalog and not the storage tier is the platform floor.',
        },
        {
          q: 'A platform holds 9 TB and planning has grown to over half of query time. Ingest moved from 15-minute batches to 30-second micro-batches two weeks ago to meet a freshness target; data volume is unchanged. What is the mechanism, and which lever actually helps?',
          options: [
            'The catalog database needs an index rebuild or a larger instance to keep up with metadata volume',
            'Shorter commits multiplied the file count at constant data — 9 TB at 6 MB per file is 1.5M entries where 240 MB files would be 37,500 — and planning scales with entries, not bytes. The levers are the batch interval and compaction throughput sized against the creation rate; more compute cannot help because the cost is paid before any data is read',
            'Partition more finely so each query touches fewer files',
            'Compression degraded across many small files, so the same data now occupies more bytes and takes longer to read',
          ],
          correct: [1],
          explanation:
            'This is INC-2 and its arithmetic: file count is commits × partitions × writers, so halving the interval doubles files for identical data, and query planning enumerates files and reads their statistics. Scaling the catalog instance treats a growth curve as a capacity blip and buys months at best while the deficit keeps accumulating. Finer partitioning is the classic trap — it reduces files per query only when the predicate matches the partition key, and it increases total file count unconditionally, which is the metric that is already the problem. Compression is a red herring: the bytes did not change, the number of things describing them did.',
        },
        {
          q: 'A second team wants to write to your Iceberg tables from their own Spark cluster, using a Hadoop catalog against the same storage prefix while you use a metastore catalog. What is the risk, and how will you find out about it?',
          options: [
            'Slower commits from contention on the same prefix, detectable as elevated retry rates in both clusters',
            'Two independent pointers means two linear histories: both writers succeed, each ratifying through its own catalog, and one set of commits is silently discarded with no error anywhere because every individual write was legal. Nothing detects it except a reconciliation that diffs storage against the metadata tree — and the file-system commit scheme is deprecated precisely because of this',
            'No real risk, since Iceberg uses optimistic concurrency and the loser of any conflict will retry against the current snapshot',
            'A schema conflict, which the format will reject at commit time when the two clusters disagree about the current schema',
          ],
          correct: [1],
          explanation:
            'Optimistic concurrency protects you only when both writers contend on the same conditional update. Two catalogs are two separate compare-and-sets over the same files, so there is no contention to resolve and no retry to trigger — both sides observe success and each has a valid-looking table. That is why the guarantee has to be exactly one operation wide in exactly one place, and why the spec now documents file-system commits as unsafe in object stores. Retry rates stay clean, which is what makes the first option misleading: an elevated retry rate would actually be reassuring, because it would mean the writers were meeting. Schema validation cannot save you either, since each catalog independently believes its own schema is current.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: control planes, and the literature on the component nobody owns',
      md: `**Read the Iceberg REST Catalog specification**, not for the endpoints but for what it says about responsibility: the operations it defines are commit, load, list and update-with-a-base-version, which is a precise enumeration of what a control plane for tables actually has to do. Then read **Delta's \`catalogManaged\` section** and notice that two independent projects converged on "the catalog ratifies the commit" from opposite starting points. Convergence between competing specifications is the strongest signal available that a design constraint is real rather than fashionable.

For the failure model, the transferable literature is not from data platforms. **Google's SRE book chapters on managing critical state and on load shedding** describe exactly this component class: small, cheap to serve, in the path of everything, and catastrophic under overload rather than gracefully degraded. **The Chubby paper (Burrows, OSDI 2006)** is the classic on a tiny consistent store whose availability becomes everybody else's availability, and its operational lessons — clients cache, caches make outages weirder, quotas are load-bearing — read as a direct commentary on catalog design. For the CAS primitive itself, **Herlihy's "Wait-Free Synchronization" (1991)** is why one conditional write is not a small thing.

On the metadata-scale claim, the primary sources are the specs plus your own numbers: run the arithmetic in this lesson against your real commit rate, partition count and writer count before you believe any vendor's file-count guidance. Sibling course: **→ tablespace T2** for how a row store's catalog and system tables carry the same load with a different failure surface, and **→ byzantine** for what "one place the decision happens" costs when the one place has to survive a partition.

Next: **A2.L2**. The catalog decides which files are in the table. It has no opinion whatsoever about what the columns *mean*, and that gap ran a revenue model wrong for eleven days with every pipeline green.`,
    },
  ],
}

export default lesson
