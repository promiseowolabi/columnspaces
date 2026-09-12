/**
 * anatomy — a Parquet file described by its own footer, level by level.
 *
 * ── The claim under test ───────────────────────────────────────────────────
 * "Everything a scan needs to skip work is in the metadata, and metadata is not
 * free." Both halves are falsifiable and both are measured here from real files
 * written by DuckDB's own writer.
 *
 * The first half is a claim about WHERE. Parquet has no file-level statistics.
 * The min/max/null-count triple lives on the COLUMN CHUNK — one per column per
 * row group — and a planner that wants a file-level bound has to fold the chunk
 * entries itself. This module proves that grain by counting: statistics entries
 * come out at exactly `row groups × leaf columns` in every configuration, and the
 * folded bound is checked against the true extremes read from the data.
 *
 * The second half is a claim about COST, and it has two independent drivers that
 * are usually conflated:
 *
 *   · ENTRY COUNT — `row groups × columns`. Both dials are swept here, so the
 *     product is visible rather than asserted. This is the dial C2's pruning lab
 *     turns for pruning resolution; this lab shows the bill it runs up.
 *   · ENTRY SIZE — a statistics entry stores the actual minimum and maximum
 *     VALUES, so a wide key inflates every entry in the file. A 160-character
 *     string key carries its 160 characters twice per chunk. That is why the
 *     fixture includes a long-key file: without it a reader concludes metadata
 *     cost is only about row-group size, which is half the story.
 *
 * A configuration where metadata is a SIGNIFICANT fraction of the file is
 * included on purpose, because "not free" is easy to wave away at 0.03%. Wide and
 * highly compressible plus small row groups gets there: the data side shrinks to
 * almost nothing while the footer side grows with the entry grid. Both roads to
 * that corner are real — streaming ingest that lands small files, and wide event
 * tables full of enum columns.
 *
 * ── What this measures, precisely ─────────────────────────────────────────
 * Every number comes from `parquet_file_metadata`, `parquet_schema` and
 * `parquet_metadata` over files this module wrote. `footer_size` and
 * `file_size_bytes` are the writer's own accounting of the serialised footer and
 * the file on disk. Where a build does not expose them the measurement degrades
 * to null and the UI says the share could not be computed — it is never inferred.
 *
 * ── Where the walk stops, and why that is stated rather than hidden ───────
 * Parquet has four nesting levels: file → row group → column chunk → page.
 * DuckDB's footer views reach the third. The page level is only visible in the
 * footer as OFFSETS — `dictionary_page_offset`, `data_page_offset`,
 * `index_page_offset` — because page headers are serialised inline with the data,
 * not in the footer. Exactly one page-level byte count is therefore derivable
 * here and it is derived honestly: where a dictionary page exists,
 * `data_page_offset − dictionary_page_offset` is that page's exact size on disk.
 * Per-page statistics (the optional ColumnIndex/OffsetIndex structures) are not
 * exposed by these views, so this module reports their absence rather than
 * inventing page statistics.
 *
 * ── The refusal, and the thing that is worse than a refusal ───────────────
 * A reader who has just been told the footer is authoritative should be shown
 * what happens when it lies. Four mutations are applied to real bytes and the
 * engine's ACTUAL error text is surfaced — never a written-in string. Three of
 * them are structural and are refused. The fourth flips a byte in the data
 * region, and the interesting result is that it is NOT refused: Parquet's page
 * CRC is optional, so a corrupted value can come back as a plausible wrong
 * answer with no error at all. That asymmetry is the finding this lab exists to
 * hand over, and it is reported whichever way it comes out.
 */

import { exec, query } from './client'
import { FIXTURE_SEED } from './fixtures'
import type { FileStore } from './vfs'

/** Rows in the anatomy fixture. 64 × 2048, so every row-group size divides evenly. */
export const ANATOMY_ROWS = 131_072

/** Same seed lineage as every other fixture in the course. Determinism is the point. */
export const ANATOMY_SEED = FIXTURE_SEED

/** DuckDB's vector size. ROW_GROUP_SIZE is rounded up to a multiple of it. */
export const VECTOR_SIZE = 2_048

/** Seconds between successive rows, so timestamp statistics carry no fractional part. */
export const ANATOMY_STEP_SECONDS = 123

export const ANATOMY_START = '2024-01-01 00:00:00'

/** Enum-ish columns in the wide table. Wide tables are where the entry grid bites. */
export const WIDE_COLUMNS = 32

/** Rows between value changes in a wide column — long runs, so the data side is tiny. */
export const WIDE_RUN_LENGTH = 8_192

/** Characters in the long statistics key. Every chunk stores it twice. */
export const LONG_KEY_CHARS = 160

/**
 * The bar for "significant". 10% of a file being footer is not a rounding error:
 * it is a tenth of your storage bill and a tenth of every full-file transfer,
 * spent before a single value is decoded.
 */
export const SIGNIFICANT_METADATA_SHARE = 0.1

/** Leaf columns in the narrow table. Checked against `parquet_schema`, not trusted. */
export const NARROW_COLUMNS = ['order_ts', 'customer_id', 'region', 'net_revenue']

/** The column the statistics-location proof folds. Timestamps render sortably as text. */
export const PROOF_COLUMN = 'order_ts'

/* -------------------------------- the fixture ------------------------------- */

/**
 * The narrow table: the shape the rest of the course has been using, in
 * timestamp order. `region` is deliberately low-cardinality so that one column in
 * the file is dictionary-encoded and the page-level panel has a dictionary page
 * to measure.
 */
