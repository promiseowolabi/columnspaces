/**
 * fields.ts — the desks, described well enough to submit to.
 *
 * The eight reference models grade submissions. Until this file existed there
 * was no way for a learner to make one: the models were reachable from tests
 * and from nothing else, which made the architecture half a promise the course
 * could not keep. This is the presentation contract for the desk submissions,
 * and it is deliberately the same shape as `@/lib/rooms/dossier-fields`:
 *
 *   a prose label, never an identifier — "bytes scanned per day", not
 *   `dailyScanBytes`;
 *   a unit and an entry FACTOR, because nobody types fourteen digits
 *   correctly and bytes are typed in TB;
 *   a short help line that says what the number is;
 *   for the discipline terms, WHAT SILENCE COSTS — the specific check that
 *   fails on the omission, quoted by id, because several desk checks fail on
 *   an omitted term even when the point estimate is perfect. The UI has to say
 *   so before the learner submits, not after.
 *
 * ── Why the registry is keyed by PATH ──────────────────────────────────────
 * A desk submission is a nested object: a scenario (`input`) plus the claims
 * and the discipline terms. Rather than invent a parallel flat schema and hand
 * a mapping between the two, every field is keyed by its dot path into the
 * submission — `input.classes.0.tableBytes`, `claimedPerQueryBytes.dashboards`,
 * `cost.pricingShapeNamed`. `assemble` rebuilds the submission from a flat
 * path → value record, `flatten` takes it apart, and the two are inverses.
 *
 * That buys the property this file exists to hold: the coverage test walks the
 * LEAF PATHS of each desk's known-good submission — a value typed as the
 * model's own `Submission` interface, so the compiler forces it to carry every
 * field the model requires — and asserts each one has a registry entry. Add a
 * field to a model's input type and the reference literal fails to typecheck;
 * fix it and the registry test fails until the field is describable. A model
 * change cannot silently produce an unfillable form.
 *
 * ── Derived, not transcribed ───────────────────────────────────────────────
 * Every claim in every reference submission is read out of the model's own
 * output. Nothing correct is typed twice: `claimedDailyTotalBytes` is
 * `modelScanBudget(...).dailyTotalBytes`, the promised pruning ratios are the
 * model's per-class ratios, the TCO total is `computeTco(...).lines[rec].total`.
 * The scenarios are the worked examples the L300/L400 models already export;
 * the three L500 desks get scenarios defined here, once.
 *
 * NO PRICES. The TCO desk takes a rate card, and every entry in it is the
 * caller's own weight in the caller's own units — a ratio between labour and
 * platform, never a currency. No RNG beyond the shared seeded xorshift the
 * tenancy model already uses, and no wall-clock anywhere.
 */

import type { DeskId } from '@/data/lessons/types'
import type { Dossier } from '@/data/rooms'
import type { DeskReport } from './kit'

/* ============================== field types ============================== */

/** Everything a desk field can hold. `null` is "stated as absent" where a model accepts it. */
export type DeskValue = number | boolean | string | null

/** A flat path → value record. What the form holds and what the store persists. */
export type DeskValues = Record<string, DeskValue>

export type DeskFieldKind = 'number' | 'boolean' | 'enum' | 'text'

/**
 * What a blank costs, in the model's own terms. Present on every field whose
 * omission is graded rather than merely wrong — which is most of the discipline
 * terms and all of the tri-state booleans.
 */
export interface DeskDiscipline {
  /** The check id that fails on the omission. Must be one of the desk's own. */
  check: string
  /** One sentence: what the omission does, not what the field means. */
  cost: string
}

export interface DeskField {
  /** Dot path into the submission object. The registry's key. */
  path: string
  /** Prose label. Never the identifier. */
  label: string
  kind: DeskFieldKind
  /**
   * Multiplier from the unit the learner types into the unit the model reads.
   * Bytes are entered in TB (1e12), GiB (2^30) or MB (1e6) depending on what
   * the quantity actually is; a fraction typed as a percent carries 0.01.
   */
  factor?: number
  /** Unit shown beside the input, in the ENTRY unit. Never a currency. */
  unit?: string
  options?: readonly string[]
  /** One line: what this number is. */
  help: string
  /** True when the model's own type accepts `null` here — blank is submittable. */
  nullable?: boolean
  /** What the omission costs, and which check charges for it. */
  discipline?: DeskDiscipline
  /**
   * True when the discipline note's check fails only under a further condition —
   * a recommendation that is not the cheapest, a replica with no catalog of its
   * own. The note says so in prose; this flag says so to the tests, which
   * execute every unconditional note by blanking the field.
   */
  conditional?: boolean
  /**
   * True when the model cannot represent a blank and would crash or silently
   * claim something. The form refuses to submit until these are set, and says
   * which are missing.
   */
  required?: boolean
}

/**
 * `given` is the brief's scenario — prefilled, editable, and not what is being
 * graded. `claim` is a number the learner derives. `discipline` is a term whose
 * ABSENCE is the graded failure.
 */
export type DeskGroupRole = 'given' | 'claim' | 'discipline'

export interface DeskFieldGroup {
  id: string
  title: string
  role: DeskGroupRole
  /** Where these values come from, in the learner's own words. */
  blurb: string
  fields: DeskField[]
}

/** One line of the reference computation, shown beside the grade. */
export interface ReferenceLine {
  label: string
  value: string
  /** Why this number is the one to look at. */
  note?: string
}

/** A dossier field a passing desk result can supply, and where it came from. */
export interface DossierOffer {
  key: keyof Dossier
  /** Prose label for the dossier field, so the offer reads without a lookup. */
  label: string
  value: Dossier[keyof Dossier]
  /** How the desk produced it. */
  derivation: string
}

export interface DeskForm {
  desk: DeskId
  /** The brief: the decision, posed with the scenario the givens describe. */
  brief: string
  groups: DeskFieldGroup[]
  /** Rebuild the model's submission from a flat value record. */
  assemble: (values: DeskValues) => unknown
  /** Grade through `assemble`. The only grading path the UI or a test may use. */
  grade: (values: DeskValues) => DeskReport
  /** What the model computed, for display beside the checks. */
  reference: (values: DeskValues) => ReferenceLine[]
  /** Dossier fields this submission can supply. Never applied without an action. */
  offers: (values: DeskValues) => DossierOffer[]
  /** A known-good submission. Typed as the model's own interface on purpose. */
  known: unknown
}

/* ========================= paths, flatten, assemble ========================= */

/**
 * Leaf paths of a plain object, in declaration order. A leaf is anything that
 * is not a plain object: numbers, booleans, strings, `null`, arrays of
 * primitives (there are none in the submissions, and one would show up here as
 * indexed leaves anyway).
 */
export function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return prefix === '' ? [] : [prefix]
  const out: string[] = []
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    /* `undefined` is absence, and absence has no path. */
    if (v === undefined) continue
    out.push(...leafPaths(v, prefix === '' ? k : `${prefix}.${k}`))
  }
  return out
}

/** A submission taken apart into the flat record the form holds. */
export function flatten(value: unknown): DeskValues {
  const out: DeskValues = {}
  for (const p of leafPaths(value)) out[p] = readPath(value, p) as DeskValue
  return out
}

export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * Write one path into a nested structure, creating containers as it goes. A
 * numeric segment creates an array, so `input.classes.0.tableBytes` rebuilds
 * the array the model expects rather than an object with a "0" key.
 */
export function writePath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.')
  let cur: Record<string, unknown> | unknown[] = root
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    const nextIsIndex = /^\d+$/.test(segs[i + 1])
    const container = cur as Record<string, unknown>
    if (container[seg] === undefined || typeof container[seg] !== 'object' || container[seg] === null) {
      container[seg] = nextIsIndex ? [] : {}
    }
    cur = container[seg] as Record<string, unknown> | unknown[]
  }
  ;(cur as Record<string, unknown>)[segs[segs.length - 1]] = value
}

/**
 * Rebuild a nested submission from a flat record, following a field list so
 * that a blank becomes what the MODEL means by blank rather than `undefined`:
 * `null` where the model's type is nullable, `false` for a boolean whose
 * absence is the omission, `0` for a number nobody stated, `''` for an enum
 * left unset (which every grader reads as "not the reference answer").
 */
export function assembleFrom(fields: DeskField[], values: DeskValues): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const raw = values[f.path]
    writePath(out, f.path, raw === undefined ? blankFor(f) : raw)
  }
  return out
}

/** What this field's blank assembles to. Exported because the UI explains it. */
export function blankFor(f: DeskField): DeskValue {
  if (f.nullable) return null
  switch (f.kind) {
    case 'boolean':
      return false
    case 'number':
      return 0
    default:
      return ''
  }
}

/** Fields the model cannot represent as blank. The form blocks submit on these. */
export function missingRequired(form: DeskForm, values: DeskValues): DeskField[] {
  return allFields(form).filter((f) => f.required && !isStated(values[f.path]))
}

/** Is this value a submission, or a blank? `null` is a blank; `false` is not. */
export const isStated = (v: DeskValue | undefined): boolean =>
  v !== undefined && v !== null && v !== ''

export const allFields = (form: DeskForm): DeskField[] => form.groups.flatMap((g) => g.fields)

export function deskField(form: DeskForm, path: string): DeskField | undefined {
  return allFields(form).find((f) => f.path === path)
}

/**
 * The values the form opens with: the brief's scenario as given, every claim and
 * every discipline term blank. The scenario is read out of the known-good
 * submission rather than transcribed, so a scenario and its reference answer
 * cannot drift apart.
 */
export function briefValues(form: DeskForm): DeskValues {
  const flat = flatten(form.known)
  const out: DeskValues = {}
  for (const g of form.groups) {
    if (g.role !== 'given') continue
    for (const f of g.fields) {
      if (flat[f.path] !== undefined) out[f.path] = flat[f.path]
    }
  }
  return out
}

/** The known-good submission as form values. The answer, for tests and for reveal. */
export const knownValues = (form: DeskForm): DeskValues => flatten(form.known)

/* ------------------------------ field builders ------------------------------ */

/** A number field. `factor` is entry-unit → model-unit. */
export const nf = (
  path: string,
  label: string,
  help: string,
  o: Partial<DeskField> = {},
): DeskField => ({ path, label, kind: 'number', help, ...o })

/**
 * A tri-state boolean. Blank is a visible position, exactly as in the dossier
 * editor, and it assembles to `false` — because for these fields `false` and
 * "not stated" are the same submission, and the check that fails says so.
 * `discipline` is omitted only for booleans that describe the SCENARIO rather
 * than the learner's discipline.
 */
export const bf = (
  path: string,
  label: string,
  help: string,
  discipline?: DeskDiscipline,
  o: Partial<DeskField> = {},
): DeskField => ({
  path,
  label,
  kind: 'boolean',
  help,
  ...(discipline ? { discipline } : {}),
  ...o,
})

export const ef = (
  path: string,
  label: string,
  options: readonly string[],
  help: string,
  o: Partial<DeskField> = {},
): DeskField => ({ path, label, kind: 'enum', options, help, ...o })

export const tf = (path: string, label: string, help: string, o: Partial<DeskField> = {}): DeskField => ({
  path,
  label,
  kind: 'text',
  help,
  ...o,
})

/* ================================ scan-desk ================================ */

import {
  PRICING_SHAPES,
  SCAN_WORKED_EXAMPLE,
  gradeScan,
  modelScanBudget,
} from './scan'
import type { PricingShape, ScanSubmission } from './scan'
import { GB, MB, MIB, GIB, TB, fmtBytes, fmtCount, pct, round2, toGB, toTB } from './kit'

const scanRef = modelScanBudget(SCAN_WORKED_EXAMPLE)

/**
 * The known-good scan submission. Every claim is read out of the model, so the
 * only hand-written values here are the scenario (which is C0.L5's worked
 * example, already exported) and the discipline terms, which are booleans and a
 * name rather than numbers.
 */
export const SCAN_KNOWN: ScanSubmission = {
  input: SCAN_WORKED_EXAMPLE,
  claimedPerQueryBytes: Object.fromEntries(scanRef.perClass.map((r) => [r.id, r.perQueryBytes])),
  claimedDailyTotalBytes: scanRef.dailyTotalBytes,
  statedShape: 'per-byte-scanned',
  statedDataGrowth: true,
  statedAdoptionGrowth: true,
}

