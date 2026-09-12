/**
 * chooser.ts — the model behind the C1 browser lab, `codec-chooser`.
 *
 * Forge lab 01 (`labs/encodings`) has the reader implement four codecs and a
 * chooser in Rust, and grades them against a pinned tape measure. This file is
 * the same tape measure, in TypeScript, applied to columns described by the
 * three properties a reader can actually see in a schema review — cardinality,
 * ordering, range — so the choice can be made and then PRICED before anyone
 * opens a toolchain.
 *
 * The formulas are not re-derived here. They are transcribed from
 * `labs/encodings/src/encodings.rs`, where they are given rather than graded,
 * and from the independent second copy in that lab's harness (`src/lib.rs`):
 *
 *     HEADER  = 8                                     framing, every codec pays it
 *     Plain   = 8 + 8n + ⌈n/8⌉ when a null is present
 *     Dict    = 8 + 8·distinct + 4·n                  (NULL is one of the distinct values)
 *     Rle     = 8 + 12·runs                           (8 value + 4 count, maximal runs)
 *     BitPack = 8 + 8·⌈n·w/64⌉                        no nulls, values in 0..=u32::MAX
 *     For     = 8 + 8 + 8·⌈n·w/64⌉                    no nulls; the extra 8 is the base
 *
 * A reader who works this lab and then works forge lab 01 must see the same
 * numbers, so the tests assert the formulas against hand-computed cases rather
 * than against this file's own output.
 *
 * Two structural decisions carry the teaching:
 *
 *   1. THE ALL-DISTINCT COLUMN IS IN THE SET, and on it the dictionary EXPANDS:
 *      a table of every value PLUS a 4-byte code per row is 1.5× the plain
 *      column. Frame-of-reference loses too, by exactly the 8 bytes its base
 *      costs, because a full-range column has a full-range spread. Plain wins,
 *      and the fallback is the lesson — every real format has one.
 *   2. TWO COLUMNS SHARE A CARDINALITY AND A RANGE AND DIFFER ONLY IN ORDERING,
 *      and they want different codecs. So "6 distinct values → dictionary" is
 *      shown to be the wrong shape of rule: the property that decides is not
 *      cardinality alone, and the arithmetic is what decides.
 *
 * Values are `bigint`, not `number`. That is deliberate: the interesting case is
 * a column whose spread does not fit in i64, and `wrapping_sub` on u64 is the
 * only subtraction that survives it — exactly as the Rust lab says. Doing it in
 * doubles would quietly round the one column the lesson is about.
 *
 * Deterministic throughout: columns come from the seeded xorshift in
 * `desks/kit`, are built once and memoised. No wall-clock, no `Math.random`.
 */

import { Rng } from '@/lib/desks/kit'

/* ------------------------------ the measure ----------------------------- */

/** Framing bytes every encoding pays: one tag plus its counts. */
export const HEADER = 8

const U64 = (1n << 64n) - 1n
const U32_MAX = 0xffff_ffffn
const I64_SIGN = 1n << 63n

/** A column cell: an i64 value, or NULL — which is a *value* here, not a flag. */
export type Cell = bigint | null

export type CodecId = 'plain' | 'dict' | 'rle' | 'bitpack' | 'for'

/** The five candidates, in the order forge lab 01 lists them. */
export const CODEC_IDS: CodecId[] = ['plain', 'dict', 'rle', 'bitpack', 'for']

export const CODEC_LABEL: Record<CodecId, string> = {
  plain: 'Plain',
  dict: 'Dict',
  rle: 'Rle',
  bitpack: 'BitPack',
  for: 'For',
}

export const CODEC_FORMULA: Record<CodecId, string> = {
  plain: '8 + 8n + ⌈n/8⌉ if any null',
  dict: '8 + 8·distinct + 4·n',
  rle: '8 + 12·runs',
  bitpack: '8 + 8·⌈n·w/64⌉',
  for: '8 + 8 + 8·⌈n·w/64⌉',
}