export const anatomyNarrowSql = (rows: number = ANATOMY_ROWS): string => `
CREATE OR REPLACE TABLE anatomy_narrow AS
SELECT
  TIMESTAMP '${ANATOMY_START}' + INTERVAL (i * ${ANATOMY_STEP_SECONDS}) SECOND AS order_ts,
  ((hash(i * 5 + ${ANATOMY_SEED}) % 900000) + 100000)::INTEGER AS customer_id,
  ['EMEA','NA','APAC','LATAM','UK','DACH','NORDIC','ANZ'][((hash(i + ${ANATOMY_SEED}) % 8)::BIGINT) + 1] AS region,
  ((hash(i * 3 + ${ANATOMY_SEED}) % 90000) / 100.0)::DOUBLE AS net_revenue
FROM range(${rows}) t(i)
ORDER BY order_ts;
`

/**
 * The wide table: an id plus ${WIDE_COLUMNS} enum columns held constant over long
 * runs. This is not a pathological invention — it is the shape of a wide event or
 * dimension table, and it is the shape whose data side compresses to nearly
 * nothing while its footer keeps one full statistics entry per column per row
 * group. The per-column offset means no two columns change value at the same row,
 * so the file is not one column repeated.
 */
export const anatomyWideSql = (rows: number = ANATOMY_ROWS): string => {
  const cols = Array.from({ length: WIDE_COLUMNS }, (_, k) => {
    const name = `flag_${String(k).padStart(2, '0')}`
    return `  ('v' || (((i + ${k * 997}) // ${WIDE_RUN_LENGTH}) % 4)::VARCHAR) AS ${name}`
  }).join(',\n')
  return `
CREATE OR REPLACE TABLE anatomy_wide AS
SELECT
  i::INTEGER AS event_id,
${cols}
FROM range(${rows}) t(i)
ORDER BY event_id;
`
}

/**
 * The long-key table. `k` is ${LONG_KEY_CHARS} characters wide and unique per row,
 * so every chunk's statistics entry carries two ${LONG_KEY_CHARS}-character
 * strings. Same row-group size as the narrow file, so the only variable is the
 * width of the values the statistics have to quote.
 */
export const anatomyLongKeySql = (rows: number = ANATOMY_ROWS): string => `
CREATE OR REPLACE TABLE anatomy_longkey AS
SELECT
  lpad(md5(i::VARCHAR), ${LONG_KEY_CHARS}, 'k') AS k,
  ((hash(i * 3 + ${ANATOMY_SEED}) % 90000) / 100.0)::DOUBLE AS net_revenue
FROM range(${rows}) t(i)
ORDER BY k;
`

export type AnatomyFamily = 'narrow' | 'wide' | 'longkey'

export interface AnatomyFile {
  id: string
  /** Basename inside duckdb's virtual filesystem, or under a temp dir in tests. */
  file: string
  table: 'anatomy_narrow' | 'anatomy_wide' | 'anatomy_longkey'
  family: AnatomyFamily
  rowGroupSize: number
  label: string
  why: string
}

/**
 * Eight files: the narrow table at four row-group sizes, the wide table at three,
 * and the long-key file. The narrow sweep isolates the row-group dial; comparing
 * a narrow row against the wide row at the same row-group size isolates the
 * column dial; the long-key file isolates entry SIZE from entry COUNT.
 */
export const ANATOMY_FILES: AnatomyFile[] = [
  {
    id: 'narrow-128k',
    file: 'anatomy-narrow-128k.parquet',
    table: 'anatomy_narrow',
    family: 'narrow',
    rowGroupSize: 131_072,
    label: '4 columns · 128k rows/group',
    why: 'One row group for the whole file. Four statistics entries in total — the cheapest possible footer, and the coarsest possible summary.',
  },
  {
    id: 'narrow-32k',
    file: 'anatomy-narrow-32k.parquet',
    table: 'anatomy_narrow',
    family: 'narrow',
    rowGroupSize: 32_768,
    label: '4 columns · 32k rows/group',
    why: 'Four row groups. The entry grid is four times bigger and every entry describes a quarter as much data.',
  },
  {
    id: 'narrow-8k',
    file: 'anatomy-narrow-8k.parquet',
    table: 'anatomy_narrow',
    family: 'narrow',
    rowGroupSize: 8_192,
    label: '4 columns · 8k rows/group',
    why: 'The reference file for the level-by-level walk. Sixteen row groups, and a dictionary-encoded column so the page level has something real to show.',
  },
  {
    id: 'narrow-2k',
    file: 'anatomy-narrow-2k.parquet',
    table: 'anatomy_narrow',
    family: 'narrow',
    rowGroupSize: VECTOR_SIZE,
    label: '4 columns · 2k rows/group',
    why: 'DuckDB’s floor, far below anything sane in production. Sixty-four row groups: the entry grid is 64× the first row, for the same values.',
  },
  {
    id: 'wide-128k',
    file: 'anatomy-wide-128k.parquet',
    table: 'anatomy_wide',
    family: 'wide',
    rowGroupSize: 131_072,
    label: '33 columns · 128k rows/group',
    why: 'The wide table at one row group. Compare with the 4-column file at the same row-group size: same rows, same groups, eight times the entries.',
  },
  {
    id: 'wide-8k',
    file: 'anatomy-wide-8k.parquet',
    table: 'anatomy_wide',
    family: 'wide',
    rowGroupSize: 8_192,
    label: '33 columns · 8k rows/group',
    why: 'Both dials turned part-way. The entry grid is the product, not the sum — which is why wide tables and small files are a bad combination rather than two independent problems.',
  },
  {
    id: 'wide-2k',
    file: 'anatomy-wide-2k.parquet',
    table: 'anatomy_wide',
    family: 'wide',
    rowGroupSize: VECTOR_SIZE,
    label: '33 columns · 2k rows/group',
    why: 'The corner where metadata stops being a rounding error. Highly compressible values crush the data side while the entry grid keeps growing, and the footer takes a double-digit share of the file.',
  },
  {
    id: 'longkey-8k',
    file: 'anatomy-longkey-8k.parquet',
    table: 'anatomy_longkey',
    family: 'longkey',
    rowGroupSize: 8_192,
    label: `2 columns · ${LONG_KEY_CHARS}-char key · 8k rows/group`,
    why: `The other driver of footer cost. Same row-group size as the reference file and half the columns, but every statistics entry quotes two ${LONG_KEY_CHARS}-character values, so bytes per entry — not entries — is what moves.`,
  },
]

