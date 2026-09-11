/**
 * Column Week — five scripted incident cards (the platform's oral exam).
 * Static telemetry, no wasm: the reader reads the curves, calls the root cause
 * and the mitigation. Adapted from tablespace's Crash Week, which took the
 * pattern from byzantine's Partition Drills.
 *
 * Selection rule for these five: each one is a failure that *only* happens to
 * columnar platforms, and each one is diagnosable from counts alone — no wall
 * clock, no vendor-specific telemetry. A drill that needs a stopwatch is not
 * replayable, and a drill that needs a product is not teachable here.
 */

export interface DrillOption {
  id: string
  label: string
  correct: boolean
}

export interface DrillSeries {
  label: string
  color: string
  values: number[]
}

export interface DrillIncident {
  id: string
  title: string
  briefing: string
  telemetry: DrillSeries[]
  causes: DrillOption[]
  mitigations: DrillOption[]
  /** shown after the correct call — the "what just happened" paragraph */
  debrief: string
}

const flat = (v: number, n: number) => Array.from({ length: n }, () => v)
const ramp = (from: number, to: number, n: number) =>
  Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * i) / (n - 1)))
const step = (before: number, after: number, at: number, n: number) =>
  Array.from({ length: n }, (_, i) => (i < at ? before : after))

export const DRILLS: DrillIncident[] = [
  {
    id: 'pruning-collapse',
    title: 'INC-1 — The Dashboard That Tripled Its Bill',
    briefing:
      'Overnight, the finance dashboard\'s daily scan volume went from 1.2 TB to 3.9 TB. Nothing was deployed: the queries are byte-identical, the table schema is unchanged, row counts grew 3% as usual. The dashboard is as fast as ever, which is why nobody noticed until the invoice. The layout was designed around a sort on event_time, and the recurring query filters on a seven-day window. Something upstream changed, and the metadata knows what.',
    telemetry: [
      { label: 'row groups read', color: '#FB7185', values: [...flat(180, 12), ...step(180, 1620, 0, 12)] },
      { label: 'row groups pruned %', color: '#3EF2A4', values: [...flat(89, 12), ...flat(11, 12)] },
      { label: 'rows in table (M)', color: '#5CA8FF', values: ramp(2000, 2060, 24) },
      { label: 'event_time clustering depth', color: '#FBBF24', values: [...flat(1, 12), ...flat(9, 12)] },
    ],
    causes: [
      {
        id: 'a',
        label:
          'The upstream loader stopped writing in event_time order, so each row group now spans the whole time range — min/max statistics overlap the predicate everywhere and nothing can be skipped',
        correct: true,
      },
      { id: 'b', label: 'The table grew past a size threshold and the engine switched to full scans', correct: false },
      { id: 'c', label: 'Statistics are stale and need recollecting before the planner will prune again', correct: false },
      { id: 'd', label: 'Compression degraded, so the same rows now occupy more bytes', correct: false },
    ],
    mitigations: [
      {
        id: 'a',
        label:
          'Re-cluster the affected partitions on event_time and fix the loader ordering — then alert on clustering depth, because it moved 12 hours before the invoice did',
        correct: true,
      },
      { id: 'b', label: 'Add more partitions on event_time to force finer-grained pruning', correct: false },
      { id: 'c', label: 'Add a bloom filter on event_time so the planner can skip blocks again', correct: false },
      { id: 'd', label: 'Increase the compute size so the larger scan completes in the same wall-clock time', correct: false },
    ],
    debrief:
      'Pruning is not a feature the engine provides; it is a property your physical layout makes possible. Zone maps let a scan skip a block only when the block\'s min/max cannot satisfy the predicate — which requires values to be physically clustered. An unordered write pattern gives every block nearly the full range, so every block might contain a match and none can be skipped. The query is unchanged, the plan looks the same, latency barely moves because the engine is wide enough to absorb it, and the only visible symptom is bytes. This is why clustering depth belongs on a dashboard next to cost: it is the leading indicator, and the bill is the lagging one. Note also which mitigations are traps: bloom filters answer equality, not ranges, and more partitions on a time column makes the file count worse while doing nothing about within-file ordering.',
  },
  {
    id: 'small-file-storm',
    title: 'INC-2 — Ten Thousand Files an Hour',
    briefing:
      'To hit a two-minute freshness target, streaming ingest was moved from 15-minute batches to 30-second micro-batches. Freshness improved exactly as designed. Two weeks later, query planning takes longer than query execution on the same table, and the ad-hoc queries that used to take seconds now spend most of their time before reading any data. Live file count is 1.4M against 9 TB of data.',
    telemetry: [
      { label: 'files created / hour', color: '#FB923C', values: [...flat(120, 8), ...step(120, 9600, 0, 16)] },
      { label: 'avg file size (MB)', color: '#5CA8FF', values: [...flat(240, 8), ...ramp(240, 6, 16)] },
      { label: 'planning time share %', color: '#FB7185', values: [...flat(4, 8), ...ramp(4, 61, 16)] },
      { label: 'compaction backlog (k files)', color: '#FBBF24', values: [...flat(0, 8), ...ramp(0, 940, 16)] },
    ],
    causes: [
      {
        id: 'a',
        label:
          'File creation rate now exceeds compaction throughput, so the backlog grows without bound: per-file metadata and per-file open cost dominate, and planning scales with file count rather than data size',
        correct: true,
      },
      { id: 'b', label: 'The catalog database needs an index rebuild to keep up with the metadata volume', correct: false },
      { id: 'c', label: 'Micro-batches compress worse, so the same data occupies more files', correct: false },
      { id: 'd', label: 'Query concurrency increased at the same time and the two effects compounded', correct: false },
    ],
    mitigations: [
      {
        id: 'a',
        label:
          'Size compaction capacity against the file-creation rate and raise the batch interval to the largest value the freshness SLA permits — the interval is the input variable, the file count is the consequence',
        correct: true,
      },
      { id: 'b', label: 'Keep the 30-second batches and scale up query compute to absorb the planning cost', correct: false },
      { id: 'c', label: 'Partition more finely so each query touches fewer files', correct: false },
      { id: 'd', label: 'Disable statistics collection on ingest to reduce metadata volume', correct: false },
    ],
    debrief:
      'Freshness and file size are the same dial viewed from two ends: halve the commit interval and you double the file count for the same data. That is fine only if compaction removes files at least as fast as ingest creates them — otherwise the backlog is unbounded and every query pays for it in planning, because planning enumerates files and reads their statistics. The arithmetic is the whole lesson: creation rate versus merge rate, with the batch interval as the only free variable and the freshness SLA as the constraint. Finer partitioning is the trap answer here; it reduces files per query only if the predicate matches the partition key, and it increases total file count unconditionally.',
  },
  {
    id: 'skewed-shuffle',
    title: 'INC-3 — The One Worker Nobody Was Watching',
    briefing:
      'A nightly join between events and accounts has crept from 8 minutes to 51. Cluster utilisation during the run averages 14%. Both tables grew normally. The plan is unchanged: a partitioned hash join on account_id. Per-partition byte counts are available and are the only telemetry you need.',
    telemetry: [
      { label: 'mean partition bytes (GB)', color: '#5CA8FF', values: flat(4, 24) },
      { label: 'max partition bytes (GB)', color: '#FB7185', values: ramp(9, 128, 24) },
      { label: 'workers idle %', color: '#94A3B8', values: ramp(20, 86, 24) },
      { label: 'spill bytes (GB)', color: '#FBBF24', values: [...flat(0, 10), ...ramp(0, 74, 14)] },
    ],
    causes: [
      {
        id: 'a',
        label:
          'Key skew: one account_id value now holds a large share of the rows, so its hash partition is far larger than the rest — the job runs at the speed of that single partition and spills once it exceeds memory',
        correct: true,
      },
      { id: 'b', label: 'The cluster is undersized for the data volume — mean partition size is the relevant number', correct: false },
      { id: 'c', label: 'Network bandwidth between nodes saturated during the shuffle', correct: false },
      { id: 'd', label: 'The join switched from broadcast to partitioned as the smaller table grew', correct: false },
    ],
    mitigations: [
      {
        id: 'a',
        label:
          'Split the hot key: salt it across sub-partitions and union the results, or handle the heavy hitters separately — and alert on max/mean partition ratio, since the mean was flat throughout',
        correct: true,
      },
      { id: 'b', label: 'Double the cluster size so the large partition completes faster', correct: false },
      { id: 'c', label: 'Increase per-worker memory so the spill stops', correct: false },
      { id: 'd', label: 'Force a broadcast join to eliminate the shuffle entirely', correct: false },
    ],
    debrief:
      'A distributed join runs for as long as its largest partition, so the mean is the least informative statistic available and it is the one every default dashboard shows. Hash partitioning distributes *keys* evenly, not *rows*: one value with a disproportionate share of rows lands entirely in one partition, and no amount of extra parallelism helps because the work cannot be divided further. Doubling the cluster leaves that partition on one worker; more memory stops the spill and leaves it single-threaded. The fix has to change the partitioning of that key specifically. The monitoring lesson generalises: for anything partitioned, alert on max over mean, because the maximum is the runtime.',
  },
  {
    id: 'silent-schema-change',
    title: 'INC-4 — The Column That Started Returning Zero',
    briefing:
      'A revenue model has been quietly wrong for eleven days. Upstream added a nullable column, discount_applied, and renamed the old one — mechanically a compatible change; every pipeline stayed green. The model reads discount_applied, gets null for older files and 0 after a downstream coalesce, and has been under-reporting discounts ever since. No job failed. No alert fired. The metadata shows exactly when it happened.',
    telemetry: [
      { label: 'schema version', color: '#A78BFA', values: [...flat(7, 10), ...flat(8, 14)] },
      { label: 'null rate: discount_applied %', color: '#FB7185', values: [...flat(0, 10), ...ramp(100, 38, 14)] },
      { label: 'ingest jobs failed', color: '#94A3B8', values: flat(0, 24) },
      { label: 'mean revenue per order', color: '#FBBF24', values: [...flat(84, 10), ...flat(91, 14)] },
    ],
    causes: [
      {
        id: 'a',
        label:
          'A semantic change was delivered as a schema-compatible one: adding a column and reading it as null-then-zero is mechanically valid and analytically wrong, and nothing in the pipeline checks meaning',
        correct: true,
      },
      { id: 'b', label: 'The table format failed to apply schema evolution correctly to older files', correct: false },
      { id: 'c', label: 'The coalesce in the consuming query is the bug and the platform behaved correctly', correct: false },
      { id: 'd', label: 'Statistics were not refreshed after the schema change, so the planner read stale values', correct: false },
    ],
    mitigations: [
      {
        id: 'a',
        label:
          'Publish schemas as versioned contracts where a change of meaning requires a new column rather than a redefinition, and alert on null-rate and distribution drift per column — the null rate moved on day one',
        correct: true,
      },
      { id: 'b', label: 'Backfill the new column across historical files so the null rate returns to zero', correct: false },
      { id: 'c', label: 'Pin consumers to a fixed snapshot so upstream changes cannot reach them', correct: false },
      { id: 'd', label: 'Require review on all upstream schema changes before they are merged', correct: false },
    ],
    debrief:
      'Schema evolution in a modern table format is a mechanical guarantee: adding a nullable column is safe *for the reader*, which is precisely what makes it dangerous for the consumer. The format has no opinion about meaning, so a redefinition wearing the costume of an addition passes every check and silently changes results. Backfilling fixes this instance and leaves the class of bug intact; pinning snapshots trades a wrong answer for a stale one; review helps only if reviewers know which consumers exist. The durable fix is a contract plus a detector: contracts make semantic change explicit, and distribution alerting catches the cases where somebody did it anyway. Note the shape of the failure — green pipelines, wrong numbers. That is the expensive kind, and job-status monitoring cannot see it.',
  },
  {
    id: 'disaggregation-surprise',
    title: 'INC-5 — Fine on Local Disk, Slow on the Fabric',
    briefing:
      'A workload was migrated from nodes with local NVMe to a disaggregated architecture: the same compute, the same data, storage now reached over a network fabric. Most queries are unchanged or better. One class of query — small, highly selective point-lookup-shaped reads issued at high concurrency by an application — degraded sharply. Aggregate throughput on the fabric is nowhere near saturated.',
    telemetry: [
      { label: 'fabric throughput used %', color: '#3EF2A4', values: flat(21, 24) },
      { label: 'requests / s', color: '#5CA8FF', values: ramp(400, 9800, 24) },
      { label: 'bytes per request (KB)', color: '#FB7185', values: ramp(512, 9, 24) },
      { label: 'p95 query latency (ms)', color: '#FBBF24', values: ramp(40, 610, 24) },
    ],
    causes: [
      {
        id: 'a',
        label:
          'The workload is request-bound, not bandwidth-bound: thousands of tiny reads each pay a per-request round trip, and small requests cannot amortise it — throughput is idle because the constraint is request latency and concurrency, not bytes',
        correct: true,
      },
      { id: 'b', label: 'The fabric is oversubscribed and needs more bandwidth provisioned', correct: false },
      { id: 'c', label: 'Disaggregated storage is simply slower and this workload should stay local', correct: false },
      { id: 'd', label: 'Compression is being applied on read and the decode cost moved to the compute nodes', correct: false },
    ],
    mitigations: [
      {
        id: 'a',
        label:
          'Make the requests bigger and fewer: coalesce reads, raise the minimum read granularity, prefetch by column chunk, and raise concurrency — then re-measure requests/s against bytes/request rather than watching bandwidth',
        correct: true,
      },
      { id: 'b', label: 'Provision additional fabric bandwidth to reduce latency', correct: false },
      { id: 'c', label: 'Cache the hot data on local disk and accept the coherence problem', correct: false },
      { id: 'd', label: 'Move this workload back to local NVMe and keep the rest disaggregated', correct: false },
    ],
    debrief:
      'Disaggregation changes which term of the cost model dominates. On local NVMe a small read is cheap in both latency and requests, so nobody thinks about request count. Across a fabric, every read carries a round trip, and a workload of thousands of tiny reads is bound by requests and outstanding-request concurrency while bandwidth sits idle — which is exactly what the telemetry shows: 21% throughput, rising request rate, falling bytes per request, rising latency. This is the same shape as the classic random-versus-sequential lesson, moved one layer out, and it is why "the network is the new disk" needs qualifying: fabrics have made bandwidth abundant and have not made round trips free. The general rule for evaluating any disaggregated platform — including on a proof-of-concept — is to measure requests per second and bytes per request, not just aggregate throughput, because the workloads that regress are the ones with small requests.',
  },
]