export const CODEC_EXPLOITS: Record<CodecId, string> = {
  plain: 'nothing — the honest baseline and the mandatory fallback',
  dict: 'few DISTINCT values: a value table plus one 4-byte code per row',
  rle: 'values CLUSTERED into runs: one (value, count) pair per run',
  bitpack: 'a narrow RANGE: w bits per value instead of 64',
  for: 'a narrow SPREAD at a high base: the base once, then small deltas',
}

export const hasNull = (values: Cell[]): boolean => values.some((v) => v === null)

/** One validity bit per value, and only when the column actually contains a null. */
export const bitmapBytes = (values: Cell[]): number =>
  hasNull(values) ? Math.ceil(values.length / 8) : 0

export const plainSize = (values: Cell[]): number =>
  HEADER + 8 * values.length + bitmapBytes(values)

/** NULL counts as one of the distinct values, exactly as in the Rust lab. */
export function distinctCount(values: Cell[]): number {
  const seen = new Set<string>()
  for (const v of values) seen.add(v === null ? 'null' : v.toString())
  return seen.size
}

export const dictSize = (values: Cell[]): number =>
  HEADER + 8 * distinctCount(values) + 4 * values.length

/** MAXIMAL runs: no two adjacent runs hold equal values, so this is a canonical count. */
export function runCount(values: Cell[]): number {
  let runs = 0
  let prev: Cell | undefined
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (i === 0 || v !== prev) runs += 1
    prev = v
  }
  return runs
}

export const rleSize = (values: Cell[]): number => HEADER + 12 * runCount(values)

/** The smallest w with max < 2^w, clamped to at least 1. `bitsNeeded(0) === 1`. */
export function bitsNeeded(max: bigint): number {
  if (max <= 0n) return 1
  let bits = 0
  let v = max
  while (v > 0n) {
    bits += 1
    v >>= 1n
  }
  return bits
}

/** Words a contiguous `width`-bit stream of n values occupies — a ceiling divide. */
export const packedWords = (n: number, width: number): number => Math.ceil((n * width) / 64)

const asUnsigned = (v: bigint): bigint => v & U64
const isI64Negative = (v: bigint): boolean => (asUnsigned(v) & I64_SIGN) !== 0n

/**
 * The bit-packing codec's declared domain is unsigned 32-bit, and nulls have
 * nowhere to live in a packed stream. Outside that, it returns null: a codec
 * that cannot represent the data says so rather than truncating it.
 */
export function bitpackWidth(values: Cell[]): number | null {
  if (hasNull(values)) return null
  let max = 0n
  for (const v of values) {
    const x = v as bigint
    if (isI64Negative(x) || x > U32_MAX) return null
    if (x > max) max = x
  }
  return bitsNeeded(max)
}

export function bitpackSize(values: Cell[]): number | null {
  const width = bitpackWidth(values)
  if (width === null) return null
  return HEADER + 8 * packedWords(values.length, width)
}

/**
 * Frame-of-reference: base is the column MINIMUM and the deltas are unsigned.
 * `(v as u64).wrapping_sub(base as u64)` is the true distance for every pair of
 * i64 in existence — including a column holding both i64::MIN and i64::MAX,
 * whose span does not fit in i64 at all.
 */
export function forFrame(values: Cell[]): { base: bigint; width: number } | null {
  if (hasNull(values)) return null
  if (values.length === 0) return { base: 0n, width: 1 }
  let base = values[0] as bigint
  for (const v of values) if ((v as bigint) < base) base = v as bigint
  let maxDelta = 0n
  for (const v of values) {
    const d = (asUnsigned(v as bigint) - asUnsigned(base)) & U64
    if (d > maxDelta) maxDelta = d
  }
  return { base, width: bitsNeeded(maxDelta) }
}

export function forSize(values: Cell[]): number | null {
  const frame = forFrame(values)
  if (!frame) return null
  return HEADER + 8 + 8 * packedWords(values.length, frame.width)
}

/* ------------------------------ the chooser ----------------------------- */

export interface CodecPrice {
  codec: CodecId
  /** null when the codec cannot represent this column at all. */
  bytes: number | null
  /** The arithmetic, filled in — what the reader would write on paper. */
  working: string
  /** Ratio against plain. > 1 means this codec EXPANDS the column. */
  vsPlain: number | null
  applicable: boolean
}