/** The file the level-by-level walk describes. */
export const REFERENCE_FILE_ID = 'narrow-8k'

/** The configuration where the footer takes a significant share. */
export const HEAVY_FILE_ID = 'wide-2k'

export const anatomyFile = (id: string): AnatomyFile =>
  ANATOMY_FILES.find((f) => f.id === id) ?? ANATOMY_FILES[0]

export const anatomyPath = (f: AnatomyFile, dir = ''): string => (dir ? `${dir}/${f.file}` : f.file)

export const copyAnatomySql = (f: AnatomyFile, into: string = f.file): string =>
  `COPY ${f.table} TO '${into}' (FORMAT parquet, ROW_GROUP_SIZE ${f.rowGroupSize}, COMPRESSION snappy);`

let loaded = false

/** Build the three tables and write the eight files. Idempotent per tab. */
export async function loadAnatomyFixtures(
  onStep?: (s: string) => void,
  opts: { rows?: number; dir?: string } = {},
): Promise<void> {
  if (loaded) {
    onStep?.('fixtures already built')
    return
  }
  const rows = opts.rows ?? ANATOMY_ROWS

  onStep?.(`generating ${rows.toLocaleString('en-US')} rows, 4 columns`)
  await exec(anatomyNarrowSql(rows))

  onStep?.(`generating the same rows across ${WIDE_COLUMNS + 1} columns`)
  await exec(anatomyWideSql(rows))

  onStep?.(`generating a ${LONG_KEY_CHARS}-character key column`)
  await exec(anatomyLongKeySql(rows))

  for (const f of ANATOMY_FILES) {
    onStep?.(`writing ${f.file}`)
    await exec(copyAnatomySql(f, anatomyPath(f, opts.dir)))
  }
  loaded = true
  onStep?.('ready')
}

export const anatomyFixturesLoaded = (): boolean => loaded

/* ------------------------------- level 0: file ------------------------------ */

/**
 * The file-level block, which is the four bytes `PAR1`, a serialised
 * `FileMetaData` and a length. `footer_size` and `file_size_bytes` have moved
 * between DuckDB releases, so each shape is tried in turn and the measurement
 * degrades to null instead of failing the lab.
 */
export const FILE_LEVEL_SQL_CANDIDATES: string[] = [
  `SELECT created_by,
          num_rows::BIGINT           AS num_rows,
          num_row_groups::BIGINT     AS num_row_groups,
          format_version::BIGINT     AS format_version,
          file_size_bytes::BIGINT    AS file_bytes,
          footer_size::BIGINT        AS footer_bytes
   FROM parquet_file_metadata('%FILE%')`,
  `SELECT created_by,
          num_rows::BIGINT           AS num_rows,
          num_row_groups::BIGINT     AS num_row_groups,
          format_version::BIGINT     AS format_version,
          file_size_bytes::BIGINT    AS file_bytes,
          NULL::BIGINT               AS footer_bytes
   FROM parquet_file_metadata('%FILE%')`,
  `SELECT created_by,
          num_rows::BIGINT           AS num_rows,
          num_row_groups::BIGINT     AS num_row_groups,
          NULL::BIGINT               AS format_version,
          NULL::BIGINT               AS file_bytes,
          NULL::BIGINT               AS footer_bytes
   FROM parquet_file_metadata('%FILE%')`,
]

export interface FileLevel {
  createdBy: string | null
  numRows: number
  numRowGroups: number
  formatVersion: number | null
  fileBytes: number | null
  footerBytes: number | null
}

export async function fileLevel(path: string): Promise<FileLevel> {
  for (const candidate of FILE_LEVEL_SQL_CANDIDATES) {
    try {
      const r = await query<{
        created_by: string | null
        num_rows: number
        num_row_groups: number
        format_version: number | null
        file_bytes: number | null
        footer_bytes: number | null
      }>(candidate.replace('%FILE%', path))
      if (r[0]) {
        return {
          createdBy: r[0].created_by,
          numRows: r[0].num_rows,
          numRowGroups: r[0].num_row_groups,
          formatVersion: r[0].format_version,
          fileBytes: r[0].file_bytes,
          footerBytes: r[0].footer_bytes,
        }
      }
    } catch {
      /* This build spells the file-level columns differently. Try the next shape. */
    }
  }
  throw new Error(`could not read file-level metadata for ${path}`)
}

/* ------------------------------ level 1: schema ---------------------------- */