/** Per-class scenario fields. Generated: three classes, one description. */
const scanClassFields = (i: number, id: string, adhoc: boolean): DeskField[] => [
  tf(`input.classes.${i}.id`, `class ${i + 1} — name`, 'What this query class is called in your own workload.'),
  ef(
    `input.classes.${i}.kind`,
    `class ${i + 1} — recurring or ad-hoc`,
    ['recurring', 'adhoc'],
    'A recurring class has fixed columns, predicates and a schedule, so its bytes are arithmetic. An ad-hoc class has a long tail and is reported as a CEILING instead.',
    { required: true },
  ),
  nf(`input.classes.${i}.tableBytes`, `${id} — table size read`, 'Bytes of the table(s) this class reads, uncompressed on disk.', {
    factor: TB,
    unit: 'TB',
  }),
  nf(
    `input.classes.${i}.projectedFraction`,
    `${id} — columns projected`,
    'Bytes of the columns projected divided by bytes of all columns. 100 is SELECT *.',
    { factor: 0.01, unit: '% of columns' },
  ),
  nf(
    `input.classes.${i}.pruningRatio`,
    `${id} — row groups pruned`,
    'Row groups skipped divided by row groups this class could have read. Per class, never per table.',
    { factor: 0.01, unit: '% skipped' },
  ),
  nf(`input.classes.${i}.queriesPerDay`, `${id} — queries per day`, 'The schedule, or the observed rate.', {
    unit: 'queries/day',
  }),
  ...(adhoc
    ? [
        nf(
          `input.classes.${i}.perQueryQuotaBytes`,
          `${id} — per-query quota`,
          'The per-query fence for an ad-hoc class. A quota you enforce, not a forecast you made.',
          { factor: GB, unit: 'GB' },
        ),
        nf(
          `input.classes.${i}.dailyPoolCeilingBytes`,
          `${id} — daily pool ceiling`,
          'The daily ceiling for the ad-hoc pool. This is the number you report for it: a bound, reported as a bound.',
          { factor: TB, unit: 'TB' },
        ),
      ]
    : []),
]

const scanPerQueryClaim = (id: string): DeskField =>
  nf(`claimedPerQueryBytes.${id}`, `${id} — bytes per query`, 'table bytes × columns projected × (1 − pruned).', {
    factor: GB,
    unit: 'GB',
  })

/** PricingShape → the dossier's own shape vocabulary. Lossy, and named as such. */
const DOSSIER_SHAPE: Record<PricingShape, NonNullable<Dossier['pricingShape']>> = {
  'per-byte-scanned': 'consumption-bytes',
  'credits-per-warehouse-second': 'consumption-credits',
  'per-node-hour': 'instance',
  'provisioned-compute': 'capacity',
}

const scanForm: DeskForm = {
  desk: 'scan-desk',
  brief:
    'Three query classes read the same 40 TB table: scheduled dashboards, scheduled pipelines, and analysts. Two of them are recurring and therefore computable; one is ad-hoc and can only be bounded. Produce the per-query bytes for each class, the daily total, the pricing shape the number lands on, and growth as two separate terms.',
  groups: [
    {
      id: 'classes',
      title: 'The workload, per class',
      role: 'given',
      blurb:
        'Three factors per class, because that is the arithmetic: a budget is per query CLASS and an average over classes hides the class that prunes nothing.',
      fields: [
        ...scanClassFields(0, 'dashboards', false),
        ...scanClassFields(1, 'pipelines', false),
        ...scanClassFields(2, 'analysts', true),
      ],
    },
    {
      id: 'horizon',
      title: 'Growth and horizon',
      role: 'given',
      blurb: 'Two growth terms, never one blended percentage — the blend hides the dangerous term.',
      fields: [
        nf('input.dataGrowthPerYear', 'data growth', 'How much the table itself grows. The smaller, more predictable term.', {
          factor: 0.01,
          unit: '% / yr',
        }),
        nf(
          'input.adoptionGrowthPerYear',
          'adoption growth',
          'Dashboards and analysts added per year. The larger, vaguer term, and the one that breaks budgets.',
          { factor: 0.01, unit: '% / yr' },
        ),
        nf('input.horizonMonths', 'projection horizon', 'Counted in months. Never billed in them.', { unit: 'months' }),
      ],
    },
    {
      id: 'claims',
      title: 'What you submit',
      role: 'claim',
      blurb: 'Your arithmetic, graded in a ±15% band. A sizing model is not correct; it is within tolerance.',
      fields: [
        scanPerQueryClaim('dashboards'),
        scanPerQueryClaim('pipelines'),
        scanPerQueryClaim('analysts'),
        nf(
          'claimedDailyTotalBytes',
          'daily total, whole workload',
          'Recurring classes computed, plus the ad-hoc ceiling. A number that omits the ad-hoc ceiling is the largest line in the budget you did not write.',
          { factor: TB, unit: 'TB' },
        ),
      ],
    },
    {
      id: 'discipline',
      title: 'The terms an omission fails on',
      role: 'discipline',
      blurb:
        'Each of these fails its check on absence alone. A byte count with no pricing shape is a measurement, not a budget.',
      fields: [
        ef('statedShape', 'pricing shape, by name', PRICING_SHAPES, 'A NAME, not a rate. The rate is yours and you multiply.', {
          nullable: true,
          discipline: {
            check: 'shape_stated',
            cost:
              'Blank fails shape_stated on its own. The same byte count is the entire bill under per-byte-scanned and merely a capacity input under provisioned-compute, so without the shape nobody can multiply your figure by anything — your point estimate can be exact and still un-actionable.',
          },
        }),
        bf('statedDataGrowth', 'data growth named as its own term', 'Did the plan carry a data-growth term, separately?', {
          check: 'growth_modelled',
          cost: 'Blank fails growth_modelled. Data growth compounds against every recurring line; leaving it out makes today’s figure a snapshot rather than a plan.',
        }),
        bf(
          'statedAdoptionGrowth',
          'adoption growth named as its own term',
          'Did the plan carry adoption growth separately from data growth?',
          {
            check: 'growth_modelled',
            cost:
              'Blank fails growth_modelled, and this is the term that actually breaks budgets: more dashboards and more analysts arrive without a migration or a ticket. Blending it into one percentage hides it.',
          },
        ),
      ],
    },
  ],
  assemble: (values) => assembleFrom(allFields(scanForm), values) as unknown as ScanSubmission,
  grade: (values) => gradeScan(scanForm.assemble(values) as ScanSubmission),
  reference: (values) => {
    const sub = scanForm.assemble(values) as ScanSubmission
    const out = modelScanBudget(sub.input)
    return [
      ...out.perClass.map((r) => ({
        label: `${r.id} — per query`,
        value: `${toGB(r.perQueryBytes).toFixed(1)} GB`,
        note: `${pct(r.factors.projectedFraction)} of columns × ${pct(r.factors.readFraction)} read × ${fmtCount(
          r.factors.queriesPerDay,
        )} queries/day — ${r.computed ? 'computed' : 'a CEILING, not a forecast'}`,
      })),
      {
        label: 'recurring, per day',
        value: `${toTB(out.recurringDailyBytes).toFixed(2)} TB`,
        note: 'arithmetic: fixed columns, fixed predicates, a schedule',
      },
      {
        label: 'ad-hoc bound, per day',
        value: `${toTB(out.adhocBoundBytes).toFixed(2)} TB`,
        note: 'a fence, added flat — it is what stops adoption growing the bill',
      },
      { label: 'daily total', value: `${toTB(out.dailyTotalBytes).toFixed(2)} TB` },
      {
        label: 'growth factors',
        value: `data ×${out.dataGrowthFactor.toFixed(2)} · adoption ×${out.adoptionGrowthFactor.toFixed(2)}`,
        note: 'kept apart on purpose; the larger one is the one nobody forecasts',
      },
      {
        label: `recurring at month ${sub.input.horizonMonths}`,
        value: `${toTB(out.horizonRecurringDailyBytes).toFixed(2)} TB/day`,
      },
      { label: 'largest class', value: out.largestClassId, note: 'the line to defend first' },
    ]
  },
  offers: (values) => {
    const sub = scanForm.assemble(values) as ScanSubmission
    const out = modelScanBudget(sub.input)
    const worst = out.perClass.reduce((a, b) => (b.perQueryBytes > a.perQueryBytes ? b : a), out.perClass[0])
    const offers: DossierOffer[] = [
      {
        key: 'dailyScanBytes',
        label: 'bytes scanned per day, whole workload',
        value: out.dailyTotalBytes,
        derivation: 'recurring classes computed plus the ad-hoc ceiling',
      },
      {
        key: 'worstQueryBytes',
        label: 'bytes read by the worst recurring query',
        value: worst.perQueryBytes,
        derivation: `the largest per-query class (${worst.id})`,
      },
      {
        key: 'growthModelled',
        label: 'the plan contains a growth term',
        value: sub.statedDataGrowth && sub.statedAdoptionGrowth,
        derivation: 'true only when BOTH growth terms were named separately',
      },
      {
        key: 'growthRate',
        label: 'annual growth multiplier',
        value: 1 + sub.input.dataGrowthPerYear,
        derivation: 'the data-growth term as a multiplier; the dossier has one field and this desk has two terms',
      },
    ]
    if (sub.statedShape !== null) {
      offers.push({
        key: 'pricingShape',
        label: 'how the platform is billed',
        value: DOSSIER_SHAPE[sub.statedShape],
        derivation: `${sub.statedShape} mapped into the dossier’s own shape vocabulary`,
      })
    }
    return offers
  },
  known: SCAN_KNOWN,
}

/* =============================== layout-desk =============================== */

import {
  LAYOUT_WORKED_CLASSES,
  LAYOUT_WORKED_DESIGN,
  gradeLayout,
  modelLayout,
} from './layout'
import type { LayoutSubmission, PruningMechanism } from './layout'

const MECHANISMS: readonly PruningMechanism[] = [
  'min-max-in-footer',
  'zone-map-in-manifest',
  'bloom-filter-in-footer',
  'external-index',
  'cached-statistics',
]

const layoutRef = modelLayout(LAYOUT_WORKED_CLASSES, LAYOUT_WORKED_DESIGN)
const layoutWorst = layoutRef.perClass.find((r) => r.id === layoutRef.worstClassId)!

export const LAYOUT_KNOWN: LayoutSubmission = {
  classes: LAYOUT_WORKED_CLASSES,
  design: LAYOUT_WORKED_DESIGN,
  promisedPruningRatio: Object.fromEntries(layoutRef.perClass.map((r) => [r.id, r.pruningRatio])),
  claimedFilesTouched: Object.fromEntries(layoutRef.perClass.map((r) => [r.id, r.filesTouched])),
  statedWorstClassId: layoutRef.worstClassId,
  statedWorstClassRatio: layoutWorst.pruningRatio,
  statedWorstClassResponse:
    'a second table sorted for the rollup predicate, refreshed on the same commit — accepted as a second copy of the bytes',
  statisticsMaintainedWithData: true,
  /* A ceiling is a commitment, and it must clear the worst class the design
   * actually produces. Derived from the model so the scenario stays coherent. */
  filesTouchedCeiling: Math.max(...layoutRef.perClass.map((r) => r.filesTouched)) * 2,
}

const layoutClassFields = (i: number, id: string): DeskField[] => [
  tf(`classes.${i}.id`, `class ${i + 1} — name`, 'What this query class is called.'),
  nf(
    `classes.${i}.candidateRowGroups`,
    `${id} — candidate row groups`,
    'N: the row groups this class COULD have read. The denominator of every ratio below.',
    { unit: 'row groups' },
  ),
  nf(
    `classes.${i}.selectivity`,
    `${id} — selectivity`,
    'f: the fraction of rows the predicate matches. A needle class is around 0.00001%.',
    { factor: 0.01, unit: '% of rows' },
  ),
  nf(
    `classes.${i}.projectedBytesPerRowGroup`,
    `${id} — projected bytes per row group`,
    'Bytes of the columns this class projects, inside one row group.',
    { factor: MIB, unit: 'MiB' },
  ),
  nf(
    `classes.${i}.shareOfMix`,
    `${id} — share of the daily mix`,
    'Used only to rank. Never to average a class away — the average is what hides the starved class.',
    { factor: 0.01, unit: '% of queries' },
  ),
]

