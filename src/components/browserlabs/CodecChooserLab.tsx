/**
 * CodecChooserLab — the C1 browser lab.
 *
 * Forge lab 01 has the reader implement four codecs and a chooser in Rust and
 * grades them against a pinned tape measure. This lab is the rung below it: seven
 * columns described by the three properties a reader can actually see in a schema
 * review — cardinality, ordering, range — a codec to pick for each, and then the
 * SAME byte formulas forge lab 01 grades, applied to all five candidates so the
 * pick can be checked rather than defended.
 *
 * Three structural decisions carry the teaching, and none of them is a paragraph:
 *
 *   1. THE ALL-DISTINCT COLUMN IS IN THE SET, and on it every codec loses. The
 *      dictionary EXPANDS the column by half again — a table of every value plus
 *      a 4-byte code per row — and frame-of-reference loses by exactly the 8
 *      bytes its base costs. Plain wins, and the reader has to pick it. The
 *      fallback is the lesson; every real format has one.
 *   2. TWO COLUMNS SHARE A CARDINALITY AND A RANGE AND DIFFER ONLY IN ORDERING,
 *      and they want different codecs. So "six distinct values → dictionary" is
 *      shown to be the wrong SHAPE of rule. The properties narrow the candidates;
 *      the arithmetic picks.
 *   3. ONE COLUMN IS BARRED FROM BOTH PACKED CODECS BY A NULL, at one row in
 *      twelve. It is graded as its own question, because "why is this column not
 *      bit-packed" is a real review question with a one-word answer.
 *
 * All arithmetic lives in `@/lib/codec/chooser`, which transcribes the formulas
 * from `labs/encodings/src/encodings.rs` rather than re-deriving them, and the
 * test suite checks them against hand-computed cases. Values are `bigint`,
 * because the interesting column's spread does not fit in i64. Every number is a
 * COUNT of bytes; the columns come from the seeded xorshift in `desks/kit`; there
 * is no wall-clock and no `Math.random` anywhere beneath this file.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Ban, Check, Ruler, ScanText, Shapes, X } from 'lucide-react'
/* LabShell comes from the registry module, which will import this component back
 * once the orchestrator wires it. The cycle is safe because both sides only touch
 * each other at RENDER time, and `LabTask` is a type-only import. */
import { LabShell } from '@/components/browserlabs'
import type { LabTask } from '@/components/browserlabs/shared'
import { fmtBytes, fmtCount } from '@/lib/desks/kit'
import {
  CODEC_EXPLOITS,
  CODEC_FORMULA,
  CODEC_IDS,
  CODEC_LABEL,
  COLUMNS,
  COLUMN_ROWS,
  HEADER,
  columnProfile,
  columnSpec,
  expandingDictColumns,
  nullBarredColumns,
  orderingPair,
  plainWinsColumns,
  priceOf,
  totals,
  type CodecId,
  type ColumnId,
} from '@/lib/codec/chooser'
import { cn } from '@/lib/utils'

const fmtBig = (v: bigint | null): string => (v === null ? '—' : v.toLocaleString('en-US'))