/**
 * The schema tree. Row zero is the synthetic root (`num_children` = the leaf
 * count); the rest are the leaves the reader actually queries. Repetition type is
 * included because it is the field that decides whether a column needs definition
 * levels at all — the single most commonly skipped part of the format.
 *
 * ── Why there are two shapes ───────────────────────────────────────────────
 * `parquet_schema()` grew a `column_id` column in DuckDB 1.5. duckdb-wasm 1.32.0
 * embeds DuckDB **1.4.3**, which has `field_id` and no `column_id`, so the query
 * below — written against the native 1.5.5 the unit suite uses — failed in every
 * reader's browser with
 *
 *     Binder Error: Column "column_id" referenced that exists in the SELECT
 *     clause - but this column cannot be referenced before it is defined
 *
 * (the binder finds no input column of that name, so it resolves the reference to
 * the output alias being defined, and rejects it). `npm run e2e` is what found
 * this; nothing else could, because the mocks run the native engine.
 *
 * The same candidate-list tolerance `fileLevel` already applies to `footer_size`
 * applies here. The fallback synthesises the position: `parquet_schema()` returns
 * rows in schema order — root first, then leaves — on both versions.
 */
export const SCHEMA_SQL_CANDIDATES: string[] = [
  `SELECT name,
          type,
          duckdb_type,
          repetition_type,
          num_children::BIGINT AS num_children,
          logical_type,
          column_id::BIGINT    AS column_id
   FROM parquet_schema('%FILE%')
   ORDER BY column_id`,
  `SELECT name,
          type,
          duckdb_type,
          repetition_type,
          num_children::BIGINT AS num_children,
          logical_type,
          (row_number() OVER () - 1)::BIGINT AS column_id
   FROM parquet_schema('%FILE%')`,
]

/** The preferred shape, kept exported: DuckDB 1.5+ answers it directly. */
export const schemaSql = (path: string): string =>
  SCHEMA_SQL_CANDIDATES[0].replace('%FILE%', path)

export interface SchemaEntry {
  name: string
  parquetType: string | null
  duckdbType: string | null
  repetition: string | null
  numChildren: number | null
  logicalType: string | null
  isLeaf: boolean
}

export async function schemaLevel(path: string): Promise<SchemaEntry[]> {
  type Row = {
    name: string
    type: string | null
    duckdb_type: string | null
    repetition_type: string | null
    num_children: number | null
    logical_type: string | null
  }

  let rows: Row[] | null = null
  let lastError: unknown = null
  for (const candidate of SCHEMA_SQL_CANDIDATES) {
    try {
      rows = await query<Row>(candidate.replace('%FILE%', path))
      break
    } catch (e) {
      /* This build spells the schema columns differently. Try the next shape. */
      lastError = e
    }
  }
  if (rows === null) throw lastError instanceof Error ? lastError : new Error(String(lastError))

  return rows.map((r) => ({
    name: r.name,
    parquetType: r.type,
    duckdbType: r.duckdb_type,
    repetition: r.repetition_type,
    numChildren: r.num_children,
    logicalType: r.logical_type,
    isLeaf: r.type !== null,
  }))
}

/* ---------------------------- level 2: row group --------------------------- */

export const rowGroupSql = (path: string): string => `
    SELECT row_group_id::BIGINT                       AS row_group_id,
           any_value(row_group_num_rows)::BIGINT      AS rows,
           any_value(row_group_num_columns)::BIGINT   AS columns,
           any_value(row_group_bytes)::BIGINT         AS uncompressed_bytes,
           sum(total_compressed_size)::BIGINT         AS compressed_bytes,
           count(*)::BIGINT                           AS chunks
    FROM parquet_metadata('${path}')
    GROUP BY 1
    ORDER BY 1
  `

export interface RowGroupEntry {
  id: number
  rows: number
  columns: number
  uncompressedBytes: number
  compressedBytes: number
  chunks: number
}

export async function rowGroupLevel(path: string): Promise<RowGroupEntry[]> {
  const rows = await query<{
    row_group_id: number
    rows: number
    columns: number
    uncompressed_bytes: number
    compressed_bytes: number
    chunks: number
  }>(rowGroupSql(path))
  return rows.map((r) => ({
    id: r.row_group_id,
    rows: r.rows,
    columns: r.columns,
    uncompressedBytes: r.uncompressed_bytes,
    compressedBytes: r.compressed_bytes,
    chunks: r.chunks,
  }))
}

/* --------------------- levels 3 and 4: column chunk, page ----------------- */

/**
 * One row group's column chunks, with the statistics and the page offsets.
 *
 * `dictionary_page_offset` and `data_page_offset` are the only page-level facts
 * the footer carries. Where both are present their difference is the dictionary
 * page's exact size on disk, which is a real page-level byte count rather than an
 * estimate. Everything else about pages — how many there are, their individual
 * headers, their optional CRCs — is serialised inline with the data and is not
 * visible from here.
 */
export const chunkSql = (path: string, rowGroupId: number): string => `
    SELECT path_in_schema,
           type,
           compression,
           encodings,
           num_values::BIGINT              AS num_values,
           total_compressed_size::BIGINT   AS total_compressed_size,
           total_uncompressed_size::BIGINT AS total_uncompressed_size,
           stats_min_value,
           stats_max_value,
           stats_null_count::BIGINT        AS stats_null_count,
           stats_distinct_count::BIGINT    AS stats_distinct_count,
           min_is_exact,
           dictionary_page_offset::BIGINT  AS dictionary_page_offset,
           data_page_offset::BIGINT        AS data_page_offset,
           index_page_offset::BIGINT       AS index_page_offset
    FROM parquet_metadata('${path}')
    WHERE row_group_id = ${rowGroupId}
    ORDER BY column_id
  `