const layoutForm: DeskForm = {
  desk: 'layout-desk',
  brief:
    'One table, three query classes, and exactly one physical order. Derive the pruning ratio each class actually gets, check the file arithmetic against the ingest, and name the class this design starves — with its number and what you will do about it.',
  groups: [
    {
      id: 'classes',
      title: 'The query mix',
      role: 'given',
      blurb: 'Three classes over the same 24,000 candidate row groups, spanning five orders of magnitude of selectivity.',
      fields: [
        ...layoutClassFields(0, 'dashboard'),
        ...layoutClassFields(1, 'rollup'),
        ...layoutClassFields(2, 'needle'),
      ],
    },
    {
      id: 'design',
      title: 'The design',
      role: 'given',
      blurb: 'The partition, sort and file-size decisions, plus the mechanism that has to PROVE every skip.',
      fields: [
        tf('design.partitionKey', 'partition key', 'What cuts the file list.'),
        tf('design.sortKey', 'sort key', 'What cuts the bytes inside each file. A table has exactly one physical order.'),
        nf('design.rowGroupRows', 'rows per row group', '128Ki is the conventional default.', { unit: 'rows' }),
        nf(
          'design.clusteringDepth',
          'clustering depth',
          'd: 1.0 is perfectly clustered. Above 1.0 the loader has stopped writing in key order — this is the assumption the whole design rests on.',
          { unit: '×' },
        ),
        nf(
          'design.partitionsWrittenPerDay',
          'partitions written per day',
          'What the ingest actually touches. Against the ceiling below, this is what decides file size.',
          { unit: 'partitions/day' },
        ),
        nf('design.targetFileBytes', 'target file size', 'The setting. Checked against what the scheme can reach.', {
          factor: MB,
          unit: 'MB',
        }),
        nf('design.dailyIngestBytes', 'daily ingest', 'Bytes landing in this table per day.', { factor: GB, unit: 'GB' }),
        ef(
          'design.mechanism',
          'pruning mechanism',
          MECHANISMS,
          'How the skip is PROVED. Min-max in the footer and zone maps in the manifest are written with the data; a cache or an external index is not.',
          { required: true },
        ),
      ],
    },
    {
      id: 'claims',
      title: 'What you submit',
      role: 'claim',
      blurb: 'Ratios are graded in points of ratio (±1.5 points), file counts in a ±25% band.',
      fields: [
        nf('promisedPruningRatio.dashboard', 'dashboard — promised pruning', '1 − d(f·N + 1)/N. The +1 is the boundary row group.', {
          factor: 0.01,
          unit: '%',
        }),
        nf('promisedPruningRatio.rollup', 'rollup — promised pruning', 'Same arithmetic, a thousand times less selective.', {
          factor: 0.01,
          unit: '%',
        }),
        nf('promisedPruningRatio.needle', 'needle — promised pruning', 'A needle class asymptotes below 1.0, and the +1 is why.', {
          factor: 0.01,
          unit: '%',
        }),
        nf('claimedFilesTouched.dashboard', 'dashboard — files touched', 'ceil(row groups read ÷ 8 per file).', { unit: 'files' }),
        nf('claimedFilesTouched.rollup', 'rollup — files touched', 'Planning cost, and invisible to a bytes-scanned dashboard.', {
          unit: 'files',
        }),
        nf('claimedFilesTouched.needle', 'needle — files touched', 'Small candidate sets are cheap even at a poor ratio.', {
          unit: 'files',
        }),
        nf(
          'filesTouchedCeiling',
          'ceiling on files one query may touch',
          'A count you commit to. Caller-supplied, because every planner has a level at which the file list becomes the query.',
          { unit: 'files' },
        ),
      ],
    },
    {
      id: 'discipline',
      title: 'The caveat, in three parts',
      role: 'discipline',
      blurb:
        'A design with a perfect pruning number and no named loser fails worst_query_stated — and it fails harder if it names the wrong class. Rank by BYTES READ, not by ratio.',
      fields: [
        ef(
          'statedWorstClassId',
          'the class this design starves',
          LAYOUT_WORKED_CLASSES.map((c) => c.id),
          'Which class the physical order abandons.',
          {
            nullable: true,
            discipline: {
              check: 'worst_query_stated',
              cost:
                'Blank fails worst_query_stated. A table has exactly one physical order, so the design necessarily abandons a class; a promise with no named loser is a description of the happy path.',
            },
          },
        ),
        nf('statedWorstClassRatio', 'the ratio that class actually gets', 'Its number, not the design’s best number.', {
          factor: 0.01,
          unit: '%',
          nullable: true,
          discipline: {
            check: 'worst_query_stated',
            cost: 'Naming the class without its number is two parts of a three-part caveat: the reader cannot tell how bad it is.',
          },
        }),
        tf(
          'statedWorstClassResponse',
          'what happens to it',
          'A second table, a secondary index, or "nothing, deliberately, and here is why that is acceptable".',
          {
            nullable: true,
            discipline: {
              check: 'worst_query_stated',
              cost:
                'A named loser with no stated response is an acknowledgement, not a decision — the reader cannot tell whether you weighed it or noticed it.',
            },
          },
        ),
        bf(
          'statisticsMaintainedWithData',
          'statistics written in the same commit as the data',
          'Are the statistics that prove a skip written with the data they describe?',
          {
            check: 'no_false_negatives',
            cost:
              'Blank fails no_false_negatives with ZERO tolerance, while the ratio itself is graded in a band — because a layout is allowed to change your bill and never your answer. A statistic that can lag the data turns a proof into a guess with a good hit rate.',
          },
        ),
      ],
    },
  ],
  assemble: (values) => assembleFrom(allFields(layoutForm), values) as unknown as LayoutSubmission,
  grade: (values) => gradeLayout(layoutForm.assemble(values) as LayoutSubmission),
  reference: (values) => {
    const sub = layoutForm.assemble(values) as LayoutSubmission
    const out = modelLayout(sub.classes, sub.design)
    return [
      ...out.perClass.map((r) => ({
        label: `${r.id} — pruning`,
        value: pct(r.pruningRatio),
        note: `${fmtCount(r.rowGroupsRead)} row groups, ${fmtCount(r.filesTouched)} files, ${fmtBytes(
          r.bytesRead,
        )} read · provable ceiling ${pct(r.maxProvableRatio)} · exposure ×${round2(r.exposureMultiplier)} if order stops holding`,
      })),
      { label: 'best-served class', value: out.bestClassId, note: 'the class the design was chosen for' },
      { label: 'starved class', value: out.worstClassId, note: 'ranked by bytes read, which is the honest ranking' },
      {
        label: 'partition ceiling',
        value: `${round2(out.partitionCeiling)} partitions/day`,
        note: `daily ingest ÷ target file size; the scheme averages ${fmtBytes(out.achievedFileBytes)} per file`,
      },
      {
        label: 'mix-weighted ratio',
        value: pct(out.weightedPruningRatio),
        note: 'reported, never graded — it is the average that hides the starved class',
      },
    ]
  },
  offers: (values) => {
    const sub = layoutForm.assemble(values) as LayoutSubmission
    const out = modelLayout(sub.classes, sub.design)
    const best = sub.promisedPruningRatio[out.bestClassId]
    const offers: DossierOffer[] = [
      {
        key: 'partitionKey',
        label: 'partition key',
        value: sub.design.partitionKey,
        derivation: 'the design you submitted',
      },
      { key: 'sortKey', label: 'sort key', value: sub.design.sortKey, derivation: 'the design you submitted' },
      {
        key: 'targetFileSizeBytes',
        label: 'target file size',
        value: sub.design.targetFileBytes,
        derivation: 'the configured target, which the desk checked against what the scheme can reach',
      },
      {
        key: 'worstQueryStated',
        label: 'we named the query this layout is bad for',
        value:
          sub.statedWorstClassId === out.worstClassId &&
          sub.statedWorstClassRatio !== null &&
          sub.statedWorstClassResponse !== null,
        derivation: 'true only when the RIGHT class was named, with its ratio and a response',
      },
    ]
    if (best !== undefined) {
      offers.push({
        key: 'promisedPruningRatio',
        label: 'promised pruning ratio on the target query',
        value: best,
        derivation: `the ratio promised for the best-served class (${out.bestClassId})`,
      })
    }
    return offers
  },
  known: LAYOUT_KNOWN,
}

/* =============================== ingest-desk =============================== */

import { INGEST_WORKED_EXAMPLE, REQUIRED_HEADROOM, gradeIngest, modelIngest } from './ingest'
import type { IngestSubmission, Tradeoff } from './ingest'

const TRADEOFFS: readonly Tradeoff[] = ['freshness', 'file-count']

const ingestRef = modelIngest(INGEST_WORKED_EXAMPLE)

export const INGEST_KNOWN: IngestSubmission = {
  input: INGEST_WORKED_EXAMPLE,
  claimedP99StalenessSeconds: ingestRef.p99StalenessSeconds,
  claimedAverageFileBytes: ingestRef.averageFileBytes,
  statedTradeoff: 'freshness',
  statedTradeoffMagnitude:
    'five minutes rather than one: we do not promise sub-minute freshness, and in exchange the file count stays at a rate compaction can outrun',
  statedWriteAmpBudget: ingestRef.writeAmplification,
}

