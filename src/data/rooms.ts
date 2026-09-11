/**
 * rooms.ts — Design Review: five adversaries and the objection trees they
 * attack your artifacts with.
 *
 * ── Why this exists, and why it is the riskiest thing in the course ─────────
 * The engine half can grade a compiled artifact: the checks run, the codec
 * round-trips or it does not. The architecture half's subject is judgement, and
 * judgement does not compile. The obvious fallback — grade an essay — needs a
 * server and a model and produces a number nobody trusts.
 *
 * So the room is the grader. You submit numbers; an adversary attacks the
 * numbers you actually submitted. Every objection is a PURE PREDICATE over your
 * dossier, which buys three properties:
 *
 *   deterministic  — the same dossier always faces the same room. No RNG, no
 *                    model, no server. Replayable, reviewable, diffable.
 *   personal       — the CFO does not ask a generic question about partitions.
 *                    They ask why *your* partition scheme scans 40 TB a day.
 *   diagnostic     — a weak answer does not merely score zero; its rebuttal
 *                    names the cost you failed to model. Being wrong here
 *                    should feel like being caught, not like being marked.
 *
 * ── The failure mode to watch for ──────────────────────────────────────────
 * If the trees read as a quiz in costume, this design collapses into ordinary
 * reading and the architecture half loses its claim. The test for whether it
 * works: change ONE number in your dossier and a different objection must
 * appear.
 *
 * ── Why `the-vendor` matters most in THIS course ────────────────────────────
 * columnspaces deep-dives a platform we cannot run. The honest ending is not
 * "and therefore VAST is good"; it is a learner who can say exactly what a
 * proof-of-concept would have to measure, and what result would change their
 * recommendation. `the-vendor` is where that gets tested, and its
 * `poc_undefined` objection is the single most important objection in the
 * course.
 *
 * Outcomes are three-valued, because real reviews are:
 *   survive  — answered with a number you brought, or a tradeoff you had
 *              already named out loud. The only winning move.
 *   wounded  — plausible, but you conceded ground or deferred. Survivable
 *              once; fatal in aggregate.
 *   fatal    — exposed a cost you never modelled. One is enough to lose a
 *              severity-3 objection, and the room with it.
 */

import type { ArtifactId, RoomId } from './lessons/types'

/* ------------------------------- dossier ------------------------------- */

/**
 * Everything the learner has submitted, across every desk and artifact. The
 * rooms read this and nothing else — which is what makes them deterministic.
 * Every field is optional: a partial dossier is a realistic dossier, and the
 * gaps are exactly what the adversaries hunt for.
 */
export interface Dossier {
  /* ---- from scan-desk / Artifact: scan-budget ---- */
  /** Logical table size in bytes, before compression. */
  logicalBytes?: number
  /** Bytes scanned per day across the workload. */
  dailyScanBytes?: number
  /** Bytes scanned by the single most expensive recurring query. */
  worstQueryBytes?: number
  /** How the platform is billed. Shape, never a price. */
  pricingShape?: 'consumption-bytes' | 'consumption-credits' | 'instance' | 'capacity' | 'appliance'
  /** Does the plan include a growth term at all? */
  growthModelled?: boolean
  /** Annual data growth, as a multiplier (1.5 = +50%/yr). */
  growthRate?: number
  /** Compression ratio the plan assumes. */
  compressionRatio?: number
  /** Was the compression ratio measured on real data, or assumed? */
  compressionMeasured?: boolean

  /* ---- from layout-desk / Artifact: layout-design ---- */
  partitionKey?: string
  sortKey?: string
  /** Distinct partition values expected. High cardinality here is a file-count bomb. */
  partitionCardinality?: number
  /** Promised fraction of blocks pruned on the target query. 0.9 = 90% skipped. */
  promisedPruningRatio?: number
  /** Measured, or hoped for? */
  pruningMeasured?: boolean
  /** Target file size in bytes. */
  targetFileSizeBytes?: number
  /** Total live file count. */
  fileCount?: number
  /** Did they name the query their layout is BAD for? */
  worstQueryStated?: boolean

  /* ---- from ingest-desk ---- */
  ingestMode?: 'batch' | 'micro-batch' | 'streaming' | 'cdc'
  batchIntervalSec?: number
  /** p99 end-to-end staleness, seconds. */
  stalenessP99Sec?: number
  /** What the business asked for, seconds. */
  freshnessSlaSec?: number
  /** Does compaction throughput exceed the ingest file-creation rate? */
  compactionKeepsUp?: boolean

  /* ---- from compaction-desk / Artifact: platform-runbook ---- */
  /** Bytes written by background maintenance ÷ bytes of logical change. */
  writeAmplification?: number
  /** Bytes read per query ÷ bytes the answer needed. */
  readAmplification?: number
  compactionAutomated?: boolean
  /** Snapshot/time-travel retention, days. */
  expiryWindowDays?: number
  /** Is the cost of running maintenance a line item? */
  maintenanceCosted?: boolean