export function priceAll(values: Cell[]): CodecPrice[] {
  const n = values.length
  const plain = plainSize(values)
  const distinct = distinctCount(values)
  const runs = runCount(values)
  const bw = bitpackWidth(values)
  const frame = forFrame(values)

  const price = (codec: CodecId, bytes: number | null, working: string): CodecPrice => ({
    codec,
    bytes,
    working,
    vsPlain: bytes === null ? null : bytes / plain,
    applicable: bytes !== null,
  })

  return [
    price('plain', plain, `8 + 8·${n}${bitmapBytes(values) > 0 ? ` + ⌈${n}/8⌉` : ''} = ${plain}`),
    price('dict', dictSize(values), `8 + 8·${distinct} + 4·${n} = ${dictSize(values)}`),
    price('rle', rleSize(values), `8 + 12·${runs} = ${rleSize(values)}`),
    price(
      'bitpack',
      bitpackSize(values),
      bw === null
        ? hasNull(values)
          ? 'refused: a packed stream has nowhere to put a null'
          : 'refused: a value outside 0..=u32::MAX'
        : `8 + 8·⌈${n}·${bw}/64⌉ = 8 + 8·${packedWords(n, bw)} = ${bitpackSize(values)}`,
    ),
    price(
      'for',
      forSize(values),
      frame === null
        ? 'refused: a packed stream has nowhere to put a null'
        : `8 + 8 + 8·⌈${n}·${frame.width}/64⌉ = 8 + 8 + 8·${packedWords(n, frame.width)} = ${forSize(values)}`,
    ),
  ]
}

/**
 * The chooser: the smallest applicable candidate. Plain is always applicable,
 * which is the whole content of forge lab 01's `never_expands` bound — the
 * chosen encoding can never exceed `plainSize`. Ties break in CODEC_IDS order.
 */
export function optimalCodec(values: Cell[]): CodecPrice {
  const prices = priceAll(values)
  return prices
    .filter((p) => p.bytes !== null)
    .reduce((best, cur) => ((cur.bytes as number) < (best.bytes as number) ? cur : best))
}

/* ------------------------------- the columns ---------------------------- */

export type ColumnId =
  | 'region_clustered'
  | 'region_shuffled'
  | 'event_type'
  | 'order_ts'
  | 'order_id'
  | 'is_refunded'
  | 'deleted_at'

/** Rows per column. 4,096 is forge lab 01's own storm size, so the numbers line up. */
export const COLUMN_ROWS = 4_096

export type Ordering = 'clustered' | 'unordered' | 'monotone'

export interface ColumnSpec {
  id: ColumnId
  name: string
  /** The three properties a reader can see in a schema review, stated first. */
  cardinality: string
  ordering: Ordering
  range: string
  nulls: string
  /** Where a column of this shape comes from in a real table. */
  origin: string
  seed: number
}