export interface ChunkEntry {
  column: string
  parquetType: string | null
  compression: string | null
  encodings: string | null
  values: number
  compressedBytes: number
  uncompressedBytes: number
  statsMin: string | null
  statsMax: string | null
  nullCount: number | null
  distinctCount: number | null
  minIsExact: boolean | null
  dictionaryPageOffset: number | null
  dataPageOffset: number | null
  indexPageOffset: number | null
  /** `data_page_offset − dictionary_page_offset`: the dictionary page, exactly. */
  dictionaryPageBytes: number | null
}

export async function chunkLevel(path: string, rowGroupId: number): Promise<ChunkEntry[]> {
  const rows = await query<{
    path_in_schema: string
    type: string | null
    compression: string | null
    encodings: string | null
    num_values: number
    total_compressed_size: number
    total_uncompressed_size: number
    stats_min_value: string | null
    stats_max_value: string | null
    stats_null_count: number | null
    stats_distinct_count: number | null
    min_is_exact: boolean | null
    dictionary_page_offset: number | null
    data_page_offset: number | null
    index_page_offset: number | null
  }>(chunkSql(path, rowGroupId))

  return rows.map((r) => ({
    column: r.path_in_schema,
    parquetType: r.type,
    compression: r.compression,
    encodings: r.encodings,
    values: r.num_values,
    compressedBytes: r.total_compressed_size,
    uncompressedBytes: r.total_uncompressed_size,
    statsMin: r.stats_min_value,
    statsMax: r.stats_max_value,
    nullCount: r.stats_null_count,
    distinctCount: r.stats_distinct_count,
    minIsExact: r.min_is_exact,
    dictionaryPageOffset: r.dictionary_page_offset,
    dataPageOffset: r.data_page_offset,
    indexPageOffset: r.index_page_offset,
    dictionaryPageBytes:
      r.dictionary_page_offset !== null && r.data_page_offset !== null
        ? r.data_page_offset - r.dictionary_page_offset
        : null,
  }))
}

/* --------------------- where the statistics actually live ------------------ */

/**
 * The grain proof.
 *
 * Parquet stores no file-level minimum or maximum. A planner that wants one folds
 * the per-chunk entries, and this checks that the fold agrees with the truth read
 * from the data. If the two ever disagreed, every pruning decision in C2 would be
 * unsound — so this is the one assertion in this lab that is correctness rather
 * than cost.
 *
 * Comparing statistics as VARCHAR is exact here because the column is a timestamp
 * and DuckDB renders timestamps in a sortable fixed-width form. The same
 * comparison on a variable-width integer would be wrong ('9' > '10'), which is
 * why `src/lib/duckdb/pruning.ts` pads its integer domain.
 */
export const statsGrainSql = (path: string, column: string): string => `
    WITH chunk_stats AS (
      SELECT row_group_id, stats_min_value AS lo, stats_max_value AS hi
      FROM parquet_metadata('${path}')
      WHERE path_in_schema = '${column}'
    ),
    truth AS (
      SELECT min(${column})::VARCHAR AS lo, max(${column})::VARCHAR AS hi
      FROM read_parquet('${path}')
    )
    SELECT (SELECT count(*) FROM chunk_stats)::BIGINT                          AS entries,
           (SELECT count(*) FROM chunk_stats WHERE lo IS NOT NULL)::BIGINT     AS entries_with_stats,
           (SELECT min(lo) FROM chunk_stats)                                   AS folded_min,
           (SELECT max(hi) FROM chunk_stats)                                   AS folded_max,
           (SELECT lo FROM truth)                                              AS true_min,
           (SELECT hi FROM truth)                                              AS true_max
  `

export interface StatsGrain {
  column: string
  /** Statistics entries for this column: one per row group. */
  entries: number
  entriesWithStats: number
  /** Parquet defines no file-level statistics block. This is 0, by the format. */
  fileLevelEntries: 0
  foldedMin: string | null
  foldedMax: string | null
  trueMin: string | null
  trueMax: string | null
  /** Does the folded bound actually contain the data? Must be true. */
  boundsHold: boolean
}

export async function statsGrain(path: string, column: string = PROOF_COLUMN): Promise<StatsGrain> {
  const r = (
    await query<{
      entries: number
      entries_with_stats: number
      folded_min: string | null
      folded_max: string | null
      true_min: string | null
      true_max: string | null
    }>(statsGrainSql(path, column))
  )[0]
  if (!r) throw new Error(`could not fold statistics for ${column} in ${path}`)

  const boundsHold =
    r.folded_min !== null &&
    r.folded_max !== null &&
    r.true_min !== null &&
    r.true_max !== null &&
    r.folded_min <= r.true_min &&
    r.folded_max >= r.true_max

  return {
    column,
    entries: r.entries,
    entriesWithStats: r.entries_with_stats,
    fileLevelEntries: 0,
    foldedMin: r.folded_min,
    foldedMax: r.folded_max,
    trueMin: r.true_min,
    trueMax: r.true_max,
    boundsHold,
  }
}

/* ------------------------------ the measurement ---------------------------- */

export const entryGridSql = (path: string): string => `
    SELECT count(*)::BIGINT                                                  AS stats_entries,
           count(DISTINCT row_group_id)::BIGINT                              AS row_groups,
           count(DISTINCT path_in_schema)::BIGINT                            AS leaf_columns,
           count(*) FILTER (WHERE stats_min_value IS NOT NULL)::BIGINT        AS entries_with_stats,
           count(*) FILTER (WHERE dictionary_page_offset IS NOT NULL)::BIGINT AS chunks_with_dictionary,
           sum(total_compressed_size)::BIGINT                                AS data_bytes,
           sum(total_uncompressed_size)::BIGINT                              AS data_bytes_uncompressed,
           max(num_values)::BIGINT                                           AS group_rows,
           sum(coalesce(length(stats_min_value), 0)
             + coalesce(length(stats_max_value), 0))::BIGINT                 AS stats_value_chars
    FROM parquet_metadata('${path}')
  `

