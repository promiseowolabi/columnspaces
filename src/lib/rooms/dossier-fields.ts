/**
 * dossier-fields.ts — the dossier, described well enough to edit and to probe.
 *
 * `Dossier` in `@/data/rooms` is the wire format: 57 optional fields the five
 * adversaries read and nothing else. This file is its *presentation contract*:
 * for each field, which desk produced it, what it is called in prose, how it is
 * typed, and — the part that matters — WHAT SILENCE MEANS. Every field is
 * optional, so leaving one blank is not "skipping a question", it is submitting
 * a plan with a hole in it, and the objection trees hunt holes.
 *
 * The `probes` array is the load-bearing oddity here. It is not example data and
 * it is never shown to the learner. It is the alternate-value set used to answer
 * "why am I facing this objection?" by counterfactual: perturb one field, re-run
 * the pure predicate, and if the objection appears or disappears then that field
 * is why. Doing attribution this way rather than with a hand-written
 * objection → field table means the explanation CANNOT drift from the predicate,
 * because it is computed from the predicate. See `sensitiveFields` in
 * `./encounter`.
 *
 * Probe values are chosen to sit on both sides of the thresholds the predicates
 * actually test (10,000 distinct partition values; 0.8 promised pruning; write
 * amplification above 1×), plus `undefined` — because omission is a value here,
 * not the absence of one.
 *
 * No prices. Money fields carry totals the learner computed at a desk; the
 * course never supplies a rate.
 */

import type { Dossier } from '@/data/rooms'
import type { DeskId } from '@/data/lessons/types'

export type DossierKey = keyof Dossier

export type FieldKind = 'number' | 'boolean' | 'enum' | 'text' | 'list'

/** Any value a dossier field can legally hold, plus `undefined` for omission. */
export type DossierValue = Dossier[DossierKey]

export interface DossierField {
  key: DossierKey
  /** Prose label — "bytes scanned per day", not "dailyScanBytes". */
  label: string
  kind: FieldKind
  /**
   * Multiplier from the unit the learner types into the unit the dossier
   * stores. Bytes are entered in TB (1e12) or MB (1e6) because nobody types
   * fourteen digits correctly.
   */
  factor?: number
  /** Unit shown next to the input, in the entry unit. Never a currency. */
  unit?: string
  options?: readonly string[]
  /** What an adversary does with this blank. Shown when the field is empty. */
  silence: string
  /** Counterfactual probes. Not example data — see the file header. */
  probes: readonly DossierValue[]
}

export interface DossierGroup {
  id: string
  title: string
  /** The desk that produces these numbers, when there is one. */
  desk?: DeskId
  /** Where the numbers come from, in the learner's own words. */
  provenance: string
  fields: DossierField[]
}

const BOOL_PROBES = [undefined, true, false] as const

/* ------------------------------- the groups ------------------------------- */

