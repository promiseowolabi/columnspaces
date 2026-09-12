/**
 * desk-forms.test.ts — the submission path for the eight desks.
 *
 * The gap this closes: the reference models were gradeable from tests and from
 * nothing else, so a learner could read what a desk grades and never submit to
 * it. What these tests defend, in order of how badly it breaks the course when
 * it regresses:
 *
 *   1. COVERAGE, BOTH WAYS. Every leaf of every desk's known-good submission has
 *      a field-registry entry, and every registry entry corresponds to a leaf.
 *      A field added to a model's input type fails the compiler first (the
 *      known-good literals are typed as the models' own `Submission`
 *      interfaces), then fails this test until it is describable — so a model
 *      change cannot silently create an unfillable form.
 *   2. THE FORM'S OWN PATH. Every grading assertion here goes through
 *      `form.grade(values)`, which assembles the submission out of a flat
 *      path→value record exactly as the UI does. Nothing calls a model with a
 *      hand-built object, because a hand-built object is precisely what the UI
 *      does not have.
 *   3. DISCIPLINE ON OMISSION. Every field carrying a `discipline` note claims a
 *      check id fails when it is left blank. Each claim is executed: blank the
 *      field, grade, and assert that check fails with the message the model
 *      wrote. A registry that promises the wrong check is worse than one that
 *      promises nothing.
 *   4. PERSISTENCE. Submissions round-trip through the store, through a reload,
 *      and through the export snapshot — and an older snapshot with no desk
 *      records still imports.
 *   5. THE DOSSIER HANDOFF. The copy action sets exactly the fields the offer
 *      names and nothing else, and it is never automatic.
 */

import { describe, expect, it, vi } from 'vitest'
import { DESKS } from '@/lib/desks'
import { allPassed } from '@/lib/desks/kit'
import type { DeskReport } from '@/lib/desks/kit'
import { computeTco } from '@/lib/desks/tco'
import {
  ALL_DESK_FIELDS,
  DESK_FORMS,
  DESK_TASK_ID,
  TCO_SCENARIO,
  allFields,
  assembleFrom,
  blankFor,
  briefValues,
  deskSimId,
  flatten,
  getDeskForm,
  knownValues,
  leafPaths,
  missingRequired,
  readPath,
  writePath,
} from '@/lib/desks/fields'
import type { DeskField, DeskForm, DeskValues } from '@/lib/desks/fields'
import type { Dossier } from '@/data/rooms'

const IDS = DESKS.map((d) => d.id)
const forms = IDS.map((id) => [id, DESK_FORMS[id]] as const)

const failedIds = (r: DeskReport): string[] => r.checks.filter((c) => !c.pass).map((c) => c.id)
const checkOf = (r: DeskReport, id: string) => {
  const c = r.checks.find((x) => x.id === id)
  if (!c) throw new Error(`no check ${id} in ${r.desk}: ${r.checks.map((x) => x.id).join(', ')}`)
  return c
}

/* ========================== 1. the registry covers ========================== */