export const COLUMNS: ColumnSpec[] = [
  {
    id: 'region_clustered',
    name: 'region',
    cardinality: '6 distinct',
    ordering: 'clustered',
    range: 'narrow — codes 0..5',
    nulls: 'none',
    origin: 'a table written region by region, so equal values arrive together',
    seed: 0x5eed_0001,
  },
  {
    id: 'region_shuffled',
    name: 'region (same column, unsorted table)',
    cardinality: '6 distinct',
    ordering: 'unordered',
    range: 'narrow — codes 0..5',
    nulls: 'none',
    origin: 'the identical column in a table written in arrival order',
    seed: 0x5eed_0002,
  },
  {
    id: 'event_type',
    name: 'event_type',
    cardinality: '24 distinct',
    ordering: 'unordered',
    range: 'wide and negative — spread over 2.4M, based below zero',
    nulls: 'roughly 1 row in 12',
    origin: 'an enum stored as a hashed id, with nulls where the producer omitted the field',
    seed: 0x5eed_0003,
  },
  {
    id: 'order_ts',
    name: 'order_ts',
    cardinality: 'almost all distinct',
    ordering: 'monotone',
    range: 'huge values, tiny spread — ~1.7e12 base, ~120k apart',
    nulls: 'none',
    origin: 'an append-only fact table’s event timestamp, in milliseconds',
    seed: 0x5eed_0004,
  },
  {
    id: 'order_id',
    name: 'order_id',
    cardinality: 'all distinct',
    ordering: 'unordered',
    range: 'full 64-bit',
    nulls: 'none',
    origin: 'a random unique id — the column every codec loses on',
    seed: 0x5eed_0005,
  },
  {
    id: 'is_refunded',
    name: 'is_refunded',
    cardinality: '2 distinct',
    ordering: 'unordered',
    range: 'narrow — 0 or 1',
    nulls: 'none',
    origin: 'a flag column, and there are eleven more like it in the same table',
    seed: 0x5eed_0006,
  },
  {
    id: 'deleted_at',
    name: 'deleted_at',
    cardinality: '1 distinct (NULL)',
    ordering: 'clustered',
    range: 'no values at all',
    nulls: 'every row',
    origin: 'a soft-delete column on a table nothing has been deleted from yet',
    seed: 0x5eed_0007,
  },
]

export const columnSpec = (id: ColumnId): ColumnSpec => {
  const spec = COLUMNS.find((c) => c.id === id)
  if (!spec) throw new Error(`codec-chooser: no column ${id}`)
  return spec
}

/* ----------------------------- the generators --------------------------- */
/* One per shape, all seeded, all mirroring a generator in forge lab 01's    */
/* harness so a reader who works both sees columns of the same character.    */

function genRegionClustered(rng: Rng, n: number): Cell[] {
  const out: Cell[] = []
  while (out.length < n) {
    const v = BigInt(rng.below(6))
    const len = Math.min(1 + rng.below(200), n - out.length)
    for (let i = 0; i < len; i++) out.push(v)
  }
  return out
}

function genRegionShuffled(rng: Rng, n: number): Cell[] {
  const out: Cell[] = []
  for (let i = 0; i < n; i++) out.push(BigInt(rng.below(6)))
  return out
}

function genEventType(rng: Rng, n: number): Cell[] {
  const out: Cell[] = []
  for (let i = 0; i < n; i++) {
    if (rng.below(12) === 0) {
      out.push(null)
      continue
    }
    const k = BigInt(rng.below(24))
    out.push(k * 104_729n - 50_000_000_000n)
  }
  return out
}

function genOrderTs(rng: Rng, n: number): Cell[] {
  let t = 1_700_000_000_000n + BigInt(rng.below(1 << 20))
  const out: Cell[] = []
  for (let i = 0; i < n; i++) {
    t += BigInt(rng.below(60))
    out.push(t)
  }
  return out
}

