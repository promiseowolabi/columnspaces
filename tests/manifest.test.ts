/**
 * Manifest freshness.
 *
 * src/data/lessons/manifest.ts is GENERATED from the lesson registry and
 * committed, which is the same rot-prone combination as the agent surface: add a
 * lesson, forget the generator, and the curriculum silently omits it while the
 * lesson page still works.
 *
 * The split exists because importing all 54 lessons costs ~1.7 MB, and the list
 * pages need only metadata. That saving is only real while the two stay in sync.
 *
 * Fix when this fails:  npx tsx scripts/gen-manifest.ts
 */

import { describe, expect, it } from 'vitest'
import { ALL_LESSONS } from '@/data/lessons'
import {
  LESSON_META,
  ORDERED_LESSON_IDS,
  TOTAL_LESSON_COUNT,
  lessonMeta,
  metaForTrack,
  nextMeta,
  prevMeta,
  takeaways,
} from '@/data/lessons/manifest'

const FIX = 'run: npx tsx scripts/gen-manifest.ts'

describe('generated lesson manifest', () => {
  it('covers every registered lesson, in curriculum order', () => {
    expect(LESSON_META.map((m) => m.id), FIX).toEqual(ALL_LESSONS.map((l) => l.id))
    expect(TOTAL_LESSON_COUNT).toBe(ALL_LESSONS.length)
    expect(ORDERED_LESSON_IDS).toEqual(ALL_LESSONS.map((l) => l.id))
  })

  it('every metadata field matches the lesson it describes', () => {
    for (const l of ALL_LESSONS) {
      const m = lessonMeta(l.id)
      expect(m, `${l.id} missing from the manifest — ${FIX}`).toBeDefined()
      expect(m!.slug, `${l.id} slug`).toBe(l.slug)
      expect(m!.trackId, `${l.id} trackId`).toBe(l.trackId)
      expect(m!.index, `${l.id} index`).toBe(l.index)
      expect(m!.title, `${l.id} title`).toBe(l.title)
      expect(m!.minutes, `${l.id} minutes`).toBe(l.minutes)
      expect(m!.hook, `${l.id} hook`).toBe(l.hook)
      expect(m!.exercise, `${l.id} exercise`).toBe(l.exercise)
      expect(m!.takeaway, `${l.id} takeaway`).toEqual(l.takeaway)
      expect(m!.simId, `${l.id} simId`).toBe(l.simId)
      expect(m!.artifact, `${l.id} artifact`).toBe(l.artifact)
    }
  })

  it('the block-kind census is accurate', () => {
    for (const l of ALL_LESSONS) {
      const expected = [...new Set(l.blocks.map((b) => b.type))].sort()
      expect(lessonMeta(l.id)!.blockKinds, `${l.id} blockKinds — ${FIX}`).toEqual(expected)
    }
  })

  it('resolves by slug as well as id', () => {
    for (const l of ALL_LESSONS) expect(lessonMeta(l.slug)?.id).toBe(l.id)
  })

  it('metaForTrack matches the registry per track', () => {
    const tracks = [...new Set(ALL_LESSONS.map((l) => l.trackId))]
    for (const t of tracks) {
      expect(metaForTrack(t).map((m) => m.id)).toEqual(
        ALL_LESSONS.filter((l) => l.trackId === t).map((l) => l.id),
      )
    }
  })

  it('next/prev cross track boundaries and terminate', () => {
    const first = LESSON_META[0]
    const last = LESSON_META[LESSON_META.length - 1]
    expect(prevMeta(first)).toBeUndefined()
    expect(nextMeta(last)).toBeUndefined()
    expect(nextMeta(first)?.id).toBe(LESSON_META[1].id)
  })

  it('takeaways() is the syllabus, one entry per lesson', () => {
    const t = takeaways()
    expect(t).toHaveLength(ALL_LESSONS.length)
    for (const row of t) expect(row.number, `${row.id} takeaway number`).toMatch(/\d/)
  })

  /**
   * The point of the split: the manifest module must not reach the lesson files.
   * If it ever imports them, the 1.7 MB corpus rides along and /curriculum pays
   * for it again.
   */
  it('does not import any lesson file', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/data/lessons/manifest.ts', import.meta.url).pathname, 'utf8')
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    expect(imports, 'manifest.ts may only import types').toEqual(['./types'])
    expect(src.startsWith('/**\n * GENERATED FILE')).toBe(true)
  })
})
