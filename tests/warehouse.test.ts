/**
 * The Warehouse — model tests.
 *
 * These guard the four claims the page makes to the reader. Each one is a claim
 * a lesson is written against, so if one breaks the lesson is lying:
 *
 *   1. DETERMINISM. Same seed, same counts, twice. Without this the reference
 *      diff is noise and no lesson can quote a number.
 *   2. CLUSTERING PAYS. A clustered layout prunes far more than a shuffled one
 *      on the dashboard trace. This is the course's central layout claim.
 *   3. AD-HOC RESISTS. The analyst trace prunes far less than the dashboard.
 *      If the model cannot show that, it cannot teach why quotas exist.
 *   4. SKEW IS INVISIBLE IN THE MEAN. The skewed join's busiest exchange bucket
 *      sits far above the mean.
 *
 * Plus the invariant that outranks all four: no metric is ever NaN, and no
 * count is ever negative. A NaN on the page destroys trust in every other
 * number next to it.
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import Warehouse from '@/pages/Warehouse'
import {
  ENCODINGS,
  LOWER_IS_BETTER,
  METRIC_KEYS,
  REFERENCE_LAYOUT,
  SHUFFLE_BUCKETS,
  beatsReference,
  cloneLayout,
  columnCosts,
  compareToReference,
  encodingFactor,
  runTrace,
  type Layout,
} from '@/lib/warehouse/engine'
import { TRACE_MODES, TRACE_SEED, buildTrace, scansOf, writesOf } from '@/lib/warehouse/trace'
import { COLUMN_IDS, PARTITION_KEYS, TABLE_ROWS, partitionRows } from '@/lib/warehouse/table'

const dashboard = buildTrace('dashboard')
const adhoc = buildTrace('adhoc')
const ingest = buildTrace('ingest')
const skew = buildTrace('skew')

const clustered: Layout = { ...cloneLayout(REFERENCE_LAYOUT), clustering: 1 }
const shuffled: Layout = { ...cloneLayout(REFERENCE_LAYOUT), clustering: 0 }

/** Every number reachable from a report, flattened, for the NaN/negative sweep. */
function numbersOf(value: unknown, path = 'root', out: [string, number][] = []): [string, number][] {
  if (typeof value === 'number') out.push([path, value])
  else if (Array.isArray(value)) value.forEach((v, i) => numbersOf(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) numbersOf(v, `${path}.${k}`, out)
  }
  return out
}

