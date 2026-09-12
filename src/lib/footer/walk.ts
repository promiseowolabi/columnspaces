/**
 * walk.ts — the model behind the C3 browser lab, `footer-walk`.
 *
 * C3.L1 takes a real Parquet footer apart and the `parquet-anatomy` duck lab
 * reads eight real files' metadata back out of the files themselves. This lab is
 * the rung below both: a MODELLED footer the reader steps through level by
 * level, so the shape of the thing — and the arithmetic of what it costs — is in
 * hand before they read a real one.
 *
 * It is a model. It parses nothing, it writes nothing, and it is not a Parquet
 * reader; the UI says so in its own panel and points at the duck lab for the
 * measured version. What it does carry is the format's structure and the two
 * relationships C3 is about:
 *
 *   1. THE ENTRY COUNT IS EXACTLY `row groups × leaf columns`. Not
 *      approximately — this is the format's grain rather than a measurement,
 *      and it is why wide tables and small row groups are one problem and not
 *      two. 33 columns at 2,048 rows per group is 33 × 64 = 2,112 statistics
 *      entries in one file, against 4 × 1 = 4 for a four-column file written in
 *      a single row group.
 *   2. THE FOOTER'S SHARE OF THE FILE RISES AS ROW GROUPS SHRINK, monotonically,
 *      and stops being a rounding error. And a second, independent driver:
 *      every entry quotes the actual minimum and maximum VALUES, so a wide sort
 *      key multiplies every entry in the file.
 *
 * The byte model, stated once so every number on the page can be redone:
 *
 *     entry bytes   = 63 + 2·keyWidth
 *                     63 = 24 (three page offsets) + 8 (file offset)
 *                        + 8 (compressed size) + 8 (uncompressed size)
 *                        + 8 (num_values) + 4 (null_count) + 3 (codec, encodings)
 *     footer bytes  = 96 (file header fields) + 48·columns (schema elements)
 *                   + 24·rowGroups (row-group structs) + entries·entryBytes
 *     file bytes    = 4 (leading PAR1) + data + footer + 8 (length + trailing PAR1)
 *
 * Those constants are the model's, not the format's — TCompactProtocol makes
 * every integer variable-length, so there are no fixed sizes to quote. They are
 * chosen so the four-column single-row-group case lands on the 0.02% the duck
 * lab measured, and the wide small-row-group case lands near its 16.36%. Where
 * the model and the measurement differ, the lab prints both.
 *
 * Deterministic and count-only throughout: the modelled schema comes from the
 * seeded xorshift in `desks/kit`, and there is no wall-clock and no
 * `Math.random` anywhere beneath this file.
 */

import { Rng } from '@/lib/desks/kit'

/* ------------------------------ the constants --------------------------- */

/** The same row count the parquet-anatomy duck lab writes, so the two compare. */
export const ROWS = 131_072

/** Leading `PAR1`. */
export const LEADING_MAGIC_BYTES = 4
/** The 4-byte little-endian footer length plus the trailing `PAR1`. */
export const TRAILER_BYTES = 8

/** File-level fields: created_by, num_rows, num_row_groups, format version, key/value metadata. */
export const FOOTER_FIXED_BYTES = 96
/** One schema element per leaf column: name, type, repetition, converted type. */
export const SCHEMA_BYTES_PER_COLUMN = 48
/** One RowGroup struct: num_rows, total_byte_size, ordinal, file offset. */
export const ROW_GROUP_STRUCT_BYTES = 24

/**
 * The fixed part of a column-chunk entry, itemised so it is checkable:
 * 24 (dictionary_page_offset, data_page_offset, index_page_offset)
 *  + 8 (file_offset) + 8 (total_compressed_size) + 8 (total_uncompressed_size)
 *  + 8 (num_values) + 4 (null_count) + 3 (codec + encodings tags) = 63.
 */
export const ENTRY_FIXED_BYTES = 63
/** The three page offsets inside every entry — the entire page level, as seen from the footer. */
export const PAGE_OFFSET_BYTES = 24

/** Row-group counts. 128 groups of 1,024 rows is what unbatched streaming ingest produces. */
export const ROW_GROUP_CHOICES = [1, 2, 8, 16, 64, 128]

/**
 * The width of the min/max values a statistics entry quotes. An int64 key is 8
 * bytes and the model rounds it up to 12 for the short-string case the duck lab
 * measured; 160 is the long natural key that lab writes on purpose.
 */
export const KEY_WIDTH_CHOICES = [12, 40, 160]

export type ColumnSetId = 'narrow' | 'reference' | 'wide'