  /* ---- from tenancy-desk ---- */
  tenants?: number
  tenancyModel?: 'table-per-tenant' | 'schema-per-tenant' | 'shared-table-filter' | 'cluster-per-tenant'
  /** Can spend be attributed per tenant from platform telemetry? */
  costAttribution?: boolean
  /** Is there any protection against one tenant's query starving others? */
  noisyNeighbourControl?: boolean

  /* ---- from capacity-desk ---- */
  horizonMonths?: number
  /** The component the learner says saturates first. */
  firstBottleneck?: 'storage' | 'compute' | 'catalog' | 'network' | 'ingest'
  /** Peak concurrent queries planned for. */
  peakConcurrency?: number
  /** Provisioned ÷ required. Below 1 is a plan that already fails. */
  headroomFactor?: number

  /* ---- from tco-desk / Artifact: platform-memo ---- */
  choice?: 'managed-warehouse' | 'engine-on-object-store' | 'appliance-platform'
  threeYearTotal?: number
  /** Is ongoing operational labour in the total? */
  statedOngoingOps?: boolean
  /** Engineer-months per year to operate it. */
  opsEngineerMonths?: number
  migrationCost?: number
  /** Cost to leave, computed rather than asserted. */
  exitCost?: number
  /** Is the data in an open format a second engine could read? */
  openFormat?: boolean

  /* ---- governance / A2 ---- */
  retentionPolicyDays?: number
  /** Is there a tested path to delete one subject's rows? */
  erasurePath?: boolean
  /** Column- and row-level lineage available to auditors? */
  lineageEvidence?: boolean
  regions?: number
  residencyRequired?: boolean
  /** Are schema changes published as a versioned contract? */
  schemaContract?: boolean

  /* ---- consumer-facing / A2 ---- */
  querySloDefined?: boolean
  /** The p95 the platform promises, seconds. */
  querySloP95Sec?: number
  /** Alerting on result quality/freshness, not only on errors. */
  qualityAlerting?: boolean
  runbookExists?: boolean
  onCallRotation?: boolean

  /* ---- the POC / vendor evaluation ---- */
  /** Has the learner defined what a proof-of-concept would measure? */
  pocDefined?: boolean
  /** The specific metrics the POC would collect. */
  pocMetrics?: string[]
  /** A result that would make them choose differently. Falsifiability. */
  pocFalsifier?: boolean
  /** Was the platform under evaluation actually tested by the team? */
  benchmarkedOurselves?: boolean
  /** Are vendor-published numbers being quoted as if they were ours? */
  vendorNumbersQuoted?: boolean
}

/* ------------------------------ structure ------------------------------ */

export type Outcome = 'survive' | 'wounded' | 'fatal'

export interface Response {
  id: string
  label: string
  outcome: Outcome
  /** What the adversary says back. Must teach, not just score. */
  rebuttal: string
}

export interface Objection {
  id: string
  /** 3 = must be survived to pass the room. 1 = pressure, not a blocker. */
  severity: 1 | 2 | 3
  /** Which artifact this attacks. */
  artifact: ArtifactId
  /** Pure predicate over the dossier. Deterministic by construction. */
  fires: (d: Dossier) => boolean
  /** The adversary's line, with the learner's own numbers in it. */
  ask: (d: Dossier) => string
  responses: Response[]
}

export interface Room {
  id: RoomId
  adversary: string
  role: string
  /** How they open. Sets the register. */
  opening: string
  objections: Objection[]
  /** What they say when you survive the whole room. */
  closing: string
}

/* -------------------------------- helpers -------------------------------- */

const TB_ = 1_000 ** 4

const tb = (bytes: number | undefined): string =>
  bytes === undefined ? 'an unstated number of' : (bytes / TB_).toFixed(1)

const num = (v: number | undefined): string => (v === undefined ? 'an unstated number' : v.toLocaleString('en-US'))

const money = (v: number | undefined): string =>
  v === undefined ? 'an unstated amount' : v.toLocaleString('en-US', { maximumFractionDigits: 0 })

/* ============================== the-cfo ============================== */