const ingestForm: DeskForm = {
  desk: 'ingest-desk',
  brief:
    'A table taking 25 GB a day from four writers across six partitions. Choose the commit interval, then state the p99 staleness it produces, the average file size it actually achieves, and whether compaction can outrun the file creation rate with headroom. Freshness, file size and compaction capacity are only jointly achievable at some interval — find it and say which side you gave up.',
  groups: [
    {
      id: 'topology',
      title: 'The ingest topology',
      role: 'given',
      blurb:
        'Commits per day, partitions per commit and writers multiply into the file count directly. The interval is the one you can change today; the other two usually imply a migration.',
      fields: [
        nf('input.batchIntervalSeconds', 'commit interval', 'Seconds between commits. Halving it doubles the file count at constant data.', {
          unit: 'seconds',
        }),
        nf('input.commitSeconds', 'commit time', 'Time to commit a batch and make it visible. Use the p99, not the median.', {
          unit: 'seconds',
        }),
        nf(
          'input.conversionLagSeconds',
          'conversion lag',
          'Seconds until buffered rows become columnar. Irrelevant when the buffer is on the read path, DOMINANT when it is not.',
          { unit: 'seconds' },
        ),
        bf(
          'input.bufferOnReadPath',
          'the write buffer is on the read path',
          'When readers can see the buffer, conversion lag does not apply. When they cannot, it is added to every staleness figure — and it is usually larger than the interval anyone tuned.',
        ),
        nf('input.dailyIngestBytes', 'daily ingest', 'Bytes landing per day.', { factor: GB, unit: 'GB' }),
        nf('input.partitionsWrittenPerBatch', 'partitions per commit', 'Multiplies the file count directly.', {
          unit: 'partitions',
        }),
        nf('input.writers', 'concurrent writers', 'Also multiplies the file count directly.', { unit: 'writers' }),
        nf('input.targetFileBytes', 'target file size', 'The setting. The desk checks it against what one partition-day can reach.', {
          factor: MB,
          unit: 'MB',
        }),
        nf(
          'input.mergeRateFilesPerHour',
          'sustained merge capacity',
          'A COUNT of files per hour compaction can merge. Graded as a rate against a rate, never as "we run compaction nightly".',
          { unit: 'files/hour' },
        ),
      ],
    },
    {
      id: 'claims',
      title: 'What you submit',
      role: 'claim',
      blurb:
        'The p99, not the mean. Mean staleness is interval ÷ 2 + commit and it is roughly half the number you are actually promising.',
      fields: [
        nf(
          'claimedP99StalenessSeconds',
          'p99 end-to-end staleness',
          '0.99 × interval + commit, plus conversion lag when the buffer is off the read path. What the unluckiest row experiences.',
          { unit: 'seconds' },
        ),
        nf(
          'claimedAverageFileBytes',
          'average file size actually achieved',
          'Daily ingest ÷ files per day, where files per day is commits × partitions × writers. State it beside the target you configured.',
          { factor: MB, unit: 'MB' },
        ),
      ],
    },
    {
      id: 'discipline',
      title: 'The side you gave up',
      role: 'discipline',
      blurb:
        'tradeoff_stated fails on any of these three being absent. A submission with a fresh SLA, a large target file size and no rate arithmetic fails here even when each individual number is plausible.',
      fields: [
        ef('statedTradeoff', 'which side you gave up', TRADEOFFS, 'Freshness, or file count. One of them is going to give.', {
          nullable: true,
          discipline: {
            check: 'tradeoff_stated',
            cost: 'Blank fails tradeoff_stated. The three constraints are only jointly achievable at some interval, and this desk grades whether you found it AND said so.',
          },
        }),
        tf('statedTradeoffMagnitude', 'by how much', 'The freshness not promised, or the file count accepted. In numbers.', {
          nullable: true,
          discipline: {
            check: 'tradeoff_stated',
            cost: 'A tradeoff named without a magnitude is unfalsifiable — nobody can tell whether you gave up a minute or an hour.',
          },
        }),
        nf(
          'statedWriteAmpBudget',
          'write-amplification budget it consumes',
          '1 + compaction passes. Say it as a bill: every ingested byte is written this many times.',
          {
            unit: '×',
            nullable: true,
            discipline: {
              check: 'tradeoff_stated',
              cost:
                'Blank fails tradeoff_stated on its own. A plan with no write-amp budget is an unbounded background bill: the rewriting is forever, for as long as the table exists.',
            },
          },
        ),
      ],
    },
  ],
  assemble: (values) => assembleFrom(allFields(ingestForm), values) as unknown as IngestSubmission,
  grade: (values) => gradeIngest(ingestForm.assemble(values) as IngestSubmission),
  reference: (values) => {
    const sub = ingestForm.assemble(values) as IngestSubmission
    const out = modelIngest(sub.input)
    return [
      {
        label: 'p99 staleness',
        value: `${out.p99StalenessSeconds.toFixed(1)} s`,
        note: `mean is ${out.meanStalenessSeconds.toFixed(1)} s — quoting the mean halves what you are promising${
          out.conversionLagApplied > 0 ? `; conversion lag of ${out.conversionLagApplied} s applies and dominates` : ''
        }`,
      },
      {
        label: 'files per day',
        value: fmtCount(out.filesPerDay),
        note: `${fmtCount(out.commitsPerDay)} commits × ${sub.input.partitionsWrittenPerBatch} partitions × ${sub.input.writers} writers`,
      },
      {
        label: 'average file size',
        value: fmtBytes(out.averageFileBytes),
        note: out.targetReachable
          ? 'the configured target is reachable from one partition-day of ingest'
          : 'the configured target exceeds one partition-day of ingest, so it is a wish rather than a setting',
      },
      {
        label: 'compaction headroom',
        value: `${round2(out.headroomRatio)}×`,
        note: `${fmtCount(out.creationRateFilesPerHour)} created/hour against ${fmtCount(
          sub.input.mergeRateFilesPerHour,
        )} merged/hour · ${REQUIRED_HEADROOM}× required${
          out.backlogGrowthFilesPerDay > 0
            ? ` · deficit ${fmtCount(out.backlogGrowthFilesPerDay)} files/day, which ACCUMULATES rather than saturating`
            : ''
        }`,
      },
      {
        label: 'write amplification',
        value: `${round2(out.writeAmplification)}×`,
        note: `${out.compactionPasses} pass(es) rewriting ${fmtBytes(out.bytesRewrittenPerDay)}/day for ${fmtBytes(
          sub.input.dailyIngestBytes,
        )} ingested`,
      },
    ]
  },
  offers: (values) => {
    const sub = ingestForm.assemble(values) as IngestSubmission
    const out = modelIngest(sub.input)
    return [
      {
        key: 'batchIntervalSec',
        label: 'commit / batch interval',
        value: sub.input.batchIntervalSeconds,
        derivation: 'the interval you chose',
      },
      {
        key: 'stalenessP99Sec',
        label: 'p99 end-to-end staleness',
        value: sub.claimedP99StalenessSeconds,
        derivation: 'the p99 you submitted, which the desk banded against interval + commit + conversion lag',
      },
      {
        key: 'compactionKeepsUp',
        label: 'compaction outruns file creation',
        value: out.headroomRatio >= REQUIRED_HEADROOM,
        derivation: `merge rate ÷ creation rate ≥ ${REQUIRED_HEADROOM}× — a rate against a rate, with headroom`,
      },
    ]
  },
  known: INGEST_KNOWN,
}

/* =============================== tenancy-desk =============================== */

import { TENANCY_WORKED_EXAMPLE, attributionWorks, gradeTenancy, modelTenancy } from './tenancy'
import type { AttributionMethod, IsolationBoundary, TenancyModel, TenancySubmission } from './tenancy'

const TENANCY_MODELS: readonly TenancyModel[] = [
  'table-per-tenant',
  'schema-per-tenant',
  'shared-table-partitioned',
  'shared-table-clustered',
  'account-per-tenant',
]

const BOUNDARIES: readonly IsolationBoundary[] = ['none', 'row-filter', 'partition', 'table', 'schema', 'account']

const ATTRIBUTION_METHODS: readonly AttributionMethod[] = [
  'per-tenant-query-tags',
  'per-tenant-compute-pool',
  'bytes-scanned-per-tenant-from-query-log',
  'storage-bytes-by-partition',
  'account-level-billing',
]

const tenancyRef = modelTenancy(TENANCY_WORKED_EXAMPLE)

export const TENANCY_KNOWN: TenancySubmission = {
  input: TENANCY_WORKED_EXAMPLE,
  statedBoundary: 'partition',
  attributionMethod: 'storage-bytes-by-partition',
  claimedWorstTenantBytes: tenancyRef.largestTenantBytes,
  claimedCatalogObjects: tenancyRef.catalogObjects,
}

/** TenancyModel → the dossier's coarser vocabulary. Lossy, and named as such. */
const DOSSIER_TENANCY: Record<TenancyModel, NonNullable<Dossier['tenancyModel']>> = {
  'table-per-tenant': 'table-per-tenant',
  'schema-per-tenant': 'schema-per-tenant',
  'shared-table-partitioned': 'shared-table-filter',
  'shared-table-clustered': 'shared-table-filter',
  'account-per-tenant': 'cluster-per-tenant',
}

const tenancyForm: DeskForm = {
  desk: 'tenancy-desk',
  brief:
    'Four hundred tenants, Zipf-distributed, sharing tables, one compute pool and one catalog. The mean tenant is a fiction: one tenant sets your capacity ceiling and the smallest ones set your per-query metadata overhead. Report both ends, count the catalog objects, and say how per-tenant cost is attributed.',
  groups: [
    {
      id: 'population',
      title: 'The tenant population',
      role: 'given',
      blurb:
        'Sizes are drawn from the shared seeded xorshift, so every learner sees the same 400 tenants. Change the seed and you get a different population, not a different model.',
      fields: [
        ef('input.model', 'tenancy model', TENANCY_MODELS, 'How tenants share tables. This sets the ceiling on any boundary you can claim.', {
          required: true,
        }),
        nf('input.tenants', 'tenants', 'How many share the platform.', { unit: 'tenants' }),
        nf('input.totalBytes', 'total bytes, all tenants', 'Distributed Zipf across the population, not evenly.', {
          factor: GIB,
          unit: 'GiB',
        }),
        nf('input.zipfExponent', 'Zipf exponent', 'Around 1.1 is typical of real tenant populations. Higher is more skewed.', {
          unit: 's',
        }),
        nf('input.seed', 'population seed', 'The seeded xorshift’s seed. Replayable: same seed, same tenants, every time.', {
          unit: 'seed',
        }),
      ],
    },
    {
      id: 'catalog',
      title: 'What the catalog has to track',
      role: 'given',
      blurb:
        'Objects grow with tenants × tables × partitions × files. Storage grows with data; metadata grows with FILE COUNT. Different curves.',
      fields: [
        nf('input.tablesPerTenant', 'tables per tenant', 'A table-per-tenant model multiplies this by the tenant count.', {
          unit: 'tables',
        }),
        nf('input.partitionsPerTenantTable', 'partitions per tenant table', 'Per tenant, per table.', { unit: 'partitions' }),
        nf('input.filesPerPartition', 'files per partition', 'The term most often dropped, and the product of every other term.', {
          unit: 'files',
        }),
        nf('input.footerBytes', 'footer bytes per file', 'What a reader must open per file to plan. This is what the long tail pays.', {
          factor: 1024,
          unit: 'KiB',
        }),
        nf('input.catalogObjectCeiling', 'catalog object ceiling', 'A COUNT, caller-supplied. Every catalog has one.', {
          unit: 'objects',
        }),
      ],
    },
    {
      id: 'pool',
      title: 'The shared compute pool',
      role: 'given',
      blurb: 'Concurrency is counted in slots, because a slot is a count and an hour is not.',
      fields: [
        nf('input.poolSlots', 'pool capacity', 'Concurrent slots the shared pool holds.', { unit: 'slots' }),
      ],
    },
    {
      id: 'claims',
      title: 'What you submit',
      role: 'claim',
      blurb: 'Both ends of the distribution. Never the average — a Zipf population has no typical member.',
      fields: [
        nf(
          'claimedWorstTenantBytes',
          'bytes held by the largest tenant',
          'The head of the distribution, which is what sets the capacity ceiling. Not the mean, and not the median.',
          { factor: GIB, unit: 'GiB' },
        ),
        nf('claimedCatalogObjects', 'catalog objects the design creates', 'tables + partitions + files.', { unit: 'objects' }),
      ],
    },
    {
      id: 'discipline',
      title: 'Boundaries, attribution and the cap',
      role: 'discipline',
      blurb:
        'A boundary claimed above what the layout can enforce is enforced by convention, and convention is not an access control. An unattributed pool reports one aggregate that never names the tenant consuming it.',
      fields: [
        ef(
          'statedBoundary',
          'isolation boundary the design enforces',
          BOUNDARIES,
          '"none" is a real answer and it is graded as one — with 400 tenants it means a planner bug is a data breach rather than a wrong number.',
          {
            required: true,
            conditional: true,
            discipline: {
              check: 'isolation',
              cost:
                'Choosing "none" fails isolation outright, and claiming a boundary stronger than the model can enforce fails it too — a boundary that does not exist is worse than a weak one, because it stops anyone looking for the compensating control.',
            },
          },
        ),
        ef(
          'attributionMethod',
          'how per-tenant cost is attributed',
          ATTRIBUTION_METHODS,
          'The method has to actually separate tenants under the model you chose.',
          {
            nullable: true,
            discipline: {
              check: 'attribution',
              cost:
                'Blank fails attribution. Without a method every tenant’s cost is the mean, and the mean is a fiction here — your worst-tenant figure can be exact and still undefendable, because you cannot show a tenant the bytes that were theirs.',
            },
          },
        ),
        nf(
          'input.perTenantSlotCap',
          'per-tenant concurrency cap',
          'A COUNT of slots. Size it so the head tenant’s worst hour still leaves the tail able to plan.',
          {
            unit: 'slots',
            nullable: true,
            discipline: {
              check: 'noisy_neighbour',
              cost:
                'Blank fails noisy_neighbour. Uncapped, the largest tenant’s byte share is its share of the pool, and every other tenant queues behind one customer’s backfill. A cap equal to the pool is not a cap either.',
            },
          },
        ),
      ],
    },
  ],
  assemble: (values) => assembleFrom(allFields(tenancyForm), values) as unknown as TenancySubmission,
  grade: (values) => gradeTenancy(tenancyForm.assemble(values) as TenancySubmission),
  reference: (values) => {
    const sub = tenancyForm.assemble(values) as TenancySubmission
    const out = modelTenancy(sub.input)
    return [
      {
        label: 'largest tenant',
        value: fmtBytes(out.largestTenantBytes),
        note: `${round2(out.skewRatio)}× the mean of ${fmtBytes(out.meanTenantBytes)} — the number that makes "the average tenant" unsayable`,
      },
      {
        label: 'smallest tenant',
        value: fmtBytes(out.smallestTenantBytes),
        note: `pays ${round2(out.smallTenantMetadataAmplification)}× its own data in footers (${fmtBytes(
          out.metadataBytesPerSmallTenantQuery,
        )} per query)`,
      },
      { label: 'top 1% hold', value: pct(out.topPercentShare), note: 'of all bytes' },
      {
        label: 'catalog objects',
        value: fmtCount(out.catalogObjects),
        note: `${fmtCount(out.tables)} tables + ${fmtCount(out.partitions)} partitions + ${fmtCount(
          out.files,
        )} files · headroom ${fmtCount(out.catalogHeadroom)}`,
      },
      {
        label: 'noisy neighbour',
        value: out.noisyNeighbourBounded ? 'bounded' : 'unbounded',
        note: `uncapped the head tenant claims about ${fmtCount(out.worstTenantSlotsUncapped)} of ${fmtCount(
          sub.input.poolSlots,
        )} slots; ${fmtCount(out.slotsLeftForOthers)} left for everyone else as submitted`,
      },
    ]
  },
  offers: (values) => {
    const sub = tenancyForm.assemble(values) as TenancySubmission
    const out = modelTenancy(sub.input)
    return [
      { key: 'tenants', label: 'tenants sharing the platform', value: sub.input.tenants, derivation: 'the population you modelled' },
      {
        key: 'tenancyModel',
        label: 'tenancy model',
        value: DOSSIER_TENANCY[sub.input.model],
        derivation: `${sub.input.model} mapped into the dossier’s coarser vocabulary`,
      },
      {
        key: 'costAttribution',
        label: 'spend attributable per tenant',
        value: sub.attributionMethod !== null && attributionWorks(sub.input.model, sub.attributionMethod),
        derivation: 'true only when a method was named AND it actually separates tenants under this model',
      },
      {
        key: 'noisyNeighbourControl',
        label: 'noisy-neighbour control exists',
        value: out.noisyNeighbourBounded,
        derivation: 'a per-tenant cap that still leaves the pool usable by the others',
      },
    ]
  },
  known: TENANCY_KNOWN,
}