export interface ColumnSetSpec {
  id: ColumnSetId
  label: string
  columns: number
  /**
   * Encoded bytes per value, as a count of bytes per value — the data side of
   * the file. Wide event tables are mostly low-cardinality enums, which encode
   * to a fraction of a byte per value, which is exactly why their footers
   * dominate.
   */
  bytesPerValue: number
  line: string
}

export const COLUMN_SETS: ColumnSetSpec[] = [
  {
    id: 'narrow',
    label: '4 columns',
    columns: 4,
    bytesPerValue: 5,
    line: 'a timestamp, an id, a region and a measure — high entropy, so the data side is heavy',
  },
  {
    id: 'reference',
    label: '12 columns',
    columns: 12,
    bytesPerValue: 3,
    line: 'the named schema of an ordinary fact table',
  },
  {
    id: 'wide',
    label: '33 columns',
    columns: 33,
    bytesPerValue: 0.25,
    line: 'a wide event table of low-cardinality enums — the data encodes to almost nothing',
  },
]

export const columnSet = (id: ColumnSetId): ColumnSetSpec => {
  const spec = COLUMN_SETS.find((c) => c.id === id)
  if (!spec) throw new Error(`footer-walk: no column set ${id}`)
  return spec
}

/* -------------------------------- the levels ---------------------------- */

export type LevelId = 'file' | 'row-group' | 'column-chunk' | 'page'

export const LEVEL_IDS: LevelId[] = ['file', 'row-group', 'column-chunk', 'page']

export interface LevelSpec {
  id: LevelId
  index: number
  name: string
  physically: string
  known: string[]
  unknown: string[]
  decisions: string[]
  /** Does this level carry a min/max/null-count triple? Exactly one level does. */
  hasStatistics: boolean
}

export const LEVEL_SPECS: LevelSpec[] = [
  {
    id: 'file',
    index: 0,
    name: 'file',
    physically: 'PAR1 · column chunks · FileMetaData · 4-byte length · PAR1',
    known: [
      'num_rows — the row count, for the whole file',
      'num_row_groups — how many horizontal slices there are',
      'the schema tree, so which columns exist and what type each one is',
      'created_by and the format version',
      'footer_len, read from the last 8 bytes before anything else',
    ],
    unknown: [
      'any statistic at all — Parquet defines NO file-level statistics',
      'therefore: whether this file can be skipped for your predicate',
    ],
    decisions: [
      'is this a Parquet file, and can this reader read it',
      'is the projection satisfiable — do the columns I want exist',
      'how many row groups I am about to consider',
    ],
    hasStatistics: false,
  },
  {
    id: 'row-group',
    index: 1,
    name: 'row group',
    physically: 'a horizontal slice of rows; exactly one column chunk per leaf column',
    known: [
      'num_rows in this group',
      'total_byte_size of the group',
      'the ordinal, and the file offset of its first chunk',
      'which chunk entries belong to it',
    ],
    unknown: [
      'still no statistics — the group struct itself carries none',
      'a planner that wants a group-level bound must FOLD its chunk entries',
    ],
    decisions: [
      'the unit of parallelism — one task per group',
      'the unit of pruning: a row group is skipped or read whole',
      'the granularity every C2 pruning ratio is expressed in',
    ],
    hasStatistics: false,
  },
  {
    id: 'column-chunk',
    index: 2,
    name: 'column chunk',
    physically: 'one column’s values for one row group, GUARANTEED contiguous on disk',
    known: [
      'min, max and null_count — the first and only statistics in the footer',
      'file_offset, total_compressed_size, total_uncompressed_size',
      'the encodings used, and the compression codec',
      'num_values in the chunk',
    ],
    unknown: [
      'whether the min or max is a value that actually EXISTS in the chunk — it is a bound, not a member',
      'how many distinct values the chunk holds',
    ],
    decisions: [
      'skip this row group: predicate outside [min, max] means no match is possible',
      'projection as a range read: one contiguous byte range per chunk',
      'is there a dictionary to compare codes against instead of values',
    ],
    hasStatistics: true,
  },
  {
    id: 'page',
    index: 3,
    name: 'page',
    physically: 'the indivisible unit of encoding and compression; its header is serialised inline with the data',
    known: [
      'dictionary_page_offset, data_page_offset, index_page_offset — offsets only',
      'derivable: where a dictionary page exists, data_page_offset − dictionary_page_offset is its exact size',
    ],
    unknown: [
      'how many pages the chunk holds — page headers live with the data, not in the footer',
      'per-page min/max — those live in the optional ColumnIndex/OffsetIndex, which this model does not carry',
    ],
    decisions: [
      'read one page of a chunk instead of the whole chunk — only with the offsets you have',
      'skip the dictionary page when you do not need it',
    ],
    hasStatistics: false,
  },
]