export interface AnatomyMeasurement {
  fileId: string
  path: string
  family: AnatomyFamily
  label: string
  rowGroupSize: number
  /** File-level block, level 0 of the walk. */
  file: FileLevel
  rowGroups: number
  leafColumns: number
  groupRows: number
  /** Column chunks in the footer. One statistics entry each. */
  statsEntries: number
  /** `row groups × leaf columns` — what the entry count should be. */
  entriesPredicted: number
  /** Does the footer's entry count equal the product exactly? */
  gridIsExact: boolean
  entriesWithStats: number
  chunksWithDictionary: number
  /** Characters of actual VALUES quoted by the min/max pairs. The entry-size driver. */
  statsValueChars: number
  dataBytes: number
  dataBytesUncompressed: number
  footerBytes: number | null
  fileBytes: number | null
  /** footerBytes ÷ fileBytes. Null where the build does not report the sizes. */
  metadataShare: number | null
  footerBytesPerEntry: number | null
  anomaly: string | null
}

export async function measure(f: AnatomyFile, dir = ''): Promise<AnatomyMeasurement> {
  const path = anatomyPath(f, dir)
  const level0 = await fileLevel(path)

  const grid = (
    await query<{
      stats_entries: number
      row_groups: number
      leaf_columns: number
      entries_with_stats: number
      chunks_with_dictionary: number
      data_bytes: number
      data_bytes_uncompressed: number
      group_rows: number
      stats_value_chars: number
    }>(entryGridSql(path))
  )[0]
  if (!grid) throw new Error(`no parquet metadata for ${path}`)

  const entriesPredicted = grid.row_groups * grid.leaf_columns
  const gridIsExact = grid.stats_entries === entriesPredicted

  const anomalies: string[] = []
  if (!gridIsExact) {
    anomalies.push(
      `the footer holds ${grid.stats_entries} entries but ${grid.row_groups} row groups × ${grid.leaf_columns} columns predicts ${entriesPredicted} — the entry grid is not the product this lab claims it is`,
    )
  }
  if (grid.row_groups !== level0.numRowGroups) {
    anomalies.push(
      `the file-level block reports ${level0.numRowGroups} row groups and the chunk entries imply ${grid.row_groups}`,
    )
  }
  if (level0.footerBytes === null || level0.fileBytes === null) {
    anomalies.push(
      'this build does not report footer_size or file_size_bytes, so the metadata share could not be computed and is shown as unavailable rather than estimated',
    )
  }
  if (grid.entries_with_stats < grid.stats_entries) {
    anomalies.push(
      `${grid.stats_entries - grid.entries_with_stats} of ${grid.stats_entries} entries carry no min/max pair, so those chunks cannot be pruned on any predicate`,
    )
  }

  return {
    fileId: f.id,
    path,
    family: f.family,
    label: f.label,
    rowGroupSize: f.rowGroupSize,
    file: level0,
    rowGroups: grid.row_groups,
    leafColumns: grid.leaf_columns,
    groupRows: grid.group_rows,
    statsEntries: grid.stats_entries,
    entriesPredicted,
    gridIsExact,
    entriesWithStats: grid.entries_with_stats,
    chunksWithDictionary: grid.chunks_with_dictionary,
    statsValueChars: grid.stats_value_chars,
    dataBytes: grid.data_bytes,
    dataBytesUncompressed: grid.data_bytes_uncompressed,
    footerBytes: level0.footerBytes,
    fileBytes: level0.fileBytes,
    metadataShare:
      level0.footerBytes !== null && level0.fileBytes !== null && level0.fileBytes > 0
        ? level0.footerBytes / level0.fileBytes
        : null,
    footerBytesPerEntry:
      level0.footerBytes !== null && grid.stats_entries > 0
        ? level0.footerBytes / grid.stats_entries
        : null,
    anomaly: anomalies.length > 0 ? anomalies.join('; ') : null,
  }
}

export type AnatomyGrid = Record<string, AnatomyMeasurement>

export async function measureAll(onStep?: (s: string) => void, dir = ''): Promise<AnatomyGrid> {
  const grid: AnatomyGrid = {}
  let i = 0
  for (const f of ANATOMY_FILES) {
    i += 1
    onStep?.(`reading footer ${i}/${ANATOMY_FILES.length}: ${f.label}`)
    grid[f.id] = await measure(f, dir)
  }
  return grid
}

/** The whole level-by-level walk of one file, for the UI's anatomy panel. */
export interface AnatomyWalk {
  path: string
  file: FileLevel
  schema: SchemaEntry[]
  rowGroups: RowGroupEntry[]
  /** Chunks of row group zero. One row group is enough to show the grain. */
  chunks: ChunkEntry[]
  stats: StatsGrain
}

export async function walk(f: AnatomyFile, dir = ''): Promise<AnatomyWalk> {
  const path = anatomyPath(f, dir)
  const level0 = await fileLevel(path)
  const schema = await schemaLevel(path)
  const groups = await rowGroupLevel(path)
  const chunks = await chunkLevel(path, 0)
  const stats = await statsGrain(path, PROOF_COLUMN)
  return { path, file: level0, schema, rowGroups: groups, chunks, stats }
}

/* -------------------------- the reader refusing input ---------------------- */

export type CorruptionKind =
  | 'truncate-tail'
  | 'clobber-magic'
  | 'lie-about-footer-length'
  | 'flip-a-data-byte'