/* ============================= compaction-desk ============================= */

import { COMPACTION_WORKED_EXAMPLE, gradeCompaction, modelCompaction } from './compaction'
import type { CompactionSubmission } from './compaction'

const compactionRef = modelCompaction(COMPACTION_WORKED_EXAMPLE)

export const COMPACTION_KNOWN: CompactionSubmission = {
  input: COMPACTION_WORKED_EXAMPLE,
  claimedReadAmp: compactionRef.amplification.read,
  /* A ceiling is a commitment, so it is derived from what the policy achieves
   * plus a stated margin rather than picked to be comfortable. */
  readAmpCeiling: round2(compactionRef.amplification.read) + 0.03,
  claimedWriteAmp: compactionRef.amplification.write,
  statedRecoveryAfterExpiry: true,
  claimedStorageMultiple: compactionRef.storageMultiple,
  statedStrandedRows: true,
  cost: {
    bytesRewrittenPerDay: compactionRef.bytesRewrittenPerDay,
    rewriteShareOfTablePerDay: compactionRef.rewriteShareOfTablePerDay,
    filesCreatedPerDay: compactionRef.filesWrittenPerDay,
    filesMergedPerDay: compactionRef.filesWrittenPerDay,
    requestsAddedPerDay: compactionRef.requestsAddedPerDay,
    pricingShapeNamed: 'per-byte-scanned',
    quotedWallClock: false,
  },
}

const compactionForm: DeskForm = {
  desk: 'compaction-desk',
  brief:
    'A 40 GiB table taking 2 GiB of logical change a day under a levelled policy. Compaction does not reduce cost; it MOVES cost from the read path to the write path. State both amplification numbers, the expiry window that bounds the third storage component, and every cost term as a count.',
  groups: [
    {
      id: 'policy',
      title: 'The policy',
      role: 'given',
      blurb:
        'The trigger and the scope ARE the policy: a full rewrite gives write amp = base ÷ delta at the trigger, and a levelled policy that only rewrites the overlapping files is far lower.',
      fields: [
        nf('input.baseBytes', 'live base bytes', 'What the table holds.', { factor: GIB, unit: 'GiB' }),
        nf(
          'input.compactionScopeFraction',
          'compaction scope',
          'How much of the base one compaction rewrites. 100 is a full-table rewrite; a levelled policy touches only the files overlapping the delta.',
          { factor: 0.01, unit: '% of base' },
        ),
        nf('input.triggerDeltaBytes', 'trigger', 'Delta bytes accumulated before a compaction fires. THE knob.', {
          factor: MIB,
          unit: 'MiB',
        }),
        nf('input.targetFileBytes', 'output file size', 'Configured size for the files a compaction writes.', {
          factor: MIB,
          unit: 'MiB',
        }),
        nf('input.dailyLogicalChangeBytes', 'daily logical change', 'Inserts, updates and deletes as written.', {
          factor: GIB,
          unit: 'GiB',
        }),
        nf('input.tombstoneFraction', 'tombstoned but present', 'Share of the base deleted and not yet rewritten away. Still stored, still read.', {
          factor: 0.01,
          unit: '% of base',
        }),
        nf('input.projectionHorizonDays', 'projection horizon', 'What an unbounded storage component is projected against, so the number stays finite.', {
          unit: 'days',
        }),
      ],
    },
    {
      id: 'reads',
      title: 'What a reader pays',
      role: 'given',
      blurb:
        'Read amplification has two terms and the metadata one is routinely dropped: footers are counted as planning rather than reading, and they are read bytes like any other.',
      fields: [
        nf('input.footerBytes', 'footer bytes per file', 'Opened per file to plan.', { factor: 1024, unit: 'KiB' }),
        nf('input.filesReadPerQuery', 'files opened per query', 'The count that makes the metadata term large at small file sizes.', {
          unit: 'files',
        }),
        nf('input.answerBytes', 'bytes the answer needed', 'The denominator of read amplification. Live data the answer actually required.', {
          factor: MIB,
          unit: 'MiB',
        }),
      ],
    },
    {
      id: 'claims',
      title: 'What you submit',
      role: 'claim',
      blurb:
        'Read amp is banded on its OVERHEAD rather than on the ratio, because ±10% of 1.02× would accept a figure with six times the actual overhead.',
      fields: [
        nf('claimedReadAmp', 'read amplification', 'Data term + metadata term. State both, and the point in the cycle you measured.', {
          unit: '×',
        }),
        nf('readAmpCeiling', 'read-amp ceiling you commit to', 'A ceiling with no measurement method is unfalsifiable.', { unit: '×' }),
        nf(
          'claimedStorageMultiple',
          'storage multiple, total ÷ live',
          '(live + tombstoned + retained superseded) ÷ live. A figure of 1.0× counts only the component that was never at risk.',
          { unit: '×' },
        ),
        nf(
          'claimedWriteAmp',
          'write-amplification budget',
          '1 + (base × scope) ÷ delta-at-trigger. Say it as a bill: every ingested byte is written this many times, forever.',
          {
            unit: '×',
            nullable: true,
            discipline: {
              check: 'write_amp_budget',
              cost:
                'Blank fails write_amp_budget on its own. A background job with no budget has no condition under which anyone would notice it growing — it is an unbounded background bill rather than a policy.',
            },
          },
        ),
      ],
    },
    {
      id: 'expiry',
      title: 'The expiry window, as a risk decision',
      role: 'discipline',
      blurb:
        'Retained superseded files are the third storage component, and expiry is the only term that converts an amplification ratio into a storage total. A policy without it is bounded in ratio and unbounded in bytes.',
      fields: [
        nf('input.expiryWindowDays', 'expiry window for superseded files', 'Retention for files a compaction replaced.', {
          unit: 'days',
          nullable: true,
          discipline: {
            check: 'expiry_stated',
            cost:
              'Blank fails expiry_stated and storage_stable together: with no window the retained component has no bound at all, and the table grows past its live size for as long as it exists.',
          },
        }),
        bf(
          'statedRecoveryAfterExpiry',
          'recovery path stated beyond the window',
          'What recovery looks like once the window closes — that is the risk half of the decision.',
          {
            check: 'expiry_stated',
            cost:
              'Blank fails expiry_stated even with a window stated. Past the window time travel cannot reconstruct the table, and time travel lives in the same metadata tree it would have to recover from.',
          },
        ),
        bf('statedStrandedRows', 'stranded rows named', 'Tombstoned rows still present. A delete that has not been compacted away is still stored and still read.', {
          check: 'storage_stable',
          cost: 'Blank fails storage_stable whenever any of the base is tombstoned — the bytes are real and they are being read.',
        }),
      ],
    },
    {
      id: 'cost',
      title: 'The cost, entirely in counts',
      role: 'discipline',
      blurb:
        'Every term here is a COUNT. An hour of compaction means a different amount of work on every cluster size, so it cannot be diffed, replayed or held to a budget. An omitted term makes the policy look cheaper by exactly the amount of the term.',
      fields: [
        nf('cost.bytesRewrittenPerDay', 'bytes rewritten per day', 'The headline count.', {
          factor: GIB,
          unit: 'GiB',
          nullable: true,
          discipline: { check: 'cost_counted', cost: 'Omitted, and the policy has no measurable volume at all.' },
        }),
        nf('cost.rewriteShareOfTablePerDay', 'that as a share of the table, per day', 'The same count made comparable across table sizes.', {
          factor: 0.01,
          unit: '% / day',
          nullable: true,
          discipline: { check: 'cost_counted', cost: 'Omitted, and nobody can tell whether the rewrite volume is large for this table.' },
        }),
        nf('cost.filesCreatedPerDay', 'file creation rate', 'Files compaction writes per day.', {
          unit: 'files/day',
          nullable: true,
          discipline: { check: 'cost_counted', cost: 'Omitted, and the metadata growth term is missing.' },
        }),
        nf('cost.filesMergedPerDay', 'file merge rate', 'Files compaction consumes per day. A rate against a rate.', {
          unit: 'files/day',
          nullable: true,
          discipline: { check: 'cost_counted', cost: 'Omitted, and there is no way to see a deficit accumulating.' },
        }),
        nf('cost.requestsAddedPerDay', 'requests added per day', 'GETs and PUTs the policy adds. Also a count.', {
          unit: 'requests/day',
          nullable: true,
          discipline: { check: 'cost_counted', cost: 'Omitted, and a request-priced storage tier is uncosted.' },
        }),
        ef('cost.pricingShapeNamed', 'pricing shape it lands on', PRICING_SHAPES, 'A name. The rate is yours and you multiply.', {
          nullable: true,
          discipline: {
            check: 'cost_counted',
            cost:
              'Blank fails cost_counted. Without the shape none of those counts is a bill: the same rewrite volume is the whole cost under per-byte-written and nearly free on a flat cluster you already run.',
          },
        }),
        bf(
          'cost.quotedWallClock',
          'the cost was quoted in wall-clock',
          'Answer yes if the policy is costed as "two hours of compaction nightly". Yes fails cost_counted outright — an hour does not transfer between machines and a byte does.',
        ),
      ],
    },
  ],
  assemble: (values) => assembleFrom(allFields(compactionForm), values) as unknown as CompactionSubmission,
  grade: (values) => gradeCompaction(compactionForm.assemble(values) as CompactionSubmission),
  reference: (values) => {
    const sub = compactionForm.assemble(values) as CompactionSubmission
    const out = modelCompaction(sub.input)
    return [
      {
        label: 'read amplification',
        value: `${out.amplification.read.toFixed(4)}×`,
        note: `data ${out.readDataTerm.toFixed(4)} + metadata ${out.readMetadataTerm.toFixed(4)} — ${
          out.readMetadataTerm > out.readDataTerm - 1
            ? 'the metadata term is the LARGER half, so lowering the trigger will not help; the lever is fewer, larger files'
            : 'the data term dominates, so the trigger is set too high'
        }`,
      },
      {
        label: 'write amplification',
        value: `${round2(out.amplification.write)}×`,
        note: `every ingested byte written ${round2(out.amplification.write)} times, forever — ${fmtBytes(
          out.bytesRewrittenPerDay,
        )}/day across ${round2(out.compactionsPerDay)} compactions`,
      },
      {
        label: 'storage',
        value: `${round2(out.storageMultiple)}× live`,
        note: `live ${fmtBytes(out.liveBytes)} + tombstoned ${fmtBytes(out.tombstonedBytes)} + retained ${fmtBytes(
          out.retainedSupersededBytes,
        )}${out.storageBounded ? ', all three bounded' : ' — the retained component is UNBOUNDED with no expiry window'}`,
      },
      {
        label: 'counts per day',
        value: `${fmtCount(out.filesWrittenPerDay)} files · ${fmtCount(out.requestsAddedPerDay)} requests`,
        note: `${pct(out.rewriteShareOfTablePerDay)} of the table rewritten per day · ${round2(
          out.engineerMonthsPerYear,
        )} engineer-months a year to own it`,
      },
    ]
  },
  offers: (values) => {
    const sub = compactionForm.assemble(values) as CompactionSubmission
    const c = sub.cost
    const counted =
      !c.quotedWallClock &&
      c.bytesRewrittenPerDay !== null &&
      c.rewriteShareOfTablePerDay !== null &&
      c.filesCreatedPerDay !== null &&
      c.filesMergedPerDay !== null &&
      c.requestsAddedPerDay !== null &&
      c.pricingShapeNamed !== null
    const offers: DossierOffer[] = [
      {
        key: 'readAmplification',
        label: 'read amplification',
        value: sub.claimedReadAmp,
        derivation: 'the figure you submitted, banded on its overhead against the reference',
      },
      {
        key: 'maintenanceCosted',
        label: 'maintenance is a line item',
        value: counted,
        derivation: 'true when every cost term is present as a count and none of it is quoted in wall-clock',
      },
    ]
    if (sub.claimedWriteAmp !== null) {
      offers.push({
        key: 'writeAmplification',
        label: 'write amplification',
        value: sub.claimedWriteAmp,
        derivation: 'the budget you committed to',
      })
    }
    if (sub.input.expiryWindowDays !== null) {
      offers.push({
        key: 'expiryWindowDays',
        label: 'snapshot / time-travel retention',
        value: sub.input.expiryWindowDays,
        derivation: 'the expiry window, which is also part of your erasure deadline',
      })
    }
    return offers
  },
  known: COMPACTION_KNOWN,
}