export const levelSpec = (id: LevelId): LevelSpec => {
  const spec = LEVEL_SPECS.find((l) => l.id === id)
  if (!spec) throw new Error(`footer-walk: no level ${id}`)
  return spec
}

/** The one level whose entries carry a min/max/null-count triple. Computed, not asserted. */
export function statisticsLevel(): LevelId {
  const withStats = LEVEL_SPECS.filter((l) => l.hasStatistics)
  if (withStats.length !== 1) throw new Error('footer-walk: statistics must live at exactly one level')
  return withStats[0].id
}

/* -------------------------------- the model ----------------------------- */

export interface FooterConfig {
  rowGroups: number
  columnSet: ColumnSetId
  keyWidth: number
}

export const OPENING_CONFIG: FooterConfig = {
  rowGroups: 16,
  columnSet: 'reference',
  keyWidth: 12,
}

export const configKey = (c: FooterConfig): string =>
  `${c.rowGroups}/${c.columnSet}/${c.keyWidth}`

export interface LevelReport extends LevelSpec {
  /** How many things exist at this level in this file. */
  entities: number
  entityLabel: string
  /** Footer bytes attributable to this level. */
  bytesHere: number
  /** Footer bytes attributable to this level and every level above it. */
  bytesCumulative: number
  /** Share of the footer this level accounts for. */
  shareOfFooter: number
}

export interface FooterReport {
  config: FooterConfig
  key: string

  rows: number
  rowGroups: number
  rowsPerGroup: number
  columns: number
  keyWidth: number

  /** The format's grain: row groups × leaf columns, exactly. */
  metadataEntries: number
  entryBytes: number

  fileFieldBytes: number
  schemaBytes: number
  rowGroupStructBytes: number
  entriesBytes: number
  footerBytes: number

  dataBytes: number
  fileBytes: number
  footerShare: number
  /** Bytes of description per row of data. A count, per row. */
  footerBytesPerRow: number
  footerExceedsData: boolean

  /** Ranges read before a single value is decoded: the tail, then the footer. */
  openingRangeReads: number
  levels: LevelReport[]
}

export function footerModel(config: FooterConfig): FooterReport {
  const set = columnSet(config.columnSet)
  const columns = set.columns
  const rowGroups = config.rowGroups
  const rowsPerGroup = ROWS / rowGroups

  const metadataEntries = rowGroups * columns
  const entryBytes = ENTRY_FIXED_BYTES + 2 * config.keyWidth

  const fileFieldBytes = FOOTER_FIXED_BYTES
  const schemaBytes = SCHEMA_BYTES_PER_COLUMN * columns
  const rowGroupStructBytes = ROW_GROUP_STRUCT_BYTES * rowGroups
  const entriesTotal = metadataEntries * entryBytes
  const footerBytes = fileFieldBytes + schemaBytes + rowGroupStructBytes + entriesTotal

  /* The data side does NOT depend on the row-group count in this model, which
   * isolates the footer term. Real files compress slightly worse in small row
   * groups, which makes the real share rise a little slower — said out loud in
   * the lab's own caveat panel rather than buried here. */
  const dataBytes = Math.round(ROWS * columns * set.bytesPerValue)
  const fileBytes = LEADING_MAGIC_BYTES + dataBytes + footerBytes + TRAILER_BYTES

  const perLevelBytes: Record<LevelId, number> = {
    file: fileFieldBytes + schemaBytes,
    'row-group': rowGroupStructBytes,
    'column-chunk': entriesTotal,
    /* The page level costs nothing extra: it is visible only as the three
     * offsets already counted inside every chunk entry. */
    page: 0,
  }

  const entityCount: Record<LevelId, number> = {
    file: 1,
    'row-group': rowGroups,
    'column-chunk': metadataEntries,
    page: 3 * metadataEntries,
  }

  const entityLabel: Record<LevelId, string> = {
    file: 'file',
    'row-group': 'row groups',
    'column-chunk': 'chunk entries (row groups × columns)',
    page: 'page offsets (3 per chunk) — the pages themselves are not enumerable from here',
  }

  let running = 0
  const levels: LevelReport[] = LEVEL_SPECS.map((spec) => {
    const bytesHere = perLevelBytes[spec.id]
    running += bytesHere
    return {
      ...spec,
      entities: entityCount[spec.id],
      entityLabel: entityLabel[spec.id],
      bytesHere,
      bytesCumulative: running,
      shareOfFooter: bytesHere / footerBytes,
    }
  })

  return {
    config,
    key: configKey(config),

    rows: ROWS,
    rowGroups,
    rowsPerGroup,
    columns,
    keyWidth: config.keyWidth,

    metadataEntries,
    entryBytes,

    fileFieldBytes,
    schemaBytes,
    rowGroupStructBytes,
    entriesBytes: entriesTotal,
    footerBytes,

    dataBytes,
    fileBytes,
    footerShare: footerBytes / fileBytes,
    footerBytesPerRow: footerBytes / ROWS,
    footerExceedsData: footerBytes > dataBytes,

    openingRangeReads: 2,
    levels,
  }
}

