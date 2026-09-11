/**
 * report — the honest build state.
 *
 * `npm run report` is authoritative for "what is actually built". The point is
 * that the gap between the plan and the repo is printed rather than remembered:
 * a course built in public needs its own outstanding-work queue, and README
 * prose rots faster than a script does.
 *
 *   npx tsx scripts/report.ts
 */

import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_LESSONS, LESSONS_BY_TRACK } from '../src/data/lessons'
import { TRACKS } from '../src/lib/tracks'
import { DESKS } from '../src/lib/desks'
import { ROOMS } from '../src/data/rooms'
import { FORGE_LABS } from '../src/data/labs'
import { BROWSER_LABS } from '../src/data/browser-labs'
import { DUCK_LABS } from '../src/data/duck-labs'
import { DRILLS } from '../src/data/drills'
import type { TrackId } from '../src/data/lessons/types'

const ROOT = join(import.meta.dirname, '..')

const bar = (done: number, total: number, width = 18): string => {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return `${'█'.repeat(filled)}${'·'.repeat(width - filled)}`
}

/* ------------------------------ lessons ------------------------------ */

console.log('\ncolumnspaces — build state\n' + '='.repeat(56) + '\n')
console.log('LESSONS')

let authored = 0
let planned = 0
for (const t of TRACKS) {
  const have = LESSONS_BY_TRACK[t.id as TrackId].length
  authored += have
  planned += t.lessons
  const half = t.half === 'engine' ? 'E' : 'A'
  console.log(
    `  ${t.code.padEnd(3)} ${half} ${t.name.padEnd(26)} ${bar(have, t.lessons)} ${String(have).padStart(2)}/${t.lessons}`,
  )
}
console.log(`\n  total ${authored}/${planned} lessons authored (${Math.round((authored / planned) * 100)}%)`)

/* ------------------------------ machinery ---------------------------- */

const componentsDir = join(ROOT, 'src/components')
const builtBrowserLabs = existsSync(join(componentsDir, 'browserlabs'))
  ? readdirSync(join(componentsDir, 'browserlabs')).filter((f) => f.endsWith('Lab.tsx')).length
  : 0
const builtDuckLabs = existsSync(join(componentsDir, 'ducklabs'))
  ? readdirSync(join(componentsDir, 'ducklabs')).filter((f) => f.endsWith('Lab.tsx')).length
  : 0

const labsDir = join(ROOT, 'labs')
const builtForge = FORGE_LABS.filter((l) => existsSync(join(labsDir, l.id, 'Cargo.toml'))).length
const packedZips = existsSync(join(ROOT, 'public/labs'))
  ? readdirSync(join(ROOT, 'public/labs')).filter((f) => f.endsWith('.zip')).length
  : 0

/* A desk is "built" when it has a reference model file, not just metadata. */
const desksDir = join(ROOT, 'src/lib/desks')
const builtDesks = DESKS.filter((d) =>
  existsSync(join(desksDir, `${d.id.replace('-desk', '')}.ts`)),
).length

console.log('\nMACHINERY')
console.log(`  forge labs      ${bar(builtForge, FORGE_LABS.length)} ${builtForge}/${FORGE_LABS.length} crates`)
console.log(`  packed zips     ${bar(packedZips, FORGE_LABS.length)} ${packedZips}/${FORGE_LABS.length}`)
console.log(`  duckdb labs     ${bar(builtDuckLabs, DUCK_LABS.length)} ${builtDuckLabs}/${DUCK_LABS.length} components`)
console.log(`  browser labs    ${bar(builtBrowserLabs, BROWSER_LABS.length)} ${builtBrowserLabs}/${BROWSER_LABS.length} components`)
console.log(`  desk models     ${bar(builtDesks, DESKS.length)} ${builtDesks}/${DESKS.length} reference models`)
console.log(`  rooms           ${bar(ROOMS.length, 5)} ${ROOMS.length}/5 (${ROOMS.reduce((n, r) => n + r.objections.length, 0)} objections, ${ROOMS.reduce((n, r) => n + r.objections.filter((o) => o.severity === 3).length, 0)} critical)`)
console.log(`  drills          ${bar(DRILLS.length, 5)} ${DRILLS.length}/5 incident cards`)

/* ------------------------------ content debt -------------------------- */

const vendorBlocks = ALL_LESSONS.flatMap((l) =>
  l.blocks.filter((b) => b.type === 'vendor').map((b) => ({ lesson: l.id, block: b })),
)
const now = new Date()
const staleMonths = 6
const stale = vendorBlocks.filter(({ block }) => {
  if (block.type !== 'vendor') return false
  const [y, m] = block.snapshot.split('-').map(Number)
  const age = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m)
  return age > staleMonths
})

console.log('\nVENDOR CLAIMS (the only content expected to rot)')
console.log(`  ${vendorBlocks.length} vendor blocks, ${stale.length} older than ${staleMonths} months`)
for (const { lesson, block } of stale) {
  if (block.type === 'vendor') console.log(`    RECHECK ${lesson} — ${block.title} (${block.snapshot})`)
}

/* ------------------------------ takeaways ----------------------------- */

console.log('\nTAKEAWAYS (the real syllabus)')
for (const l of ALL_LESSONS) {
  console.log(`  ${l.id.padEnd(7)} ${l.takeaway.number.padEnd(14)} ${l.takeaway.claim.slice(0, 80)}`)
}

/* ------------------------------ outstanding --------------------------- */

const outstanding: string[] = []
if (authored < planned) outstanding.push(`${planned - authored} lessons unwritten`)
if (builtForge < FORGE_LABS.length) outstanding.push(`${FORGE_LABS.length - builtForge} forge lab crates unbuilt`)
if (builtDuckLabs < DUCK_LABS.length) outstanding.push(`${DUCK_LABS.length - builtDuckLabs} duckdb labs unbuilt`)
if (builtBrowserLabs < BROWSER_LABS.length)
  outstanding.push(`${BROWSER_LABS.length - builtBrowserLabs} browser labs unbuilt`)
if (builtDesks < DESKS.length) outstanding.push(`${DESKS.length - builtDesks} desk reference models unbuilt`)
if (!existsSync(join(ROOT, 'public/llms.txt'))) outstanding.push('agent surface (llms.txt) not generated')

console.log('\nOUTSTANDING')
if (outstanding.length === 0) console.log('  nothing — see PLAN.md for the next wave')
else for (const o of outstanding) console.log(`  · ${o}`)
console.log('')