export const THE_CFO: Room = {
  id: 'the-cfo',
  adversary: 'Adaeze Mba',
  role: 'CFO',
  opening:
    "I approve the invoice for this platform every month and it has gone up every month for a year. I am not technical. I am going to ask what things cost, and I will keep asking until I get a number. If the answer begins with 'it depends', tell me what it depends on and give me both numbers.",
  closing:
    "Good. You brought arithmetic instead of adjectives and you told me the bad part before I found it. Send me the one-pager. Next time lead with cost per query — it is the only number I actually think in.",
  objections: [
    {
      id: 'daily_scan_unbudgeted',
      severity: 3,
      artifact: 'scan-budget',
      fires: (d) => d.dailyScanBytes === undefined,
      ask: () =>
        "You have asked me to approve a platform billed by how much data it reads, and nowhere in this document is a number for how much data it will read. What is it?",
      responses: [
        {
          id: 'computed',
          label:
            'Per query it is columns projected × rows surviving pruning, and I have that for each of the six recurring queries; multiplied by their daily frequency it comes to a figure I can show you, with the ad-hoc workload as a separate, wider band.',
          outcome: 'survive',
          rebuttal:
            'That is what I wanted. A recurring workload you can compute and an ad-hoc workload you have bounded separately — that is a budget, not a guess.',
        },
        {
          id: 'depends_on_users',
          label: 'It depends on how the analysts use it, so we plan to observe it for a quarter and report back.',
          outcome: 'wounded',
          rebuttal:
            'So you want me to sign an open-ended commitment and find out afterwards. I have done that once. Come back with a per-query number and a frequency, even if the frequency is a guess — a guess I can see is worth more than a blank.',
        },
        {
          id: 'compression_will_handle',
          label: 'Compression will keep it low — columnar data compresses roughly ten times.',
          outcome: 'fatal',
          rebuttal:
            'You have just told me the size of the stored data and called it the size of the bill. Those are different numbers: I am billed for what is read, and reading badly can scan the whole table however well it is compressed.',
        },
      ],
    },
    {
      id: 'no_growth_term',
      severity: 2,
      artifact: 'scan-budget',
      fires: (d) => d.growthModelled === false || (d.growthModelled === undefined && d.dailyScanBytes !== undefined),
      ask: (d) =>
        `You have given me ${tb(d.dailyScanBytes)} TB scanned per day as if it were a constant. Data does not do that. What does this cost me in twenty-four months?`,
      responses: [
        {
          id: 'growth_with_both_terms',
          label:
            'Two growth terms, separately: the table grows with the business, and the query mix grows as adoption spreads. I have the arithmetic for both, and the second one is larger and less predictable, which is why the layout matters more over time, not less.',
          outcome: 'survive',
          rebuttal:
            'Separating those two is the answer. Most people give me one growth number and it is always the smaller one.',
        },
        {
          id: 'linear_extrapolation',
          label: 'We assume it roughly doubles over two years and have budgeted accordingly.',
          outcome: 'wounded',
          rebuttal:
            'A number with no mechanism behind it. It might be right. I cannot tell, and neither can you, which means we will not know we are wrong until the invoice arrives.',
        },
        {
          id: 'elastic',
          label: 'The platform is elastic, so cost scales with usage automatically.',
          outcome: 'fatal',
          rebuttal:
            'Elastic means the bill moves without anyone approving it. You have described the mechanism by which I lose control of this line item and presented it as reassurance.',
        },
      ],
    },
    {
      id: 'pruning_promised_not_measured',
      severity: 3,
      artifact: 'layout-design',
      fires: (d) => (d.promisedPruningRatio ?? 0) >= 0.8 && d.pruningMeasured !== true,
      ask: (d) =>
        `Your saving rests on skipping ${((d.promisedPruningRatio ?? 0) * 100).toFixed(0)}% of the data unread. Did you measure that, or is it the design intent?`,
      responses: [
        {
          id: 'measured_on_sample',
          label:
            'Measured on a representative sample and reported as a range rather than a point, and I can tell you which query in the mix prunes worst — that one is the risk, not the average.',
          outcome: 'survive',
          rebuttal:
            'You volunteered your worst case. That buys you more credibility with me than the average ever will.',
        },
        {
          id: 'design_intent',
          label: 'It is the design intent based on how the sort key matches the predicate.',
          outcome: 'wounded',
          rebuttal:
            'Intent is not a measurement. If the upstream data arrives less ordered than you assume, the saving evaporates and the invoice tells me before you do.',
        },
        {
          id: 'engine_handles',
          label: 'The engine handles pruning automatically, so it will be in that range.',
          outcome: 'fatal',
          rebuttal:
            'The engine can only skip what your layout let it skip. You have outsourced the number that justifies this entire business case to a component you have not measured.',
        },
      ],
    },
    {
      id: 'maintenance_uncosted',
      severity: 2,
      artifact: 'platform-runbook',
      fires: (d) => d.maintenanceCosted !== true && (d.compactionAutomated === true || (d.writeAmplification ?? 0) > 1),
      ask: () =>
        'You have a background process constantly rewriting files that were already written. Who pays for that, and how much is it?',
      responses: [
        {
          id: 'write_amp_budget',
          label:
            'Compaction is a stated write-amplification budget: for every byte of change we rewrite a bounded multiple, and that multiple is a line item I can show you next to the read saving it buys.',
          outcome: 'survive',
          rebuttal:
            'A background process with a budget and a justification. Fine. The ones that frighten me are the ones nobody has a number for.',
        },
        {
          id: 'runs_off_peak',
          label: 'It runs off-peak, so it does not affect user-facing performance.',
          outcome: 'wounded',
          rebuttal:
            'I did not ask about performance. I asked who pays. Off-peak compute is still compute, and it is on my invoice at the same rate.',
        },
        {
          id: 'included',
          label: 'It is included in the platform — there is no separate charge for maintenance.',
          outcome: 'fatal',
          rebuttal:
            'Nothing is included. It is either metered as compute or it is amortised into the price you were quoted. You have not looked, which means there is a line item in my budget you cannot explain.',
        },
      ],
    },
    {
      id: 'exit_uncosted',
      severity: 2,
      artifact: 'platform-memo',
      fires: (d) => d.exitCost === undefined && d.choice !== undefined,
      ask: (d) =>
        `You are recommending ${d.choice ?? 'a platform'} at ${money(d.threeYearTotal)} over three years. What does it cost me to change my mind in year two?`,
      responses: [
        {
          id: 'exit_computed',
          label:
            'Computed, in three parts: moving the data, rewriting the pipelines and queries, and running both in parallel while we cut over. The data is in an open format, which makes the first part small and the second part the real cost.',
          outcome: 'survive',
          rebuttal:
            'You separated the storage from the labour. Most people quote me an egress figure and forget the six months of human work.',
        },
        {
          id: 'open_format_so_cheap',
          label: 'We are using an open table format, so exit is inexpensive.',
          outcome: 'wounded',
          rebuttal:
            'The files might be portable. The queries, the permissions, the schedules and the people are not. Give me the labour number.',
        },
        {
          id: 'no_plan_to_leave',
          label: 'We do not plan to leave, so I have not costed it.',
          outcome: 'fatal',
          rebuttal:
            'Then you have handed a supplier the knowledge that we cannot leave, and they will price accordingly at every renewal. That is not a technical oversight, it is a commercial one.',
        },
      ],
    },
  ],
}

