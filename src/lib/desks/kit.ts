/**
 * kit.ts — shared machinery for the columnspaces desks.
 *
 * Adapted from vectorspace's desk kit. Four things every desk needs and none
 * of them should reimplement:
 *
 *   1. UNITS, with the GB/GiB distinction made explicit rather than fudged.
 *      Storage is quoted in TB (10^12) by vendors and provisioned in TiB
 *      (2^40) by systems; consumption bills are quoted in TB scanned. The gap
 *      is ~10% at the TB/TiB level, which is exactly the size of the headroom
 *      people believe they have and do not.
 *
 *   2. BANDS. A sizing model is not "correct"; it is within tolerance and
 *      honestly caveated. Grading in bands rather than against one magic
 *      number is inherited from latentspace's recall bands for the same
 *      reason: a point value grades conformity to the reference
 *      implementation, not understanding.
 *
 *   3. A SEEDED RNG, bit-identical to the xorshift in every lab in this
 *      series, so any synthetic table or query stream is replayable and every
 *      learner sees the same numbers.
 *
 *   4. AMPLIFICATION, as a first-class concept. Columnar platforms are ruled
 *      by three ratios — read, write and metadata amplification — and a desk
 *      that cannot express them cannot grade a compaction policy.
 *
 * Cost is always a COUNT: bytes, files, partitions, row groups,
 * engineer-months. Never wall-clock. A count means the same thing on every
 * machine, which is what makes these gradeable and replayable.
 */

/* -------------------------------- units -------------------------------- */

export const KIB = 1024
export const MIB = 1024 * KIB
export const GIB = 1024 * MIB
export const TIB = 1024 * GIB
export const PIB = 1024 * TIB

export const KB = 1_000
export const MB = 1_000 * KB
export const GB = 1_000 * MB
export const TB = 1_000 * GB
export const PB = 1_000 * TB

export const toGiB = (bytes: number): number => bytes / GIB
export const toTiB = (bytes: number): number => bytes / TIB
export const toGB = (bytes: number): number => bytes / GB
export const toTB = (bytes: number): number => bytes / TB

/**
 * The overstatement you get by quoting a byte count in decimal TB when the
 * thing you must fit it into is sold in binary TiB. ~1.0995 at the TB/TiB
 * boundary — a "100 TB" table needs ~91 TiB, and a bill quoted per TB scanned
 * is counting decimal terabytes.
 */
export const TB_PER_TIB = TIB / TB

