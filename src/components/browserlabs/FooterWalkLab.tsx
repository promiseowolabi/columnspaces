/**
 * FooterWalkLab — the C3 browser lab.
 *
 * C3.L1 takes a real Parquet footer apart and the `parquet-anatomy` duck lab
 * reads eight real files' own metadata back out of them. This lab is the rung
 * below both: a stepper over a MODELLED footer, level by level — file, row group,
 * column chunk, page — so that the shape of the thing, and what each level makes
 * possible, is in hand before the reader opens a real one.
 *
 * It models a footer. It does not parse one, and the panel at the bottom of the
 * page says so in those words and points at the duck lab for the measured
 * version. What it does carry is the structure and the two relationships C3 is
 * about, both of them computed rather than asserted:
 *
 *   1. THE ENTRY COUNT IS EXACTLY `row groups × leaf columns`. Not approximately
 *      — this is the format's grain, and it is graded as a numeric pick because
 *      "wide tables and small row groups are one problem, not two" is the whole
 *      consequence.
 *   2. THE FOOTER'S SHARE RISES AS ROW GROUPS SHRINK, monotonically along the
 *      whole axis, and there is a configuration in the space where the footer is
 *      LARGER than the data it describes. The reader has to find it.
 *
 * The stepper is the third teaching device: at each level the panel names what is
 * known, what is still unknown, and which decisions the level makes possible.
 * Statistics appear at exactly one level, and the graded pick asks which — because
 * "there are no file-level statistics in Parquet" is the fact that explains why
 * the entry grid is as large as it is.
 *
 * All arithmetic lives in `@/lib/footer/walk`, where the byte model is stated
 * once and itemised. Every number is a COUNT of bytes or entries, the modelled
 * schema comes from the seeded xorshift in `desks/kit`, and there is no
 * wall-clock and no `Math.random` anywhere beneath this file.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Columns3,
  Key,
  Layers,
  Ruler,
  X,
} from 'lucide-react'
/* LabShell comes from the registry module, which will import this component back
 * once the orchestrator wires it. The cycle is safe because both sides only touch
 * each other at RENDER time, and `LabTask` is a type-only import. */
import { LabShell } from '@/components/browserlabs'
import type { LabTask } from '@/components/browserlabs/shared'
import { fmtBytes, fmtCount } from '@/lib/desks/kit'
import {
  COLUMN_SETS,
  CONFIG_GRID,
  ENTRY_FIXED_BYTES,
  KEY_WIDTH_CHOICES,
  LEVEL_IDS,
  MEASURED,
  OPENING_CONFIG,
  PAGE_OFFSET_BYTES,
  ROWS,
  ROW_GROUP_CHOICES,
  SHARE_TARGET,
  columnSet,
  configKey,
  configsWhereFooterExceedsData,
  footerModel,
  footerShareSweep,
  rangeReads,
  schemaTree,
  statisticsLevel,
  type ColumnSetId,
  type FooterConfig,
  type LevelId,
} from '@/lib/footer/walk'
import { cn } from '@/lib/utils'

/** Rows per group read better as 8Ki than as 8,192 once there are six of them. */
const fmtRows = (n: number): string =>
  n >= 1024 * 1024 ? `${n / (1024 * 1024)}Mi` : n >= 1024 ? `${n / 1024}Ki` : `${n}`

/**
 * A share, at enough precision to stay honest at both ends. The narrow file's
 * footer is 0.025% of it, and rounding that to "0.0%" would delete the finding —
 * the whole point is that the same relationship runs from a rounding error to a
 * majority of the file.
 */
const fmtShare = (v: number): string =>
  v >= 0.01 ? `${(v * 100).toFixed(1)}%` : v >= 0.001 ? `${(v * 100).toFixed(2)}%` : `${(v * 100).toFixed(3)}%`

/** Three columns projected out of the set — the C0.L1 dashboard query's shape. */
const PROJECTED_COLUMNS = 3