/* ============================== capacity-desk ============================== */

import { COMPONENTS, computeCapacity, gradeCapacity } from './capacity'
import type { CapacityInput, CapacitySubmission } from './capacity'
import { TIB } from './kit'

/**
 * The catalog-binds-first scenario, which is the course's central capacity
 * claim: byte growth is comfortable, and the commit interval produces 12,000
 * files a day against a merge rate of 5,000. A deficit does not saturate — it
 * accumulates — so the catalog binds on a table whose byte growth looks fine.
 */
export const CAPACITY_SCENARIO: CapacityInput = {
  horizonMonths: 24,
  liveBytes: 40 * TIB,
  dataGrowthPerMonth: 0.06,
  snapshotRetentionMultiplier: 1.4,
  storageCeilingBytes: 1000 * TIB,
  commitsPerDay: 96,
  partitionsPerCommit: 25,
  writers: 5,
  targetFileBytes: 256 * MIB,
  mergeFilesPerDay: 5_000,
  catalogEntryCeiling: 4_000_000,
  peakQueriesPerHour: 400,
  queryGrowthPerMonth: 0.02,
  instanceHoursPerQuery: 0.05,
  instanceHourCeilingPerHour: 120,
  bytesScannedPerQuery: 2 * GIB,
  networkBytesPerDayCeiling: 4000 * TIB,
  ingestBytesPerDay: 900 * GIB,
  ingestBytesPerDayCeiling: 40 * TIB,
}

const capacityRef = computeCapacity(CAPACITY_SCENARIO)

export const CAPACITY_KNOWN: CapacitySubmission = {
  input: CAPACITY_SCENARIO,
  claimedHorizonBytes: capacityRef.horizonBytes,
  claimedPeakInstanceHours: capacityRef.horizonInstanceHours,
  claimedEntryCount: capacityRef.horizonEntries,
  claimedFirstLimit: capacityRef.firstLimit,
  claimedHeadroomMonths: capacityRef.headroomMonths,
  statedGrowth: true,
}

const capacityForm: DeskForm = {
  desk: 'capacity-desk',
  brief:
    'Twenty-four months of this platform. Five components saturate on five different curves — storage on bytes, catalog on file count, compute and network on query volume, ingest on landing rate — and the deliverable is which one binds FIRST and how many months away that is. Sizing the component that is not binding buys nothing at all.',
  groups: [
    {
      id: 'data',
      title: 'The data plane — grows with bytes',
      role: 'given',
      blurb: 'Live bytes compounded at the growth rate, then multiplied by what retention is still pinning.',
      fields: [
        nf('input.horizonMonths', 'planning horizon', 'The question the desk asks. 24 months is its default.', { unit: 'months' }),
        nf('input.liveBytes', 'live bytes today', 'Excluding retained snapshots.', { factor: TIB, unit: 'TiB' }),
        nf('input.dataGrowthPerMonth', 'data growth', 'Per month. 6%/month doubles inside a year.', { factor: 0.01, unit: '% / month' }),
        nf(
          'input.snapshotRetentionMultiplier',
          'snapshot retention multiplier',
          'Retained snapshots and orphans as a multiple of live size. A plan that quotes live bytes as its storage requirement is short by this factor.',
          { unit: '×' },
        ),
        nf('input.storageCeilingBytes', 'storage ceiling', 'What the tier is provisioned or budgeted for.', { factor: TIB, unit: 'TiB' }),
      ],
    },
    {
      id: 'files',
      title: 'The file count — grows with commits, not with bytes',
      role: 'given',
      blurb:
        'This is the curve that surprises people. With a merge deficit the catalog grows on a curve that has nothing to do with how much data you hold.',
      fields: [
        nf('input.commitsPerDay', 'commits per day', 'The one free variable that moves file count at constant data.', {
          unit: 'commits/day',
        }),
        nf('input.partitionsPerCommit', 'partitions per commit', 'Multiplies the file count.', { unit: 'partitions' }),
        nf('input.writers', 'concurrent writers', 'Multiplies it again.', { unit: 'writers' }),
        nf('input.targetFileBytes', 'target file size after compaction', 'Steady-state entry count is bytes ÷ this.', {
          factor: MIB,
          unit: 'MiB',
        }),
        nf('input.mergeFilesPerDay', 'files compaction merges away per day', 'A deficit here does not saturate; it accumulates linearly in months.', {
          unit: 'files/day',
        }),
        nf('input.catalogEntryCeiling', 'catalog entry ceiling', 'Manifest entries the catalog can plan within budget. A COUNT.', {
          unit: 'entries',
        }),
      ],
    },
    {
      id: 'compute',
      title: 'Compute and network — grow with queries',
      role: 'given',
      blurb: 'Concurrency is instance-hours per wall-hour, which is a count. Never a clock.',
      fields: [
        nf('input.peakQueriesPerHour', 'peak queries per hour', 'The busiest hour you see today, in queries. Compute is sized against this, not against the daily mean.', { unit: 'queries/hour' }),
        nf('input.queryGrowthPerMonth', 'query growth', 'Per month, and usually not the same as data growth.', {
          factor: 0.01,
          unit: '% / month',
        }),
        nf('input.instanceHoursPerQuery', 'instance-hours per query', 'For an average query.', { unit: 'inst-hours' }),
        nf('input.instanceHourCeilingPerHour', 'compute ceiling', 'Instance-hours available per wall-hour at peak.', {
          unit: 'inst-hours/hour',
        }),
        nf('input.bytesScannedPerQuery', 'bytes scanned per query', 'Grows with data unless pruning improves.', {
          factor: GIB,
          unit: 'GiB',
        }),
        nf('input.networkBytesPerDayCeiling', 'network ceiling', 'Bytes per day the read path can move.', { factor: TIB, unit: 'TiB' }),
      ],
    },
    {
      id: 'ingest',
      title: 'Ingest — bytes landed per day',
      role: 'given',
      blurb: 'The landing rate and what the write path can take.',
      fields: [
        nf('input.ingestBytesPerDay', 'ingest today', 'Bytes landed per day.', { factor: GIB, unit: 'GiB' }),
        nf('input.ingestBytesPerDayCeiling', 'ingest ceiling', 'Bytes per day the write path can take.', { factor: TIB, unit: 'TiB' }),
      ],
    },
    {
      id: 'claims',
      title: 'What you submit',
      role: 'claim',
      blurb: 'Three projections in a ±15% band, and the component that binds first — graded against the computed curves.',
      fields: [
        nf('claimedHorizonBytes', 'storage provisioned at the horizon', 'Snapshots included.', { factor: TIB, unit: 'TiB' }),
        nf('claimedPeakInstanceHours', 'peak concurrency at the horizon', 'Instance-hours per wall-hour, grown at the QUERY rate.', {
          unit: 'inst-hours/hour',
        }),
        nf('claimedEntryCount', 'manifest entries at the horizon', 'Steady state PLUS the accumulated creation-versus-merge deficit.', {
          unit: 'entries',
        }),
        ef('claimedFirstLimit', 'what saturates first', COMPONENTS, 'The whole deliverable. One of five, and four of them are decoys.', {
          required: true,
        }),
      ],
    },
    {
      id: 'discipline',
      title: 'Growth and headroom',
      role: 'discipline',
      blurb:
        'A projection with no growth term is a snapshot wearing a plan’s clothes. It fails even when today’s numbers are perfect, because the deliverable is the months remaining before a ceiling binds.',
      fields: [
        bf('statedGrowth', 'the plan carries a growth term', 'Did the projection grow anything at all?', {
          check: 'headroom',
          cost:
            'Blank fails headroom outright. Every number above is a projection of a growth rate, so without one the plan cannot answer "how many months of headroom" — which is the only question the desk asked.',
        }),
        nf(
          'claimedHeadroomMonths',
          'months of headroom',
          'The month at which the FIRST curve reaches its ceiling. Not the average across components — the comfortable four do not lend capacity to the one that binds.',
          {
            unit: 'months',
            nullable: true,
            discipline: {
              check: 'headroom',
              cost:
                'Blank fails headroom. A capacity plan whose output is a size rather than a DATE has no trigger anyone can act on.',
            },
          },
        ),
      ],
    },
  ],
  assemble: (values) => assembleFrom(allFields(capacityForm), values) as unknown as CapacitySubmission,
  grade: (values) => gradeCapacity(capacityForm.assemble(values) as CapacitySubmission),
  reference: (values) => {
    const sub = capacityForm.assemble(values) as CapacitySubmission
    const out = computeCapacity(sub.input)
    return [
      {
        label: 'first limit',
        value: out.firstLimit,
        note: out.clearThroughHorizon
          ? 'nothing binds inside the horizon; ranked on utilisation at the horizon'
          : `binds at month ${out.curves[out.firstLimit].saturationMonth}`,
      },
      { label: 'headroom', value: `${out.headroomMonths} months`, note: 'until the first ceiling binds' },
      ...COMPONENTS.map((c) => ({
        label: `${c} at the horizon`,
        value: `${(out.curves[c].utilisation * 100).toFixed(0)}% of ceiling`,
        note: `${out.curves[c].demandNow.toExponential(2)} → ${out.curves[c].demandAtHorizon.toExponential(2)} ${
          out.curves[c].unit
        }${out.curves[c].saturationMonth !== null ? ` · binds month ${out.curves[c].saturationMonth}` : ''}`,
      })),
      {
        label: 'files created per day',
        value: fmtCount(out.filesCreatedPerDay),
        note: `commits × partitions × writers · merge deficit ${fmtCount(
          out.mergeDeficitPerDay,
        )}/day, which accumulates rather than saturating`,
      },
    ]
  },
  offers: (values) => {
    const sub = capacityForm.assemble(values) as CapacitySubmission
    const out = computeCapacity(sub.input)
    const binding = out.curves[out.firstLimit]
    const offers: DossierOffer[] = [
      { key: 'horizonMonths', label: 'planning horizon', value: sub.input.horizonMonths, derivation: 'the horizon you planned to' },
      {
        key: 'peakConcurrency',
        label: 'peak concurrent queries',
        value: Math.round(sub.claimedPeakInstanceHours),
        derivation: 'instance-hours per wall-hour at peak — concurrency as a count of slots held',
      },
      {
        key: 'headroomFactor',
        label: 'headroom (provisioned ÷ required)',
        value: binding.utilisation > 0 ? round2(1 / binding.utilisation) : 0,
        derivation: `ceiling ÷ demand at the horizon for the binding component (${out.firstLimit})`,
      },
    ]
    if (sub.claimedFirstLimit !== undefined && (COMPONENTS as readonly string[]).includes(sub.claimedFirstLimit)) {
      offers.push({
        key: 'firstBottleneck',
        label: 'what saturates first',
        value: sub.claimedFirstLimit,
        derivation: 'the component you named, which the desk checked against the computed curves',
      })
    }
    return offers
  },
  known: CAPACITY_KNOWN,
}