describe('trace generation', () => {
  it('exposes exactly the four contracted mode ids', () => {
    expect(TRACE_MODES.map((m) => m.id)).toEqual(['dashboard', 'adhoc', 'ingest', 'skew'])
  })

  it('is deterministic: same seed, same trace, twice', () => {
    for (const m of TRACE_MODES) {
      expect(buildTrace(m.id)).toEqual(buildTrace(m.id))
    }
  })

  it('a different seed gives a different trace (the seed is actually used)', () => {
    expect(buildTrace('dashboard', TRACE_SEED + 1)).not.toEqual(buildTrace('dashboard'))
  })

  it('every query names its projection and its predicate range', () => {
    for (const t of [dashboard, adhoc, skew]) {
      for (const q of scansOf(t)) {
        expect(q.columns.length).toBeGreaterThan(0)
        for (const c of q.columns) expect(COLUMN_IDS).toContain(c)
        for (const p of q.predicates) {
          expect(p.hi).toBeGreaterThan(p.lo)
          expect(p.lo).toBeGreaterThanOrEqual(0)
          expect(p.hi).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('only the ingest trace writes, and every write moves rows', () => {
    expect(writesOf(dashboard)).toHaveLength(0)
    expect(writesOf(adhoc)).toHaveLength(0)
    expect(writesOf(skew)).toHaveLength(0)
    const w = writesOf(ingest)
    expect(w.length).toBeGreaterThan(0)
    for (const q of w) {
      expect(q.rowsWritten).toBeGreaterThan(0)
      expect(q.columns).toHaveLength(0)
    }
    /* The ingest trace still has to read, or it could not show read amplification. */
    expect(scansOf(ingest).length).toBeGreaterThan(0)
  })
})

describe('the table model', () => {
  it('describes the same table however it is partitioned', () => {
    for (const pk of PARTITION_KEYS) {
      const rows = partitionRows(pk.id)
      expect(rows).toHaveLength(pk.count)
      expect(rows.reduce((a, b) => a + b, 0)).toBe(TABLE_ROWS)
      for (const r of rows) expect(r).toBeGreaterThan(0)
    }
  })

  it('tenant partitions are skewed and day partitions are not', () => {
    const tenant = partitionRows('tenant')
    const day = partitionRows('day')
    const skewOf = (xs: number[]) => Math.max(...xs) / (xs.reduce((a, b) => a + b, 0) / xs.length)
    expect(skewOf(tenant)).toBeGreaterThan(4)
    expect(skewOf(day)).toBeLessThan(1.5)
  })
})

describe('determinism', () => {
  it('the same trace and layout produce identical counts, twice', () => {
    for (const t of [dashboard, adhoc, ingest, skew]) {
      const a = runTrace(t, REFERENCE_LAYOUT)
      const b = runTrace(t, REFERENCE_LAYOUT)
      expect(a.metrics).toEqual(b.metrics)
      expect(a.detail).toEqual(b.detail)
      expect(a.queries).toEqual(b.queries)
      expect(a.columns).toEqual(b.columns)
    }
  })

  it('a rebuilt trace object replays to the same counts (no hidden state)', () => {
    const first = runTrace(buildTrace('ingest'), REFERENCE_LAYOUT)
    const second = runTrace(buildTrace('ingest'), REFERENCE_LAYOUT)
    expect(second.metrics).toEqual(first.metrics)
  })
})

describe('clustering pays on the dashboard trace', () => {
  const good = runTrace(dashboard, clustered)
  const bad = runTrace(dashboard, shuffled)

  it('a clustered layout prunes far more than a shuffled one', () => {
    expect(good.metrics.pruningRatio).toBeGreaterThan(bad.metrics.pruningRatio)
    expect(good.metrics.rowGroupsRead * 4).toBeLessThan(bad.metrics.rowGroupsRead)
  })

  it('and the bill follows the pruning', () => {
    expect(good.metrics.bytesScanned * 3).toBeLessThan(bad.metrics.bytesScanned)
  })

  it('clustering does not change the file count — only partition pruning does', () => {
    /* Footers of every candidate file must be read to prune at all, so
     * clustering cannot reduce filesTouched. This is the asymmetry that makes
     * a small-file storm expensive even on a well-clustered table. */
    expect(good.metrics.filesTouched).toBe(bad.metrics.filesTouched)
  })
})

describe('the analyst resists pruning', () => {
  const dash = runTrace(dashboard, REFERENCE_LAYOUT)
  const wide = runTrace(adhoc, REFERENCE_LAYOUT)

  it('adhoc prunes far less than dashboard', () => {
    expect(wide.metrics.pruningRatio).toBeLessThan(dash.metrics.pruningRatio * 0.5)
  })

  it('and scans far more bytes for it', () => {
    expect(wide.metrics.bytesScanned).toBeGreaterThan(dash.metrics.bytesScanned * 10)
  })
})

describe('the skewed join hides in the mean', () => {
  const s = runTrace(skew, REFERENCE_LAYOUT)
  const d = runTrace(dashboard, REFERENCE_LAYOUT)

  it('the busiest exchange bucket sits far above the mean', () => {
    expect(s.detail.shuffleSkew).toBeGreaterThan(4)
    expect(s.detail.shuffleMaxBytes).toBeGreaterThan(s.detail.shuffleMeanBytes * 4)
  })

  it('an even group-by does not, so the metric means something', () => {
    expect(d.detail.shuffleSkew).toBeLessThan(2)
  })

  it('a trace that shuffles nothing reports 0 skew, not NaN', () => {
    const none = runTrace(ingest, REFERENCE_LAYOUT)
    expect(none.metrics.bytesShuffled).toBe(0)
    expect(none.detail.shuffleSkew).toBe(0)
  })

  it('shuffled bytes are conserved across the buckets', () => {
    expect(s.detail.shuffleMeanBytes * SHUFFLE_BUCKETS).toBeCloseTo(s.metrics.bytesShuffled, 3)
  })
})

describe('merge-on-read: compaction pays down read amplification', () => {
  const never: Layout = { ...cloneLayout(REFERENCE_LAYOUT), compactEvery: 0 }
  const often: Layout = { ...cloneLayout(REFERENCE_LAYOUT), compactEvery: 2 }

  it('never compacting leaves more files open and reads more metadata', () => {
    const a = runTrace(ingest, never)
    const b = runTrace(ingest, often)
    expect(a.detail.smallFilesOpen).toBeGreaterThan(b.detail.smallFilesOpen)
    expect(a.detail.metadataBytes).toBeGreaterThan(b.detail.metadataBytes)
    expect(a.metrics.filesTouched).toBeGreaterThan(b.metrics.filesTouched)
  })

  it('compaction is not free — it rewrites bytes', () => {
    const a = runTrace(ingest, never)
    const b = runTrace(ingest, often)
    expect(a.detail.bytesRewritten).toBe(0)
    expect(b.detail.bytesRewritten).toBeGreaterThan(0)
  })
})

describe('encodings are modelled as mechanisms, wins and losses alike', () => {
  it('a dictionary is a big win on a 6-value column', () => {
    expect(encodingFactor('region', 'dict', REFERENCE_LAYOUT)).toBeGreaterThan(4)
  })

  it('a dictionary is a loss on a nearly-unique column', () => {
    expect(encodingFactor('payload', 'dict', REFERENCE_LAYOUT)).toBeLessThan(1)
  })

  it('run-length expands unclustered data and pays on the sort key', () => {
    const onSortKey = encodingFactor('tenant_id', 'rle', clustered)
    const offSortKey = encodingFactor('user_id', 'rle', clustered)
    expect(onSortKey).toBeGreaterThan(2)
    expect(offSortKey).toBeLessThan(1)
  })

  it('delta does nothing to a string, and the model refuses to reward it', () => {
    expect(encodingFactor('event_type', 'delta', REFERENCE_LAYOUT)).toBe(1)
  })

  it('bit-packing does nothing to a float', () => {
    expect(encodingFactor('amount', 'bitpack', REFERENCE_LAYOUT)).toBe(1)
  })

  it('block compression is the only lever on the wide, nearly-unique column', () => {
    const others = (['plain', 'dict', 'rle', 'delta', 'bitpack'] as const).map((e) =>
      encodingFactor('payload', e, REFERENCE_LAYOUT),
    )
    for (const f of others) expect(f).toBeLessThanOrEqual(1)
    expect(encodingFactor('payload', 'zstd', REFERENCE_LAYOUT)).toBeGreaterThan(2)
  })

  it('a dictionary still beats block compression on a 6-value column', () => {
    /* Otherwise the model would teach that reaching for a generic codec is as
     * good as understanding the column, which is the opposite of the lesson. */
    expect(encodingFactor('region', 'dict', REFERENCE_LAYOUT)).toBeGreaterThan(
      encodingFactor('region', 'zstd', REFERENCE_LAYOUT),
    )
  })

  it('every column cost is positive and finite under every encoding', () => {
    for (const enc of ENCODINGS) {
      const layout = cloneLayout(REFERENCE_LAYOUT)
      for (const id of COLUMN_IDS) layout.encodings[id] = enc.id
      for (const c of columnCosts(layout)) {
        expect(Number.isFinite(c.bytesPerRow)).toBe(true)
        expect(c.bytesPerRow).toBeGreaterThan(0)
        expect(c.storedBytes).toBeGreaterThan(0)
      }
    }
  })
})

describe('the reference diff', () => {
  it('the reference layout ties itself on every metric', () => {
    const { deltas } = compareToReference(dashboard, cloneLayout(REFERENCE_LAYOUT))
    for (const d of deltas) {
      expect(d.delta).toBe(0)
      expect(d.better).toBe(true)
    }
    expect(beatsReference(dashboard, cloneLayout(REFERENCE_LAYOUT))).toBe(true)
  })

  it('the reference is beatable — there is a better layout to find', () => {
    const better = cloneLayout(REFERENCE_LAYOUT)
    better.clustering = 1
    better.encodings.region = 'dict'
    better.encodings.event_type = 'dict'
    better.encodings.device = 'dict'
    better.encodings.payload = 'zstd'
    expect(beatsReference(dashboard, better)).toBe(true)
    const { deltas } = compareToReference(dashboard, better)
    const bytes = deltas.find((d) => d.key === 'bytesScanned')
    expect(bytes?.delta).toBeLessThan(0)
    /* The payload codec moves the storage ratio without touching the dashboard's
     * scan bill — the two metrics are not the same lever, and the page has to
     * be able to show that. */
    const comp = deltas.find((d) => d.key === 'compressionRatio')
    expect(comp?.delta).toBeGreaterThan(0)
  })

  it('a bad layout loses on bytes scanned', () => {
    const worse = cloneLayout(REFERENCE_LAYOUT)
    worse.partitionKey = 'none'
    worse.clustering = 0.05
    expect(beatsReference(dashboard, worse)).toBe(false)
  })

  it('covers exactly the seven contracted metrics, each with a direction', () => {
    expect(METRIC_KEYS).toEqual([
      'bytesScanned',
      'rowGroupsRead',
      'rowGroupsPruned',
      'pruningRatio',
      'compressionRatio',
      'filesTouched',
      'bytesShuffled',
    ])
    for (const k of METRIC_KEYS) expect(typeof LOWER_IS_BETTER[k]).toBe('boolean')
  })
})

describe('no metric is ever NaN or negative', () => {
  /* The sweep covers every trace against every partition key, both clustering
   * extremes and a uniform encoding, because the divide-by-zero cases hide in
   * the corners: an unpartitioned table, a write-only stretch, a layout whose
   * row group is larger than a whole partition. */
  const layouts: Layout[] = []
  for (const pk of PARTITION_KEYS) {
    for (const clustering of [0, 0.5, 1]) {
      for (const rowGroupRows of [8_192, 131_072, 4_000_000]) {
        layouts.push({
          ...cloneLayout(REFERENCE_LAYOUT),
          partitionKey: pk.id,
          clustering,
          rowGroupRows,
          fileRows: Math.max(rowGroupRows, 1_048_576),
        })
      }
    }
  }
  for (const sortKey of [...COLUMN_IDS, 'none'] as const) {
    layouts.push({ ...cloneLayout(REFERENCE_LAYOUT), sortKey })
  }
  for (const compactEvery of [0, 1, 3]) {
    layouts.push({ ...cloneLayout(REFERENCE_LAYOUT), compactEvery })
  }

  it(`survives every trace × ${layouts.length} layouts with finite, non-negative counts`, () => {
    for (const t of [dashboard, adhoc, ingest, skew]) {
      for (const layout of layouts) {
        const report = runTrace(t, layout)
        for (const [path, n] of numbersOf(report)) {
          expect(Number.isFinite(n), `${t.mode} ${layout.partitionKey} ${path} = ${n}`).toBe(true)
          expect(n, `${t.mode} ${layout.partitionKey} ${path} = ${n}`).toBeGreaterThanOrEqual(0)
        }
        expect(report.metrics.pruningRatio).toBeLessThanOrEqual(1)
        expect(report.metrics.rowGroupsRead).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('never reads more row groups than the table has, per query', () => {
    for (const t of [dashboard, adhoc, ingest, skew]) {
      const r = runTrace(t, REFERENCE_LAYOUT)
      for (const q of r.queries) {
        expect(q.rowGroupsRead).toBeLessThanOrEqual(r.detail.totalRowGroups)
        expect(q.rowsRead).toBeLessThanOrEqual(TABLE_ROWS)
      }
    }
  })
})

describe('the page', () => {
  /**
   * A render, not a snapshot. `tsc` cannot catch a metric key that does not
   * exist in the report or an undefined dereference inside a formatter, and
   * those would ship as a blank route. Rendered on the server, so effects do
   * not run — this asserts the FIRST PAINT is honest, which is the state a
   * reader arrives in.
   */
  const html = renderToString(
    createElement(MemoryRouter, { initialEntries: ['/warehouse'] }, createElement(Warehouse)),
  )

  it('renders the initial run without crashing', () => {
    expect(html).toContain('The Warehouse')
    expect(html.length).toBeGreaterThan(10_000)
  })

  it('puts no NaN, no Infinity and no undefined on the page', () => {
    for (const bad of ['NaN', 'Infinity', 'undefined']) expect(html).not.toContain(bad)
  })

  it('names all four traces and every metric it promises', () => {
    /* Rendered HTML escapes `&`, so compare against the escaped form rather
     * than loosening the assertion to a substring that could pass by accident. */
    for (const m of TRACE_MODES) expect(html).toContain(m.name.replace(/&/g, '&amp;'))
    for (const s of ['bytes scanned', 'pruning ratio', 'compression ratio', 'files touched', 'bytes shuffled']) {
      expect(html).toContain(s)
    }
  })

  it('opens on the reference layout, so the first thing a reader sees is a tie', () => {
    expect(html).toContain('tie')
  })
})