export default function FooterWalkLab({ trackColor }: { trackColor: string }) {
  const [config, setConfig] = useState<FooterConfig>(OPENING_CONFIG)
  const [level, setLevel] = useState<number>(0)
  const [seen, setSeen] = useState<LevelId[]>([LEVEL_IDS[0]])
  const [statsPick, setStatsPick] = useState<LevelId | null>(null)
  const [pageBoundsPick, setPageBoundsPick] = useState<LevelId | null>(null)
  const [entryPick, setEntryPick] = useState<number | null>(null)
  const [shareSeen, setShareSeen] = useState(false)
  const [exceedSeen, setExceedSeen] = useState(false)

  const report = useMemo(() => footerModel(config), [config])
  const sweep = useMemo(() => footerShareSweep(config.columnSet, config.keyWidth), [config])
  const exceeding = useMemo(() => configsWhereFooterExceedsData(), [])
  const statsLevel = useMemo(() => statisticsLevel(), [])
  const schema = useMemo(() => schemaTree(config.columnSet), [config.columnSet])
  const current = report.levels[level]

  /* Every configuration priced latches what it demonstrated, so the task list is
   * a record of what was on screen rather than of an effect firing. */
  const choose = useCallback((patch: Partial<FooterConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch }
      const r = footerModel(next)
      if (r.footerShare >= SHARE_TARGET) setShareSeen(true)
      if (r.footerExceedsData) setExceedSeen(true)
      setEntryPick(null)
      return next
    })
  }, [])

  const goto = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(LEVEL_IDS.length - 1, index))
    setLevel(clamped)
    setSeen((prev) => (prev.includes(LEVEL_IDS[clamped]) ? prev : [...prev, LEVEL_IDS[clamped]]))
  }, [])

  /** The entry-count pick: the product, plus three distractors from the same two numbers. */
  const entryOptions = useMemo(() => {
    const p = report.metadataEntries
    const set = new Set<number>([p, p + report.columns, 2 * p, report.rowGroups + report.columns])
    return [...set].sort((a, b) => a - b)
  }, [report])

  const tasks: LabTask[] = useMemo(
    () => [
      {
        id: 'walk',
        label: 'Step through all four levels — file, row group, column chunk, page',
        done: seen.length === LEVEL_IDS.length,
        hint: 'Each level names what it knows, what it still cannot tell you, and which decisions it makes possible.',
      },
      {
        id: 'stats',
        label: 'Name the level where a scan finds its first statistic',
        done: statsPick === statsLevel,
        hint: 'Parquet defines no file-level statistics at all. A planner that wants a file-level bound has to fold something itself.',
      },
      {
        id: 'entries',
        label: 'Name the number of metadata entries in this file',
        done: entryPick !== null && entryPick === report.metadataEntries,
        hint: 'It is a product of two numbers you already have on screen. That it is a product, and not a sum, is the whole point.',
      },
      {
        id: 'page-bounds',
        label: 'Name the level whose per-value bounds this footer cannot give you',
        done: pageBoundsPick === 'page',
        hint: 'One level is visible only as offsets. Its headers live inline with the data, so the footer cannot even count them.',
      },
      {
        id: 'share',
        label: `Find a layout where the footer is at least ${fmtShare(SHARE_TARGET)} of the file`,
        done: shareSeen,
        hint: 'Two dials do it and they multiply: more columns and more row groups. A third — the width of the values each entry quotes — multiplies it again.',
      },
      {
        id: 'exceed',
        label: 'Find the layout where the footer is LARGER than the data it describes',
        done: exceedSeen,
        hint: `${exceeding.length} of the ${CONFIG_GRID.length} layouts in this space manage it. You need small row groups, many columns, and a wide value in every statistics entry.`,
      },
    ],
    [seen.length, statsPick, statsLevel, entryPick, report.metadataEntries, pageBoundsPick, shareSeen, exceedSeen, exceeding.length],
  )

  return (
    <LabShell labId="footer-walk" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        One file of {fmtCount(ROWS)} rows, and a footer to walk. A Parquet reader starts at the{' '}
        <strong>end</strong> of the file and works backwards: the last 8 bytes are the only positions
        it knows in advance, and two range reads later it knows everything the file is willing to say
        about itself. Step down the four levels and watch what becomes decidable at each one.
      </p>
      <p className="mt-2 rounded-md border border-amber-400/40 bg-amber-400/[0.05] px-3 py-2 text-body-sm text-text-2">
        <strong>This lab models a footer; it does not parse one.</strong> The structure and the
        arithmetic are real, the byte constants are a teaching model — TCompactProtocol makes every
        integer variable-length, so there are no fixed field sizes to quote. For the measured version,
        the <span className="font-mono text-[11.5px]">parquet-anatomy</span> duck lab writes eight real
        Parquet files and reads every number back out of the files’ own metadata.
      </p>

      {/* ------------------------- the opening sequence ----------------------- */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
          the opening sequence — {report.openingRangeReads} ranges before a single value is decoded
        </p>
        <ol className="mt-2 space-y-1 font-mono text-[11px] text-text-2">
          <li>1 · read [file_len − 8, file_len) → the 4-byte footer length, then “PAR1”</li>
          <li>
            2 · seek to file_len − 8 − footer_len and read {fmtCount(report.footerBytes)} B → the whole
            FileMetaData
          </li>
          <li>
            3+ · one contiguous range per projected column per surviving row group ={' '}
            {fmtCount(
              rangeReads(report, PROJECTED_COLUMNS, Math.max(1, Math.round(report.rowGroups / 8))),
            )}{' '}
            ranges at {PROJECTED_COLUMNS} columns projected and one row group in eight surviving
          </li>
        </ol>
        <p className="mt-2 text-body-sm text-text-3">
          That is the entire reason columnar storage works over object storage: a scan is priced and
          planned from a few kilobytes at the end of a file, and only then are the ranges it decided on
          fetched. A production reader usually fetches a speculative tail in ONE request instead of
          two, trading wasted bytes for a saved round trip — which this model does not do, and forge
          lab 04 does not either.
        </p>
      </div>

      {/* -------------------------------- knobs ------------------------------- */}
      <div className="mt-5 space-y-3">
        <Knob
          icon={<Layers size={13} />}
          label="row groups"
          note={`${fmtRows(report.rowsPerGroup)} rows per group · ${fmtCount(report.rowGroups)} groups · ${fmtCount(report.metadataEntries)} chunk entries`}
        >
          {ROW_GROUP_CHOICES.map((rg) => (
            <Chip
              key={rg}
              active={config.rowGroups === rg}
              color={trackColor}
              onClick={() => choose({ rowGroups: rg })}
            >
              {rg} × {fmtRows(ROWS / rg)}
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<Columns3 size={13} />}
          label="leaf columns"
          note={columnSet(config.columnSet).line}
        >
          {COLUMN_SETS.map((s) => (
            <Chip
              key={s.id}
              active={config.columnSet === s.id}
              color={trackColor}
              onClick={() => choose({ columnSet: s.id as ColumnSetId })}
            >
              {s.label}
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<Key size={13} />}
          label="min/max value width"
          note={`every entry quotes the actual minimum and maximum VALUES · ${ENTRY_FIXED_BYTES} + 2 × ${config.keyWidth} = ${fmtCount(report.entryBytes)} B per entry`}
        >
          {KEY_WIDTH_CHOICES.map((w) => (
            <Chip
              key={w}
              active={config.keyWidth === w}
              color={trackColor}
              onClick={() => choose({ keyWidth: w })}
            >
              {w} B
            </Chip>
          ))}
        </Knob>
      </div>

      {/* ------------------------------- the stepper -------------------------- */}
      <div className="mt-6">
        <div className="flex flex-wrap items-center gap-1.5">
          {report.levels.map((l, i) => (
            <button
              key={l.id}
              type="button"
              onClick={() => goto(i)}
              aria-pressed={i === level}
              className={cn(
                'rounded-sm border px-2.5 py-1 font-mono text-[11.5px] transition-colors',
                i === level ? 'text-text-1' : 'border-line text-text-3 hover:text-text-2',
              )}
              style={i === level ? { borderColor: trackColor, backgroundColor: `${trackColor}1a` } : undefined}
            >
              {seen.includes(l.id) && <Check size={10} className="mr-1 inline text-accent" />}
              {i}. {l.name}
            </button>
          ))}
          <span className="ml-auto flex gap-1.5">
            <button
              type="button"
              onClick={() => goto(level - 1)}
              className="rounded-sm border border-line px-2 py-1 font-mono text-[11px] text-text-3 hover:text-text-1"
              aria-label="previous level"
            >
              <ArrowLeft size={11} />
            </button>
            <button
              type="button"
              onClick={() => goto(level + 1)}
              className="rounded-sm border border-line px-2 py-1 font-mono text-[11px] text-text-3 hover:text-text-1"
              aria-label="next level"
            >
              <ArrowRight size={11} />
            </button>
          </span>
        </div>

        <div className="mt-3 rounded-md border border-line px-4 py-3">
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[13px] text-text-1">
              level {current.index} — {current.name}
            </span>
            <span className="font-mono text-[10.5px] text-text-3">{current.physically}</span>
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Fact
              label="how many at this level"
              value={fmtCount(current.entities)}
              note={current.entityLabel}
            />
            <Fact
              label="footer bytes here"
              value={fmtBytes(current.bytesHere)}
              note={
                current.id === 'page'
                  ? `nothing extra — the page level is the ${PAGE_OFFSET_BYTES} bytes of offsets already inside every chunk entry`
                  : `${fmtShare(current.shareOfFooter)} of the footer`
              }
            />
            <Fact
              label="statistics here"
              value={current.hasStatistics ? 'min · max · null_count' : 'none'}
              note={
                current.hasStatistics
                  ? 'the first and only statistics the footer carries'
                  : 'nothing this level tells you can prune a predicate'
              }
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Column title="what is known here" tone="known">
              {current.known.map((k) => (
                <li key={k}>· {k}</li>
              ))}
            </Column>
            <Column title="what is still unknown" tone="unknown">
              {current.unknown.map((k) => (
                <li key={k}>· {k}</li>
              ))}
            </Column>
            <Column title="what this level makes decidable" tone="decisions">
              {current.decisions.map((k) => (
                <li key={k}>· {k}</li>
              ))}
            </Column>
          </div>

          {current.id === 'file' && (
            <div className="mt-4">
              <p className="font-mono text-[10px] uppercase tracking-wide text-text-3">
                the schema tree — {fmtCount(report.columns)} leaf columns, modelled
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {schema.map((leaf) => (
                  <span
                    key={leaf.name}
                    className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] text-text-3"
                  >
                    {leaf.name} <span className="opacity-60">{leaf.type}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* -------------------------------- the counts -------------------------- */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="metadata entries"
          value={fmtCount(report.metadataEntries)}
          sub={`${fmtCount(report.rowGroups)} row groups × ${fmtCount(report.columns)} leaf columns — exactly, in every configuration`}
          color={trackColor}
        />
        <Metric
          label="footer bytes"
          value={fmtBytes(report.footerBytes)}
          sub={`96 file fields + 48 × ${report.columns} schema + 24 × ${report.rowGroups} groups + ${fmtCount(report.metadataEntries)} × ${report.entryBytes} entries`}
        />
        <Metric
          label="footer share of file"
          value={fmtShare(report.footerShare)}
          sub={`${fmtBytes(report.footerBytes)} of description against ${fmtBytes(report.dataBytes)} of data`}
          color={report.footerShare >= SHARE_TARGET ? '#FB7185' : undefined}
        />
        <Metric
          label="description per row"
          value={`${report.footerBytesPerRow.toFixed(2)} B`}
          sub={
            report.footerExceedsData
              ? 'the footer is LARGER than the data it describes — the file is mostly about itself'
              : `the data side is ${(report.dataBytes / report.footerBytes).toFixed(1)}× the footer`
          }
          color={report.footerExceedsData ? '#FB7185' : undefined}
        />
      </div>

      {/* -------------------------------- the sweep --------------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <Ruler size={12} /> the footer share as row groups shrink — {columnSet(config.columnSet).label},{' '}
          {config.keyWidth} B values
        </p>
        <table className="mt-3 w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              {['row groups', 'rows per group', 'entries', 'footer', 'share of file'].map((h) => (
                <th key={h} className="py-1.5 pr-3 font-mono text-[10px] uppercase tracking-wide text-text-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sweep.map((p) => {
              const here = p.rowGroups === report.rowGroups
              return (
                <tr key={p.rowGroups} className={cn('border-b border-line/60', here && 'bg-surface-2/60')}>
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-text-2">
                    <button
                      type="button"
                      onClick={() => choose({ rowGroups: p.rowGroups })}
                      className="hover:underline"
                      style={here ? { color: trackColor } : undefined}
                    >
                      {p.rowGroups}
                    </button>
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-text-3">{fmtRows(p.rowsPerGroup)}</td>
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-text-3">{fmtCount(p.metadataEntries)}</td>
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-text-3">{fmtBytes(p.footerBytes)}</td>
                  <td
                    className="py-1.5 pr-3 font-mono text-[11px]"
                    style={{ color: p.footerShare >= SHARE_TARGET ? '#FB7185' : undefined }}
                  >
                    {fmtShare(p.footerShare)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="mt-2 text-body-sm text-text-3">
          The share rises down every column of this table, always, because the data side is fixed and
          each extra row group adds a row-group struct plus {fmtCount(report.columns)} more entries.
          For comparison, the parquet-anatomy duck lab MEASURED{' '}
          {MEASURED.filter((m) => m.share !== undefined)
            .map((m) => `${fmtShare(m.share as number)} for ${m.label}`)
            .join(' and ')}{' '}
          on real files, and {MEASURED[2].entryBytes} B per entry for its{' '}
          {MEASURED[2].label.toLowerCase()} against {MEASURED[0].entryBytes} B for the reference —
          this model’s constants are chosen to land near those, and the gap between a model and a
          measurement is exactly why that lab exists.
        </p>
      </div>

      {/* ------------------------------- the picks ---------------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="text-body-sm text-text-2">
          At which level does a scan find its <strong>first statistic</strong> — the min/max that lets
          it skip something unread?
        </p>
        <LevelPicks picked={statsPick} correct={statsLevel} onPick={setStatsPick} trackColor={trackColor} />
        <p className="mt-2 text-body-sm text-text-3">
          There are <strong>no file-level statistics in Parquet</strong> — the format defines none. A
          planner that wants to ask “could this file match?” must fold the per-chunk entries itself,
          which is both why the entries exist and why there are {fmtCount(report.metadataEntries)} of
          them here. The fold is work the planner does per file, not a value it reads, and its result
          is a bound rather than a value that exists in the file.
        </p>
      </div>

      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="text-body-sm text-text-2">
          And which level does this footer see <strong>only as offsets</strong>, with no bounds at all?
        </p>
        <LevelPicks
          picked={pageBoundsPick}
          correct="page"
          onPick={setPageBoundsPick}
          trackColor={trackColor}
        />
        <p className="mt-2 text-body-sm text-text-3">
          Page headers are serialised inline with the data, so the footer cannot tell you how many
          pages a chunk holds or what any one of them contains. Exactly one page-level byte count is
          derivable: where a dictionary page exists,{' '}
          <span className="font-mono text-[11px]">data_page_offset − dictionary_page_offset</span> is
          that page’s exact size. Per-page bounds live in the optional ColumnIndex/OffsetIndex
          structures, which this model does not carry — so it reports their absence rather than
          inventing page statistics.
        </p>
      </div>

      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="text-body-sm text-text-2">
          How many statistics entries does <strong>this</strong> file carry?
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {entryOptions.map((n) => (
            <Chip key={n} active={entryPick === n} color={trackColor} onClick={() => setEntryPick(n)}>
              {fmtCount(n)}
            </Chip>
          ))}
        </div>
        {entryPick !== null && (
          <p
            className={cn(
              'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
              entryPick === report.metadataEntries ? 'text-accent' : 'text-rose-400',
            )}
          >
            {entryPick === report.metadataEntries ? <Check size={12} /> : <X size={12} />}
            {entryPick === report.metadataEntries
              ? `correct — ${fmtCount(report.rowGroups)} × ${fmtCount(report.columns)} = ${fmtCount(report.metadataEntries)}, at ${report.entryBytes} B each`
              : `not ${fmtCount(entryPick)} — the grain is one entry per column per row group, so it is a product`}
          </p>
        )}
        <p className="mt-2 text-body-sm text-text-3">
          Because it is a product, the two dials multiply: {report.columns} columns at{' '}
          {fmtRows(report.rowsPerGroup)} rows per group is {fmtCount(report.metadataEntries)} entries,
          against 4 × 1 = 4 for a four-column file written in a single row group. Wide tables and
          small files are one problem, not two — and both roads to that corner are ordinary: streaming
          ingest that lands small files, and event tables that accumulate low-cardinality columns
          whose data side compresses to almost nothing while the entry grid keeps growing.
        </p>
      </div>

      {/* -------------------------------- honesty ----------------------------- */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <AlertTriangle size={12} /> what this lab is not
        </p>
        <ul className="mt-2 space-y-1.5 text-body-sm text-text-3">
          <li>
            <strong className="text-text-2">It models a footer; it does not parse one.</strong> No
            bytes are read, no Thrift is decoded, and no file exists. The four levels, the entry grain
            and the opening sequence are the format’s; the byte constants are this lab’s, chosen so
            the four-column single-row-group case lands near the{' '}
            {fmtShare(MEASURED[0].share as number)} the duck lab measured. Where a real file disagrees, the
            real file is right.
          </li>
          <li>
            <strong className="text-text-2">The data side is held constant along the row-group
            axis.</strong> That isolates the footer term, which is what makes the sweep readable — but
            a real file written in small row groups also compresses slightly worse, so the real share
            rises a little faster than the footer term alone would suggest, not slower.
          </li>
          <li>
            <strong className="text-text-2">There are no fixed field sizes in Parquet.</strong> Every
            integer in the footer is serialised with TCompactProtocol, which is variable-length —
            which is also why footer parsing is not a matter of fixed offsets, and why you cannot skip
            a field you do not understand without decoding it. Any per-entry byte count, including
            this lab’s {report.entryBytes} B, is an average rather than a size.
          </li>
          <li>
            <strong className="text-text-2">Optional structures are missing on purpose.</strong> Real
            footers may carry ColumnIndex and OffsetIndex (per-page bounds), bloom filter offsets, key
            value metadata, and an encrypted-footer mode. Every field of{' '}
            <span className="font-mono text-[11px]">Statistics</span> is optional too, and the page
            checksum is optional — C3.L2 is entirely about what that optionality costs you.
          </li>
          <li>
            <strong className="text-text-2">For the measured version, open the duck lab.</strong>{' '}
            <span className="font-mono text-[11px]">parquet-anatomy</span> writes eight real Parquet
            files from the same {fmtCount(ROWS)} rows, reads every number back out of the files’ own
            metadata, checks the folded chunk statistics against the truth read from the data, and
            mutates real bytes to print DuckDB’s own error text. That is the rung above this one, and
            this lab exists to make its output legible.
          </li>
        </ul>
      </div>

      <p className="mt-5 flex items-center gap-1.5 font-mono text-[10.5px] text-text-3">
        <FileText size={11} />
        layout {configKey(config)} · {fmtCount(CONFIG_GRID.length)} in the space · {exceeding.length}{' '}
        with a footer larger than its data · counts only, no clock
      </p>
    </LabShell>
  )
}

/* ------------------------------- fragments ------------------------------ */

function LevelPicks({
  picked,
  correct,
  onPick,
  trackColor,
}: {
  picked: LevelId | null
  correct: LevelId
  onPick: (id: LevelId) => void
  trackColor: string
}) {
  const right = picked !== null && picked === correct
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {LEVEL_IDS.map((id) => (
          <Chip key={id} active={picked === id} color={trackColor} onClick={() => onPick(id)}>
            {id}
          </Chip>
        ))}
      </div>
      {picked !== null && (
        <p
          className={cn(
            'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
            right ? 'text-accent' : 'text-rose-400',
          )}
        >
          {right ? <Check size={12} /> : <X size={12} />}
          {right ? 'correct' : `not ${picked} — step to that level and read what it knows`}
        </p>
      )}
    </>
  )
}

function Column({
  title,
  tone,
  children,
}: {
  title: string
  tone: 'known' | 'unknown' | 'decisions'
  children: ReactNode
}) {
  return (
    <div>
      <p
        className={cn(
          'font-mono text-[10px] uppercase tracking-wide',
          tone === 'unknown' ? 'text-rose-400' : tone === 'decisions' ? 'text-accent' : 'text-text-3',
        )}
      >
        {title}
      </p>
      <ul className="mt-1.5 space-y-1 text-body-sm text-text-3">{children}</ul>
    </div>
  )
}

function Knob({
  icon,
  label,
  note,
  children,
}: {
  icon: ReactNode
  label: string
  note: string
  children: ReactNode
}) {
  return (
    <div className="rounded-md border border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-text-3">
          {icon}
          {label}
        </span>
        <span className="font-mono text-[10.5px] text-text-3">{note}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">{children}</div>
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

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-sm border border-line px-2.5 py-1.5">
      <p className="font-mono text-[10px] uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-0.5 font-mono text-[12px] text-text-1">{value}</p>
      {note && <p className="mt-0.5 text-[10px] leading-snug text-text-3">{note}</p>}
    </div>
  )
}

function Metric({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub: string
  color?: string
}) {
  return (
    <div className="rounded-md border border-line px-3 py-2.5">
      <p className="font-mono text-[10px] uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-1 font-mono text-[15px]" style={{ color: color ?? undefined }}>
        {value}
      </p>
      <p className="mt-1 text-[10.5px] leading-snug text-text-3">{sub}</p>
    </div>
  )
}