/* ============================ the-principal ============================ */

export const THE_PRINCIPAL: Room = {
  id: 'the-principal',
  adversary: 'Ola Adeyemi',
  role: 'Principal engineer, not on your team',
  opening:
    "I have read the design. I am going to push on the parts you are most confident about, because that is where the unexamined assumptions live. I am not trying to block this — I am trying to find out whether you know why it works.",
  closing:
    "Right. You knew where your own design was weakest and you had already priced it. That is the difference between a design review and a presentation.",
  objections: [
    {
      id: 'partition_cardinality_bomb',
      severity: 3,
      artifact: 'layout-design',
      fires: (d) => (d.partitionCardinality ?? 0) > 10_000,
      ask: (d) =>
        `You are partitioning on ${d.partitionKey ?? 'a column'} with about ${num(d.partitionCardinality)} distinct values. Walk me through what the file listing looks like a year in.`,
      responses: [
        {
          id: 'knows_the_bomb',
          label:
            'It is a small-file generator, so partitioning stops at a coarse grain and the high-cardinality column becomes the sort key inside each partition instead. Partitioning cuts the file list; sorting cuts the bytes within files.',
          outcome: 'survive',
          rebuttal:
            'That is the distinction most people never make. Partitioning is a directory decision, sorting is a physics decision.',
        },
        {
          id: 'compaction_will_fix',
          label: 'Compaction will merge the small files back into reasonable sizes.',
          outcome: 'wounded',
          rebuttal:
            'Compaction cannot merge across partition boundaries without breaking the partitioning you asked for. You will have thousands of directories that each hold one small file forever.',
        },
        {
          id: 'more_partitions_more_pruning',
          label: 'More partitions means more pruning, which is the point of partitioning.',
          outcome: 'fatal',
          rebuttal:
            'Past a point it inverts: planning has to enumerate the partitions, and metadata work grows while the data per file shrinks. You have built a table whose planning cost scales with its own partition count.',
        },
      ],
    },
    {
      id: 'sort_key_mismatch',
      severity: 3,
      artifact: 'layout-design',
      fires: (d) => d.sortKey !== undefined && d.pruningMeasured !== true,
      ask: (d) =>
        `You sorted on ${d.sortKey}. Which predicate does that help, and what happens to the query that filters on something else?`,
      responses: [
        {
          id: 'names_the_loser',
          label:
            'It helps the time-range predicate that dominates the recurring workload. The queries filtering on other columns prune almost nothing, and I have stated that in the design as the accepted cost — a table has one physical order.',
          outcome: 'survive',
          rebuttal:
            'One physical order, and you chose it deliberately and said what it costs. Good.',
        },
        {
          id: 'secondary_index',
          label: 'We can add secondary indexes or bloom filters for the other predicates.',
          outcome: 'wounded',
          rebuttal:
            'Bloom filters help equality on high-cardinality columns and do nothing for ranges. You have named a mechanism without checking whether it matches the predicate shape.',
        },
        {
          id: 'sorts_on_everything',
          label: 'The multi-column sort key covers all the main filter columns.',
          outcome: 'fatal',
          rebuttal:
            'A multi-column sort clusters strongly on the first column and progressively less after it. Your third sort column is nearly randomly distributed within blocks, so it prunes nothing — you have a design that looks like it covers four predicates and covers one.',
        },
      ],
    },
    {
      id: 'compression_assumed',
      severity: 2,
      artifact: 'scan-budget',
      fires: (d) => (d.compressionRatio ?? 0) > 1 && d.compressionMeasured !== true,
      ask: (d) =>
        `You have assumed ${(d.compressionRatio ?? 0).toFixed(1)}× compression. On which columns? Because that number is a property of your data, not of the format.`,
      responses: [
        {
          id: 'per_column',
          label:
            'Per column, from cardinality and ordering: the low-cardinality dimensions dictionary-encode hard, the timestamps delta-encode, and the free-text column barely compresses and dominates the residual size.',
          outcome: 'survive',
          rebuttal:
            'You know which column is your floor. That is the one that will decide your storage bill at scale.',
        },
        {
          id: 'typical',
          label: 'It is the typical ratio reported for this format on analytical data.',
          outcome: 'wounded',
          rebuttal:
            'Typical of someone else\'s data. If your high-cardinality strings are a bigger share than theirs, your ratio is worse and your whole storage plan moves with it.',
        },
        {
          id: 'ratio_is_the_win',
          label: 'The ratio is the main win of going columnar, so it is central to the case.',
          outcome: 'fatal',
          rebuttal:
            'The main win is not reading the bytes at all. You have led with the second-order effect and left the first-order one — pruning — as an afterthought.',
        },
      ],
    },
    {
      id: 'no_worst_query',
      severity: 2,
      artifact: 'layout-design',
      fires: (d) => d.worstQueryStated !== true,
      ask: () =>
        'Which query does this design handle badly? If the answer is none, I do not believe the design — I believe you have not looked.',
      responses: [
        {
          id: 'names_it',
          label:
            'The unpredicated ad-hoc scan across the wide columns: it prunes nothing and projects widely, and it is the one I would put a guardrail or a separate quota on rather than pretend the layout helps it.',
          outcome: 'survive',
          rebuttal:
            'Naming your own worst case before I find it is the most useful professional habit there is. Keep doing it.',
        },
        {
          id: 'all_covered',
          label: 'The design covers the known query patterns, so there is no significant loser.',
          outcome: 'fatal',
          rebuttal:
            'Every physical layout privileges some access patterns over others — that is what a layout is. A design with no loser is a design with an unexamined one.',
        },
      ],
    },
  ],
}