export const DOSSIER_GROUPS: DossierGroup[] = [
  {
    id: 'scan',
    title: 'Scan budget',
    desk: 'scan-desk',
    provenance: 'the bytes-scanned arithmetic you produced at the scan desk',
    fields: [
      {
        key: 'logicalBytes',
        label: 'logical table size, uncompressed',
        kind: 'number',
        factor: 1e12,
        unit: 'TB',
        silence: 'You have no denominator, so no ratio you quote later can be checked.',
        probes: [undefined, 40e12],
      },
      {
        key: 'dailyScanBytes',
        label: 'bytes scanned per day, whole workload',
        kind: 'number',
        factor: 1e12,
        unit: 'TB',
        silence: 'The CFO opens with this one. On a consumption shape it IS the bill.',
        probes: [undefined, 1.2e12, 40e12],
      },
      {
        key: 'worstQueryBytes',
        label: 'bytes read by the worst recurring query',
        kind: 'number',
        factor: 1e12,
        unit: 'TB',
        silence: 'Averages hide the query that will actually break the budget.',
        probes: [undefined, 8e12],
      },
      {
        key: 'pricingShape',
        label: 'how the platform is billed',
        kind: 'enum',
        options: ['consumption-bytes', 'consumption-credits', 'instance', 'capacity', 'appliance'],
        silence: 'Without the shape, a bytes number cannot be turned into a cost at all.',
        probes: [undefined, 'consumption-bytes', 'capacity'],
      },
      {
        key: 'growthModelled',
        label: 'the plan contains a growth term',
        kind: 'boolean',
        silence: 'A flat forecast for a growing table reads as a forecast nobody made.',
        probes: BOOL_PROBES,
      },
      {
        key: 'growthRate',
        label: 'annual growth multiplier',
        kind: 'number',
        unit: '× / yr',
        silence: 'Growth asserted without a rate is an adjective.',
        probes: [undefined, 1.5],
      },
      {
        key: 'compressionRatio',
        label: 'assumed compression ratio',
        kind: 'number',
        unit: '×',
        silence: 'Your storage plan has no floor under it.',
        probes: [undefined, 1, 6],
      },
      {
        key: 'compressionMeasured',
        label: 'that ratio was measured on our data',
        kind: 'boolean',
        silence: 'An unmeasured ratio is a property of someone else’s data.',
        probes: BOOL_PROBES,
      },
    ],
  },
  {
    id: 'layout',
    title: 'Layout design',
    desk: 'layout-desk',
    provenance: 'the partition, sort and file-size decisions from the layout desk',
    fields: [
      {
        key: 'partitionKey',
        label: 'partition key',
        kind: 'text',
        silence: 'The principal cannot review a directory decision you did not state.',
        probes: [undefined, 'event_date'],
      },
      {
        key: 'sortKey',
        label: 'sort key',
        kind: 'text',
        silence: 'A table has exactly one physical order. Not naming it does not avoid choosing it.',
        probes: [undefined, 'event_ts'],
      },
      {
        key: 'partitionCardinality',
        label: 'distinct partition values expected',
        kind: 'number',
        unit: 'values',
        silence: 'This is the file-count bomb. Unstated means undetonated, not defused.',
        probes: [undefined, 365, 50_000],
      },
      {
        key: 'promisedPruningRatio',
        label: 'promised pruning ratio on the target query',
        kind: 'number',
        unit: '0–1',
        silence: 'The saving in your business case has no mechanism behind it.',
        probes: [undefined, 0.4, 0.95],
      },
      {
        key: 'pruningMeasured',
        label: 'pruning was measured, not intended',
        kind: 'boolean',
        silence: 'Design intent is not a measurement, and the invoice knows the difference.',
        probes: BOOL_PROBES,
      },
      {
        key: 'targetFileSizeBytes',
        label: 'target file size',
        kind: 'number',
        factor: 1e6,
        unit: 'MB',
        silence: 'Small files are a planning cost you pay per query, forever.',
        probes: [undefined, 128e6],
      },
      {
        key: 'fileCount',
        label: 'live file count',
        kind: 'number',
        unit: 'files',
        silence: 'Metadata scales with files, not with data. This is the catalog’s ceiling.',
        probes: [undefined, 120_000],
      },
      {
        key: 'worstQueryStated',
        label: 'we named the query this layout is bad for',
        kind: 'boolean',
        silence: 'A design with no loser is a design with an unexamined one.',
        probes: BOOL_PROBES,
      },
    ],
  },
  {
    id: 'ingest',
    title: 'Ingest topology',
    desk: 'ingest-desk',
    provenance: 'the freshness-versus-file-count tradeoff from the ingest desk',
    fields: [
      {
        key: 'ingestMode',
        label: 'ingest mode',
        kind: 'enum',
        options: ['batch', 'micro-batch', 'streaming', 'cdc'],
        silence: 'Freshness claims cannot be checked without the topology that produces them.',
        probes: [undefined, 'batch', 'streaming'],
      },
      {
        key: 'batchIntervalSec',
        label: 'commit / batch interval',
        kind: 'number',
        unit: 'seconds',
        silence: 'Halving this doubles files at constant data. Unstated, so is the file count.',
        probes: [undefined, 300],
      },
      {
        key: 'stalenessP99Sec',
        label: 'p99 end-to-end staleness',
        kind: 'number',
        unit: 'seconds',
        silence: 'Your consumer will assume the number they asked for. They will be wrong.',
        probes: [undefined, 60, 3600],
      },
      {
        key: 'freshnessSlaSec',
        label: 'freshness the business asked for',
        kind: 'number',
        unit: 'seconds',
        silence: 'A requirement you did not record is a requirement you cannot be shown to meet.',
        probes: [undefined, 300, 30],
      },
      {
        key: 'compactionKeepsUp',
        label: 'compaction outruns file creation',
        kind: 'boolean',
        silence: 'If it does not, the file count grows without bound and so does planning.',
        probes: BOOL_PROBES,
      },
    ],
  },
  {
    id: 'maintenance',
    title: 'Compaction & expiry',
    desk: 'compaction-desk',
    provenance: 'the write-amp budget and expiry policy from the compaction desk',
    fields: [
      {
        key: 'writeAmplification',
        label: 'write amplification',
        kind: 'number',
        unit: '×',
        silence: 'Background rewriting with no budget is an unbounded line item.',
        probes: [undefined, 1, 4],
      },
      {
        key: 'readAmplification',
        label: 'read amplification',
        kind: 'number',
        unit: '×',
        silence: 'The number compaction exists to hold down, unstated.',
        probes: [undefined, 1.2],
      },
      {
        key: 'compactionAutomated',
        label: 'compaction runs automatically',
        kind: 'boolean',
        silence: 'Manual maintenance is an on-call task nobody costed.',
        probes: BOOL_PROBES,
      },
      {
        key: 'expiryWindowDays',
        label: 'snapshot / time-travel retention',
        kind: 'number',
        unit: 'days',
        silence: 'This window is part of your erasure deadline whether you wrote it down or not.',
        probes: [undefined, 7],
      },
      {
        key: 'maintenanceCosted',
        label: 'maintenance is a line item',
        kind: 'boolean',
        silence: 'Nothing is "included". It is metered, or amortised into a price you were quoted.',
        probes: BOOL_PROBES,
      },
    ],
  },
  {
    id: 'tenancy',
    title: 'Tenancy',
    desk: 'tenancy-desk',
    provenance: 'the isolation and attribution model from the tenancy desk',
    fields: [
      {
        key: 'tenants',
        label: 'tenants sharing the platform',
        kind: 'number',
        unit: 'tenants',
        silence: 'Tenant sizes are Zipf-distributed; without a count there is no ceiling.',
        probes: [undefined, 40],
      },
      {
        key: 'tenancyModel',
        label: 'tenancy model',
        kind: 'enum',
        options: ['table-per-tenant', 'schema-per-tenant', 'shared-table-filter', 'cluster-per-tenant'],
        silence: 'The isolation boundary is unstated, so the blast radius is unknown.',
        probes: [undefined, 'shared-table-filter'],
      },
      {
        key: 'costAttribution',
        label: 'spend attributable per tenant',
        kind: 'boolean',
        silence: 'Unattributable spend cannot be charged back or defended.',
        probes: BOOL_PROBES,
      },
      {
        key: 'noisyNeighbourControl',
        label: 'noisy-neighbour control exists',
        kind: 'boolean',
        silence: 'One tenant’s scan becomes everyone’s incident.',
        probes: BOOL_PROBES,
      },
    ],
  },
  {
    id: 'capacity',
    title: 'Capacity plan',
    desk: 'capacity-desk',
    provenance: 'the horizon and first-limit analysis from the capacity desk',
    fields: [
      {
        key: 'horizonMonths',
        label: 'planning horizon',
        kind: 'number',
        unit: 'months',
        silence: 'A plan with no horizon cannot be wrong, which is the problem.',
        probes: [undefined, 24],
      },
      {
        key: 'firstBottleneck',
        label: 'what saturates first',
        kind: 'enum',
        options: ['storage', 'compute', 'catalog', 'network', 'ingest'],
        silence: 'The vendor will pick your bottleneck for you, and it will be the one they are good at.',
        probes: [undefined, 'catalog', 'compute'],
      },
      {
        key: 'peakConcurrency',
        label: 'peak concurrent queries',
        kind: 'number',
        unit: 'queries',
        silence: 'p95 latency without a concurrency figure is a single-user benchmark.',
        probes: [undefined, 60],
      },
      {
        key: 'headroomFactor',
        label: 'headroom (provisioned ÷ required)',
        kind: 'number',
        unit: '×',
        silence: 'Below 1× is a plan that already fails. Unstated is a plan that might.',
        probes: [undefined, 1.3],
      },
    ],
  },
  {
    id: 'tco',
    title: 'Three-year total',
    desk: 'tco-desk',
    provenance: 'the recommendation and totals from the TCO desk',
    fields: [
      {
        key: 'choice',
        label: 'recommendation',
        kind: 'enum',
        options: ['managed-warehouse', 'engine-on-object-store', 'appliance-platform'],
        silence: 'A review with no recommendation defers the decision to whoever speaks last.',
        probes: [undefined, 'managed-warehouse', 'engine-on-object-store'],
      },
      {
        key: 'threeYearTotal',
        label: 'three-year total, your own currency',
        kind: 'number',
        silence: 'The one number the CFO will repeat upward.',
        probes: [undefined, 2_400_000],
      },
      {
        key: 'statedOngoingOps',
        label: 'ongoing operational labour is in the total',
        kind: 'boolean',
        silence: 'A build cost amortises; an on-call rotation does not.',
        probes: BOOL_PROBES,
      },
      {
        key: 'opsEngineerMonths',
        label: 'engineer-months per year to operate',
        kind: 'number',
        unit: 'eng-months',
        silence: 'Labour left as a count of nobody.',
        probes: [undefined, 18],
      },
      {
        key: 'migrationCost',
        label: 'migration cost',
        kind: 'number',
        silence: 'Getting in is a project, not a switch.',
        probes: [undefined, 300_000],
      },
      {
        key: 'exitCost',
        label: 'cost to leave, computed',
        kind: 'number',
        silence: 'Not knowing your walk-away position is a commercial position: theirs.',
        probes: [undefined, 0, 450_000],
      },
      {
        key: 'openFormat',
        label: 'data readable by a second engine',
        kind: 'boolean',
        silence: 'Portable files are half the exit; the queries and people are the other half.',
        probes: BOOL_PROBES,
      },
    ],
  },
  {
    id: 'governance',
    title: 'Governance evidence',
    provenance: 'the A2 governance work — the runbook and the memo, not a desk',
    fields: [
      {
        key: 'retentionPolicyDays',
        label: 'retention period',
        kind: 'number',
        unit: 'days',
        silence: 'Data kept without a reason is liability held without a reason.',
        probes: [undefined, 400],
      },
      {
        key: 'erasurePath',
        label: 'tested path to erase one subject',
        kind: 'boolean',
        silence: 'The steward’s critical objection. A DELETE that writes a marker is not a deletion.',
        probes: BOOL_PROBES,
      },
      {
        key: 'lineageEvidence',
        label: 'column-level lineage available to auditors',
        kind: 'boolean',
        silence: 'Code tells an auditor what runs now, not what produced this value.',
        probes: BOOL_PROBES,
      },
      {
        key: 'regions',
        label: 'regions in the design',
        kind: 'number',
        unit: 'regions',
        silence: 'One region is an answer; it just may not be the required one.',
        probes: [undefined, 1, 3],
      },
      {
        key: 'residencyRequired',
        label: 'a residency requirement applies',
        kind: 'boolean',
        silence: 'If it applies and you did not record it, encryption will be offered as the answer.',
        probes: BOOL_PROBES,
      },
      {
        key: 'schemaContract',
        label: 'schemas published as a versioned contract',
        kind: 'boolean',
        silence: 'Mechanical schema evolution has no opinion about meaning, and meaning is what breaks models.',
        probes: BOOL_PROBES,
      },
    ],
  },
  {
    id: 'consumer',
    title: 'What consumers may expect',
    provenance: 'the SLOs and operational promises in your platform runbook',
    fields: [
      {
        key: 'querySloDefined',
        label: 'query SLO defined per workload class',
        kind: 'boolean',
        silence: 'Your consumer cannot promise anything downstream either.',
        probes: BOOL_PROBES,
      },
      {
        key: 'querySloP95Sec',
        label: 'p95 the platform promises',
        kind: 'number',
        unit: 'seconds',
        silence: 'An SLO with no number is a sentiment.',
        probes: [undefined, 4],
      },
      {
        key: 'qualityAlerting',
        label: 'alerting on data shape, not only job status',
        kind: 'boolean',
        silence: 'A green pipeline delivering half the rows is the incident that actually happens.',
        probes: BOOL_PROBES,
      },
      {
        key: 'runbookExists',
        label: 'runbook exists',
        kind: 'boolean',
        silence: 'The knowledge is in one head, and that head takes holidays.',
        probes: BOOL_PROBES,
      },
      {
        key: 'onCallRotation',
        label: 'on-call rotation staffed',
        kind: 'boolean',
        silence: 'Someone is on call informally. They have not been asked.',
        probes: BOOL_PROBES,
      },
    ],
  },
  {
    id: 'poc',
    title: 'The evaluation',
    provenance: 'what a proof-of-concept would measure — the honest ending of a course without a cluster',
    fields: [
      {
        key: 'pocDefined',
        label: 'the POC has defined measurements',
        kind: 'boolean',
        silence: 'The most important blank in the course. Six weeks producing a result nobody can act on.',
        probes: BOOL_PROBES,
      },
      {
        key: 'pocMetrics',
        label: 'metrics the POC collects',
        kind: 'list',
        silence: '"We will run some queries and see how it feels."',
        probes: [undefined, ['bytes read per query', 'p95 at real concurrency']],
      },
      {
        key: 'pocFalsifier',
        label: 'a result that would make us decline',
        kind: 'boolean',
        silence: 'An evaluation that cannot fail is a purchase with extra steps.',
        probes: BOOL_PROBES,
      },
      {
        key: 'benchmarkedOurselves',
        label: 'we measured it on our own data',
        kind: 'boolean',
        silence: 'Then every performance figure in the memo belongs to someone else.',
        probes: BOOL_PROBES,
      },
      {
        key: 'vendorNumbersQuoted',
        label: 'vendor-published figures appear in our case',
        kind: 'boolean',
        silence: 'Unlabelled vendor figures become "our numbers" by the third slide.',
        probes: BOOL_PROBES,
      },
    ],
  },
]

/* ------------------------------- lookups ------------------------------- */

export const DOSSIER_FIELDS: DossierField[] = DOSSIER_GROUPS.flatMap((g) => g.fields)

const BY_KEY = new Map<DossierKey, DossierField>(DOSSIER_FIELDS.map((f) => [f.key, f]))

export function dossierField(key: DossierKey): DossierField | undefined {
  return BY_KEY.get(key)
}

/** Prose label for a key, falling back to the key itself so nothing renders blank. */
export function fieldLabel(key: DossierKey): string {
  return BY_KEY.get(key)?.label ?? key
}

export function groupForKey(key: DossierKey): DossierGroup | undefined {
  return DOSSIER_GROUPS.find((g) => g.fields.some((f) => f.key === key))
}

/** Keys actually present in a dossier. Omission is a value, so this is a score. */
export function filledKeys(d: Dossier): DossierKey[] {
  return DOSSIER_FIELDS.map((f) => f.key).filter((k) => d[k] !== undefined)
}

export function blankKeys(d: Dossier): DossierKey[] {
  return DOSSIER_FIELDS.map((f) => f.key).filter((k) => d[k] === undefined)
}