/* ================================= tco-desk ================================= */

import { OPTIONS, computeTco, exitBreakdown, gradeTco } from './tco'
import type { Option, OptionCounts, TcoInput, TcoSubmission } from './tco'

/**
 * The rate card, and it is NOT a price list. Every entry is the caller's own
 * weight in the caller's own units, and the only thing that matters is the
 * RATIO between the labour weight and the platform weights — which varies by
 * geography and company far more than any infrastructure rate does. These seeds
 * are a plausible ratio to start from and every one of them is meant to be
 * replaced with yours.
 */
const TCO_RATES = {
  perByteMonth: 22 / TIB,
  perComputeUnit: 2,
  perEngineerMonth: 9_000,
  perEgressByte: 11 / TIB,
}

const optionCounts = (o: Partial<OptionCounts>): OptionCounts => ({
  storageBytes: 100 * TIB,
  storageGrowthPerMonth: 0.03,
  computeUnitsPerMonth: 4_000,
  computeGrowthPerMonth: 0.02,
  oneOffEngineerMonths: 6,
  ongoingOpsFte: 0.25,
  migrationEngineerMonths: 4,
  migrationParallelMonths: 3,
  exitEngineerMonths: 5,
  exitEgressBytes: 100 * TIB,
  exitParallelMonths: 2,
  ...o,
})

/**
 * Three options over 36 months. `engine` is the classic trap: the cheapest
 * platform counts of the three, and 18 one-off engineer-months plus 1.5 FTE of
 * ongoing operations — 54 more engineer-months — which is what makes labour
 * roughly half of a self-operated total and loses the argument on the invoice.
 */
export const TCO_SCENARIO: TcoInput = {
  horizonMonths: 36,
  rates: TCO_RATES,
  options: {
    managed: optionCounts({ computeUnitsPerMonth: 6_000, oneOffEngineerMonths: 3, ongoingOpsFte: 0.25 }),
    engine: optionCounts({
      computeUnitsPerMonth: 3_000,
      oneOffEngineerMonths: 18,
      ongoingOpsFte: 1.5,
      exitEngineerMonths: 9,
    }),
    appliance: optionCounts({ computeUnitsPerMonth: 5_000, oneOffEngineerMonths: 8, ongoingOpsFte: 0.8 }),
  },
}

const tcoRef = computeTco(TCO_SCENARIO)

export const TCO_KNOWN: TcoSubmission = {
  input: TCO_SCENARIO,
  recommendation: tcoRef.cheapest,
  claimedTotal: tcoRef.lines[tcoRef.cheapest].total,
  statedOngoingOps: true,
  statedMigration: true,
  statedExit: true,
  nonCostJustification: null,
}

/** The eleven counts, described once and generated for each of the three options. */
const optionFields = (option: Option): DeskField[] => {
  const p = `input.options.${option}`
  return [
    nf(`${p}.storageBytes`, `${option} — bytes held in month 1`, 'Storage as a count of bytes, not a tier name.', {
      factor: TIB,
      unit: 'TiB',
    }),
    nf(`${p}.storageGrowthPerMonth`, `${option} — storage growth`, 'Per month, compounded across the horizon.', { factor: 0.01, unit: '% / month' }),
    nf(
      `${p}.computeUnitsPerMonth`,
      `${option} — compute units in month 1`,
      'Instance-hours, or credits. A count either way, and the desk never asks which.',
      { unit: 'units/month' },
    ),
    nf(`${p}.computeGrowthPerMonth`, `${option} — compute growth`, 'Per month, and usually not the same rate as storage.', { factor: 0.01, unit: '% / month' }),
    nf(`${p}.oneOffEngineerMonths`, `${option} — one-off engineer-months`, 'Build to production. This amortises.', {
      unit: 'eng-months',
    }),
    nf(
      `${p}.ongoingOpsFte`,
      `${option} — ongoing operations`,
      'As a fraction of an FTE. Rarely zero even for a managed service — someone still owns the schema, the upgrade and the page. This does NOT amortise.',
      { unit: 'FTE' },
    ),
    nf(`${p}.migrationEngineerMonths`, `${option} — migration engineer-months`, 'To move in from where you are.', {
      unit: 'eng-months',
    }),
    nf(`${p}.migrationParallelMonths`, `${option} — parallel run at cutover`, 'Months of running the outgoing platform alongside.', {
      unit: 'months',
    }),
    nf(`${p}.exitEngineerMonths`, `${option} — exit engineer-months`, 'To leave again. Compute it before the renewal, not during.', {
      unit: 'eng-months',
    }),
    nf(`${p}.exitEgressBytes`, `${option} — bytes to move out`, 'What leaving physically requires.', { factor: TIB, unit: 'TiB' }),
    nf(`${p}.exitParallelMonths`, `${option} — parallel run at exit`, 'Months of double-running while you leave.', { unit: 'months' }),
  ]
}

const tcoForm: DeskForm = {
  desk: 'tco-desk',
  brief:
    'Managed warehouse, engine on your own storage, or an appliance-class platform, over 36 months with labour costed. Every quantity is a COUNT — byte-months, compute units, engineer-months, bytes moved — and the rate card is yours. At this horizon labour is routinely half the total of a self-operated platform: a build cost amortises and an on-call rotation does not.',
  groups: [
    {
      id: 'rates',
      title: 'Your rate card',
      role: 'given',
      blurb:
        'Weights in your own units, not prices. The ratio between the engineer-month weight and the platform weights is what decides every build-or-buy argument, so these are the numbers to replace first.',
      fields: [
        nf('input.horizonMonths', 'horizon', 'The horizon at which labour stops looking like a rounding error.', { unit: 'months' }),
        nf('input.rates.perByteMonth', 'weight of one TiB held for one month', 'Your own weight for storage.', {
          factor: 1 / TIB,
          unit: 'weight / TiB-month',
        }),
        nf('input.rates.perComputeUnit', 'weight of one compute unit', 'One instance-hour, or one credit. A count either way.', {
          unit: 'weight / unit',
        }),
        nf(
          'input.rates.perEngineerMonth',
          'weight of one fully loaded engineer-month',
          'The term every build-or-buy memo is lost on, because infrastructure is quoted precisely and labour is quoted as "we’ll absorb it".',
          { unit: 'weight / eng-month' },
        ),
        nf('input.rates.perEgressByte', 'weight of moving one TiB out', 'Zero is a claim, not a default.', {
          factor: 1 / TIB,
          unit: 'weight / TiB',
        }),
      ],
    },
    {
      id: 'managed',
      title: 'Option — managed warehouse',
      role: 'given',
      blurb: 'Counts only. Someone still owns the schema, the upgrade and the page.',
      fields: optionFields('managed'),
    },
    {
      id: 'engine',
      title: 'Option — engine on your own storage',
      role: 'given',
      blurb: 'The cheapest platform counts of the three. Watch what happens to the total once labour is in it.',
      fields: optionFields('engine'),
    },
    {
      id: 'appliance',
      title: 'Option — appliance-class platform',
      role: 'given',
      blurb: 'Between the two on both axes, which is the position that makes the arithmetic worth doing.',
      fields: optionFields('appliance'),
    },
    {
      id: 'claims',
      title: 'What you submit',
      role: 'claim',
      blurb: 'Your recommendation and your own horizon total for it, banded at ±10%.',
      fields: [
        ef('recommendation', 'the option the memo recommends', OPTIONS, 'Pick any of the three. The desk has no opinion about which.', {
          required: true,
        }),
        nf(
          'claimedTotal',
          'horizon total for that option',
          'Platform + labour + migration, in your own units. Exit is quoted separately because it is leverage, not run cost.',
          { unit: 'weight' },
        ),
      ],
    },
    {
      id: 'discipline',
      title: 'The four omissions, each of which flatters one option',
      role: 'discipline',
      blurb:
        'An ops term of zero flatters the self-operated option. An uncosted migration flatters whatever you move TO. An uncosted exit flatters the deepest lock-in. And a recommendation your own arithmetic contradicts makes the arithmetic decoration.',
      fields: [
        bf('statedOngoingOps', 'ongoing operations is in the total', 'Did the memo carry an ops term?', {
          check: 'ongoing_ops',
          cost:
            'Blank fails ongoing_ops, and a zero FTE fails it too. At 36 months a one-off build amortises and an on-call rotation does not — dropping this term is precisely why self-operation wins on slides and loses on invoices.',
        }),
        bf('statedMigration', 'the migration is costed', 'Did the memo cost getting there?', {
          check: 'migration',
          cost:
            'Blank fails migration. The move is charged entirely to the option you are recommending, so leaving it out flatters the change and understates the status quo.',
        }),
        bf('statedExit', 'the exit is costed', 'Did the memo compute what leaving costs?', {
          check: 'exit_costed',
          cost:
            'Blank fails exit_costed. That count is both your risk if this decision is wrong and the CAP on any increase a vendor can make stick at renewal — the most useful figure in the memo and the one most often missing.',
        }),
        tf(
          'nonCostJustification',
          'non-cost reason, if you chose the more expensive option',
          'Residency, control, latency, a skills position. Accepted at face value: the desk grades whether the recommendation survives the arithmetic, never which option it is.',
          {
            nullable: true,
            conditional: true,
            discipline: {
              check: 'honest_answer',
              cost:
                'Only needed when your recommendation is more expensive than the cheapest by more than a tie. Then a blank fails honest_answer: a more expensive option with a stated reason is a decision, and without one it is an accident.',
            },
          },
        ),
      ],
    },
  ],
  assemble: (values) => assembleFrom(allFields(tcoForm), values) as unknown as TcoSubmission,
  grade: (values) => gradeTco(tcoForm.assemble(values) as TcoSubmission),
  reference: (values) => {
    const sub = tcoForm.assemble(values) as TcoSubmission
    const out = computeTco(sub.input)
    return [
      ...OPTIONS.map((o) => {
        const l = out.lines[o]
        return {
          label: `${o} — ${out.horizonMonths}-month total`,
          value: l.total.toFixed(0),
          note: `platform ${l.platformWeight.toFixed(0)} + labour ${l.labourWeight.toFixed(0)} + migration ${l.migrationWeight.toFixed(
            0,
          )} · ${l.totalEngineerMonths.toFixed(1)} engineer-months · labour is ${(l.labourShare * 100).toFixed(0)}% of it`,
        }
      }),
      { label: 'ranking', value: out.ranking.join(' < '), note: out.tied.length > 1 ? `${out.tied.join(' and ')} are within 5% and so undecided by cost` : 'cheapest first' },
      {
        label: 'cost to leave the recommended option',
        value: out.lines[sub.recommendation]?.exitWeight.toFixed(0) ?? '—',
        note: out.lines[sub.recommendation]
          ? (() => {
              const bd = exitBreakdown(out.lines[sub.recommendation], sub.input.rates)
              return `labour ${bd.labourWeight.toFixed(0)} · egress ${bd.egressWeight.toFixed(0)} over ${fmtBytes(
                out.lines[sub.recommendation].exitEgressBytes,
              )} · parallel run ${bd.parallelWeight.toFixed(0)} — that count caps your renewal exposure`
          })()
          : 'name a recommendation to see it',
      },
    ]
  },
  offers: (values) => {
    const sub = tcoForm.assemble(values) as TcoSubmission
    const out = computeTco(sub.input)
    const line = out.lines[sub.recommendation]
    if (!line) return []
    const counts = sub.input.options[sub.recommendation]
    const DOSSIER_CHOICE: Record<Option, NonNullable<Dossier['choice']>> = {
      managed: 'managed-warehouse',
      engine: 'engine-on-object-store',
      appliance: 'appliance-platform',
    }
    return [
      {
        key: 'choice',
        label: 'recommendation',
        value: DOSSIER_CHOICE[sub.recommendation],
        derivation: `${sub.recommendation} mapped into the dossier’s own vocabulary`,
      },
      {
        key: 'threeYearTotal',
        label: 'three-year total, your own currency',
        value: sub.claimedTotal,
        derivation: `the total you submitted over the ${out.horizonMonths}-month horizon, in your own units`,
      },
      {
        key: 'statedOngoingOps',
        label: 'ongoing operational labour is in the total',
        value: sub.statedOngoingOps,
        derivation: 'whether the memo carried an ops term',
      },
      {
        key: 'opsEngineerMonths',
        label: 'engineer-months per year to operate',
        value: round2(counts.ongoingOpsFte * 12),
        derivation: 'the ongoing FTE fraction, annualised',
      },
      {
        key: 'migrationCost',
        label: 'migration cost',
        value: round2(line.migrationWeight),
        derivation: 'migration engineer-months plus the parallel run, at your own rates',
      },
      {
        key: 'exitCost',
        label: 'cost to leave, computed',
        value: round2(line.exitWeight),
        derivation: 'exit labour plus egress plus the parallel run — your renewal leverage',
      },
    ]
  },
  known: TCO_KNOWN,
}