/** Format bytes for prose. Binary units, because that is what you provision. */
export function fmtBytes(bytes: number): string {
  const abs = Math.abs(bytes)
  if (abs >= PIB) return `${(bytes / PIB).toFixed(2)} PiB`
  if (abs >= TIB) return `${(bytes / TIB).toFixed(2)} TiB`
  if (abs >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`
  if (abs >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`
  if (abs >= KIB) return `${(bytes / KIB).toFixed(1)} KiB`
  return `${Math.round(bytes)} B`
}

/** Format a count of files/partitions/row groups with thousands separators. */
export const fmtCount = (n: number): string => Math.round(n).toLocaleString('en-US')

/* -------------------------------- bands -------------------------------- */

export interface Band {
  /** Inclusive lower bound. */
  lo: number
  /** Inclusive upper bound. */
  hi: number
}

/** A band of +/- `pct` percent around `centre`. */
export function bandAround(centre: number, pct: number): Band {
  const delta = Math.abs(centre) * (pct / 100)
  return { lo: centre - delta, hi: centre + delta }
}

export function inBand(value: number, band: Band): boolean {
  return value >= band.lo && value <= band.hi
}

export const fmtBand = (b: Band, digits = 1): string =>
  `${b.lo.toFixed(digits)}–${b.hi.toFixed(digits)}`

/**
 * A graded check. Deliberately the same shape as the forge labs' `Check`
 * (id, label, pass, msg) so a learner moving between the halves of the course
 * reads the identical output format.
 */
export interface Check {
  id: string
  label: string
  pass: boolean
  msg: string
}

export const pass = (id: string, label: string, msg: string): Check => ({ id, label, pass: true, msg })
export const fail = (id: string, label: string, msg: string): Check => ({ id, label, pass: false, msg })

export interface DeskReport {
  desk: string
  version: number
  checks: Check[]
}

export const allPassed = (r: DeskReport): boolean => r.checks.every((c) => c.pass)

/* --------------------------- amplification --------------------------- */

/**
 * The three ratios that govern a columnar platform. Kept in one place because
 * every desk in the architecture half ends up quoting at least one of them,
 * and because naming them makes the tradeoff sayable out loud: you cannot
 * reduce all three at once, and a policy that claims to is unmeasured.
 */
export interface Amplification {
  /** Bytes read to answer a query ÷ bytes of live data the answer needed. */
  read: number
  /** Bytes written to storage ÷ bytes of logical change. */
  write: number
  /** Metadata bytes touched to plan the query ÷ data bytes read. Small until it is not. */
  metadata: number
}

/* --------------------------------- rng --------------------------------- */

/**
 * xorshift64* — bit-identical to the generator in every lab in this series, so
 * a seeded table reproduces across courses. Not cryptographic; not for that.
 */
export class Rng {
  private s: bigint

  constructor(seed: number | bigint) {
    const v = BigInt(seed) & 0xffff_ffff_ffff_ffffn
    /* A zero state is absorbing for xorshift — reject it. */
    this.s = v === 0n ? 0x9e37_79b9_7f4a_7c15n : v
  }

  next(): bigint {
    let x = this.s
    x ^= x >> 12n
    x ^= (x << 25n) & 0xffff_ffff_ffff_ffffn
    x ^= x >> 27n
    this.s = x & 0xffff_ffff_ffff_ffffn
    return (this.s * 0x2545_f491_4f6c_dd1dn) & 0xffff_ffff_ffff_ffffn
  }

  /** Uniform in [0, n). */
  below(n: number): number {
    return Number(this.next() % BigInt(n))
  }

  /** Uniform in [lo, hi), from the top 24 bits — stable across platforms. */
  uniform(lo: number, hi: number): number {
    const bits = Number(this.next() >> 40n) /* 24 bits */
    return lo + (hi - lo) * (bits / (1 << 24))
  }

  /** Sum-of-12 approximation to a standard normal. Mean 0, variance 1. */
  gauss(): number {
    let s = 0
    for (let i = 0; i < 12; i++) s += Number(this.next() >> 40n) / (1 << 24)
    return s - 6
  }

  /**
   * A Zipf-ish draw in [1, max], exponent `s`. Used for partition sizes, tenant
   * sizes and join-key frequencies: real analytical data is brutally skewed,
   * and a uniform assumption is why capacity models and shuffle estimates come
   * in low.
   */
  zipfSize(max: number, s = 1.1): number {
    const u = Math.max(1e-9, this.uniform(0, 1))
    const v = Math.pow(u, -1 / s)
    return Math.max(1, Math.min(max, Math.round(v)))
  }
}

/* ------------------------------- helpers ------------------------------- */

export const ceilDiv = (a: number, b: number): number => Math.ceil(a / b)

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

export const round2 = (v: number): number => Math.round(v * 100) / 100

/**
 * Is point A at least as good as B on both axes, and strictly better on one?
 * Freshness is minimised, cost is minimised — so both axes are "lower is
 * better" here, unlike vectorspace's recall/cost frontier.
 */
export function dominates(a: { staleness: number; cost: number }, b: { staleness: number; cost: number }): boolean {
  const noWorse = a.staleness <= b.staleness && a.cost <= b.cost
  const strictlyBetter = a.staleness < b.staleness || a.cost < b.cost
  return noWorse && strictlyBetter
}

/** The non-dominated subset — the Pareto frontier, by (staleness down, cost down). */
export function paretoFrontier<T extends { staleness: number; cost: number }>(points: T[]): T[] {
  return points.filter((p) => !points.some((q) => dominates(q, p)))
}
