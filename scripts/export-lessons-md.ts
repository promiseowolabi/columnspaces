/**
 * export-lessons-md — render every lesson's blocks to plain markdown files
 * in public/lessons-md/, plus public/llms.txt (the agent manifest).
 *
 * This is the agent-native tutoring surface: any coding/chat agent can
 * ingest a lesson as clean markdown; the site links each lesson page to
 * its .md and to Claude/ChatGPT deep links.
 *
 *   npx tsx scripts/export-lessons-md.ts
 */
import { writeFileSync, mkdirSync } from 'fs'
import { ALL_LESSONS, TRACK_EXTRAS } from '../src/data/lessons'
import type { ContentBlock, Lesson } from '../src/data/lessons/types'
import { TRACKS } from '../src/lib/tracks'
import { browserLabMeta } from '../src/data/browser-labs'
import { duckLabMeta } from '../src/data/duck-labs'
import { DESKS } from '../src/lib/desks'
import { ROOMS } from '../src/data/rooms'

/**
 * The one place a public URL is written down. Change this and every generated
 * link moves — the manifest needs absolute URLs to be useful to an agent, and
 * exactly one constant is the price of that.
 */
const SITE = process.env.SITE_URL ?? 'https://promiseowolabi.github.io/columnspaces'

function blockToMd(b: ContentBlock): string {
  switch (b.type) {
    case 'prose':
    case 'deepdive':
      return b.md
    case 'code': {
      if (b.tabs?.length) {
        return b.tabs.map((t) => `**${t.label}**\n\n\`\`\`${t.lang}\n${t.code}\n\`\`\``).join('\n\n')
      }
      return `\`\`\`${b.lang ?? ''}\n${b.code ?? ''}\n\`\`\``
    }
    case 'callout':
      return `> **[${b.variant}]** ${b.md.replace(/\n/g, '\n> ')}`
    case 'statline':
      return b.stats.map((s) => `- **${s.value}** — ${s.label}${s.hint ? ` (${s.hint})` : ''}`).join('\n')
    case 'diagram': {
      const nodes = b.nodes.map((n) => `${n.label}${n.sub ? ` (${n.sub})` : ''}`).join(' · ')
      const steps = (b.steps ?? []).map((s, i) => `${i + 1}. ${s.caption}`).join('\n')
      return `_${b.caption}_\n\nComponents: ${nodes}${steps ? `\n\nSteps:\n${steps}` : ''}`
    }
    case 'isomorphism':
      return `_${b.title ?? 'isomorphism'}_\n\n${b.pairs
        .map((p) => `- **${p.os}** (${p.osLine}) ≡ **${p.llm}** (${p.llmLine})`)
        .join('\n')}`
    case 'quiz':
      return b.questions
        .map((q, i) => {
          const opts = q.options.map((o, j) => `   ${String.fromCharCode(65 + j)}. ${o}`).join('\n')
          const correct = q.correct.map((c) => String.fromCharCode(65 + c)).join(', ')
          return `**Q${i + 1}. ${q.q}**\n${opts}\n   Answer: ${correct} — ${q.explanation}`
        })
        .join('\n\n')
    case 'exercise':
      return `**Exercise: ${b.title}**\n\n${b.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}${b.note ? `\n\n_${b.note}_` : ''}`
    case 'lab': {
      const meta = browserLabMeta(b.lab)
      return `**Browser lab: ${meta?.title ?? b.lab}** — ${meta?.hook ?? ''} (interactive, on the lesson page)`
    }
    case 'ducklab': {
      const meta = duckLabMeta(b.lab)
      return `**DuckDB lab: ${meta?.title ?? b.lab}** — ${meta?.hook ?? ''}\n\nClaim under test: ${meta?.claim ?? ''} (runs a real columnar engine in the browser)`
    }
    case 'vendor':
      return [
        `> **[vendor snapshot — verified ${b.snapshot}]** ${b.title}`,
        '>',
        `> ${b.md.replace(/\n/g, '\n> ')}`,
        b.sources?.length ? `>\n> Sources: ${b.sources.join(' · ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    case 'desk': {
      const desk = DESKS.find((d) => d.id === b.desk)
      return `**Desk: ${desk?.name ?? b.desk}** — ${b.brief}\n\nDecision: ${desk?.decision ?? ''}\nYou submit: ${desk?.submits ?? ''}\nGraded: ${desk?.checks.join(', ') ?? ''}`
    }
    case 'room': {
      const room = ROOMS.find((r) => r.id === b.room)
      return `**Design review: ${room?.adversary ?? b.room} (${room?.role ?? ''})** — ${b.brief}\n\nAttacks the ${b.artifact}.`
    }
    default:
      return ''
  }
}

function lessonToMd(l: Lesson): string {
  const track = TRACKS.find((t) => t.id === l.trackId)
  const header = [
    `# ${l.id.toUpperCase()} — ${l.title}`,
    '',
    `_Track ${track?.code ?? l.trackId}: ${track?.name ?? ''} · ~${l.minutes} min · columnspaces_`,
    '',
    `> ${l.hook}`,
    '',
  ].join('\n')
  const body = l.blocks.map(blockToMd).filter(Boolean).join('\n\n---\n\n')
  return `${header}${body}\n`
}

mkdirSync('public/lessons-md', { recursive: true })
let count = 0
for (const l of ALL_LESSONS) {
  writeFileSync(`public/lessons-md/${l.id}.md`, lessonToMd(l))
  count++
}

/* llms.txt — the agent manifest (llmstxt.org shape) */
const byTrack = TRACKS.map((t) => {
  const lessons = ALL_LESSONS.filter((l) => l.trackId === t.id)
    .map((l) => `- [${l.id.toUpperCase()} ${l.title}](${SITE}/lessons-md/${l.id}.md): ${l.hook}`)
    .join('\n')
  const extras = TRACK_EXTRAS[t.id as keyof typeof TRACK_EXTRAS]
  return `### ${t.code} — ${t.name}\n\n_${extras?.pitch ?? ''}_\n\n${lessons}`
}).join('\n\n')

const llmsTxt = `# columnspaces

> Columnar databases, from an encoded block to a platform decision. Two halves:
> the engine half (C0-C7) builds and measures the columnar layer — encodings,
> pruning, table formats, vectorized execution, the write path, shuffle — with
> Rust labs graded in-browser and DuckDB-wasm labs that let the reader falsify
> the course's own numbers. The architecture half (A1-A2) turns those
> measurements into designs, graded by numeric desks and by adversarial design
> reviews. The deep-dive subject is VAST DataBase, taught as named architecture
> against a hands-on proxy, with every vendor claim dated and sourced.
> All content is plain markdown under /lessons-md/; every page is at
> ${SITE}/lesson/<id> (e.g. c1.l2).

## How to tutor from this material

- The reader writes SQL, has seen a query plan, and has been surprised by a
  warehouse bill. They are here to stop guessing. Be Socratic; never dump full
  lab solutions (they are graded by invariant checks).
- Insist on arithmetic. Every claim in this course is redoable: if the reader
  asserts a number, ask them to show the multiplication.
- Forge labs live at ${SITE}/labs (Rust, wasm-graded in-browser). The Warehouse
  (${SITE}/warehouse) is the persistent world. Column Week (${SITE}/drills) is
  the incident-diagnosis set. The desks (${SITE}/desks) and Design Review rooms
  (${SITE}/rooms) grade the architecture half.
- On VAST DataBase specifically: never present a VAST performance figure as
  measured by the reader or by this course. Mechanisms are teachable; benchmarks
  are the vendor's, cited as theirs.

## Curriculum

${byTrack}

## Optional

- [The Forge labs](${SITE}/labs): six Rust labs (encodings -> zone maps -> vectorized execution -> Parquet reader -> merge-on-read -> shuffle)
- [The Warehouse](${SITE}/warehouse): a columnar platform under deterministic query traces, measured in counts
- [The Desks](${SITE}/desks): eight numeric decisions graded in tolerance bands
- [Design Review](${SITE}/rooms): five adversaries who attack the numbers you submitted
- [Column Week](${SITE}/drills): five incident cards — pruning collapse, small-file storm, skewed shuffle, silent schema change, disaggregation surprise
`

writeFileSync('public/llms.txt', llmsTxt)
console.log(`exported ${count} lessons + llms.txt`)