export default function CodecChooserLab({ trackColor }: { trackColor: string }) {
  const [active, setActive] = useState<ColumnId>('region_clustered')
  const [picks, setPicks] = useState<Partial<Record<ColumnId, CodecId>>>({})
  const [barredPick, setBarredPick] = useState<ColumnId | null>(null)
  const [fallbackPick, setFallbackPick] = useState<CodecId | null>(null)

  const spec = columnSpec(active)
  const profile = useMemo(() => columnProfile(active), [active])
  const pair = useMemo(() => orderingPair(), [])
  const barred = useMemo(() => nullBarredColumns(), [])
  const expanding = useMemo(() => expandingDictColumns(), [])
  const plainWins = useMemo(() => plainWinsColumns(), [])
  const sums = useMemo(() => totals(), [])

  const pick = useCallback((codec: CodecId) => {
    setPicks((prev) => ({ ...prev, [active]: codec }))
  }, [active])

  /** A pick is right when it names the smallest applicable candidate. */
  const rightFor = useCallback(
    (id: ColumnId): boolean => picks[id] === columnProfile(id).optimal.codec,
    [picks],
  )

  const correctCount = useMemo(() => COLUMNS.filter((c) => rightFor(c.id)).length, [rightFor])

  /* What the reader's picks would actually cost, against what the optimal picks
   * cost. Unpicked columns are charged at plain: doing nothing is a decision. */
  const chosenBytes = useMemo(
    () =>
      COLUMNS.reduce((n, c) => {
        const p = columnProfile(c.id)
        const picked = picks[c.id]
        if (!picked) return n + p.plainBytes
        const price = priceOf(p, picked)
        /* An inapplicable pick is charged as the fallback, which is what a real
         * writer does when a codec refuses the column. */
        return n + (price.bytes ?? p.plainBytes)
      }, 0),
    [picks],
  )

  const pickedOverPlain = useMemo(
    () =>
      COLUMNS.some((c) => {
        const p = columnProfile(c.id)
        const picked = picks[c.id]
        if (!picked) return false
        const bytes = priceOf(p, picked).bytes
        return bytes !== null && bytes > p.plainBytes
      }),
    [picks],
  )

  const tasks: LabTask[] = useMemo(
    () => [
      {
        id: 'all-seven',
        label: `Name the smallest codec for all ${COLUMNS.length} columns`,
        done: correctCount === COLUMNS.length,
        hint: `${correctCount} of ${COLUMNS.length} so far. The properties narrow the candidates; the arithmetic picks — and the arithmetic is printed for every candidate.`,
      },
      {
        id: 'fallback',
        label: 'Find the column where EVERY codec loses to plain, and pick plain',
        done: plainWins.every((id) => picks[id] === 'plain'),
        hint: 'One column is all-distinct over the full 64-bit range. A dictionary of every value plus a code per row is larger than the values were; the frame costs 8 bytes and buys nothing when the spread is the whole range.',
      },
      {
        id: 'ordering',
        label: 'Pick correctly for BOTH region columns — same cardinality, same range, different ordering',
        done: rightFor(pair.a) && rightFor(pair.b),
        hint: 'Same six values, same three bits. One table was written region by region and the other in arrival order, and that alone changes which codec wins.',
      },
      {
        id: 'nulls',
        label: 'Name the column that a null bars from BOTH packed codecs',
        done: barredPick !== null && barred.includes(barredPick),
        hint: 'A packed bit stream has nowhere to put a null. One row in twelve is enough to take bit-packing and frame-of-reference off the table entirely.',
      },
      {
        id: 'bound',
        label: 'Name the one codec that is a candidate for every column, on every column',
        done: fallbackPick === 'plain',
        hint: 'It is the reason the chosen encoding can never be larger than the plain column — forge lab 01 grades exactly that bound as `never_expands`.',
      },
    ],
    [correctCount, plainWins, picks, rightFor, pair, barredPick, barred, fallbackPick],
  )

  return (
    <LabShell labId="codec-chooser" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        Seven columns of {fmtCount(COLUMN_ROWS)} values, each described the way a schema review
        describes one: <strong>cardinality, ordering, range</strong>. Pick the encoding for each — then
        read what every candidate would have cost, in bytes, using the same formulas{' '}
        <span className="font-mono text-[11.5px] text-text-1">labs/encodings</span> grades in Rust.
      </p>
      <p className="mt-2 text-body-sm text-text-3">
        The measure is pinned and given, not negotiated: {HEADER} bytes of framing per encoding, then
        the arithmetic in the table below. Every candidate’s working is printed, so any number here can
        be checked with a pencil. Nothing is timed and nothing is compressed twice — this is the
        encoding layer only, before any block compressor sees the bytes.
      </p>

      {/* ------------------------------ the columns --------------------------- */}
      <div className="mt-5 overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              {['column', 'cardinality', 'ordering', 'range', 'nulls', 'your pick', 'bytes'].map((h) => (
                <th
                  key={h}
                  className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wide text-text-3"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COLUMNS.map((c) => {
              const p = columnProfile(c.id)
              const picked = picks[c.id]
              const right = picked === p.optimal.codec
              const isActive = c.id === active
              return (
                <tr
                  key={c.id}
                  className={cn('border-b border-line/60 align-top', isActive && 'bg-surface-2/60')}
                >
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      onClick={() => setActive(c.id)}
                      aria-pressed={isActive}
                      className="text-left font-mono text-[11.5px] text-text-1 hover:underline"
                      style={isActive ? { color: trackColor } : undefined}
                    >
                      {c.name}
                    </button>
                  </td>
                  <td className="py-2 pr-3 font-mono text-[10.5px] text-text-3">{c.cardinality}</td>
                  <td className="py-2 pr-3 font-mono text-[10.5px] text-text-3">{c.ordering}</td>
                  <td className="py-2 pr-3 font-mono text-[10.5px] text-text-3">{c.range}</td>
                  <td className="py-2 pr-3 font-mono text-[10.5px] text-text-3">{c.nulls}</td>
                  <td className="py-2 pr-3 font-mono text-[11px]">
                    {picked ? (
                      <span className={right ? 'text-accent' : 'text-rose-400'}>
                        {right ? <Check size={10} className="mr-1 inline" /> : <X size={10} className="mr-1 inline" />}
                        {CODEC_LABEL[picked]}
                      </span>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-text-2">
                    {fmtCount(p.optimal.bytes as number)}
                    <span className="block text-[10px] text-text-3">
                      of {fmtCount(p.plainBytes)} plain
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* --------------------------- the active column ------------------------ */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3">
            <ScanText size={12} /> {spec.name}
          </span>
          <span className="font-mono text-[10.5px] text-text-3">{spec.origin}</span>
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="rows" value={fmtCount(profile.rows)} />
          <Fact label="distinct" value={fmtCount(profile.distinct)} note="NULL counts as one" />
          <Fact label="runs" value={fmtCount(profile.runs)} note="maximal runs" />
          <Fact label="nulls" value={fmtCount(profile.nullCount)} />
          <Fact
            label="spread"
            value={profile.spread === null ? '—' : fmtBig(profile.spread)}
            note={`min ${fmtBig(profile.min)} · max ${fmtBig(profile.max)}`}
          />
          <Fact
            label="widths"
            value={`${profile.bitpackWidth ?? '—'} / ${profile.forWidth ?? '—'} bits`}
            note="bit-pack / frame-of-reference"
          />
        </div>
      </div>

      {/* ------------------------------ the candidates ------------------------ */}
      <div className="mt-5">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <Ruler size={12} /> every candidate, priced — pick one
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CODEC_IDS.map((id) => {
            const price = priceOf(profile, id)
            const isBest = profile.optimal.codec === id
            const isPicked = picks[active] === id
            const expands = price.bytes !== null && price.bytes > profile.plainBytes
            return (
              <button
                key={id}
                type="button"
                onClick={() => pick(id)}
                aria-pressed={isPicked}
                disabled={!price.applicable}
                className={cn(
                  'rounded-md border px-3 py-2.5 text-left transition-colors',
                  !price.applicable && 'cursor-not-allowed opacity-60',
                  expands ? 'border-rose-400/40 bg-rose-400/[0.04]' : 'border-line',
                  isPicked && 'ring-1',
                )}
                style={
                  isPicked
                    ? { borderColor: trackColor, backgroundColor: `${trackColor}0d` }
                    : undefined
                }
              >
                <p className="flex items-center justify-between font-mono text-[11.5px] text-text-1">
                  <span>{CODEC_LABEL[id]}</span>
                  {isPicked && <Check size={11} style={{ color: trackColor }} />}
                </p>
                <p className="mt-1 font-mono text-[15px] text-text-1">
                  {price.bytes === null ? (
                    <span className="flex items-center gap-1 text-[12px] text-text-3">
                      <Ban size={11} /> not applicable
                    </span>
                  ) : (
                    fmtBytes(price.bytes)
                  )}
                </p>
                <p className="mt-1 font-mono text-[10px] leading-snug text-text-3">{price.working}</p>
                <p className="mt-1 font-mono text-[10px] text-text-3">{CODEC_FORMULA[id]}</p>
                <p className="mt-1.5 text-[10.5px] leading-snug text-text-3">{CODEC_EXPLOITS[id]}</p>
                {price.vsPlain !== null && (
                  <p
                    className={cn(
                      'mt-1.5 font-mono text-[10.5px]',
                      expands ? 'text-rose-400' : 'text-text-3',
                    )}
                  >
                    {expands
                      ? `EXPANDS the column: ${price.vsPlain.toFixed(2)}× plain`
                      : `${(1 / price.vsPlain).toFixed(price.vsPlain < 0.01 ? 0 : 2)}× smaller than plain`}
                    {isBest && <span className="ml-1 uppercase" style={{ color: trackColor }}>· smallest</span>}
                  </p>
                )}
              </button>
            )
          })}
        </div>
        {picks[active] && (
          <p
            className={cn(
              'mt-3 flex items-center gap-1.5 font-mono text-[11.5px]',
              rightFor(active) ? 'text-accent' : 'text-rose-400',
            )}
          >
            {rightFor(active) ? <Check size={12} /> : <X size={12} />}
            {rightFor(active)
              ? `correct — ${CODEC_LABEL[profile.optimal.codec]} at ${fmtCount(profile.optimal.bytes as number)} B, saving ${fmtCount(profile.savedBytes)} B against plain`
              : `${CODEC_LABEL[picks[active] as CodecId]} costs ${fmtCount(
                  (priceOf(profile, picks[active] as CodecId).bytes ?? profile.plainBytes) -
                    (profile.optimal.bytes as number),
                )} B more than the smallest candidate on this column`}
          </p>
        )}
      </div>

      {/* -------------------------- the ordering pair ------------------------- */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <Shapes size={12} /> the same column, twice
        </p>
        <p className="mt-2 text-body-sm text-text-2">
          <span className="font-mono text-[11.5px] text-text-1">{columnSpec(pair.a).name}</span> and{' '}
          <span className="font-mono text-[11.5px] text-text-1">{columnSpec(pair.b).name}</span> hold
          the same six values in the same three-bit range —{' '}
          {pair.sameCardinality ? 'identical cardinality' : 'different cardinality'}, identical range.
          One table was written region by region; the other in arrival order. The clustered one
          encodes to{' '}
          <strong>{fmtCount(columnProfile(pair.a).optimal.bytes as number)} B</strong> as{' '}
          {CODEC_LABEL[columnProfile(pair.a).optimal.codec]} ({fmtCount(columnProfile(pair.a).runs)}{' '}
          runs); the shuffled one to{' '}
          <strong>{fmtCount(columnProfile(pair.b).optimal.bytes as number)} B</strong> as{' '}
          {CODEC_LABEL[columnProfile(pair.b).optimal.codec]} ({fmtCount(columnProfile(pair.b).runs)}{' '}
          runs).{' '}
          {pair.differentCodec
            ? 'Different codecs, from the same properties minus one — which is why "low cardinality → dictionary" is the wrong shape of rule.'
            : 'They currently agree, which would make this panel pointless — the test suite fails if that ever happens.'}{' '}
          Physical order is a layout decision (C2) that shows up as a compression bill (C1), and the
          two are the same decision seen from different ends.
        </p>
      </div>

      {/* ----------------------------- the null bar --------------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="text-body-sm text-text-2">
          Which column is barred from <strong>both</strong> packed codecs by its nulls?
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {COLUMNS.map((c) => (
            <Chip
              key={c.id}
              active={barredPick === c.id}
              color={trackColor}
              onClick={() => setBarredPick(c.id)}
            >
              {c.name}
            </Chip>
          ))}
        </div>
        {barredPick !== null && (
          <p
            className={cn(
              'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
              barred.includes(barredPick) ? 'text-accent' : 'text-rose-400',
            )}
          >
            {barred.includes(barredPick) ? <Check size={12} /> : <X size={12} />}
            {barred.includes(barredPick)
              ? `correct — ${fmtCount(columnProfile(barredPick).nullCount)} nulls in ${fmtCount(COLUMN_ROWS)} rows, and a packed bit stream has nowhere to put one`
              : `not ${columnSpec(barredPick).name} — check its null count, and check whether the packed codecs are offered on it at all`}
          </p>
        )}
        <p className="mt-2 text-body-sm text-text-3">
          This is why Parquet carries definition levels beside the data rather than inside it: nulls
          are kept out of the packed stream, and the validity information is a separate, cheaper
          structure. The all-null column here is the extreme — it is one run, {fmtCount(HEADER + 12)}{' '}
          bytes for {fmtCount(COLUMN_ROWS)} rows, and its plain encoding pays a validity bitmap for
          every row of nothing.
        </p>
      </div>

      {/* ------------------------------- the bound ---------------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="text-body-sm text-text-2">
          Which codec is a candidate on <strong>every</strong> column, whatever its properties?
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CODEC_IDS.map((id) => (
            <Chip
              key={id}
              active={fallbackPick === id}
              color={trackColor}
              onClick={() => setFallbackPick(id)}
            >
              {CODEC_LABEL[id]}
            </Chip>
          ))}
        </div>
        {fallbackPick !== null && (
          <p
            className={cn(
              'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
              fallbackPick === 'plain' ? 'text-accent' : 'text-rose-400',
            )}
          >
            {fallbackPick === 'plain' ? <Check size={12} /> : <X size={12} />}
            {fallbackPick === 'plain'
              ? 'correct — and because it is always a candidate, the chosen encoding can never be larger than the plain column'
              : `${CODEC_LABEL[fallbackPick]} refuses at least one of these seven columns. Look for the "not applicable" cards.`}
          </p>
        )}
        <p className="mt-2 text-body-sm text-text-3">
          The columns where the dictionary is <em>larger</em> than the column it replaces:{' '}
          <span className="font-mono text-[11px] text-text-1">
            {expanding.map((id) => columnSpec(id).name).join(', ')}
          </span>
          . On{' '}
          <span className="font-mono text-[11px] text-text-1">
            {plainWins.map((id) => columnSpec(id).name).join(', ')}
          </span>{' '}
          every codec loses and the fallback is the answer — the frame-of-reference candidate loses by
          exactly 8 bytes, which is what its base costs. Parquet falls back to plain pages and ORC to
          direct encoding for the same reason: “compressed” is a claim you check.
        </p>
      </div>

      {/* ------------------------------ the totals ---------------------------- */}
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Gauge
          label="your seven picks"
          value={fmtBytes(chosenBytes)}
          ok={chosenBytes === sums.optimal}
          note={
            chosenBytes === sums.optimal
              ? 'the smallest total available from these five candidates'
              : `${fmtBytes(chosenBytes - sums.optimal)} more than the optimal set; unpicked columns are charged at plain, because doing nothing is a decision`
          }
        />
        <Gauge
          label="optimal, all seven"
          value={fmtBytes(sums.optimal)}
          ok
          note={`${sums.ratio.toFixed(2)}× smaller than ${fmtBytes(sums.plain)} of plain columns`}
        />
        <Gauge
          label="never larger than plain"
          value={pickedOverPlain ? 'a pick exceeds plain' : 'bound holds'}
          ok={!pickedOverPlain}
          note={
            pickedOverPlain
              ? 'one of your picks is larger than the plain column it replaces — a real writer would fall back instead'
              : 'no pick you have made is larger than the plain column it replaces'
          }
        />
      </div>

      {/* ------------------------------- honesty ------------------------------ */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <AlertTriangle size={12} /> what this lab is not
        </p>
        <ul className="mt-2 space-y-1.5 text-body-sm text-text-3">
          <li>
            <strong className="text-text-2">No codec runs here.</strong> This lab SIZES the five
            candidates with the pinned formulas; it does not encode, decode or round-trip anything.
            Forge lab 01 is where you implement all four codecs plus the chooser in Rust and where
            2,000 seeded columns are checked byte-exact through
            <span className="font-mono text-[11px]"> decode(encode(c)) == c</span>. A codec that
            cannot round-trip is data loss, not a slow path — and that is the check this lab cannot
            make for you.
          </li>
          <li>
            <strong className="text-text-2">These are encoding bytes, not file bytes.</strong> A real
            format applies a block compressor (Snappy, ZSTD) on top of the encoded page, and the two
            interact: an encoding that removes redundancy can leave the compressor with less to find,
            so the sum is not the product of the two ratios. The{' '}
            <span className="font-mono text-[11px]">codec-bench</span> duck lab measures the combined
            result on real files.
          </li>
          <li>
            <strong className="text-text-2">Cardinality, ordering and range are not the whole
            story.</strong> A real writer decides per PAGE, not per column, so one column can be
            dictionary-encoded at the start of a file and plain at the end once the dictionary
            exceeds its size limit. Dictionaries are per block, which is why joining on codes across
            blocks is unsafe (C4). And the sort key’s own statistics get quoted in every footer entry,
            which is C3’s subject.
          </li>
          <li>
            <strong className="text-text-2">The five candidates are forge lab 01’s five.</strong> Real
            formats have more — delta-binary-packed, byte-stream-split, delta-length byte arrays, and
            RLE-with-bit-packing hybrids. The four here are the four ideas the others are built out
            of, and the chooser’s shape — price every applicable candidate, take the smallest, keep a
            fallback — is what every real writer does.
          </li>
        </ul>
      </div>

      <p className="mt-5 font-mono text-[10.5px] text-text-3">
        {COLUMNS.length} columns · {fmtCount(COLUMN_ROWS)} values each · {correctCount} of{' '}
        {COLUMNS.length} named · formulas transcribed from labs/encodings/src/encodings.rs · counts
        only, no clock
      </p>
    </LabShell>
  )
}

/* ------------------------------- fragments ------------------------------ */

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-sm border border-line px-2.5 py-1.5">
      <p className="font-mono text-[10px] uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-0.5 font-mono text-[12px] text-text-1">{value}</p>
      {note && <p className="mt-0.5 font-mono text-[9.5px] leading-snug text-text-3">{note}</p>}
    </div>
  )
}

function Chip({
  active,
  color,
  onClick,
  children,
}: {
  active: boolean
  color: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-sm border px-2.5 py-1 font-mono text-[11.5px] transition-colors',
        active ? 'text-text-1' : 'border-line text-text-3 hover:text-text-2',
      )}
      style={active ? { borderColor: color, backgroundColor: `${color}1a` } : undefined}
    >
      {children}
    </button>
  )
}

function Gauge({
  label,
  value,
  ok,
  note,
}: {
  label: string
  value: string
  ok: boolean
  note: string
}) {
  return (
    <div
      className={cn(
        'rounded-sm border px-3 py-2',
        ok ? 'border-accent/50 bg-accent/[0.06]' : 'border-line',
      )}
    >
      <p className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wide text-text-3">
        {ok ? (
          <Check size={11} className="text-accent" />
        ) : (
          <AlertTriangle size={11} className="text-rose-400" />
        )}
        {label}
      </p>
      <p className={cn('mt-1 font-mono text-[12px]', ok ? 'text-accent' : 'text-text-1')}>{value}</p>
      <p className="mt-1 font-mono text-[10px] leading-snug text-text-3">{note}</p>
    </div>
  )
}