export interface CorruptionProbe {
  kind: CorruptionKind
  label: string
  /** Which part of the format the mutation damages. */
  breaks: string
  /** What a correct reader should do. `false` for the one Parquet cannot catch. */
  shouldRefuse: boolean
  why: string
}

/**
 * Four mutations, in order of how deep into the format they reach. The first
 * three damage structure the footer needs to be parsed at all. The fourth damages
 * a VALUE, which the format does not protect by default — and that is the probe
 * worth reading twice.
 */
export const CORRUPTIONS: CorruptionProbe[] = [
  {
    kind: 'truncate-tail',
    label: 'truncate the last 8 bytes',
    breaks: 'the footer length and the trailing PAR1 magic',
    shouldRefuse: true,
    why: 'A Parquet reader starts at the END of the file: read the last 4 bytes for the magic, the 4 before that for the footer length, then seek back. Remove them and there is no way in — which is also why a partially uploaded Parquet file is unreadable rather than partially readable.',
  },
  {
    kind: 'clobber-magic',
    label: 'overwrite the trailing PAR1 magic',
    breaks: 'the format identifier, leaving every other byte intact',
    shouldRefuse: true,
    why: 'Four bytes out of the whole file, and the file is gone. The magic is the reader’s only cheap proof it is looking at Parquet at all, so it is checked before anything is decoded.',
  },
  {
    kind: 'lie-about-footer-length',
    label: 'write an impossible footer length',
    breaks: 'the 4-byte little-endian length that precedes the magic',
    shouldRefuse: true,
    why: 'The magic still says PAR1, so the file passes the identity check and then claims its footer is larger than the file. A reader that trusted this number would seek outside the file — which is why the length is validated against the file size before it is used.',
  },
  {
    kind: 'flip-a-data-byte',
    label: 'flip one byte a third of the way in',
    breaks: 'a compressed data page — not the footer, not the schema, not the statistics',
    shouldRefuse: false,
    why: 'Read this result carefully. Page CRCs are OPTIONAL in Parquet and DuckDB’s writer does not emit them, so there is nothing to check the value against. The footer parses, the row count is right, the query succeeds, and the answer can be wrong. Structural corruption is loud; value corruption is silent. That is an argument for checksums at the storage layer, not for trusting the reader.',
  },
]

/**
 * Apply a mutation to a copy of the bytes.
 *
 * Pure, exported and tested directly: the mutations are the experimental
 * conditions, and a mutation that silently did nothing would make a refusal look
 * like a pass.
 *
 * `dataByteOffset` is where `flip-a-data-byte` strikes. It is a parameter rather
 * than a fraction of the file because "a third of the way in" is a guess, and a
 * guess can land in a byte the query never decodes — which produces a
 * right-looking answer and proves nothing. The caller derives the offset from the
 * footer instead: the chunk entry for the column being checksummed states exactly
 * where that column's bytes for one row group begin and how many there are. That
 * the footer can aim a corruption is itself the lab's first claim, used in anger.
 */
export function corruptBytes(
  bytes: Uint8Array,
  kind: CorruptionKind,
  dataByteOffset?: number,
): Uint8Array {
  if (bytes.length < 16) throw new Error('file is too small to corrupt meaningfully')
  const out = bytes.slice()
  switch (kind) {
    case 'truncate-tail':
      return out.slice(0, out.length - 8)
    case 'clobber-magic': {
      for (let i = 0; i < 4; i += 1) out[out.length - 4 + i] = 0x58 /* 'X' */
      return out
    }
    case 'lie-about-footer-length': {
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
      /* Little-endian, per the format. Larger than any plausible file. */
      view.setUint32(out.length - 8, 0xfffffff0, true)
      return out
    }
    case 'flip-a-data-byte': {
      const fallback = Math.floor(out.length / 3)
      const at =
        dataByteOffset !== undefined && dataByteOffset > 0 && dataByteOffset < out.length
          ? dataByteOffset
          : fallback
      out[at] ^= 0xff
      return out
    }
  }
}

/**
 * Where to aim the value corruption: the middle of the middle row group's chunk
 * for one column, located from the footer. Returns null if the footer does not
 * carry the offsets, in which case the mutation falls back to a fraction of the
 * file and the lab's anomaly panel will say if that produced nothing.
 */
export const dataByteTargetSql = (path: string, column: string): string => `
    SELECT (data_page_offset + (total_compressed_size // 2))::BIGINT AS byte_offset
    FROM parquet_metadata('${path}')
    WHERE path_in_schema = '${column}'
      AND data_page_offset IS NOT NULL
      AND total_compressed_size > 64
    ORDER BY row_group_id
    OFFSET (SELECT count(DISTINCT row_group_id) // 2 FROM parquet_metadata('${path}'))
    LIMIT 1
  `

export async function dataByteTarget(path: string, column: string): Promise<number | null> {
  try {
    const r = await query<{ byte_offset: number }>(dataByteTargetSql(path, column))
    return r[0]?.byte_offset ?? null
  } catch {
    return null
  }
}

export interface CorruptionResult extends CorruptionProbe {
  /** Did the probe execute at all? False means the UI must say so, not pretend. */
  ran: boolean
  /** Did the engine refuse to read the file? */
  refused: boolean
  /** The engine's OWN message, verbatim. Never authored here. */
  error: string | null
  /** Rows the engine returned when it did not refuse. */
  rowsReturned: number | null
  /** For the value-corruption probe: did the answer still match the original? */
  answerMatchedOriginal: boolean | null
  /** Byte offset the mutation struck, where the mutation targets one. */
  byteOffset: number | null
  /** Why the probe could not run, verbatim from whatever refused to cooperate. */
  unavailableReason: string | null
  /** Set when the outcome contradicts `shouldRefuse`. Reported, never hidden. */
  anomaly: string | null
}

