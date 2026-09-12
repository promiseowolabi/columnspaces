/**
 * Site integrity gate — the publication audit, made permanent.
 *
 * Three classes of rot this file exists to catch, each of which had already
 * shipped at least once when it was written:
 *
 *  1. ORPHANED SURFACES. A route lands in App.tsx and nothing links to it, so
 *     the only way in is to type the URL. `/desks` and `/rooms` were both built
 *     before anything pointed at them.
 *
 *  2. DEAD LINKS. The reverse: a nav entry survives a course fork and points at
 *     a route that no longer exists. The palette, the curriculum stack, the
 *     progress capstone row and the drills debrief all pointed at `/labs/hnsw`
 *     — a lab from the sibling row-store course that FORGE_LABS has never
 *     contained. The footer pointed at `#method` and `#faq`, which are not
 *     sections of any page.
 *
 *  3. HARDCODED COURSE COUNTS. A number in prose that a registry also knows.
 *     This repo shipped "thirty-seven lessons" on /curriculum and "37 lesson
 *     blocks" on /progress against a 54-lesson curriculum, and "four incidents"
 *     on /drills against five.
 *
 * The checks are source-text assertions rather than render tests on purpose:
 * there is no DOM environment configured in this project, and the failure modes
 * above are all statically visible.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TRACKS } from '@/lib/tracks'
import { TOTAL_LESSON_COUNT, ORDERED_LESSON_IDS } from '@/data/lessons/manifest'
import { FORGE_LABS } from '@/data/labs'
import { BROWSER_LABS } from '@/data/browser-labs'
import { DUCK_LABS } from '@/data/duck-labs'
import { DESKS } from '@/lib/desks'
import { ROOMS } from '@/data/rooms'
import { DRILLS } from '@/data/drills'

const ROOT = new URL('..', import.meta.url).pathname
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

const APP = read('src/App.tsx')
const NAVBAR = read('src/components/Navbar.tsx')
const FOOTER = read('src/components/Footer.tsx')
const PALETTE = read('src/components/CommandPalette.tsx')

/** Pages whose copy is audited for hardcoded counts. */
const AUDITED_PAGES = [
  'src/pages/Home.tsx',
  'src/pages/Curriculum.tsx',
  'src/pages/Forge.tsx',
  'src/pages/Drills.tsx',
  'src/pages/Progress.tsx',
  'src/components/Navbar.tsx',
  'src/components/Footer.tsx',
  'src/components/CommandPalette.tsx',
] as const

/* ------------------------------------------------------------------ */
/* 1. routes ⇄ navigation                                              */
/* ------------------------------------------------------------------ */

/** Every `path="…"` in the route table. */
function routePaths(): string[] {
  return [...APP.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1])
}

/**
 * Static route targets found in a nav surface: `to="/x"`, `to='/x'` and the
 * `to: '/x'` form the palette index and the link arrays use.
 */
function linkTargets(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/\bto[=:]\s*["'](\/[^"'`${}]*)["']/g)) out.add(m[1])
  return out
}

const NAV_TARGETS = new Set<string>([
  ...linkTargets(NAVBAR),
  ...linkTargets(FOOTER),
  ...linkTargets(PALETTE),
])

/**
 * Routes that are legitimately reachable only by deep link, with the reason.
 * Adding to this list is a decision, which is why it is written down here and
 * asserted below rather than being an implicit gap.
 */
const DEEP_LINK_ONLY: Record<string, string> = {
  '/tracks/:trackId': 'parameterised — reached from the curriculum stack and track cards',
  '/lesson/:lessonId': 'parameterised — reached from track pages, LessonRow and the up-next card',
  '/labs/:labId': 'parameterised — reached from the forge index',
  '/desk/:deskId': 'parameterised — also indexed by name in the command palette',
  '/room/:roomId': 'parameterised — also indexed by name in the command palette',
  '*': 'the NotFound catch-all is not a destination',
}