/** Ranges a scan issues in total: the tail, the footer, then one per projected chunk. */
export const rangeReads = (report: FooterReport, projectedColumns: number, groupsSurviving: number): number =>
  report.openingRangeReads + projectedColumns * groupsSurviving

/* ------------------------------- the sweeps ----------------------------- */

export interface SweepPoint {
  rowGroups: number
  rowsPerGroup: number
  metadataEntries: number
  footerBytes: number
  footerShare: number
}

/**
 * The footer share across the row-group axis, coarsest first. Strictly
 * increasing, because the data side is fixed and every extra row group adds a
 * row-group struct and `columns` more entries.
 */
export function footerShareSweep(columnSetId: ColumnSetId, keyWidth: number): SweepPoint[] {
  return ROW_GROUP_CHOICES.map((rowGroups) => {
    const r = footerModel({ rowGroups, columnSet: columnSetId, keyWidth })
    return {
      rowGroups,
      rowsPerGroup: r.rowsPerGroup,
      metadataEntries: r.metadataEntries,
      footerBytes: r.footerBytes,
      footerShare: r.footerShare,
    }
  })
}

/** The whole space: 6 × 3 × 3. */
export const CONFIG_GRID: FooterConfig[] = ROW_GROUP_CHOICES.flatMap((rowGroups) =>
  COLUMN_SETS.flatMap((set) =>
    KEY_WIDTH_CHOICES.map((keyWidth) => ({ rowGroups, columnSet: set.id, keyWidth })),
  ),
)

/** Configurations whose footer is larger than the data it describes. */
export const configsWhereFooterExceedsData = (): FooterConfig[] =>
  CONFIG_GRID.filter((c) => footerModel(c).footerExceedsData)

/** The graded threshold: a footer worth a tenth of the file is no longer a rounding error. */
export const SHARE_TARGET = 0.1

/**
 * What the parquet-anatomy duck lab measured on real DuckDB-written files, kept
 * beside the model so the gap is visible instead of implied.
 */
export const MEASURED = [
  { label: '4 columns, 1 row group', share: 0.000_24, entryBytes: 87, source: 'parquet-anatomy' },
  { label: '33 columns, 64 row groups', share: 0.163_6, entryBytes: 87, source: 'parquet-anatomy' },
  { label: '160-char key, same row groups', share: undefined, entryBytes: 404, source: 'parquet-anatomy' },
] as const

/* ------------------------------- the schema ----------------------------- */

const TYPE_POOL = ['INT64', 'INT32', 'BYTE_ARRAY', 'DOUBLE', 'BOOLEAN'] as const

const NAME_POOL = [
  'order_ts',
  'order_id',
  'region',
  'net_revenue',
  'customer_id',
  'sku',
  'quantity',
  'discount',
  'channel',
  'status',
  'ship_country',
  'payment_method',
]

export interface SchemaLeaf {
  name: string
  type: string
}

const schemaCache = new Map<ColumnSetId, SchemaLeaf[]>()

/**
 * The modelled schema tree, for the file-level panel. Seeded so every reader
 * sees the same one; the names past the twelve real ones are the `attr_NN`
 * columns a wide event table actually accumulates.
 */
export function schemaTree(id: ColumnSetId): SchemaLeaf[] {
  const cached = schemaCache.get(id)
  if (cached) return cached
  const set = columnSet(id)
  const rng = new Rng(0x5eed_f007)
  const out: SchemaLeaf[] = []
  for (let i = 0; i < set.columns; i++) {
    const name = i < NAME_POOL.length ? NAME_POOL[i] : `attr_${String(i - NAME_POOL.length).padStart(2, '0')}`
    out.push({ name, type: TYPE_POOL[rng.below(TYPE_POOL.length)] })
  }
  schemaCache.set(id, out)
  return out
}