/**
 * A cheap whole-file aggregate, so value corruption can be detected as a wrong
 * answer rather than only as an absent error. The column is a parameter because
 * the probe runs against whichever file the caller nominates.
 */
export const CHECKSUM_COLUMN = 'customer_id'

export const checksumSql = (path: string, column: string = CHECKSUM_COLUMN): string =>
  `SELECT count(*)::BIGINT AS rows, sum(${column})::BIGINT AS checksum FROM read_parquet('${path}')`

/**
 * Run every mutation against a real file and record what the engine did.
 *
 * The probe is deliberately double-barrelled: it asks for the FOOTER
 * (`parquet_metadata`) and then for the DATA (`read_parquet`), because those fail
 * at different depths and a reader that refused only one of them would be worth
 * knowing about.
 */
export async function runCorruptionProbes(
  store: FileStore | null,
  sourcePath: string,
  opts: { dir?: string; onStep?: (s: string) => void; checksumColumn?: string } = {},
): Promise<CorruptionResult[]> {
  const dir = opts.dir ?? ''
  const checksumColumn = opts.checksumColumn ?? CHECKSUM_COLUMN
  const blank = (p: CorruptionProbe, reason: string): CorruptionResult => ({
    ...p,
    ran: false,
    refused: false,
    error: null,
    rowsReturned: null,
    answerMatchedOriginal: null,
    byteOffset: null,
    unavailableReason: reason,
    anomaly: null,
  })

  if (!store) {
    return CORRUPTIONS.map((p) =>
      blank(
        p,
        'this build does not expose byte-level access to the engine’s filesystem, so no file was corrupted and no refusal was obtained',
      ),
    )
  }

  let original: Uint8Array
  try {
    original = await store.read(sourcePath)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return CORRUPTIONS.map((p) => blank(p, `could not read ${sourcePath} back as bytes: ${reason}`))
  }

  /* The truth the value-corruption probe is compared against. */
  let baseline: { rows: number; checksum: number } | null = null
  try {
    baseline =
      (await query<{ rows: number; checksum: number }>(checksumSql(sourcePath, checksumColumn)))[0] ??
      null
  } catch {
    /* Without a baseline the flip probe can still report refusal, just not wrongness. */
  }

  /* Where the value corruption will strike, located from the footer. */
  const flipOffset = await dataByteTarget(sourcePath, checksumColumn)

  const out: CorruptionResult[] = []
  for (const p of CORRUPTIONS) {
    opts.onStep?.(`corrupting a copy: ${p.label}`)
    const target = dir ? `${dir}/corrupt-${p.kind}.parquet` : `corrupt-${p.kind}.parquet`
    const offset = p.kind === 'flip-a-data-byte' ? flipOffset : null

    try {
      await store.write(target, corruptBytes(original, p.kind, offset ?? undefined))
    } catch (e) {
      out.push(
        blank(p, `could not write the corrupted copy: ${e instanceof Error ? e.message : String(e)}`),
      )
      continue
    }

    let refused = false
    let error: string | null = null
    let rowsReturned: number | null = null
    let answerMatchedOriginal: boolean | null = null

    /* Level 0 first: can the footer be parsed at all? */
    try {
      await query(`SELECT count(*)::BIGINT AS n FROM parquet_metadata('${target}')`)
    } catch (e) {
      refused = true
      error = e instanceof Error ? e.message : String(e)
    }

    /* Then the data, which fails at a different depth. */
    if (!refused) {
      try {
        const r = (
          await query<{ rows: number; checksum: number }>(checksumSql(target, checksumColumn))
        )[0]
        rowsReturned = r?.rows ?? null
        if (baseline && r) {
          answerMatchedOriginal = r.rows === baseline.rows && r.checksum === baseline.checksum
        }
      } catch (e) {
        refused = true
        error = e instanceof Error ? e.message : String(e)
      }
    }

    const anomalies: string[] = []
    if (p.shouldRefuse && !refused) {
      anomalies.push(
        'this build accepted a file this lab expected it to refuse, which is a stronger finding than the one the lab was written to show',
      )
    }
    if (!p.shouldRefuse && refused) {
      anomalies.push(
        'this build refused a value-level corruption the lab expected it to accept silently — so page checksums are being written or verified here, which is better than the lab predicted',
      )
    }
    if (!p.shouldRefuse && !refused && answerMatchedOriginal === true) {
      anomalies.push(
        'the flipped byte did not change the answer — it likely landed in a byte this query does not decode, so this run does not demonstrate silent corruption',
      )
    }
    if (p.kind === 'flip-a-data-byte' && offset === null) {
      anomalies.push(
        'the byte to flip could not be located from the footer, so the mutation fell back to a fixed fraction of the file and may have missed the column being checked',
      )
    }

    out.push({
      ...p,
      ran: true,
      refused,
      error,
      rowsReturned,
      answerMatchedOriginal,
      byteOffset: offset,
      unavailableReason: null,
      anomaly: anomalies.length > 0 ? anomalies.join('; ') : null,
    })
  }

  return out
}

/* --------------------------------- formatting ------------------------------ */

export const fmtCount = (n: number): string => n.toLocaleString('en-US')

export const fmtShare = (r: number): string =>
  r >= 0.1 ? `${(r * 100).toFixed(1)}%` : r >= 0.001 ? `${(r * 100).toFixed(2)}%` : `${(r * 100).toFixed(3)}%`
