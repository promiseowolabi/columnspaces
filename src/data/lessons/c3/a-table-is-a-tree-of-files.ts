import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c3.l3',
  slug: 'a-table-is-a-tree-of-files',
  trackId: 'c3',
  index: 3,
  title: 'A Table Is a Tree of Files',
  minutes: 18,
  hook: 'Every guarantee a table format gives you — atomic commits, serializable reads, time travel — rests on exactly one atomic operation: swapping a single pointer. Everything else in the tree exists because listing a directory is neither cheap nor consistent.',
  exercise: 'quiz',
  artifact: 'layout-design',
  takeaway: {
    number: '1 atomic swap',
    claim:
      'A table format\'s entire atomicity story reduces to one compare-and-set on a single pointer — every other file in the tree is written first and is inert until that swap lands, which is why the catalog, not the storage, is the thing that has to be correct.',
  },
  blocks: [
    {
      type: 'prose',
      md: `You now know what one file is, byte for byte. A table is not one file, and the gap between those two sentences is where most platform incidents live.

Ask the question directly: **which files are in this table right now?** Three answers have been tried in production, and only the third one works.

**Answer 1: "everything in this directory."** This is the Hive convention, and it fails at the first concurrent write. A reader listing the directory mid-commit sees half a commit's files. There is no way to add four files at once. There is no way to know whether a file is finished. C3.L1's truncated upload is queryable garbage under this scheme, because the file list is whatever the storage happens to contain at the instant you asked.

**Answer 2: "everything the metastore knows about."** Better — partitions become explicit and prunable without a listing — but the unit of tracking is still the *directory*, so the contents of a partition are still whatever is in it, and the same race is still there one level down.

**Answer 3: "exactly the files named by the current snapshot."** The table tracks individual data files rather than directories, so a file becomes part of the table only when a commit says so. That is what Iceberg and Delta both do, and everything else in this lesson is a consequence of it.

The consequence worth stating first, because it is the load-bearing one: **if the file list is data, then committing is writing a new file list, and making a commit atomic means making exactly one pointer move atomically.** Not two. One.`,
    },
    {
      type: 'prose',
      md: `## The tree, level by level, and what each level buys

Iceberg's shape, which is the clearest to describe because the specification is explicit about the reasoning:

| level | what it is | why it exists as its own level |
|---|---|---|
| **the catalog pointer** | one location: "the current metadata file for this table" | it is the only thing that has to change atomically, so it is the only thing that needs a strong guarantee |
| **table metadata file** | JSON: schemas, partition specs, sort orders, properties, the list of valid snapshots | one file per commit, so history is a list of immutable documents rather than a mutable record |
| **snapshot** | a table state at a point in time; names one manifest list | this is the unit time travel selects, and the unit expiry removes |
| **manifest list** | one row per manifest: counts, sequence number, and **partition value summaries** | lets a scan skip whole manifests without reading them — partition pruning happens *above* the file list |
| **manifest** | one row per data file: path, partition tuple, record count, size, per-column bounds and null counts | reusable across snapshots, so a commit rewrites metadata proportional to the change and not to the table |
| **data file** | immutable Parquet, with the footer from C3.L1 | never modified after it is written; the only ways it leaves the table are being unreferenced and then deleted |

Two of those rows are doing more work than they look like.

**Manifests are reused across snapshots.** A commit that adds four files writes a new manifest for those four files and a new manifest list that points at it *plus* the manifests the previous snapshot already had. The old manifests are untouched. That is the difference between commit cost proportional to the change and commit cost proportional to the table — and it is what makes a thousand commits a day possible at all.

**The manifest list carries partition summaries.** So a scan reads one metadata file, one manifest list, and then only the manifests whose partition summaries could contain matching files. Iceberg's stated goal is explicit about the target: *"Operations will use O(1) remote calls to plan the files for a scan and not O(n) where n grows with the size of the table."*

Put C2.L5's incident against that. 1.4 million files, seven days out of ninety. Under answer 1, before you know what exists you have to enumerate the objects — and object listings are paginated, typically 1,000 keys per request, so that is on the order of **1,400 LIST requests** just to obtain a file list you must then filter. Under answer 3 it is one metadata read, one manifest list, and the manifests the summaries did not eliminate. The file count did not change. The number of round trips before planning starts changed by three orders of magnitude.`,
    },
    {
      type: 'prose',
      md: `## What atomicity actually rests on

Here is the part that gets waved at, and it deserves being pinned down because it decides which component in your architecture must be correct.

**Every file in the tree except the pointer is written optimistically, before the commit, and is inert.** New data files, a new manifest, a new manifest list, a new table metadata file — all of them can sit in storage indefinitely, referenced by nothing, visible to no query. Then one operation makes them all visible at once:

\`\`\`text
commit(v -> v+1):
  1. write data files                      (inert)
  2. write manifest(s)                     (inert)
  3. write the manifest list               (inert)
  4. write metadata file v+1               (inert)
  5. swap the pointer from v to v+1        <-- the only atomic step
\`\`\`

If step 5 fails, nothing happened. Readers on \`v\` never saw anything. The files from steps 1–4 are now **orphans**: real bytes that no metadata references, which no query will ever find and which no snapshot expiry will ever remove — because expiry removes what a *former* snapshot referenced, and these were never referenced at all. That is why orphan cleanup is a separate maintenance job with a separate mechanism, and C3.L5 gives it a budget.

**Step 5 is the whole guarantee, and it needs a compare-and-set.** "Write the new pointer" is not enough; the requirement is "set the pointer to v+1 **only if** it is still v", because otherwise two concurrent writers both succeed and one of them is silently lost. Iceberg names two implementations and is explicit about their standing:

- **Metastore/catalog tables:** the pointer lives in a catalog and is moved with a check-and-put that validates the base version is still current. This is the recommended shape.
- **File-system tables:** an atomic rename to \`v<N+1>.metadata.json\`. The specification now marks this scheme **deprecated and unsafe in object stores and local file systems**, and plans to remove it.

Delta does the same thing with a different surface: the commit *is* the log entry \`_delta_log/00000000000000000042.json\`, and the protocol's requirement is that writers **must never overwrite an existing log entry** and should use the filesystem's atomic primitives so that concurrent writers cannot clobber each other. A PUT-if-absent on that exact path is both the ratification and the publication, and the file's existence is the proof that the version is committed.

Both designs land in the same place: **the strong guarantee is exactly one operation wide, and it does not live in the data layer.** It lives in a catalog or in a single conditional write. Which is why "who owns the catalog, and what is its availability story" is a platform question with real consequences, and A2 treats the catalog as a control plane rather than a lookup table.`,
    },
    {
      type: 'prose',
      md: `## Why any of this exists: object storage promises almost nothing

The tree looks baroque until you write down what the storage layer actually offers. Iceberg's file-system requirements are three lines long:

- **in-place write** — files are not moved or altered once written;
- **seekable reads** — the data format needs to seek (which is C3.L1's whole opening sequence);
- **deletes** — the table removes files it no longer uses.

And explicitly: **no rename required**, except for the deprecated file-system commit scheme. That list is short because it is the intersection of what object stores guarantee. Everything a database normally leans on is missing: no in-place update, no locks, no multi-file transaction, no cheap directory, no ordering.

Two absences do most of the damage, and they are the ones to be able to name in a review.

**Listing is a paid, paginated, eventually-arriving view — not a snapshot.** It costs a request per page, it returns keys in lexicographic order rather than in commit order, and it has historically been the *last* operation in an object store to reflect a write. Delta's protocol says the quiet part out loud about the cost side: the transaction log often contains ten thousand or more files, *"listing such a large directory can be prohibitively expensive"*, which is why a \`_last_checkpoint\` pointer exists at all — a pointer whose entire job is to avoid a listing.

**There is no way to make two writes visible together.** So any design that needs "these four files became part of the table simultaneously" must reduce to one write. The tree is not decoration; it is the funnel that gets an arbitrarily large change down to a single atomic act.

Say it as one sentence in a design review: **"the format is a way to spend cheap, unordered, unreliable object storage operations to buy one atomic pointer swap, and everything else follows from that."**`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'Iceberg and Delta: the same swap, two surfaces',
      systems: ['iceberg', 'delta'],
      sources: [
        'https://iceberg.apache.org/spec/',
        'https://raw.githubusercontent.com/delta-io/delta/master/PROTOCOL.md',
      ],
      md: `**Iceberg**, from the table specification:

- *"This table format tracks individual data files in a table instead of directories."* Table state lives in metadata files, and *"all changes to table state create a new metadata file and replace the old metadata with an atomic swap."*
- *"An atomic swap of one table metadata file for another provides the basis for serializable isolation."* Readers use the snapshot that was current when they loaded the metadata and are unaffected until they refresh. **Readers do not acquire locks.**
- Writers commit optimistically and, if the base snapshot is no longer current, must retry. Which retries are legal is spelled out: appends always can; replaces must verify the files they will delete are still in the table; schema and partition changes must verify the schema did not move underneath them. **The conditions a write chooses to validate are what determine its isolation level.**
- The two commit implementations are named directly. Metastore tables use a **check-and-put** on a pointer. File-system tables use atomic rename, and that scheme is documented as **deprecated and unsafe in object stores and local file systems**, to be removed in the next format version.
- Manifest lists carry per-manifest summaries — added/existing/deleted file and row counts, plus a partition field summary — *"used to avoid reading manifests that are not required for an operation."*
- The file-system contract is only in-place write, seekable reads and deletes; rename is not required.

**Delta**, from the transaction log protocol:

- A table is a directory plus \`_delta_log\`. Commits are JSON files named by contiguous, zero-padded version number; each holds an atomic set of \`add\`/\`remove\`/\`metaData\`/\`protocol\` actions applied to version \`v−1\`. **Delta files are the unit of atomicity.**
- *"Writers MUST never overwrite an existing log entry. Whenever possible they should use atomic primitives of the underlying filesystem to ensure concurrent writers do not overwrite each other's entries."* Catalog implementations with **PUT-if-absent** can ratify and publish in one step by writing the commit file directly — and it counts as committed the moment the file becomes visible.
- Transactions are MVCC: writers first write data files optimistically, then commit by adding the log entry that logically adds and removes files.
- Checkpoints (a Parquet replay of the log) plus a \`_last_checkpoint\` pointer exist because listing a log directory with ten thousand entries *"can be prohibitively expensive"*.
- Under the \`catalogManaged\` feature the catalog becomes the source of truth for whether a commit succeeded, and filesystem-based access is explicitly unsupported — the same direction Iceberg took by deprecating file-system commits.

Treat the mechanisms as durable and the version-specific feature names as perishable. The shape — write everything inert, then move one pointer conditionally — has not changed in either format since it existed.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — everything is written first and inert; one conditional write makes all of it real',
      height: 68,
      nodes: [
        { id: 'ptr', x: 2, y: 2, w: 46, h: 9, label: 'the pointer (catalog entry, or a version filename)', sub: 'the ONE thing that moves atomically, with a compare-and-set', color: '#FB7185' },
        { id: 'meta', x: 52, y: 2, w: 46, h: 9, label: 'table metadata file', sub: 'schemas, partition specs, the list of valid snapshots', color: '#5CA8FF' },
        { id: 'snap', x: 2, y: 15, w: 46, h: 9, label: 'snapshot', sub: 'one table state · what time travel selects and expiry removes', color: '#5CA8FF' },
        { id: 'mlist', x: 52, y: 15, w: 46, h: 9, label: 'manifest list', sub: 'per-manifest counts + partition summaries', color: '#22D3EE' },
        { id: 'man', x: 2, y: 28, w: 46, h: 9, label: 'manifests', sub: 'one row per data file · reused across snapshots', color: '#22D3EE' },
        { id: 'data', x: 52, y: 28, w: 46, h: 9, label: 'data files', sub: 'immutable Parquet · the footer from C3.L1', color: '#A3E635' },
        { id: 'commit', x: 2, y: 41, w: 96, h: 9, label: 'commit: write data, manifest, manifest list, metadata — all inert — then swap the pointer if it is still v', sub: 'if the swap loses, nothing happened, and everything written in steps 1–4 is now an orphan', color: '#FBBF24' },
        { id: 'store', x: 2, y: 54, w: 46, h: 9, label: 'what object storage guarantees', sub: 'in-place write · seekable reads · delete. No rename needed', color: '#94A3B8' },
        { id: 'list', x: 52, y: 54, w: 46, h: 9, label: 'and LIST, which is not a snapshot', sub: 'paginated, priced per request, ordered by key — never by commit', color: '#94A3B8' },
      ],
      edges: [
        { from: 'ptr', to: 'meta' },
        { from: 'meta', to: 'snap' },
        { from: 'snap', to: 'mlist' },
        { from: 'mlist', to: 'man' },
        { from: 'man', to: 'data' },
        { from: 'data', to: 'commit' },
        { from: 'commit', to: 'ptr' },
        { from: 'store', to: 'commit' },
        { from: 'list', to: 'commit' },
      ],
      steps: [
        {
          caption:
            'Start at the only strong guarantee in the system: one pointer, which names the current table metadata file. Everything a reader believes about the table is reached from there, and nothing else needs to be atomic.',
          active: ['ptr', 'meta'],
          edges: ['ptr->meta'],
        },
        {
          caption:
            'The metadata file lists valid snapshots; a snapshot names exactly one manifest list. This is the level time travel selects and the level snapshot expiry removes, which is why they are the same mechanism seen from two directions.',
          active: ['snap', 'mlist'],
          edges: ['meta->snap', 'snap->mlist'],
        },
        {
          caption:
            'The manifest list carries per-manifest counts and partition summaries, so a scan can skip whole manifests unread. Manifests are reused between snapshots, which is what keeps commit cost proportional to the change rather than to the table.',
          active: ['man'],
          edges: ['mlist->man'],
        },
        {
          caption:
            'Manifests name individual data files — not directories — with their partition tuple and per-column bounds. A file is in the table because a manifest says so, never because it happens to exist in a prefix.',
          active: ['data'],
          edges: ['man->data'],
        },
        {
          caption:
            'A commit writes all of that first, while it is referenced by nothing and visible to no query, and then performs exactly one conditional write. Lose that write and the table never changed; the files you wrote are orphans that no expiry will ever find.',
          active: ['commit'],
          edges: ['data->commit', 'commit->ptr'],
        },
        {
          caption:
            'And the reason for the whole funnel: storage promises in-place write, seekable reads and delete, with listing that costs a request per page and reflects key order rather than commit order. The tree buys one atomic act out of that.',
          active: ['store', 'list'],
          edges: ['store->commit', 'list->commit'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '1',
          label: 'atomic operation the entire format depends on',
          hint: 'A compare-and-set on the current metadata pointer, or a PUT-if-absent on a version-numbered log entry. Everything else is written beforehand and is inert.',
        },
        {
          value: '~1,400',
          label: 'LIST requests to enumerate 1.4M objects at 1,000 keys per page',
          hint: 'Order-of-magnitude arithmetic on C2.L5\'s incident, and the cost a manifest tree removes: one metadata read, one manifest list, then only the manifests the partition summaries did not eliminate.',
        },
        {
          value: '3',
          label: 'operations a table format requires from storage',
          hint: 'In-place write, seekable reads, delete. Notably absent: rename, locks, multi-object transactions, and a consistent cheap directory.',
        },
        {
          value: '0 locks',
          label: 'acquired by readers',
          hint: 'A reader uses whatever snapshot was current when it loaded the metadata and is unaffected by concurrent writes until it refreshes. Isolation comes from immutability plus one swap.',
        },
      ],
    },
    {
      type: 'callout',
      variant: 'warning',
      title: 'the failure modes this design creates, which are not the ones it removed',
      md: `A tree of files with one atomic swap fixes the concurrent-writer race and the half-visible commit. It creates four new problems, and all four have shown up in production platforms:

- **Orphan files.** Every failed commit leaves data files that nothing references. Snapshot expiry cannot remove them — it removes files a *previous* snapshot referenced — so only a listing pass that diffs storage against the metadata tree will ever find them. Unbudgeted, this is a storage line item that grows with your retry rate.
- **Metadata growth.** One metadata file and one manifest list **per commit**. A fast commit loop grows the metadata tree at the same rate it grows the file list, so C2.L5's small-file problem has an exact twin in the metadata layer, and rewriting manifests is its own maintenance job.
- **A single point of correctness.** The compare-and-set is the guarantee. If two engines commit through two different catalogs that both think they own the table, you get two linear histories and silent data loss — no storage-layer error will occur, because every individual write was legal.
- **Writers that skip the catalog.** A job that writes Parquet into the data directory and never commits has produced orphans, not rows. A job that deletes files behind the metadata's back has produced a table whose manifests reference paths that no longer exist, and the failure surfaces at query time on somebody else's dashboard. Both formats are now moving to shut this door explicitly — Iceberg by deprecating file-system commits, Delta by declaring filesystem access unsupported for catalog-managed tables.`,
    },
    {
      type: 'isomorphism',
      title: 'a snapshot tree ≡ three things you already trust with a single pointer',
      pairs: [
        {
          os: 'git',
          osLine:
            'Blobs, trees, commits — all immutable and content-addressed — and a branch is a file containing one hash. "Committing" writes objects that are invisible until a ref moves, and moving the ref is the only atomic act.',
          llm: 'an Iceberg table',
          llmLine:
            'Data files, manifests, manifest lists, metadata files, and a catalog pointer. Time travel is checkout; expiry is garbage collection; a failed commit leaves unreachable objects, exactly like an aborted git operation.',
        },
        {
          os: 'a blue/green deploy behind a symlink swap',
          osLine:
            'Build the new release completely in a directory nobody serves, verify it, then repoint one symlink. Rollback is repointing it back, and nothing is ever half-deployed.',
          llm: 'a copy-on-write commit',
          llmLine:
            'Same shape, and the same operational consequence: the risky, slow, expensive part is not the transition — it is everything before it, which is why C3.L4 measures the rewrite rather than the swap.',
        },
        {
          os: 'MVCC in a row store',
          osLine:
            'Readers see the version that was current when their transaction began and never block writers. Old versions live until a vacuum decides nobody can still need them.',
          llm: 'snapshot isolation over immutable files',
          llmLine:
            'Identical model at file granularity instead of row granularity, with expiry playing the part of vacuum — which means the same operational trap: skip the vacuum and storage grows without bound. (→ tablespace T5 for the row store\'s version.)',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A team runs a Spark job that writes Parquet files into an Iceberg table\'s data directory with a plain file write, then reports that the rows "are not showing up". A colleague suggests refreshing the table or waiting for eventual consistency. What is actually happening?',
          options: [
            'The files need time to become visible; the table will pick them up on the next metadata refresh',
            'The files are not in the table and never will be: membership comes from the manifests reached through the current snapshot, not from what exists under a prefix. Those files are orphans — invisible to every query, and not removable by snapshot expiry',
            'The write bypassed statistics collection, so the planner is pruning the new files away; recollecting statistics will make them visible',
            'The partition directory was not registered, so an ALTER TABLE to add the partition will expose the files',
          ],
          correct: [1],
          explanation:
            'This is the whole point of tracking individual data files rather than directories: a file becomes part of the table when a commit names it in a manifest, and never otherwise. No refresh helps, because there is nothing new in the metadata tree to refresh to — the situation is indistinguishable from a failed commit, which is exactly what it is. The files are orphans, and the second half of that matters commercially: snapshot expiry removes files that a former snapshot referenced, and these were never referenced by any snapshot, so only an orphan-file cleanup pass that diffs storage against the metadata will ever reclaim them. Adding a partition is the Hive-era reflex and does not apply; pruning is not involved at all, since a planner cannot prune a file it has never heard of.',
        },
        {
          q: 'Two independent writers commit to the same table at the same moment, both based on snapshot v. What does the format guarantee, and where does that guarantee physically live?',
          options: [
            'Both commits succeed and the manifests are merged, since manifests are additive and each writer wrote different files',
            'Exactly one commit wins, because moving the pointer is a compare-and-set that requires the base version to still be current; the loser must retry against the new version. That guarantee lives in the catalog\'s check-and-put or in a PUT-if-absent on a version-numbered file — not in the data layer',
            'The write that finishes its data files first wins, because file writes are ordered by the storage layer',
            'Neither commit succeeds; the format detects the conflict and requires an explicit lock to be taken before writing',
          ],
          correct: [1],
          explanation:
            'Both writers legitimately write data files, manifests and a new metadata file — all of it inert — and then contend on one operation. That operation must be conditional: set the pointer to v+1 only if it is still v. Without the condition, both writers "succeed" and the second silently discards the first, with no error anywhere because every individual write was legal. Merging is not something the format does on your behalf; the loser retries, and which retries are safe is specified per operation (appends always are; a replace must verify the files it intends to delete are still in the table). Nothing is ordered by the storage layer, which is exactly why the guarantee cannot live there. And readers never take locks — that is the property serializable isolation over immutable files buys you.',
        },
        {
          q: 'You are asked why a table format is worth the operational overhead when "the files are right there in object storage and any engine can read them". Which answer is defensible in a design review?',
          options: [
            '"It is the industry standard, and every engine supports it, so we get portability."',
            '"Because directory listing is neither cheap nor consistent, and there is no way to make two writes visible at once. The tree lets a scan reach the file list in a couple of reads instead of on the order of 1,400 LIST requests for a million-object prefix, and it reduces an arbitrarily large change to one conditional write. The overhead is compaction, expiry and orphan cleanup, which is a budget we own."',
            '"It gives us ACID transactions on object storage, so we can treat the lake as a database and stop worrying about concurrency."',
            '"It makes queries faster because the metadata is smaller than the data."',
            ],
          correct: [1],
          explanation:
            'The defensible version names the two storage properties that force the design, gives an arithmetic anchor for the planning saving, and states the recurring cost as something with an owner — which is what makes it a design position rather than a preference. Portability is real but it is a consequence, not the mechanism, and it evaporates the moment somebody writes files without committing them. "ACID on object storage, so stop worrying" is the answer that loses the room: the guarantee is one compare-and-set wide, it depends on every writer going through the same catalog, and it explicitly does not cover writers that touch storage directly. And the metadata being smaller than the data is not why anything is faster — C3.L1 measured a footer at 16.36% of a file, and a manifest tree that nobody compacts is precisely how planning became 61% of query time in C2.L5.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: read both specifications, then read what they were reacting to',
      md: `**Read the Iceberg spec's "Overview", "Optimistic Concurrency" and "Commit Conflict Resolution and Retry" sections.** They are a few pages and they are unusually candid: which retries are legal for which operation, why sequence numbers are inherited rather than written, and the note deprecating file-system commits as unsafe in object stores. Then read **"Scan Planning"**, which is the clearest statement anywhere of how a predicate on data values becomes a predicate on partition values via inclusive projection — the mechanism that makes C2.L2's partition pruning work without the user writing partition predicates.

**Read Delta's PROTOCOL.md** for the same story told as a log rather than a tree: actions, action reconciliation, checkpoints, and the \`catalogManaged\` feature, which is worth reading closely because it is the industry converging on "the catalog is the source of truth" from the other direction. The section on multi-part checkpoints and why they are deprecated is a compact lesson in why atomicity has to be one operation wide.

For the original problem statement, **Armbrust et al., "Delta Lake: High-Performance ACID Table Storage over Cloud Object Stores" (VLDB 2020)** is the paper to read — it enumerates exactly what object stores do and do not guarantee and derives the log from it. Pair it with **Ryan Blue's Iceberg talks** for the design history: the Netflix-era pain of Hive tables on object storage, listing costs, and correctness bugs that came from directory-based membership.

For the underlying primitive, the literature is older than the lakehouse: **compare-and-swap** and the general result that a single atomic conditional write is enough to build consensus among two participants. **Herlihy's "Wait-Free Synchronization" (1991)** is the formal version of why one CAS is not a small thing. And the operational half — **what your object store's conditional-write and consistency guarantees actually are** — is documentation you should read in your own provider's words rather than trusting a summary, because it has changed materially in the last few years and it is the foundation everything above rests on.

Next: **C3.L4** takes the tree and does the smallest possible thing to it — change three rows — and measures what that costs. The answer is 49,152 rows rewritten, and the interesting part is which direction the fix runs.`,
    },
  ],
}

export default lesson