/* ================================== dr-desk ================================== */

import { computeDr, gradeDr } from './dr'
import type { DrInput, DrSubmission } from './dr'

/**
 * A table of 1.2M manifest entries replicated every fifteen minutes. The data
 * plane survives the incident, so `bytesToRestore` is zero — which is the case
 * that makes the point: the RTO is still an hour, and all of it is metadata.
 */
export const DR_SCENARIO: DrInput = {
  commitIntervalMinutes: 5,
  replicationIntervalMinutes: 15,
  ingestBytesPerDay: 900 * GIB,
  manifestEntries: 1_200_000,
  entriesRestoredPerMinute: 20_000,
  bytesCopiedPerMinute: 40 * GIB,
  bytesToRestore: 0,
  coordinationMinutes: 30,
  crossRegionCopies: 1,
  copiesHaveIndependentCatalog: true,
  reliesOnTimeTravel: false,
  metadataExportedIndependently: true,
  drillsCompleted: 2,
  drillCoveredMetadataLoss: true,
  drillEntriesRestored: 1_200_000,
}

const drRef = computeDr(DR_SCENARIO)

export const DR_KNOWN: DrSubmission = {
  input: DR_SCENARIO,
  claimedRpoMinutes: drRef.rpoMinutes,
  claimedRtoMinutes: drRef.rtoMinutes,
  metadataRecoveryPath:
    'hourly manifest export to a separate account, replayed into the standby catalog — drilled from the export, not from the live tree',
}

const drForm: DeskForm = {
  desk: 'dr-desk',
  brief:
    'State the RPO and the RTO for a table that is a manifest tree, and say what "restore" means. The objectives are durations because that is what an RPO and an RTO are; everything that COSTS is a count, and the RTO is a count divided by a rate you MEASURED. Time travel is not backup: it lives in the same metadata tree it would have to recover from.',
  groups: [
    {
      id: 'windows',
      title: 'The windows',
      role: 'given',
      blurb: 'You lose the replication window AND the commit in flight. The second term is the one people drop.',
      fields: [
        nf('input.commitIntervalMinutes', 'commit interval', 'The floor on any RPO.', { unit: 'minutes' }),
        nf('input.replicationIntervalMinutes', 'replication interval', 'Between replications of metadata and data to the second domain.', {
          unit: 'minutes',
        }),
        nf('input.ingestBytesPerDay', 'ingest per day', 'Turns an RPO in minutes into bytes at risk — which is what makes it arguable.', {
          factor: GIB,
          unit: 'GiB',
        }),
      ],
    },
    {
      id: 'restore',
      title: 'What a restore actually has to do, in counts',
      role: 'given',
      blurb:
        'An RTO is a COUNT divided by a MEASURED rate. An RTO asserted without a measured restore rate is a wish with a unit attached.',
      fields: [
        nf('input.manifestEntries', 'manifest entries', 'Every one is re-read or re-registered on recovery. This is what sets the RTO.', {
          unit: 'entries',
        }),
        nf('input.entriesRestoredPerMinute', 'entries re-registered per minute', 'Measured on your system, not quoted from a datasheet.', {
          unit: 'entries/min',
        }),
        nf('input.bytesCopiedPerMinute', 'bytes copied per minute', 'Measured on your own copy path, not quoted from a datasheet.', { factor: GIB, unit: 'GiB/min' }),
        nf('input.bytesToRestore', 'bytes to re-materialise', 'Zero when only the metadata was lost — and the RTO is still not zero.', {
          factor: GIB,
          unit: 'GiB',
        }),
        nf(
          'input.coordinationMinutes',
          'coordination overhead',
          'Detection, paging, the decision to fail over, the cutover. Fixed, and never zero.',
          { unit: 'minutes' },
        ),
      ],
    },
    {
      id: 'claims',
      title: 'What you submit',
      role: 'claim',
      blurb: 'The RPO in a ±20% band, the RTO in ±25%. Both are quoted in whole minutes, so the bands are generous by design.',
      fields: [
        nf('claimedRpoMinutes', 'RPO the plan promises', 'Replication interval plus the commit in flight.', { unit: 'minutes' }),
        nf('claimedRtoMinutes', 'RTO the plan promises', 'Coordination + metadata re-registration + byte copy.', { unit: 'minutes' }),
      ],
    },
    {
      id: 'domains',
      title: 'Failure domains',
      role: 'discipline',
      blurb:
        'The reason this desk exists. A copy is only a copy if it is in another failure domain, and object-storage durability is not a second domain — it protects against media loss, not against the operator action that deleted the prefix.',
      fields: [
        nf('input.crossRegionCopies', 'copies in another region', 'A count. Zero is a real answer and it fails.', { unit: 'copies' }),
        bf(
          'input.copiesHaveIndependentCatalog',
          'those copies have their own catalog',
          'Or do they point at the same metadata tree?',
          {
            check: 'cross_region',
            cost:
              'Blank fails cross_region even with copies in place: the files are in two regions and the table is in one. Lose the catalog and the second copy is an unnamed pile of Parquet.',
          },
        ),
        bf(
          'input.reliesOnTimeTravel',
          'the RPO argument rests on time travel',
          'Answer yes if the plan leans on the snapshot expiry window. Yes fails metadata_path unless the manifest tree is also exported outside itself.',
        ),
        bf(
          'input.metadataExportedIndependently',
          'manifests exported outside the live tree',
          'To a store that cannot be taken with the tree.',
          {
            check: 'metadata_path',
            cost:
              'Blank leaves the metadata in ONE independent domain, unless the cross-region replica has a catalog of its own — and then this is the only remaining export. Alone it is one domain — the number people believe is two. A bad commit, a catalog migration, a deletion with the wrong prefix or an expiry job with the wrong retention takes the recovery path out along with the table.',
          },
          { conditional: true },
        ),
        tf(
          'metadataRecoveryPath',
          'how the manifest tree itself is rebuilt',
          'Not how the files come back — how the TABLE comes back. A restore of a million files with no manifest tree to name them is a bucket.',
          {
            nullable: true,
            discipline: {
              check: 'metadata_path',
              cost:
                'Blank fails metadata_path. Metadata is most of the reference RTO, so this is also the largest term you have left unwritten.',
            },
          },
        ),
      ],
    },
    {
      id: 'evidence',
      title: 'Evidence',
      role: 'discipline',
      blurb: 'A DR plan that has never been tested is not a plan, it is a document. The count that makes the check pass is 1.',
      fields: [
        nf('input.drillsCompleted', 'restore drills completed', 'A count, and zero is a real answer.', {
          unit: 'drills',
          discipline: {
            check: 'tested',
            cost:
              'Zero fails tested. The RPO and RTO above are derived from rates nobody has observed under failure, and every first restore discovers at least one credential, quota or ordering dependency that no design review finds.',
          },
        }),
        bf('input.drillCoveredMetadataLoss', 'a drill exercised METADATA loss', 'Rather than only region loss.', {
          check: 'tested',
          cost:
            'Blank fails tested. Failing over to a healthy replica tests the network; it does not test rebuilding a manifest tree, which is most of the RTO you have never run.',
        }),
        nf(
          'input.drillEntriesRestored',
          'manifest entries the last drill restored',
          'Compared against the real table. A drill on a toy table measures the procedure and not the rate.',
          { unit: 'entries' },
        ),
      ],
    },
  ],
  assemble: (values) => assembleFrom(allFields(drForm), values) as unknown as DrSubmission,
  grade: (values) => gradeDr(drForm.assemble(values) as DrSubmission),
  reference: (values) => {
    const sub = drForm.assemble(values) as DrSubmission
    const out = computeDr(sub.input)
    return [
      {
        label: 'RPO',
        value: `${out.rpoMinutes.toFixed(0)} min`,
        note: `${out.rpoCommits} commits and ${fmtBytes(out.bytesAtRisk)} at risk`,
      },
      {
        label: 'RTO',
        value: `${out.rtoMinutes.toFixed(0)} min`,
        note: `${sub.input.coordinationMinutes} coordination + ${out.metadataRestoreMinutes.toFixed(
          0,
        )} metadata + ${out.dataRestoreMinutes.toFixed(0)} data — metadata is ${(out.metadataShareOfRto * 100).toFixed(
          0,
        )}% of it, and the file count is what sets that`,
      },
      {
        label: 'failure domains',
        value: `metadata ${out.metadataDomains} · data ${out.dataDomains}`,
        note: out.singleMetadataDomain
          ? 'one metadata domain, which is the number people believe is two'
          : 'the recovery path survives the thing it recovers from',
      },
      {
        label: 'drill coverage',
        value: pct(out.drillCoverage),
        note: 'of the real manifest entry count — an RTO is a count divided by a rate, so coverage is what supports the number',
      },
    ]
  },
  offers: (values) => {
    const sub = drForm.assemble(values) as DrSubmission
    return [
      {
        key: 'regions',
        label: 'regions in the design',
        value: sub.input.crossRegionCopies + 1,
        derivation:
          'the primary plus the cross-region copies. The dossier has no RPO or RTO field — the rooms read the design, and this is the part of the DR desk they read',
      },
    ]
  },
  known: DR_KNOWN,
}

/* ================================ the registry ================================ */

/**
 * One form per desk, in registry order. `DESKS` in `./index` is the contract the
 * lessons are written against; this is the contract the SUBMISSIONS are written
 * against, and a test asserts every field a model requires appears here.
 */
export const DESK_FORMS: Record<DeskId, DeskForm> = {
  'scan-desk': scanForm,
  'layout-desk': layoutForm,
  'ingest-desk': ingestForm,
  'tenancy-desk': tenancyForm,
  'compaction-desk': compactionForm,
  'capacity-desk': capacityForm,
  'tco-desk': tcoForm,
  'dr-desk': drForm,
}

export const getDeskForm = (id: DeskId): DeskForm | undefined => DESK_FORMS[id]

/**
 * Where a desk's completion lands in the sims namespace. The same convention as
 * the browser labs (`blab:`) and the DuckDB labs (`dlab:`), so one reporting
 * path covers every graded surface in the course.
 */
export const deskSimId = (id: DeskId): string => `desk:${id}`

export const DESK_TASK_ID = 'complete'

/** Every field of every desk, for coverage checks and for the agent surface. */
export const ALL_DESK_FIELDS: { desk: DeskId; field: DeskField }[] = Object.values(DESK_FORMS).flatMap((f) =>
  allFields(f).map((field) => ({ desk: f.desk, field })),
)
