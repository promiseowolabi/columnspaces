import type { Lesson } from '../types'

const lesson: Lesson = {
  id: 'c5.l1',
  slug: 'why-column-stores-hate-updates',
  trackId: 'c5',
  index: 1,
  title: 'Why Column Stores Hate Updates',
  minutes: 16,
  hook: 'You want to change one value. The value does not exist as a value: it is a code in a dictionary, packed at a width the whole page shares, compressed with its neighbours, and summarised by statistics that describe all of them. There is nothing there to edit.',
  exercise: 'quiz',
  takeaway: {
    number: '8,192 values',
    claim:
      'A single changed value re-encodes its whole page — take 8,192 values a page and that is the floor, before the footer offsets, the statistics and the file itself move — so no column store edits in place; every one of them accepts the change somewhere cheap and reconciles later.',
  },
  blocks: [
    {
      type: 'prose',
      md: `Everything in C1 through C4 made reading cheaper by making the *block* the unit. A dictionary is amortised over a page. A bit-packing width is chosen for a page. A run length spans as many neighbours as it can. Min/max statistics describe a row group. A filter is evaluated against a batch and a compressed operator consumes a run whole. Every one of those wins came from treating many values as one object.

Now change one row.

The reason you cannot is not that the format forbids it, or that the engine has not implemented it yet. It is that **the thing you want to edit does not exist as a separate thing.** Walk down the ladder for a single \`status\` value in a dictionary-encoded, bit-packed page:

- the value is not stored — a **code** is, an index into the page's dictionary;
- the code is not byte-aligned — it is packed at a width the whole page shares, so writing a code that no longer fits re-packs every code after it;
- if the new value is not already in the dictionary, the dictionary grows, and if it grows past a power of two the width changes and **every code in the page re-packs**;
- the page is then compressed as a unit, so its compressed length changes, which moves every byte after it;
- the page's byte offset and size are recorded in the column chunk metadata, and the chunk's offsets are recorded in the footer — so those move too;
- and the row group's **statistics describe all of the values**, not this one, so min, max and null count may now be wrong.

Take a page of 8,192 values as the worked case — the batch size C4 used, and a reasonable page in practice. **One changed value re-encodes 8,192.** That is the floor of an in-place edit, before anything downstream, and the ladder above says the real answer is worse: the smallest thing a columnar file can honestly rewrite is the file.`,
    },
    {
      type: 'prose',
      md: `## The arithmetic, and where it has already been measured

You do not have to take the "whole file" claim on faith, because C3.L4 measured it on real Parquet files in the tab: **three rows changed, 49,152 rows rewritten, a byte amplification of about 16,384×** at 16,384-row files, with bytes read landing within 10% of bytes written because the rewrite has to read every row before it can write it back.

Do not re-derive that here. Build past it, because there are two consequences of it that people miss even after they have accepted the number.

**The read side of a write.** A copy-on-write update is a *scan plus a write of the same magnitude*. On a consumption-priced platform this means an update shows up twice, and neither time on a dashboard that graphs query volume. C0.L5's rule is the one that bites: the optimisation and the pricing shape have to match.

**The width of the change is irrelevant to its cost.** Rewriting a file to change one value costs the same as rewriting it to change every value in it. So the interesting variable is not how much data changed — it is **how many files the change touched**, which is set by your physical layout and by nothing about the update statement. Two hundred single-row erasure requests scattered across a table are 200 file rewrites; the same 200 rows inside one file are one.

That asymmetry is why the write path is a design problem rather than a tuning problem, and it is worth writing down as a two-line cost model you can carry:

\`\`\`text
copy-on-write cost   ≈ files_touched × file_bytes          (read AND write)
                       independent of rows changed

merge-on-read cost   ≈ change_bytes                        at write time
                     + delta_bytes + footers per READ      until compaction
\`\`\`

Nobody chooses the first model because it is good at updates. They choose it because reads pay nothing, and then they discover the write path. The rest of C5 is about deciding that trade with numbers instead of discovering it with an invoice.`,
    },
    {
      type: 'code',
      filename: 'one-value.txt',
      lang: 'text',
      chips: ['1 value changed', '8,192 re-encoded', 'every offset after it moves'],
      code: `page, before                          page, after "APPROVED" -> "VOIDED_BY_OPS"

dictionary   [PENDING, APPROVED, SHIPPED]  dictionary   [PENDING, APPROVED, SHIPPED,
                                                         VOIDED_BY_OPS]        <- grew
codes        2 bits/value x 8,192          codes        2 bits was enough for 3 values;
             = 2,048 B                                  4 values still fit in 2 bits —
                                                        but 5 would not, and then all
                                                        8,192 codes re-pack

compressed   1 unit, length L              compressed   1 unit, length L'  (L' != L)
                                                        -> every byte after this page
                                                           shifts

chunk meta   page offset, page size,       chunk meta   all three change
             uncompressed + compressed

footer       column chunk offsets,         footer       offsets move; min/max/null_count
             row-group statistics                       must be RECOMPUTED, and a stale
                                                        one is a wrong answer, not a bill

file         PAR1 ... data ... footer      file         written once, end to end. The
             ... footer length ... PAR1                 format has no edit operation.`,
    },
    {
      type: 'prose',
      md: `## The statistics are the part that makes in-place editing unsafe rather than merely awkward

Everything above is cost. This part is correctness, and it is the reason "we will patch the bytes carefully" is not an engineering plan.

C2's non-negotiable rule: a pruning decision is a **proof**. A planner may skip a block only when the block's statistics make a match impossible. Forge lab 02 grades \`no_false_negatives\` with zero tolerance and grades the pruning ratio only in a band, because reading a block that held nothing is a bill and skipping a block that held a match is a wrong answer.

Now suppose you edit a value in place and the statistics do not move with it. Nothing errors. Nothing logs. Every subsequent query that filters on that column may skip the block that contains your new value, and the row you just wrote silently vanishes from results. **An in-place update is a false-negative generator**, and it is the worst kind because the symptom is a plausible number in a report rather than a stack trace.

So the invariant every columnar system enforces instead is: **data files are immutable, and the statistics are written with the data, in the same act, by the same writer.** That is not a limitation the formats are trying to grow out of. It buys three things a mutable file cannot offer:

- **readers need no locks.** A file that never changes can be read by anyone at any time, cached anywhere, and copied to another region while it is being read. C3's snapshot isolation rests on this entirely — a snapshot is a list of files that nobody will edit.
- **statistics can be trusted without revalidation.** They were computed over exactly the bytes they describe, and those bytes cannot have changed since.
- **the commit is a pointer swap.** Atomicity comes for free when the only mutable thing in the system is one reference.

Which produces the sentence at the centre of this track, and it is worth memorising in this shape because every system converges on it:

> **You cannot edit the block. So accept the change somewhere cheap, and reconcile later.**

The two halves are the whole design space. *Somewhere cheap* is a write buffer or a delta store (C5.L2). *Reconcile later* is a merge on the read path and a compaction policy behind it (C5.L3–L5). Everything else — position deletes, equality deletes, deletion vectors, MergeTree parts, LSM runs, a tuple mover — is an implementation of those two clauses.`,
    },
    {
      type: 'callout',
      variant: 'segfault',
      title: 'the update that returns wrong answers instead of a bill',
      md: `The tempting shortcut, said out loud in a real meeting: *"the corrected value is the same length as the old one, so we can patch it in the file and skip the rewrite."*

Trace it. Even in the luckiest case — the new value is already in the dictionary, the code fits the existing width, the page is stored uncompressed — you have changed the values a row group's statistics describe. If the new value falls outside the recorded min/max, then:

- every query with a range predicate on that column may skip the row group, because its statistics prove the value is not there. They were right when they were written and they are now a lie.
- a bloom filter on that column, if present, has no entry for the new value, so an equality predicate skips the block too (C2.L4 — a bloom filter answers "definitely not present", which is precisely the answer that is now wrong).
- the page's CRC, if written, no longer matches, so a reader that validates checksums rejects the file and one that does not, silently trusts it.

**The failure mode is a missing row, not an error.** It shows up as a total that is slightly low, weeks later, in a report somebody is presenting. This is why immutability is enforced by the writers rather than by policy, and why the honest way to describe the columnar write path in a review is: *the format traded update cost for the guarantee that a statistic can never be stale.*`,
    },
    {
      type: 'vendor',
      snapshot: '2026-09',
      title: 'The format says so in its own words: metadata after the data, single-pass writing',
      systems: ['parquet', 'iceberg'],
      sources: [
        'https://parquet.apache.org/docs/file-format/',
        'https://iceberg.apache.org/docs/latest/configuration/',
      ],
      md: `**Parquet.** The file-format page gives the layout as magic number, then column chunks grouped into row groups, then \`File Metadata\`, then a 4-byte metadata length, then the magic number again — and states the reason plainly: *"File metadata is written after the data to allow for single pass writing."* It also states what that metadata is for: *"The file metadata contains the locations of all the column chunk start locations"*, and readers are *"expected to first read the file metadata to find all the column chunks they are interested in."*

Read that as a design decision about writes rather than reads. A footer of offsets computed while streaming data out is what makes a Parquet writer single-pass and cheap. It is also exactly what makes the file unpatchable: every offset in the footer is a fact about byte positions, and any change to a page's compressed length invalidates the offsets of everything after it. There is no update operation in the format, and that is not an omission.

**Iceberg** puts the consequence in configuration. Row-level changes are governed by three table properties — \`write.delete.mode\`, \`write.update.mode\` and \`write.merge.mode\` — each documented as *"copy-on-write or merge-on-read (v2 and above)"*, and each defaulting to **copy-on-write**. So the choice this track is about is a table property with a default, the default is the rewrite, and somebody on your team either set it deliberately or inherited it. C5.L3 is where you decide which, with arithmetic.

Verify both against your own versions; the durable part is the shape — files are written once, their metadata describes them completely, and changing a row means writing a different file or writing a note beside it.`,
    },
    {
      type: 'diagram',
      caption: 'fig 1 — the ladder that ends at "the file", and the fork every column store takes at the bottom',
      height: 72,
      nodes: [
        { id: 'val', x: 2, y: 2, w: 22, h: 9, label: 'a value', sub: 'does not exist — a code does', color: '#FB923C' },
        { id: 'page', x: 26, y: 2, w: 22, h: 9, label: 'a page', sub: 'shared dictionary + one packed width', color: '#22D3EE' },
        { id: 'chunk', x: 50, y: 2, w: 22, h: 9, label: 'a column chunk', sub: 'page offsets and sizes recorded', color: '#22D3EE' },
        { id: 'file', x: 74, y: 2, w: 24, h: 9, label: 'a file', sub: 'footer of offsets, written last', color: '#22D3EE' },
        { id: 'unit', x: 2, y: 15, w: 96, h: 10, label: 'so the smallest honestly rewritable unit is the FILE — and its cost does not depend on how much you changed', sub: 'C3.L4 measured it: 3 rows in, 49,152 rows rewritten, ≈16,384× byte amplification, bytes read ≈ bytes written', color: '#FB7185' },
        { id: 'inplace', x: 2, y: 29, w: 46, h: 10, label: 'option A · edit in place', sub: 'offsets move, statistics go stale, pruning starts skipping live rows', color: '#FB7185' },
        { id: 'cheap', x: 52, y: 29, w: 46, h: 10, label: 'option B · accept it somewhere cheap', sub: 'a write buffer or a delta file, plus a note about what it supersedes', color: '#3EF2A4' },
        { id: 'wrong', x: 2, y: 43, w: 46, h: 10, label: 'A fails as a WRONG ANSWER, not a bill', sub: 'a stale statistic is a false negative, and C2 grades that pass/fail', color: '#FB7185' },
        { id: 'defer', x: 52, y: 43, w: 46, h: 10, label: 'B defers the cost onto every reader', sub: 'read amplification grows with the delta until something folds it in', color: '#FBBF24' },
        { id: 'recon', x: 2, y: 57, w: 96, h: 10, label: 'reconcile later: a merge on the read path, and a compaction policy with a stated write-amplification budget', sub: 'forge lab 05 grades exactly this pair — read_amp_bounded against write_amp_budget, on one workload, in opposing bands', color: '#A78BFA' },
      ],
      edges: [
        { from: 'val', to: 'page' },
        { from: 'page', to: 'chunk' },
        { from: 'chunk', to: 'file' },
        { from: 'file', to: 'unit' },
        { from: 'unit', to: 'inplace' },
        { from: 'unit', to: 'cheap' },
        { from: 'inplace', to: 'wrong' },
        { from: 'cheap', to: 'defer' },
        { from: 'defer', to: 'recon' },
      ],
      steps: [
        {
          caption:
            'Start at the value you wanted to change and notice it is not stored: a dictionary code is, packed at a width the entire page shares, so the smallest addressable thing is already thousands of values wide.',
          active: ['val', 'page'],
          edges: ['val->page'],
        },
        {
          caption:
            'Climb one rung and the page\'s compressed length is recorded in the column chunk, whose offsets are recorded in a footer written after all the data — which is what makes a Parquet writer single-pass and the file unpatchable.',
          active: ['chunk', 'file'],
          edges: ['page->chunk', 'chunk->file'],
        },
        {
          caption:
            'So the unit of change is the file, and its cost is independent of how many rows you touched: C3.L4 measured three changed rows producing 49,152 rewritten ones, read in full before being written back.',
          active: ['unit'],
          edges: ['file->unit'],
        },
        {
          caption:
            'That leaves two options, and only one of them is available. Editing in place moves every offset after the edit and leaves the row group\'s statistics describing values that are no longer there.',
          active: ['inplace', 'wrong'],
          edges: ['unit->inplace', 'inplace->wrong'],
        },
        {
          caption:
            'Which is not an expensive mistake but a silent one: a planner is allowed to skip a block whose statistics prove no match, so a stale statistic deletes live rows from results with no error anywhere.',
          active: ['wrong'],
        },
        {
          caption:
            'The available option is to accept the change somewhere cheap — a buffer or a small delta file that says what it supersedes — which is fast to write and moves the work onto every subsequent reader.',
          active: ['cheap', 'defer'],
          edges: ['unit->cheap', 'cheap->defer'],
        },
        {
          caption:
            'And because deferred work accumulates, the design is only finished when it has a reconciliation policy with a budget: read amplification bounded, write amplification stated, both graded on the same workload.',
          active: ['recon'],
          edges: ['defer->recon'],
        },
      ],
    },
    {
      type: 'statline',
      stats: [
        {
          value: '8,192 values',
          label: 're-encoded by one changed value',
          hint: 'The floor of an in-place edit, at a page of 8,192 values. If the dictionary crosses a power of two the packed width changes and every code in the page is rewritten regardless.',
        },
        {
          value: '16,384×',
          label: 'byte amplification of a 3-row update, measured',
          hint: 'From C3.L4\'s snapshot lab at 16,384-row files. Cited, not re-derived — and the read side is the same size, because the rewrite must read every row before writing it back.',
        },
        {
          value: '0 rows',
          label: 'a stale statistic may hide',
          hint: 'The C2 invariant. Pruning must never skip a block holding a match, which is why statistics are written with the data and files are immutable rather than patched.',
        },
        {
          value: '2 clauses',
          label: 'the whole design space',
          hint: 'Accept the change somewhere cheap; reconcile later. Delta stores, deletion vectors, MergeTree parts, LSM runs and tuple movers are all implementations of those two clauses.',
        },
      ],
    },
    {
      type: 'isomorphism',
      title: 'immutable blocks ≡ three systems you already operate this way',
      pairs: [
        {
          os: 'a NAND flash page',
          osLine:
            'You cannot overwrite a page; you write a new one elsewhere and let the flash translation layer remap the address. Old pages accumulate until garbage collection reclaims them, and the ratio of media writes to host writes has a name: write amplification.',
          llm: 'a columnar data file',
          llmLine:
            'The same mechanism one layer up. The delta store is the new page, the merge is the translation layer, compaction is the garbage collector, and the vocabulary transfers unchanged — which is why the flash literature is the best-calibrated place to learn write amplification.',
        },
        {
          os: 'a write-ahead log plus a checkpoint',
          osLine:
            'Accept the change as a cheap sequential append, keep the expensive structure clean, and reconcile on a schedule. Recovery replays the log; a reader consults both.',
          llm: 'a delta store plus a merge',
          llmLine:
            'Identical two-clause shape, with one addition the WAL does not have: here the *reader* pays the reconciliation, on every query, until compaction runs. That is the cost C5.L3 makes you bound.',
        },
        {
          os: 'a build artifact',
          osLine:
            'You do not patch a compiled binary to change a constant; you rebuild it, because the artifact is derived and internally consistent. Patching it works right up until the checksum, the symbol table or the next build disagrees.',
          llm: 'a Parquet file',
          llmLine:
            'Also derived and internally consistent: offsets, lengths and statistics all describe each other. Rewriting is not a workaround for a missing feature — it is the only operation that keeps the file honest.',
        },
      ],
    },
    {
      type: 'quiz',
      questions: [
        {
          q: 'A correction arrives: one order\'s status must change from "APPROVED" to "VOIDED". An engineer proposes writing the new dictionary code directly into the existing page, arguing the code is the same width so no bytes move. What is the strongest objection?',
          options: [
            'Page checksums would fail, so the file would be rejected at read time and the change would be caught immediately',
            'The row group\'s statistics describe every value in it. If the patched value falls outside the recorded min/max — or is missing from a bloom filter — a planner is entitled to skip that block, and the row silently disappears from any query with a predicate on that column. The failure is a wrong answer with no error, which is why C2 grades false negatives pass/fail',
            'The dictionary is sorted, so inserting a new code would reorder every other code in the page',
            'Parquet files are opened read-only by most engines, so the write would need a lower-level tool but is otherwise sound',
          ],
          correct: [1],
          explanation:
            'Cost is not the objection here; correctness is. Statistics are a proof that a block cannot contain a match, and a patched value that falls outside them turns that proof into a lie — after which pruning removes live rows from results with nothing logged anywhere. That is strictly worse than an expensive rewrite. Checksums are a real hazard but the weakest form of the argument: they are optional, and a reader that skips validation trusts the file happily. The dictionary-ordering claim is wrong as stated — a dictionary need not be sorted — and "read-only by most engines" treats an invariant as a tooling gap, which is the mindset that produces the incident.',
        },
        {
          q: 'A compliance workflow will submit roughly 300 single-row updates a day against a 4 TB copy-on-write table whose files average 512 MB. Your platform bills on bytes processed. What do you put in the design review?',
          options: [
            'That the change volume is negligible — 300 rows against 4 TB is far below any threshold worth designing around — and that compression will keep the write cost small',
            'That per-request cost is set by files touched, not rows changed: about 512 MB read plus 512 MB written per scattered request, so ~300 requests a day is on the order of 150 GB read and 150 GB written for 300 rows, plus a superseded copy of each file retained until expiry. The fixes are batching requests into one commit per period, and moving this table\'s delete and update modes to merge-on-read',
            'That the cluster should be scaled up so the rewrites complete inside the maintenance window, and the file size raised to 1 GB so fewer files are affected per request',
            'That statistics need recollecting more often, since the updates will otherwise degrade pruning and inflate the scan bill',
          ],
          correct: [1],
          explanation:
            'Do the multiplication before naming a mechanism. A scattered single-row update rewrites whole files, so the unit cost is the file size and the row count is irrelevant — 300 requests at 512 MB is a backfill-sized workload wearing maintenance clothes, and it appears twice on a bytes-processed bill because the rewrite must read before it writes. "Negligible" is the answer that gets found later holding an invoice, and compression is already applied to both sides so it changes nothing about the ratio. Scaling up buys wall-clock, not bytes, and raising the target file size runs the wrong way: C3.L4 measured amplification falling monotonically as files get smaller, so bigger files make each request more expensive. Recollecting statistics addresses a problem this workload does not have.',
        },
        {
          q: 'Someone summarises the lesson as: "immutability is a Parquet limitation that table formats work around." Why is that framing wrong in a way that matters operationally?',
          options: [
            'It is only wrong about attribution — the limitation is really in object storage, which cannot modify an object in place',
            'Immutability is what the read path is built on: a file that never changes needs no reader locks, can be cached and replicated freely, and lets a snapshot be nothing more than a list of files — so atomic commits, time travel and trustworthy statistics are consequences of it, not workarounds for it. Table formats do not remove immutability; they add a way to express change without violating it',
            'It is wrong because newer format versions do support in-place edits through deletion vectors, which modify the data file',
            'It is wrong because compaction rewrites files anyway, so files are effectively mutable and the distinction is academic',
          ],
          correct: [1],
          explanation:
            'The framing matters because it predicts the wrong roadmap: if immutability were a defect, the right move would be to wait for it to be fixed, and the right move is actually to design a write path. Immutability is load-bearing — it is why a snapshot can be a file list, why a commit can be a pointer swap, and why statistics can be trusted without revalidation. Object-store semantics reinforce it but did not cause it; local Parquet files are equally unpatchable. Deletion vectors are the opposite of an in-place edit: they are a separate file recording which positions to ignore, which is exactly "express change without violating immutability". And compaction writes new files and swaps a pointer, which is a demonstration of the rule rather than an exception to it.',
        },
      ],
    },
    {
      type: 'deepdive',
      title: 'going deeper: the papers that named this problem, and the one conjecture that frames it',
      md: `The split this lesson ends on is twenty years old and was explicit from the start. **Stonebraker et al., "C-Store: A Column-oriented DBMS" (VLDB 2005)** proposes a read-optimised store (RS) and a *writable store* (WS) with the same logical schema, plus a **tuple mover** that migrates data from WS to RS in batches. Read the WS section specifically: it is a small, write-optimised, differently-encoded structure that queries must consult alongside RS, which is the delta store you will build in forge lab 05 with the names changed.

For the precise mechanics of applying updates by *position* rather than by key, the reference is **Héman, Zukowski, Nes, Sidirourgos and Boncz, "Positional Update Handling in Column Stores" (SIGMOD 2010)** and its Positional Delta Trees. The insight that transfers even if you never implement a PDT: a delta keyed by position can be merged into a scan in a single pass with no key comparison, which is why Iceberg's position deletes exist and why they are cheaper to apply than equality deletes.

The frame for the whole track is the **RUM conjecture — Athanassoulis, Kester, Maas, Stoica, Idreos, Ailamaki and Ada, "Designing Access Methods: The RUM Conjecture" (EDBT 2016)**: read overhead, update overhead and memory overhead, pick two. Columnar storage picks read and memory, which is a choice, and this track is the bill for it. **O'Neil, Cheng, Gawlick and O'Neil, "The Log-Structured Merge-Tree" (1996)** is where the other corner of the triangle was worked out, and **Dayan, Athanassoulis and Idreos on Monkey (SIGMOD 2017)** is where LSM tuning became arithmetic rather than folklore.

For write amplification as a first-class metric with a mature vocabulary, go to the flash literature rather than the database literature. It has been measuring media writes per host write for two decades, and every term — write amplification, garbage collection, over-provisioning, steady state — maps onto compaction with no translation.

And read **Abadi, Boncz and Harizopoulos's column-store survey** for why the encodings in C1 and the update problem in C5 are the *same* decision seen from two ends: everything that makes a block cheap to read makes it expensive to change.

Next: **C5.L2**. If the change has to land somewhere cheap, that somewhere needs to be durable, bounded, and — the part most designs get wrong — queryable, or your freshness waits for a background job.`,
    },
  ],
}

export default lesson