/* ============================= the-steward ============================= */

export const THE_STEWARD: Room = {
  id: 'the-steward',
  adversary: 'Ingrid Halvorsen',
  role: 'Data protection & governance officer',
  opening:
    "My concern is not performance. It is whether you can tell me, with evidence, what data is in here, who can see it, how long it stays, and how it leaves. I will be asked these questions by someone external, and I will be repeating your answers.",
  closing:
    "That I can defend. You gave me evidence rather than intentions, and you knew which of your controls is weakest. That is what I need before an audit, not after.",
  objections: [
    {
      id: 'no_erasure_path',
      severity: 3,
      artifact: 'platform-runbook',
      fires: (d) => d.erasurePath !== true,
      ask: () =>
        'A person exercises their right to erasure. Their rows are inside immutable files, spread across an unknown number of them, and older snapshots still reference those files. Talk me through the deletion.',
      responses: [
        {
          id: 'delete_plus_expiry',
          label:
            'A delete marks the rows logically, a targeted rewrite removes them from the files that held them, and snapshot expiry then drops the old versions — so the deadline we can commit to is the rewrite plus the retention window, not the delete alone.',
          outcome: 'survive',
          rebuttal:
            'You included the retention window in the deadline. Almost nobody does, and it is precisely where the commitment is broken.',
        },
        {
          id: 'delete_statement',
          label: 'We issue a DELETE and the platform handles it.',
          outcome: 'wounded',
          rebuttal:
            'A delete in a table format like this usually writes a marker, not a removal. The bytes remain readable in earlier snapshots until something expires them. Have you tested that they are gone?',
        },
        {
          id: 'time_travel_is_a_feature',
          label: 'Time travel keeps history, which is generally an advantage for auditing.',
          outcome: 'fatal',
          rebuttal:
            'You have just described a retention mechanism that keeps deleted personal data recoverable, and called it a feature. That is the finding, in the auditor\'s words rather than mine.',
        },
      ],
    },
    {
      id: 'no_retention_policy',
      severity: 2,
      artifact: 'platform-runbook',
      fires: (d) => d.retentionPolicyDays === undefined,
      ask: () => 'How long does data stay in this platform, and what enforces that?',
      responses: [
        {
          id: 'policy_automated',
          label:
            'A stated retention period per dataset class, enforced by an automated expiry job whose runs are logged — so the evidence is the job history, not a document saying we intend to.',
          outcome: 'survive',
          rebuttal:
            'Enforcement with a log. That is the difference between a policy and a wish.',
        },
        {
          id: 'keep_everything',
          label: 'We keep everything, since storage is inexpensive and analysts may need history.',
          outcome: 'wounded',
          rebuttal:
            'Storage cost is not the constraint I am raising. Data you keep without a reason is liability you hold without a reason.',
        },
      ],
    },
    {
      id: 'no_lineage',
      severity: 2,
      artifact: 'platform-runbook',
      fires: (d) => d.lineageEvidence !== true,
      ask: () =>
        'This column feeds a decision that affects customers. Show me where its values came from and what transformed them.',
      responses: [
        {
          id: 'lineage_from_catalog',
          label:
            'Column-level lineage from the catalog and the pipeline definitions, tied to the snapshot the query read — so the answer is reproducible for a specific point in time, not just for today.',
          outcome: 'survive',
          rebuttal:
            'Reproducible as of a snapshot. That is the version of lineage that survives contact with an auditor.',
        },
        {
          id: 'pipeline_code',
          label: 'The pipeline code is in version control, so the transformations are documented there.',
          outcome: 'wounded',
          rebuttal:
            'Code tells me what runs now. I asked what produced this value. Those differ every time the pipeline changed, which is often.',
        },
      ],
    },
    {
      id: 'residency_unaddressed',
      severity: 3,
      artifact: 'platform-memo',
      fires: (d) => d.residencyRequired === true && (d.regions ?? 1) < 2,
      ask: (d) =>
        `You have a residency requirement and ${num(d.regions ?? 1)} region in the design. How does data that must not leave a jurisdiction stay inside one?`,
      responses: [
        {
          id: 'per_region_with_cost',
          label:
            'Regional storage and compute per jurisdiction, with the metadata layer scoped accordingly, and I have costed the duplication — residency is a cost decision as much as a compliance one, and I would rather state the cost than discover it.',
          outcome: 'survive',
          rebuttal:
            'You costed it instead of promising it. Good — the ones who promise it come back in six months asking for budget.',
        },
        {
          id: 'encryption',
          label: 'Data is encrypted at rest and in transit, which addresses the sensitivity concern.',
          outcome: 'fatal',
          rebuttal:
            'Encryption is not residency. The requirement is about where the bytes physically are and which jurisdiction can compel access to them. You have answered a different question, which tells me the requirement was not read.',
        },
      ],
    },
  ],
}