describe('routes and navigation', () => {
  it('the route table parses (the matcher is not silently empty)', () => {
    const paths = routePaths()
    expect(paths.length).toBeGreaterThan(8)
    expect(paths).toContain('/')
    expect(paths).toContain('*')
  })

  it('every non-parameterised route is reachable from Navbar, Footer or the palette', () => {
    const unreachable = routePaths().filter(
      (p) => !(p in DEEP_LINK_ONLY) && !NAV_TARGETS.has(p),
    )
    expect(
      unreachable,
      `built but unreachable: ${unreachable.join(', ')} — add to Navbar/Footer/CommandPalette, ` +
        'or document it in DEEP_LINK_ONLY with a reason',
    ).toEqual([])
  })

  it('every deep-link-only exception is a real route with a stated reason', () => {
    const paths = new Set(routePaths())
    for (const [p, reason] of Object.entries(DEEP_LINK_ONLY)) {
      expect(paths, `DEEP_LINK_ONLY names ${p}, which is not a route`).toContain(p)
      expect(reason.length, `${p} needs a reason`).toBeGreaterThan(20)
    }
  })

  it('no nav surface links to a route that does not exist', () => {
    const paths = routePaths()
    const literal = new Set(paths.filter((p) => !p.includes(':') && p !== '*'))
    /* `/lesson/c0.l1`-style targets resolve against the parameterised routes. */
    const prefixes = paths
      .filter((p) => p.includes(':'))
      .map((p) => p.slice(0, p.indexOf(':')))
    const dead = [...NAV_TARGETS].filter(
      (t) => !literal.has(t) && !prefixes.some((pre) => t.startsWith(pre) && t.length > pre.length),
    )
    expect(dead, `nav links with no route: ${dead.join(', ')}`).toEqual([])
  })

  it('no page links at a forge lab id that does not exist', () => {
    const ids = new Set(FORGE_LABS.map((l) => l.id))
    const offenders: string[] = []
    for (const rel of AUDITED_PAGES) {
      for (const m of prose(read(rel)).matchAll(/["'`]\/labs\/([a-z0-9-]+)["'`]/g)) {
        if (!ids.has(m[1])) offenders.push(`${rel} → /labs/${m[1]}`)
      }
    }
    expect(offenders, `dead lab links: ${offenders.join(', ')}`).toEqual([])
  })

  it('no page links at a lesson id that does not exist', () => {
    const ids = new Set(ORDERED_LESSON_IDS)
    const offenders: string[] = []
    for (const rel of AUDITED_PAGES) {
      for (const m of prose(read(rel)).matchAll(/["'`]\/lesson\/([a-z0-9]+\.l\d+)["'`]/g)) {
        if (!ids.has(m[1])) offenders.push(`${rel} → /lesson/${m[1]}`)
      }
    }
    expect(offenders, `dead lesson links: ${offenders.join(', ')}`).toEqual([])
  })

  it('the footer has no fragment-only links (there are no such sections)', () => {
    const frags = [...FOOTER.matchAll(/href[=:]\s*["'](#[^"']*)["']/g)].map((m) => m[1])
    expect(frags, `footer anchors point at nothing: ${frags.join(', ')}`).toEqual([])
  })

  it('the footer GitHub link names this repository, not github.com', () => {
    expect(FOOTER).toContain('https://github.com/promiseowolabi/columnspaces')
    expect(FOOTER).not.toMatch(/href[=:]\s*['"]https:\/\/github\.com['"]/)
  })

  it('no nav surface lists the same route twice (`to` doubles as the React key)', () => {
    for (const [name, src] of [
      ['Navbar', NAVBAR],
      ['Footer', FOOTER],
    ] as const) {
      for (const arr of src.matchAll(/const (\w+_LINKS) = \[([\s\S]*?)\n\]/g)) {
        const targets = [...arr[2].matchAll(/to:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
        expect(
          new Set(targets).size,
          `${name}.${arr[1]} repeats a route: ${targets.join(', ')}`,
        ).toBe(targets.length)
      }
    }
  })
})

/* ------------------------------------------------------------------ */
/* 2. no hardcoded course counts                                       */
/* ------------------------------------------------------------------ */

/**
 * Counts the registries own. A page may not state any of these as a literal —
 * digit or spelled out — next to the noun it counts.
 */
const REGISTRY_COUNTS: { n: number; nouns: string[]; source: string }[] = [
  { n: TOTAL_LESSON_COUNT, nouns: ['lesson', 'lessons'], source: 'TOTAL_LESSON_COUNT' },
  { n: TRACKS.length, nouns: ['track', 'tracks'], source: 'TRACKS.length' },
  { n: FORGE_LABS.length, nouns: ['forge labs', 'labs'], source: 'FORGE_LABS.length' },
  { n: BROWSER_LABS.length, nouns: ['browser labs'], source: 'BROWSER_LABS.length' },
  { n: DUCK_LABS.length, nouns: ['duckdb labs', 'duck labs'], source: 'DUCK_LABS.length' },
  { n: DESKS.length, nouns: ['desk', 'desks'], source: 'DESKS.length' },
  { n: ROOMS.length, nouns: ['room', 'rooms'], source: 'ROOMS.length' },
  { n: DRILLS.length, nouns: ['incident', 'incidents', 'drill', 'drills'], source: 'DRILLS.length' },
]

const WORDS: Record<number, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
  13: 'thirteen',
}

/** Strip comments — an explanatory comment may name a number. */
function prose(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ')
}

describe('no hardcoded course counts', () => {
  it('the audited pages all exist', () => {
    for (const rel of AUDITED_PAGES) {
      expect(existsSync(join(ROOT, rel)), `${rel} missing`).toBe(true)
    }
  })

  it('no audited page states a count the registries define', () => {
    const offenders: string[] = []
    for (const rel of AUDITED_PAGES) {
      const text = prose(read(rel))
      for (const { n, nouns, source } of REGISTRY_COUNTS) {
        const forms = [String(n), WORDS[n]].filter(Boolean) as string[]
        for (const form of forms) {
          for (const noun of nouns) {
            const re = new RegExp(`\\b${form}\\s+${noun}\\b`, 'i')
            const hit = text.match(re)
            if (hit) offenders.push(`${rel}: "${hit[0]}" — use ${source}`)
          }
        }
      }
    }
    expect(offenders, `hardcoded counts:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('no audited page spells the lesson total in words ("thirty-seven lessons")', () => {
    const tens = /\b(twenty|thirty|forty|fifty|sixty)([- ](one|two|three|four|five|six|seven|eight|nine))?\s+lessons?\b/i
    const offenders = AUDITED_PAGES.filter((rel) => tens.test(prose(read(rel))))
    expect(offenders, `spelled-out lesson totals in: ${offenders.join(', ')}`).toEqual([])
  })

  it('the pages that show course totals read them from a registry', () => {
    /* Curriculum and Progress both render the lesson total; both must import it. */
    for (const rel of ['src/pages/Curriculum.tsx', 'src/pages/Progress.tsx']) {
      expect(read(rel), `${rel} should derive the lesson total`).toMatch(
        /TOTAL_LESSON_COUNT|ORDERED_LESSON_IDS\.length/,
      )
    }
  })

  it('no audited page references the superseded TOTAL_LESSONS constant', () => {
    /* lib/progress exports TOTAL_LESSONS = 37 and the curriculum outgrew it. */
    const offenders = AUDITED_PAGES.filter((rel) => /\bTOTAL_LESSONS\b/.test(prose(read(rel))))
    expect(offenders, `still dividing by TOTAL_LESSONS: ${offenders.join(', ')}`).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* 3. forge lab downloads                                             */
/* ------------------------------------------------------------------ */

describe('forge lab artifacts', () => {
  it('every FORGE_LABS zip exists in public/', () => {
    const missing = FORGE_LABS.filter((l) => !existsSync(join(ROOT, 'public', l.zip))).map(
      (l) => `${l.id} → public${l.zip}`,
    )
    expect(missing, `missing lab archives: ${missing.join(', ')}`).toEqual([])
  })

  it('every zip path is base-relative and named for its lab', () => {
    for (const l of FORGE_LABS) {
      expect(l.zip, `${l.id} zip path`).toBe(`labs/${l.id}.zip`)
    }
  })

  it('every archive is non-trivial (a zero-byte zip is worse than a 404)', () => {
    for (const l of FORGE_LABS) {
      const bytes = readFileSync(join(ROOT, 'public', l.zip)).length
      expect(bytes, `${l.id} archive size`).toBeGreaterThan(2048)
    }
  })

  it('the forge index does not assert a single check count for every lab', () => {
    /* Labs have five or six checks; "six checks pass" was wrong for four of them. */
    const forge = prose(read('src/pages/Forge.tsx'))
    expect(forge).not.toMatch(/\b(four|five|six|seven)\s+checks\b/i)
    expect(forge, 'the count should come from lab.checks').toMatch(/checks\.length/)
  })
})

/* ------------------------------------------------------------------ */
/* 3b. public assets and the deploy base path                          */
/* ------------------------------------------------------------------ */

/**
 * KNOWN DEFECT, pinned rather than fixed here.
 *
 * The Pages workflow builds with `VITE_BASE=/columnspaces/`, so anything in
 * public/ is served from `/columnspaces/…`. A root-absolute string like
 * `/labs/encodings.zip` therefore resolves to `promiseowolabi.github.io/labs/…`
 * and 404s in production, even though the file exists on disk. Vite rewrites
 * asset URLs in index.html and in `import`ed assets — it does not rewrite string
 * literals, so these need `import.meta.env.BASE_URL` explicitly.
 *
 * The three offenders live in files outside this audit's edit scope
 * (src/data/labs.ts, src/components/AgentActions.tsx, src/pages/Lesson.tsx), so
 * they are recorded here instead. The assertion is an equality, not an absence:
 * it stays green on the current state and fails the moment a fourth one appears
 * or one of these is fixed — either way somebody updates this list deliberately.
 */
/*
 * Was a list of known offenders; all of them are fixed. Public files now go
 * through asset() in src/lib/asset.ts, which resolves against
 * import.meta.env.BASE_URL. The list stays empty on purpose: a new entry means
 * a new production 404 that is invisible in dev, because dev serves from /.
 */
const KNOWN_ROOT_ABSOLUTE_ASSETS: string[] = []

describe('public asset paths and the deploy base', () => {
  function filesWithRootAbsoluteAssets(): string[] {
    const re = /["'`]\/[A-Za-z0-9_\-/${}.]*\.(zip|md|svg|png|txt)["'`]/
    const out = new Set<string>()
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(name) && re.test(prose(read(rel)))) out.add(rel)
      }
    }
    walk('src')
    return [...out].sort()
  }

  it('only the known offenders hardcode a root-absolute public asset path', () => {
    const found = filesWithRootAbsoluteAssets()
    expect(
      found,
      'root-absolute public asset paths 404 under VITE_BASE=/columnspaces/. ' +
        'Use `${import.meta.env.BASE_URL}…`. If you fixed one, remove it from ' +
        'KNOWN_ROOT_ABSOLUTE_ASSETS; if you added one, do not.',
    ).toEqual(KNOWN_ROOT_ABSOLUTE_ASSETS)
  })

  it('the surfaces this audit owns use BASE_URL for public files', () => {
    expect(read('src/components/Footer.tsx')).toContain('import.meta.env.BASE_URL')
    for (const rel of AUDITED_PAGES) {
      expect(
        KNOWN_ROOT_ABSOLUTE_ASSETS,
        `${rel} is in the audit scope and must not hardcode an asset root`,
      ).not.toContain(rel)
    }
  })

  it('the router basename comes from BASE_URL', () => {
    expect(read('src/main.tsx')).toContain('basename={import.meta.env.BASE_URL}')
  })
})

/* ------------------------------------------------------------------ */
/* 3c. dead links outside the audit's edit scope                       */
/* ------------------------------------------------------------------ */

/**
 * KNOWN DEFECT, pinned rather than fixed here.
 *
 * `/labs/hnsw` is the capstone lab of the sibling row-store course. FORGE_LABS
 * has never contained it, so every link to it 404s. The audit fixed the four
 * occurrences inside its edit scope (CommandPalette, Curriculum, Progress,
 * Drills); these two are on pages outside it.
 *
 * Both should point at `/capstone`, which is where the other four now go:
 *   src/pages/Lesson.tsx:743   <Link to="/labs/hnsw">   → to="/capstone"
 *   src/pages/Track.tsx:317    <Link to="/labs/hnsw">   → to="/capstone"
 *
 * src/pages/Engine.tsx is a third case with a different remedy: it is a 33 kB
 * page from the sibling course that App.tsx does not route at all, so its links
 * are unreachable rather than broken. It should be deleted, not repaired.
 *
 * Equality assertion again: green now, fails if a fourth appears or one is fixed.
 */
/*
 * Was /labs/hnsw in two pages — the capstone lab of the sibling row-store
 * course, which this course does not have. Both now link /capstone.
 */
const KNOWN_DEAD_LAB_LINKS: string[] = []

describe('dead forge-lab links across the whole app', () => {
  it('only the known offenders remain', () => {
    const ids = new Set(FORGE_LABS.map((l) => l.id))
    const offenders = new Set<string>()
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(name)) {
          for (const m of prose(read(rel)).matchAll(/["'`]\/labs\/([a-z0-9-]+)["'`]/g)) {
            if (!ids.has(m[1])) offenders.add(rel)
          }
        }
      }
    }
    walk('src')
    expect(
      [...offenders].sort(),
      'links to a forge lab id that does not exist. Point them at /capstone and ' +
        'remove them from KNOWN_DEAD_LAB_LINKS.',
    ).toEqual(KNOWN_DEAD_LAB_LINKS)
  })

  it('no route-serving page other than those two links at a missing lab', () => {
    for (const rel of AUDITED_PAGES) {
      expect(KNOWN_DEAD_LAB_LINKS, `${rel} is in scope and must be clean`).not.toContain(rel)
    }
  })

  /**
   * The other direction: a page component that App.tsx never renders. Engine.tsx
   * is the one orphan — the sibling course's simulator page, 33 kB of it, kept
   * out of every bundle only because nothing imports it. It should be deleted.
   */
  it('no page component is orphaned', () => {
    const orphans = readdirSync(join(ROOT, 'src/pages'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => f.replace(/\.tsx$/, ''))
      .filter((name) => !new RegExp(`@/pages/${name}['"]`).test(APP))
      .sort()
    /*
     * Engine.tsx used to live here unrouted — 33 kB of buffer-pool simulator
     * inherited from the sibling course. Deleted rather than repaired. An orphan
     * page is dead weight that still typechecks, so it must stay at zero.
     */
    expect(
      orphans,
      'page components nothing routes to: ' + orphans.join(', '),
    ).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* 4. the drills registry and the page that renders it                 */
/* ------------------------------------------------------------------ */

describe('column week drills', () => {
  it('holds five incidents with distinct ids', () => {
    expect(DRILLS).toHaveLength(5)
    const ids = DRILLS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every incident has a title, a briefing and a debrief', () => {
    for (const d of DRILLS) {
      expect(d.title.length, `${d.id} title`).toBeGreaterThan(10)
      expect(d.briefing.length, `${d.id} briefing`).toBeGreaterThan(120)
      expect(d.debrief.length, `${d.id} debrief`).toBeGreaterThan(200)
    }
  })

  it('every incident has non-empty telemetry the sparkline can draw', () => {
    for (const d of DRILLS) {
      expect(d.telemetry.length, `${d.id} series count`).toBeGreaterThanOrEqual(2)
      for (const s of d.telemetry) {
        expect(s.label.length, `${d.id} series label`).toBeGreaterThan(2)
        expect(s.color, `${d.id}/${s.label} colour`).toMatch(/^#[0-9A-Fa-f]{6}$/)
        /* The Sparkline needs at least two points; every value must be finite. */
        expect(s.values.length, `${d.id}/${s.label} points`).toBeGreaterThanOrEqual(2)
        for (const v of s.values) {
          expect(Number.isFinite(v), `${d.id}/${s.label} has a non-finite value`).toBe(true)
        }
      }
      /* Series lengths line up, or the cards imply readings that never coincided. */
      const lengths = new Set(d.telemetry.map((s) => s.values.length))
      expect(lengths.size, `${d.id} series lengths differ: ${[...lengths].join(', ')}`).toBe(1)
    }
  })

  it('every incident grades exactly one correct cause and one correct mitigation', () => {
    for (const d of DRILLS) {
      expect(d.causes.filter((c) => c.correct).length, `${d.id} correct causes`).toBe(1)
      expect(d.mitigations.filter((m) => m.correct).length, `${d.id} correct mitigations`).toBe(1)
      expect(d.causes.length, `${d.id} cause options`).toBeGreaterThanOrEqual(3)
      expect(d.mitigations.length, `${d.id} mitigation options`).toBeGreaterThanOrEqual(3)
    }
  })

  it('option ids are unique within an incident (they key the selection)', () => {
    for (const d of DRILLS) {
      const c = d.causes.map((o) => o.id)
      const m = d.mitigations.map((o) => o.id)
      expect(new Set(c).size, `${d.id} duplicate cause ids`).toBe(c.length)
      expect(new Set(m).size, `${d.id} duplicate mitigation ids`).toBe(m.length)
    }
  })

  it('the wrong answers are plausible, not filler', () => {
    for (const d of DRILLS) {
      for (const o of [...d.causes, ...d.mitigations].filter((x) => !x.correct)) {
        expect(o.label.length, `${d.id}/${o.id} distractor is too short to be tempting`).toBeGreaterThan(30)
      }
    }
  })

  it('the page renders the whole registry and derives every count from it', () => {
    const drills = read('src/pages/Drills.tsx')
    expect(drills).toMatch(/DRILLS\.map/)
    expect(drills).toMatch(/DRILLS\.length/)
    expect(drills).toMatch(/incident\.telemetry/)
    expect(drills).toMatch(/incident\.causes\.map/)
    expect(drills).toMatch(/incident\.mitigations\.map/)
    /* Grading reads `correct` from the registry rather than comparing to a literal. */
    expect(drills).toMatch(/\.correct/)
  })

  it('the page states that the telemetry is modelled rather than measured', () => {
    /* Never overclaim: these curves were authored, not captured. */
    expect(read('src/pages/Drills.tsx')).toMatch(/modelled/i)
  })
})

/* ------------------------------------------------------------------ */
/* 5. cost is a count                                                  */
/* ------------------------------------------------------------------ */

describe('no prices on the audited pages', () => {
  it('no page states a currency amount', () => {
    const priceLike = /(\$|£|€)\s?\d|\b\d+(\.\d+)?\s?(USD|EUR|GBP)\b/
    const offenders: string[] = []
    for (const rel of AUDITED_PAGES) {
      const hit = read(rel).match(priceLike)
      if (hit) offenders.push(`${rel}: "${hit[0]}"`)
    }
    expect(offenders, `prices found: ${offenders.join(', ')}`).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* 6. accessibility floor                                             */
/* ------------------------------------------------------------------ */

describe('accessibility basics on the audited pages', () => {
  it('every <img> has an alt attribute', () => {
    const offenders: string[] = []
    for (const rel of AUDITED_PAGES) {
      for (const m of read(rel).matchAll(/<img\b[^>]*>/g)) {
        if (!/\balt\s*=/.test(m[0])) offenders.push(`${rel}: ${m[0].slice(0, 60)}`)
      }
    }
    expect(offenders, `images without alt: ${offenders.join(', ')}`).toEqual([])
  })

  it('every <button> declares a type (default submit is a footgun in forms)', () => {
    const offenders: string[] = []
    for (const rel of AUDITED_PAGES) {
      for (const m of read(rel).matchAll(/<button\b[^>]*?>/gs)) {
        if (!/\btype=/.test(m[0])) offenders.push(`${rel}: ${m[0].replace(/\s+/g, ' ').slice(0, 70)}`)
      }
    }
    expect(offenders, `buttons without type:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('toggle buttons on the drills page expose their pressed state', () => {
    /* Selection is otherwise signalled by border and text colour alone. */
    const drills = read('src/pages/Drills.tsx')
    expect((drills.match(/aria-pressed/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('the drills verdict is announced, not just recoloured', () => {
    const drills = read('src/pages/Drills.tsx')
    expect(drills).toMatch(/aria-live/)
    /* And the words carry the result, so ✓ / ✗ is never the only signal. */
    expect(drills).toMatch(/CORRECT CALL/)
    expect(drills).toMatch(/WRONG CALL/)
  })
})