describe('the field registry covers every desk, and every input of every model', () => {
  it('there is a form for all eight desks and no others', () => {
    expect(Object.keys(DESK_FORMS).sort()).toEqual([...IDS].sort())
    expect(IDS).toHaveLength(8)
    for (const [id, form] of forms) expect(form.desk).toBe(id)
  })

  it.each(forms)('%s — every leaf of the known-good submission has a registry entry', (_id, form) => {
    const leaves = leafPaths(form.known)
    const described = new Set(allFields(form).map((f) => f.path))
    const unfillable = leaves.filter((p) => !described.has(p))
    expect(
      unfillable,
      `${form.desk}: the model needs these and the form cannot express them: ${unfillable.join(', ')}`,
    ).toEqual([])
    /* Non-trivial: a form with no fields would pass the assertion above. */
    expect(leaves.length).toBeGreaterThan(10)
  })

  it.each(forms)('%s — every registry entry corresponds to a leaf the model reads', (_id, form) => {
    const leaves = new Set(leafPaths(form.known))
    const orphans = allFields(form)
      .map((f) => f.path)
      .filter((p) => !leaves.has(p))
    expect(orphans, `${form.desk}: describes fields the submission has no place for: ${orphans.join(', ')}`).toEqual(
      [],
    )
  })

  it.each(forms)('%s — no path is described twice', (_id, form) => {
    const paths = allFields(form).map((f) => f.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('every field reads as prose: a label, a help line, and never the identifier', () => {
    for (const { desk, field } of ALL_DESK_FIELDS) {
      const where = `${desk} ${field.path}`
      expect(field.label.trim().length, where).toBeGreaterThan(3)
      expect(field.help.trim().length, where).toBeGreaterThan(15)
      /* The label is prose, so it never contains the camelCase key. */
      const key = field.path.split('.').pop()!
      if (/[a-z][A-Z]/.test(key)) expect(field.label, where).not.toContain(key)
    }
  })

  it('every number field that stores bytes or a fraction carries an entry factor and a unit', () => {
    for (const { desk, field } of ALL_DESK_FIELDS) {
      if (field.kind !== 'number') continue
      const where = `${desk} ${field.path}`
      /* Every number is entered in some unit; nothing is unitless here. */
      expect(field.unit, `${where} has no unit`).toBeTruthy()
      if (/Bytes$/.test(field.path.split('.').pop()!)) {
        expect(field.factor, `${where} stores bytes and must be entered in a human unit`).toBeGreaterThan(1)
      }
      if (/Fraction$/.test(field.path.split('.').pop()!)) {
        expect(field.factor, `${where} is a fraction and should be entered as a percent`).toBe(0.01)
      }
    }
  })

  it('every enum field offers the options the model accepts, and no blank string among them', () => {
    for (const { desk, field } of ALL_DESK_FIELDS) {
      if (field.kind !== 'enum') continue
      expect(field.options, `${desk} ${field.path}`).toBeTruthy()
      expect(field.options!.length, `${desk} ${field.path}`).toBeGreaterThan(1)
      expect(field.options).not.toContain('')
    }
  })

  it('every discipline note names a check the desk actually grades', () => {
    for (const [id, form] of forms) {
      const graded = new Set(DESKS.find((d) => d.id === id)!.checks)
      for (const f of allFields(form)) {
        if (!f.discipline) continue
        expect(graded.has(f.discipline.check), `${id} ${f.path} → ${f.discipline.check}`).toBe(true)
        expect(f.discipline.cost.length, `${id} ${f.path}`).toBeGreaterThan(40)
      }
    }
  })

  it('the registry carries no prices — the rate card is weights in the caller’s own units', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/lib/desks/fields.ts', import.meta.url), 'utf8')
    expect(src.match(/[£€¥₹¢]/g) ?? []).toEqual([])
    /* A symbol immediately in front of a figure is a price however it is spelled. */
    expect(src.match(/\$\s*[\d.]/g) ?? []).toEqual([])
    expect(src.match(/\b(USD|EUR|GBP|JPY|dollars?|cents?|euros?)\b/gi) ?? []).toEqual([])
    expect(src.match(/\b(costPer|pricePer|ratePer|perTBScanned|monthlyCost|hourlyRate)\w*/g) ?? []).toEqual([])
    /* The positive form: rates are the caller's. */
    expect(src).toMatch(/NOT a price list/)
  })
})

/* ===================== 2. flatten and assemble are inverses ===================== */

describe('the form assembles what the model reads, and takes it apart again', () => {
  it('writePath builds arrays for numeric segments and objects for the rest', () => {
    const o: Record<string, unknown> = {}
    writePath(o, 'input.classes.0.tableBytes', 42)
    writePath(o, 'input.classes.1.tableBytes', 43)
    writePath(o, 'claims.dashboards', 7)
    expect(Array.isArray((o.input as { classes: unknown[] }).classes)).toBe(true)
    expect(readPath(o, 'input.classes.1.tableBytes')).toBe(43)
    expect(readPath(o, 'claims.dashboards')).toBe(7)
    expect(readPath(o, 'claims.missing')).toBeUndefined()
  })

  it.each(forms)('%s — assembling the known-good values reproduces the known-good submission', (_id, form) => {
    expect(form.assemble(knownValues(form))).toEqual(form.known)
  })

  it.each(forms)('%s — flatten and assemble round-trip through the value record', (_id, form) => {
    const values = knownValues(form)
    expect(flatten(form.assemble(values))).toEqual(values)
  })

  it.each(forms)('%s — a blank assembles to what the MODEL means by blank', (_id, form) => {
    /* Nullable fields become null; booleans become false; numbers become 0. */
    const assembled = assembleFrom(allFields(form), {})
    for (const f of allFields(form)) {
      expect(readPath(assembled, f.path), `${form.desk} ${f.path}`).toEqual(blankFor(f))
    }
  })

  it('leafPaths treats undefined as absence and null as a value', () => {
    expect(leafPaths({ a: 1, b: undefined, c: null, d: { e: 'x' } })).toEqual(['a', 'c', 'd.e'])
  })
})

/* ======================= 3. a known-good submission passes ======================= */

describe('a known-good submission passes every check, through the form’s own path', () => {
  it.each(forms)('%s', (id, form) => {
    const report = form.grade(knownValues(form))
    expect(failedIds(report), `${id} failed: ${report.checks.filter((c) => !c.pass).map((c) => c.msg).join(' | ')}`).toEqual(
      [],
    )
    expect(allPassed(report)).toBe(true)
    expect(report.desk).toBe(id)
  })

  it.each(forms)('%s — emits exactly the registry check ids, in order', (id, form) => {
    const expected = DESKS.find((d) => d.id === id)!.checks
    expect(form.grade(knownValues(form)).checks.map((c) => c.id)).toEqual(expected)
  })

  it.each(forms)('%s — grading is deterministic: no clock, no unseeded randomness', (_id, form) => {
    const values = knownValues(form)
    expect(form.grade(values)).toEqual(form.grade(values))
    expect(form.reference(values)).toEqual(form.reference(values))
  })

  it.each(forms)('%s — the brief opens with the scenario given and every claim blank', (_id, form) => {
    const brief = briefValues(form)
    const known = knownValues(form)
    for (const g of form.groups) {
      for (const f of g.fields) {
        if (g.role === 'given') expect(brief[f.path], `${form.desk} ${f.path}`).toEqual(known[f.path])
        else expect(brief[f.path], `${form.desk} ${f.path} should open blank`).toBeUndefined()
      }
    }
    /* And the brief on its own does not accidentally pass. */
    if (missingRequired(form, brief).length === 0) {
      expect(allPassed(form.grade(brief)), `${form.desk} passes with nothing submitted`).toBe(false)
    }
  })

  it.each(forms)('%s — the form refuses to submit while a required field is unset', (_id, form) => {
    const required = allFields(form).filter((f) => f.required)
    for (const f of required) {
      const values = { ...knownValues(form) }
      delete values[f.path]
      expect(missingRequired(form, values).map((x) => x.path)).toContain(f.path)
    }
    expect(missingRequired(form, knownValues(form))).toEqual([])
  })

  it.each(forms)('%s — the reference computation is shown, and is more than a restatement', (_id, form) => {
    const lines = form.reference(knownValues(form))
    expect(lines.length).toBeGreaterThan(2)
    for (const l of lines) {
      expect(l.label.length).toBeGreaterThan(2)
      expect(String(l.value).length).toBeGreaterThan(0)
    }
  })
})

/* ==================== 4. an omitted discipline term fails ==================== */

/**
 * Every `discipline` note in the registry is a claim about the model: blank this
 * field and THAT check fails. Executing all of them is what keeps the help text
 * from drifting away from the grader — the failure mode that would make the
 * form actively misleading.
 */
describe('an omitted discipline term fails the specific check it claims', () => {
  /**
   * A `required` field cannot be omitted — the form refuses to submit — and a
   * `conditional` one fails only under a further condition its own prose states.
   * Both get their own tests below; every other note is executed here.
   */
  const cases = forms.flatMap(([id, form]) =>
    allFields(form)
      .filter((f) => f.discipline && !f.required && !f.conditional)
      .map((f) => [`${id} · ${f.path} → ${f.discipline!.check}`, form, f] as const),
  )

  it('there are discipline terms on every desk', () => {
    for (const [id, form] of forms) {
      expect(allFields(form).some((f) => f.discipline), `${id} has no discipline term`).toBe(true)
    }
    expect(cases.length).toBeGreaterThan(20)
  })

  it.each(cases)('%s', (_name, form: DeskForm, field: DeskField) => {
    const values = { ...knownValues(form) }
    delete values[field.path]
    const report = form.grade(values)
    const c = checkOf(report, field.discipline!.check)
    expect(c.pass, `${form.desk} ${field.path}: blanking it did not fail ${field.discipline!.check}`).toBe(false)
    /* The teaching is the model's own message, so it has to be a real one. */
    expect(c.msg.length).toBeGreaterThan(80)
  })

  it('tenancy: "none" is a submittable boundary and it is graded as one', () => {
    const form = getDeskForm('tenancy-desk')!
    const r = form.grade({ ...knownValues(form), statedBoundary: 'none' })
    expect(checkOf(r, 'isolation').pass).toBe(false)
    expect(checkOf(r, 'isolation').msg).toMatch(/no isolation boundary stated/)
    /* A boundary claimed above what the layout can enforce fails too. */
    const over = form.grade({ ...knownValues(form), statedBoundary: 'account' })
    expect(checkOf(over, 'isolation').pass).toBe(false)
    expect(checkOf(over, 'isolation').msg).toMatch(/can enforce at most partition/)
  })

  it('tco: the non-cost reason is only needed when the recommendation is not the cheapest', () => {
    const form = getDeskForm('tco-desk')!
    const known = knownValues(form)
    expect(checkOf(form.grade(known), 'honest_answer').pass).toBe(true)

    /* The self-operated option is dearer here because of labour, not platform. */
    const ref = computeTco(TCO_SCENARIO)
    expect(ref.cheapest).toBe('managed')
    expect(ref.lines.engine.platformWeight).toBeLessThan(ref.lines.managed.platformWeight)
    expect(ref.lines.engine.total).toBeGreaterThan(ref.lines.managed.total)

    const dearer: DeskValues = { ...known, recommendation: 'engine', claimedTotal: ref.lines.engine.total }
    const r = form.grade(dearer)
    expect(failedIds(r)).toEqual(['honest_answer'])
    expect(checkOf(r, 'honest_answer').msg).toMatch(/YOUR OWN numbers/)

    /* State the reason and the same submission becomes a decision. */
    const withReason = form.grade({
      ...dearer,
      nonCostJustification: 'data residency: this workload may not leave our own accounts',
    })
    expect(failedIds(withReason)).toEqual([])
    expect(checkOf(withReason, 'honest_answer').msg).toMatch(/residency/)
  })

  it('dr: the manifest export is the only metadata domain once the replica shares a catalog', () => {
    const form = getDeskForm('dr-desk')!
    const values = { ...knownValues(form) }
    delete values['input.metadataExportedIndependently']
    delete values['input.copiesHaveIndependentCatalog']
    const r = form.grade(values)
    expect(checkOf(r, 'metadata_path').pass).toBe(false)
    expect(checkOf(r, 'metadata_path').msg).toMatch(/1 independent domain/)
    expect(checkOf(r, 'cross_region').pass).toBe(false)
  })

  it('the omission fails even where the point estimate is exact — scan states the shape or it does not', () => {
    const form = getDeskForm('scan-desk')!
    const values = { ...knownValues(form) }
    delete values.statedShape
    const r = form.grade(values)
    /* Every arithmetic check still passes. Only the discipline check fails. */
    expect(failedIds(r)).toEqual(['shape_stated'])
    expect(checkOf(r, 'per_query').pass).toBe(true)
    expect(checkOf(r, 'daily_total').pass).toBe(true)
    expect(checkOf(r, 'shape_stated').msg).toMatch(/The omission is the problem, not the estimate/)
  })

  it('a compaction policy with no write-amp budget is an unbounded background bill', () => {
    const form = getDeskForm('compaction-desk')!
    const values = { ...knownValues(form) }
    delete values.claimedWriteAmp
    const r = form.grade(values)
    expect(failedIds(r)).toEqual(['write_amp_budget'])
    expect(checkOf(r, 'write_amp_budget').msg).toMatch(/unbounded background bill/)
    expect(checkOf(r, 'write_amp_budget').msg).toMatch(/every ingested byte is written/)
  })

  it('a layout that names no starved class fails even with every ratio right', () => {
    const form = getDeskForm('layout-desk')!
    const values = { ...knownValues(form) }
    delete values.statedWorstClassId
    const r = form.grade(values)
    expect(failedIds(r)).toEqual(['worst_query_stated'])
    expect(checkOf(r, 'prunes_target').pass).toBe(true)
    expect(checkOf(r, 'worst_query_stated').msg).toMatch(/exactly one physical order/)
  })

  it('a capacity plan with no growth term is a snapshot wearing a plan’s clothes', () => {
    const form = getDeskForm('capacity-desk')!
    const values = { ...knownValues(form) }
    delete values.statedGrowth
    const r = form.grade(values)
    expect(failedIds(r)).toEqual(['headroom'])
    expect(checkOf(r, 'headroom').msg).toMatch(/snapshot of today wearing a plan's clothes/)
  })

  it('a TCO memo with no ops term loses the term that decides it', () => {
    const form = getDeskForm('tco-desk')!
    const values = { ...knownValues(form) }
    delete values.statedOngoingOps
    const r = form.grade(values)
    expect(failedIds(r)).toEqual(['ongoing_ops'])
    expect(checkOf(r, 'ongoing_ops').msg).toMatch(/on-call rotation does not/)
  })

  it('a DR plan with no drills is a document', () => {
    const form = getDeskForm('dr-desk')!
    const values = { ...knownValues(form) }
    delete values['input.drillsCompleted']
    const r = form.grade(values)
    expect(checkOf(r, 'tested').pass).toBe(false)
    expect(checkOf(r, 'tested').msg).toMatch(/not a plan, it is a document/)
  })

  it('a wrong point estimate fails the banded check and leaves the discipline checks alone', () => {
    const form = getDeskForm('scan-desk')!
    const values = { ...knownValues(form) }
    values.claimedDailyTotalBytes = (values.claimedDailyTotalBytes as number) * 0.4
    const r = form.grade(values)
    expect(failedIds(r)).toEqual(['daily_total'])
    expect(checkOf(r, 'daily_total').msg).toMatch(/ad-hoc/)
  })
})

/* ========================= 5. the dossier handoff ========================= */

describe('a passing desk offers its numbers to the dossier, and sets nothing else', () => {
  it.each(forms)('%s — every offer names a real dossier field with a derivation', (_id, form) => {
    const offers = form.offers(knownValues(form))
    expect(offers.length).toBeGreaterThan(0)
    const keys = offers.map((o) => o.key)
    expect(new Set(keys).size, `${form.desk} offers a key twice`).toBe(keys.length)
    for (const o of offers) {
      expect(o.value, `${form.desk} → ${o.key} offers undefined`).not.toBeUndefined()
      expect(o.derivation.length, `${form.desk} → ${o.key}`).toBeGreaterThan(20)
      expect(o.label.length).toBeGreaterThan(3)
    }
  })

  it('the offers across the eight desks reach the fields the rooms actually attack', () => {
    const offered = new Set(forms.flatMap(([, f]) => f.offers(knownValues(f)).map((o) => o.key)))
    for (const key of [
      'dailyScanBytes',
      'promisedPruningRatio',
      'writeAmplification',
      'threeYearTotal',
      'firstBottleneck',
      'regions',
    ] as (keyof Dossier)[]) {
      expect(offered.has(key), `no desk offers ${key}`).toBe(true)
    }
  })

  it('the scan desk offers the bytes it computed, not the bytes it was given', () => {
    const form = getDeskForm('scan-desk')!
    const offers = form.offers(knownValues(form))
    const daily = offers.find((o) => o.key === 'dailyScanBytes')!
    expect(daily.value).toBe((form.known as { claimedDailyTotalBytes: number }).claimedDailyTotalBytes)
    /* The pricing shape is translated into the dossier's own vocabulary. */
    expect(offers.find((o) => o.key === 'pricingShape')!.value).toBe('consumption-bytes')
  })

  it('a desk whose discipline term is blank offers the honest boolean, not a hopeful one', () => {
    const form = getDeskForm('scan-desk')!
    const values = { ...knownValues(form) }
    delete values.statedAdoptionGrowth
    const offers = form.offers(values)
    expect(offers.find((o) => o.key === 'growthModelled')!.value).toBe(false)
    /* And with the shape blank there is nothing to offer for it at all. */
    delete values.statedShape
    expect(form.offers(values).some((o) => o.key === 'pricingShape')).toBe(false)
  })
})

/* ===================== 6. persistence in the progress store ===================== */

/**
 * The store persists through `window.localStorage`, and zustand resolves its
 * storage once at creation — so the shim has to be installed BEFORE the module
 * is imported. Hence the dynamic import, exactly as in room-encounter.test.ts.
 */
const memStorage = () => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

const storage = memStorage()
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { localStorage: storage })
const { useProgress, exportProgress, selectDesksPassed, XP } = await import('@/lib/progress')

const scan = DESK_FORMS['scan-desk']

describe('a desk submission persists like everything else in the store', () => {
  it('starts empty and is additive — nothing else in the snapshot moved', () => {
    expect(useProgress.getState().desks).toEqual({})
    /* The pre-existing slices are still there and still shaped as they were. */
    const s = useProgress.getState()
    for (const key of ['lessons', 'sims', 'labs', 'dossier', 'rooms'] as const) {
      expect(s[key]).toEqual({})
    }
    expect(s.version).toBe(1)
  })

  it('records the submission itself, not a score — a desk is a pure model over the numbers', () => {
    const values = knownValues(scan)
    const report = scan.grade(values)
    useProgress.getState().recordDeskRun('scan-desk', values, report.checks.map((c) => ({ id: c.id, pass: c.pass })))
    const run = useProgress.getState().desks['scan-desk']
    expect(run.attempts).toBe(1)
    expect(run.lastValues).toEqual(values)
    expect(run.lastChecks).toEqual({
      per_query: true,
      daily_total: true,
      shape_stated: true,
      growth_modelled: true,
    })
    expect(run.bestPassed).toBe(4)
    expect(run.bestTotal).toBe(4)
    expect(run.passedAt).toBeDefined()
  })

  it('pays XP once, and a worse later attempt does not erase the one that passed', () => {
    const before = useProgress.getState().xp
    const worse = { ...knownValues(scan) }
    delete worse.statedShape
    const r = scan.grade(worse)
    useProgress.getState().recordDeskRun('scan-desk', worse, r.checks.map((c) => ({ id: c.id, pass: c.pass })))
    const run = useProgress.getState().desks['scan-desk']
    expect(run.attempts).toBe(2)
    expect(run.lastChecks.shape_stated).toBe(false)
    /* Best is preserved, with the submission that earned it. */
    expect(run.bestPassed).toBe(4)
    expect(run.bestValues).toEqual(knownValues(scan))
    expect(run.passedAt).toBeDefined()
    /* No second reward for the same desk. */
    expect(useProgress.getState().xp).toBe(before)
  })

  it('pays XP the first time a desk passes, and counts it as passed', () => {
    const before = useProgress.getState().xp
    const layout = DESK_FORMS['layout-desk']
    const values = knownValues(layout)
    const r = layout.grade(values)
    useProgress.getState().recordDeskRun('layout-desk', values, r.checks.map((c) => ({ id: c.id, pass: c.pass })))
    expect(useProgress.getState().xp).toBe(before + XP.desk)
    expect(selectDesksPassed(useProgress.getState())).toBe(2)
  })

  it('a failing first attempt records the attempt and pays nothing', () => {
    const before = useProgress.getState().xp
    const ingest = DESK_FORMS['ingest-desk']
    const r = ingest.grade(briefValues(ingest))
    useProgress
      .getState()
      .recordDeskRun('ingest-desk', briefValues(ingest), r.checks.map((c) => ({ id: c.id, pass: c.pass })))
    const run = useProgress.getState().desks['ingest-desk']
    expect(run.attempts).toBe(1)
    expect(run.passedAt).toBeUndefined()
    expect(useProgress.getState().xp).toBe(before)
  })

  it('completion lands in the sims namespace under the same convention as the labs', () => {
    useProgress.getState().recordSimTask(deskSimId('scan-desk'), DESK_TASK_ID)
    expect(deskSimId('scan-desk')).toBe('desk:scan-desk')
    expect(useProgress.getState().sims['desk:scan-desk'].tasksDone).toEqual([DESK_TASK_ID])
    /* Idempotent: recording it twice is a replay, not a second completion. */
    useProgress.getState().recordSimTask(deskSimId('scan-desk'), DESK_TASK_ID)
    expect(useProgress.getState().sims['desk:scan-desk'].tasksDone).toEqual([DESK_TASK_ID])
  })

  it('a submission survives a reload — the persisted namespace carries it', async () => {
    const raw = storage.getItem('columnspaces:v1')
    expect(raw, 'nothing was persisted').toBeTruthy()
    const parsed = JSON.parse(raw!) as { state: { desks: Record<string, { attempts: number }> } }
    expect(parsed.state.desks['scan-desk'].attempts).toBe(2)

    vi.resetModules()
    const reloaded = await import('@/lib/progress')
    const after = reloaded.useProgress.getState().desks['scan-desk']
    expect(after.attempts).toBe(2)
    expect(after.bestValues).toEqual(knownValues(scan))
    /* And the form can be reopened straight onto it, which is the point of storing values. */
    expect(scan.grade(after.bestValues as DeskValues).checks.every((c) => c.pass)).toBe(true)
  })

  it('desk runs ride the export snapshot and come back through import', () => {
    const snapshot = exportProgress()
    const parsed = JSON.parse(snapshot) as {
      desks: Record<string, { attempts: number; bestPassed: number }>
      dossier: Dossier
      rooms: Record<string, unknown>
    }
    expect(parsed.desks['scan-desk'].attempts).toBe(2)
    expect(parsed.desks['layout-desk'].bestPassed).toBe(4)
    /* Nothing existing was displaced. */
    expect(parsed.dossier).toBeDefined()
    expect(parsed.rooms).toBeDefined()

    useProgress.getState().resetProgress()
    expect(useProgress.getState().desks).toEqual({})
    expect(useProgress.getState().importProgress(snapshot)).toBe(true)
    expect(useProgress.getState().desks['scan-desk'].attempts).toBe(2)
    expect(useProgress.getState().desks['scan-desk'].lastValues).toBeDefined()
    expect(selectDesksPassed(useProgress.getState())).toBe(2)
  })

  it('an older snapshot with no desk records still imports, and lands on an empty map', () => {
    const legacy = JSON.stringify({
      version: 1,
      lessons: {},
      sims: {},
      labs: {},
      fleetWeek: { actsDone: [], scores: {} },
      capstone: { step: 0, stepsDone: [] },
      dossier: { dailyScanBytes: 4e12 },
      rooms: {},
      xp: 700,
      streakDays: [],
      achievements: [],
      settings: {},
    })
    expect(useProgress.getState().importProgress(legacy)).toBe(true)
    expect(useProgress.getState().desks).toEqual({})
    expect(useProgress.getState().xp).toBe(700)
    expect(useProgress.getState().dossier.dailyScanBytes).toBe(4e12)
    expect(selectDesksPassed(useProgress.getState())).toBe(0)
  })
})

/* ================= 7. the copy action sets exactly what it offers ================= */

describe('copying a desk result into the dossier sets exactly the offered fields', () => {
  it('nothing is copied until the action runs', () => {
    useProgress.getState().resetProgress()
    const values = knownValues(scan)
    scan.grade(values)
    useProgress.getState().recordDeskRun('scan-desk', values, [{ id: 'per_query', pass: true }])
    /* Submitting does not touch the dossier. That is the whole point of an offer. */
    expect(useProgress.getState().dossier).toEqual({})
  })

  it('the action sets the offered keys and no others', () => {
    useProgress.getState().resetProgress()
    const offers = scan.offers(knownValues(scan))
    useProgress.getState().setDossier(Object.fromEntries(offers.map((o) => [o.key, o.value])))
    const d = useProgress.getState().dossier
    expect(Object.keys(d).sort()).toEqual(offers.map((o) => o.key).sort())
    for (const o of offers) expect(d[o.key]).toEqual(o.value)
  })

  it('an existing figure the desk does not produce is left alone', () => {
    useProgress.getState().resetProgress()
    /* A number from somewhere else in the course — governance, not a desk. */
    useProgress.getState().setDossier({ erasurePath: true, retentionPolicyDays: 400 })
    const offers = scan.offers(knownValues(scan))
    useProgress.getState().setDossier(Object.fromEntries(offers.map((o) => [o.key, o.value])))
    const d = useProgress.getState().dossier
    expect(d.erasurePath).toBe(true)
    expect(d.retentionPolicyDays).toBe(400)
    expect(Object.keys(d).sort()).toEqual([...offers.map((o) => o.key), 'erasurePath', 'retentionPolicyDays'].sort())
  })

  it('an overwrite replaces only the key it names, and is never silent in the store either', () => {
    useProgress.getState().resetProgress()
    useProgress.getState().setDossier({ dailyScanBytes: 1, worstQueryBytes: 2, sortKey: 'kept' })
    const offers = scan.offers(knownValues(scan))
    useProgress.getState().setDossier(Object.fromEntries(offers.map((o) => [o.key, o.value])))
    const d = useProgress.getState().dossier
    expect(d.dailyScanBytes).toBe(offers.find((o) => o.key === 'dailyScanBytes')!.value)
    expect(d.worstQueryBytes).toBe(offers.find((o) => o.key === 'worstQueryBytes')!.value)
    /* A key from another desk is untouched — the copy is per-desk, not a reset. */
    expect(d.sortKey).toBe('kept')
  })

  it('every desk’s copy action is idempotent: running it twice changes nothing', () => {
    for (const [id, form] of forms) {
      useProgress.getState().resetProgress()
      const offers = form.offers(knownValues(form))
      const patch = Object.fromEntries(offers.map((o) => [o.key, o.value]))
      useProgress.getState().setDossier(patch)
      const first = { ...useProgress.getState().dossier }
      useProgress.getState().setDossier(patch)
      expect(useProgress.getState().dossier, id).toEqual(first)
    }
  })

  it('the eight desks together fill a dossier the rooms can actually read', () => {
    useProgress.getState().resetProgress()
    for (const [, form] of forms) {
      const offers = form.offers(knownValues(form))
      useProgress.getState().setDossier(Object.fromEntries(offers.map((o) => [o.key, o.value])))
    }
    const d = useProgress.getState().dossier
    /* Every value is defined — an offer never hands over an undefined. */
    for (const [k, v] of Object.entries(d)) expect(v, k).not.toBeUndefined()
    expect(Object.keys(d).length).toBeGreaterThanOrEqual(20)
    /* And it rides the export snapshot alongside the desk runs. */
    const parsed = JSON.parse(exportProgress()) as { dossier: Dossier }
    expect(parsed.dossier).toEqual(d)
  })
})