/* ============================ the-consumer ============================ */

export const THE_CONSUMER: Room = {
  id: 'the-consumer',
  adversary: 'Tunde Bakare',
  role: 'Analytics & ML lead — your internal customer',
  opening:
    "My team's dashboards and models sit on top of whatever you build. I do not care about your file layout. I care whether the numbers are current, whether the columns keep their meaning, and who I call when they do not.",
  closing:
    "That works for me. You have told me what to expect, how I will find out when it breaks, and who is awake. That is all I ever wanted from a platform team.",
  objections: [
    {
      id: 'freshness_gap',
      severity: 3,
      artifact: 'platform-runbook',
      fires: (d) =>
        d.stalenessP99Sec !== undefined && d.freshnessSlaSec !== undefined && d.stalenessP99Sec > d.freshnessSlaSec,
      ask: (d) =>
        `We asked for data no older than ${num(d.freshnessSlaSec)} seconds. Your own p99 staleness is ${num(d.stalenessP99Sec)} seconds. Which of those numbers is going to change?`,
      responses: [
        {
          id: 'names_the_tradeoff',
          label:
            'Mine can come down by shortening the batch interval, and the cost is more small files and more compaction — I can show you that curve so you can choose the point, because this is your requirement to spend against, not mine.',
          outcome: 'survive',
          rebuttal:
            'You brought me the curve instead of a no. I will take the middle of it and stop asking for seconds.',
        },
        {
          id: 'will_optimise',
          label: 'We will optimise the pipeline and expect to close the gap.',
          outcome: 'wounded',
          rebuttal:
            'That is a hope with a deadline attached to my roadmap. What is the mechanism, and what does it cost?',
        },
        {
          id: 'sla_unrealistic',
          label: 'The requested figure is unrealistic for this architecture.',
          outcome: 'fatal',
          rebuttal:
            'Then you chose an architecture that cannot meet a requirement you were given, and you are telling me after the design review. My models are built on that number.',
        },
      ],
    },
    {
      id: 'no_schema_contract',
      severity: 3,
      artifact: 'platform-runbook',
      fires: (d) => d.schemaContract !== true,
      ask: () =>
        'Last quarter a column changed meaning upstream and my model silently degraded for eleven days. What stops that happening on your platform?',
      responses: [
        {
          id: 'versioned_contract',
          label:
            'Schemas are published as a versioned contract: additive changes are compatible by default, semantic changes require a new column rather than a redefinition, and consumers are notified before a version is retired.',
          outcome: 'survive',
          rebuttal:
            'A new column instead of a redefinition. That single rule would have saved me those eleven days.',
        },
        {
          id: 'schema_evolution_supported',
          label: 'The table format supports schema evolution, so changes are handled safely.',
          outcome: 'wounded',
          rebuttal:
            'It handles them *mechanically*. It has no opinion about whether the meaning changed, and meaning is what broke my model.',
        },
        {
          id: 'notify_by_email',
          label: 'We announce schema changes on the platform channel before they land.',
          outcome: 'fatal',
          rebuttal:
            'A message is not a contract. My pipeline does not read the channel, and the person who was watching it has left.',
        },
      ],
    },
    {
      id: 'no_query_slo',
      severity: 2,
      artifact: 'platform-runbook',
      fires: (d) => d.querySloDefined !== true,
      ask: () => 'What am I allowed to expect from a dashboard query, and what happens when it is not met?',
      responses: [
        {
          id: 'slo_with_class',
          label:
            'A p95 target per workload class, with the ad-hoc class explicitly excluded and quota-limited instead, so the number I commit to is one the layout actually supports.',
          outcome: 'survive',
          rebuttal:
            'Per class, with the wild one fenced off. That is honest, and it means the number means something.',
        },
        {
          id: 'best_effort',
          label: 'Performance is best-effort; we monitor and tune as patterns emerge.',
          outcome: 'wounded',
          rebuttal:
            'Then I cannot promise anything to my own stakeholders either, and the first thing they will ask is whose fault that is.',
        },
      ],
    },
    {
      id: 'no_quality_alerting',
      severity: 2,
      artifact: 'platform-runbook',
      fires: (d) => d.qualityAlerting !== true,
      ask: () =>
        'Ingest succeeds, every job is green, and the table has half the rows it should. Who notices, and how long does it take?',
      responses: [
        {
          id: 'alerts_on_shape',
          label:
            'Alerts on data shape rather than job status: row-count deltas against expectation, null-rate drift, and freshness per partition — because a green pipeline that delivers wrong data is the failure mode that actually happens.',
          outcome: 'survive',
          rebuttal:
            'Alerting on the data instead of the job. That is the difference between monitoring and knowing.',
        },
        {
          id: 'pipeline_monitoring',
          label: 'We alert on pipeline failures and latency, which covers the operational risks.',
          outcome: 'fatal',
          rebuttal:
            'It covers the ones that announce themselves. The expensive incidents are the quiet ones, and you have no detector for those — my team becomes your monitoring.',
        },
      ],
    },
  ],
}