/** Full-range i64: `rng.next()` is a u64, read as two's-complement i64. */
function genOrderId(rng: Rng, n: number): Cell[] {
  const out: Cell[] = []
  const seen = new Set<string>()
  while (out.length < n) {
    const u = rng.next()
    const v = u >= I64_SIGN ? u - (1n << 64n) : u
    const k = v.toString()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

function genFlags(rng: Rng, n: number): Cell[] {
  const out: Cell[] = []
  for (let i = 0; i < n; i++) out.push(BigInt(rng.below(2)))
  return out
}

const genAllNull = (n: number): Cell[] => new Array<Cell>(n).fill(null)

const GENERATORS: Record<ColumnId, (rng: Rng, n: number) => Cell[]> = {
  region_clustered: genRegionClustered,
  region_shuffled: genRegionShuffled,
  event_type: genEventType,
  order_ts: genOrderTs,
  order_id: genOrderId,
  is_refunded: genFlags,
  deleted_at: (_rng, n) => genAllNull(n),
}

const valueCache = new Map<ColumnId, Cell[]>()

/** The column itself. Built once per id, from that column's own seed. */
export function columnValues(id: ColumnId): Cell[] {
  const cached = valueCache.get(id)
  if (cached) return cached
  const spec = columnSpec(id)
  const built = GENERATORS[id](new Rng(spec.seed), COLUMN_ROWS)
  valueCache.set(id, built)
  return built
}

/* ------------------------------ the profile ----------------------------- */

export interface ColumnProfile {
  id: ColumnId
  rows: number
  distinct: number
  runs: number
  nullCount: number
  min: bigint | null
  max: bigint | null
  /** max − min as an unsigned distance, or null for a column with no values. */
  spread: bigint | null
  /** The width frame-of-reference would use, or null when it cannot apply. */
  forWidth: number | null
  /** The width bit-packing would use, or null when the column is outside its domain. */
  bitpackWidth: number | null
  prices: CodecPrice[]
  optimal: CodecPrice
  plainBytes: number
  /** Bytes saved against plain by the optimal choice. Never negative. */
  savedBytes: number
}

const profileCache = new Map<ColumnId, ColumnProfile>()

export function columnProfile(id: ColumnId): ColumnProfile {
  const cached = profileCache.get(id)
  if (cached) return cached

  const values = columnValues(id)
  const present = values.filter((v): v is bigint => v !== null)
  const frame = forFrame(values)
  const min = present.length === 0 ? null : present.reduce((a, b) => (b < a ? b : a))
  const max = present.length === 0 ? null : present.reduce((a, b) => (b > a ? b : a))
  const prices = priceAll(values)
  const best = optimalCodec(values)
  const plainBytes = plainSize(values)

  const profile: ColumnProfile = {
    id,
    rows: values.length,
    distinct: distinctCount(values),
    runs: runCount(values),
    nullCount: values.filter((v) => v === null).length,
    min,
    max,
    spread:
      min === null || max === null ? null : (asUnsigned(max) - asUnsigned(min)) & U64,
    forWidth: frame === null ? null : frame.width,
    bitpackWidth: bitpackWidth(values),
    prices,
    optimal: best,
    plainBytes,
    savedBytes: plainBytes - (best.bytes as number),
  }
  profileCache.set(id, profile)
  return profile
}

export const priceOf = (profile: ColumnProfile, codec: CodecId): CodecPrice => {
  const p = profile.prices.find((x) => x.codec === codec)
  if (!p) throw new Error(`codec-chooser: no price for ${codec}`)
  return p
}

/* ------------------------------ the findings ---------------------------- */

/** Columns where the dictionary is LARGER than the plain column it replaces. */
export const expandingDictColumns = (): ColumnId[] =>
  COLUMNS.filter((c) => {
    const p = columnProfile(c.id)
    return (priceOf(p, 'dict').bytes as number) > p.plainBytes
  }).map((c) => c.id)

/** Columns on which Plain wins outright — the fallback doing its job. */
export const plainWinsColumns = (): ColumnId[] =>
  COLUMNS.filter((c) => columnProfile(c.id).optimal.codec === 'plain').map((c) => c.id)

/** Columns barred from the packed codecs by a null. */
export const nullBarredColumns = (): ColumnId[] =>
  COLUMNS.filter((c) => columnProfile(c.id).bitpackWidth === null && hasNull(columnValues(c.id))).map(
    (c) => c.id,
  )

/**
 * The pair with the same cardinality and range, differing only in ordering —
 * and wanting different codecs. Computed rather than asserted, so it cannot
 * quietly stop being true.
 */
export function orderingPair(): { a: ColumnId; b: ColumnId; sameCardinality: boolean; differentCodec: boolean } {
  const a = columnProfile('region_clustered')
  const b = columnProfile('region_shuffled')
  return {
    a: a.id,
    b: b.id,
    sameCardinality: a.distinct === b.distinct,
    differentCodec: a.optimal.codec !== b.optimal.codec,
  }
}

/** Total bytes over all seven columns, plain against optimally encoded. */
export function totals(): { plain: number; optimal: number; ratio: number } {
  const plain = COLUMNS.reduce((n, c) => n + columnProfile(c.id).plainBytes, 0)
  const optimal = COLUMNS.reduce((n, c) => n + (columnProfile(c.id).optimal.bytes as number), 0)
  return { plain, optimal, ratio: plain / optimal }
}