/* ============================= the-vendor ============================= */

/**
 * The vendor room is where a course taught without a cluster earns its
 * honesty. The learner is not tested on whether they like the product; they are
 * tested on whether they know what they have not measured, and what result
 * would change their mind.
 */
export const THE_VENDOR: Room = {
  id: 'the-vendor',
  adversary: 'Marc Delaney',
  role: 'Enterprise account executive',
  opening:
    "Great to finally meet the team. I have read your requirements and I think we are a strong fit — our architecture is genuinely different from what you are used to. I would love to get a proof-of-concept scheduled this quarter. What would you need to see?",
  closing:
    "Honestly? That is the most rigorous evaluation I have been asked to support this year. You have told me exactly what would make you say no, which means if you say yes I will believe it. Let us scope that POC properly.",
  objections: [
    {
      id: 'poc_undefined',
      severity: 3,
      artifact: 'platform-memo',
      fires: (d) => d.pocDefined !== true,
      ask: () =>
        "So — what would the proof-of-concept measure? Most teams tell me 'we will run some queries and see how it feels', and then we both spend six weeks producing a result nobody can act on.",
      responses: [
        {
          id: 'metrics_and_falsifier',
          label:
            'Three metrics on our own data and our own query mix — bytes read per query, p95 at our real concurrency, and the update path under our actual change rate — plus one result that would make us decline: if the update path does not beat what we measured on our current stack, the main reason we are here disappears.',
          outcome: 'survive',
          rebuttal:
            'You have written the exit criterion before the trial. I will be straight with you: that makes this harder to win and much easier to trust.',
        },
        {
          id: 'benchmark_suite',
          label: 'We would run a standard analytical benchmark suite to compare platforms on equal footing.',
          outcome: 'wounded',
          rebuttal:
            'We do well on those, so I am happy to agree. But a standard suite tells you how the platform handles someone else\'s query mix and someone else\'s data distribution — it will not tell you about your own skew.',
        },
        {
          id: 'trust_the_architecture',
          label: 'The architecture addresses our bottleneck, so the POC is mainly about validating operations.',
          outcome: 'fatal',
          rebuttal:
            "I am delighted to hear it, and I should not be. You have concluded before measuring, and you are about to buy a platform on the strength of an architecture diagram — mine.",
        },
      ],
    },
    {
      id: 'vendor_numbers_as_ours',
      severity: 3,
      artifact: 'platform-memo',
      fires: (d) => d.vendorNumbersQuoted === true && d.benchmarkedOurselves !== true,
      ask: () =>
        'I notice the business case quotes our published performance figures. I am happy about that — but they came from our reference configuration. Do you know how yours differs?',
      responses: [
        {
          id: 'labelled_as_vendor',
          label:
            'They are in the memo labelled as your numbers, on your configuration, as an upper bound to be tested — not as our expected result. Every figure we are actually committing to came from measurements we took.',
          outcome: 'survive',
          rebuttal:
            'Labelled and bounded. That is fair use of them, and frankly it protects both of us when the board asks where the number came from.',
        },
        {
          id: 'adjusted_down',
          label: 'We discounted your figures by a margin to be conservative.',
          outcome: 'wounded',
          rebuttal:
            'A discount on a number whose mechanism you have not reproduced is still a guess, just a smaller one. What would you do if the true ratio is different in kind rather than in degree?',
        },
        {
          id: 'published_so_reliable',
          label: 'They are published figures, so they are a reasonable planning basis.',
          outcome: 'fatal',
          rebuttal:
            'They are published *by the party selling you the platform* — me. If your capacity plan rests on my marketing, the first bad quarter is going to be a conversation about who signed it off.',
        },
      ],
    },
    {
      id: 'lock_in_not_priced',
      severity: 2,
      artifact: 'platform-memo',
      fires: (d) => d.openFormat !== true && d.exitCost === undefined,
      ask: () =>
        'On commercial terms: what is your walk-away position at renewal? I ask because the teams who know it get better pricing from me, and the ones who do not, do not.',
      responses: [
        {
          id: 'second_source',
          label:
            'The data stays in a format a second engine can read, we have a named alternative, and we have costed the switch — so the walk-away position is a number rather than a bluff.',
          outcome: 'survive',
          rebuttal:
            'Then you will negotiate well, and I will have to compete on value. That is a better relationship than the alternative, even from my side of the table.',
        },
        {
          id: 'contract_terms',
          label: 'We have negotiated favourable contract terms and price protection for the initial period.',
          outcome: 'wounded',
          rebuttal:
            'Terms cover the period you negotiated. My leverage arrives the day after it ends, and it grows with every pipeline you build on us.',
        },
        {
          id: 'committed',
          label: 'We are committing to the platform strategically, so switching is not part of the plan.',
          outcome: 'fatal',
          rebuttal:
            'I will note that in the account file, and I would be doing my job badly if I did not. You have removed your own leverage and told me you have done it.',
        },
      ],
    },
    {
      id: 'workload_fit_unexamined',
      severity: 2,
      artifact: 'platform-memo',
      fires: (d) => d.firstBottleneck === undefined,
      ask: () =>
        'What is actually your bottleneck today? I want to make sure we are solving the problem you have rather than the one our architecture is best at.',
      responses: [
        {
          id: 'named_and_measured',
          label:
            'Measured, not assumed: the constraint is the update path and the freshness it forces, not raw scan throughput — which is exactly why your architecture is interesting and also exactly what the POC has to prove.',
          outcome: 'survive',
          rebuttal:
            'You have matched a measured constraint to a specific mechanism. That is a real evaluation, and it means I can send engineers instead of slides.',
        },
        {
          id: 'general_performance',
          label: 'Overall query performance and cost are both under pressure, so improvements anywhere help.',
          outcome: 'wounded',
          rebuttal:
            'Then any change will look like an improvement, including the ones that are just new hardware. You will not know what you bought.',
        },
      ],
    },
  ],
}

/* ------------------------------ registry ------------------------------ */

export const ROOMS: Room[] = [THE_CFO, THE_PRINCIPAL, THE_STEWARD, THE_CONSUMER, THE_VENDOR]

export function getRoom(id: RoomId): Room | undefined {
  return ROOMS.find((r) => r.id === id)
}

/** Objections that fire for a given dossier, in severity order (worst first). */
export function objectionsFor(room: Room, d: Dossier): Objection[] {
  return room.objections.filter((o) => o.fires(d)).sort((a, b) => b.severity - a.severity)
}

/**
 * Does this dossier survive the room? A room is lost when any severity-3
 * objection that fired has no surviving response available to the learner —
 * which is why every severity-3 objection MUST offer at least one `survive`
 * response. `tests/rooms.test.ts` asserts exactly that.
 */
export function criticalObjections(room: Room, d: Dossier): Objection[] {
  return objectionsFor(room, d).filter((o) => o.severity === 3)
}
