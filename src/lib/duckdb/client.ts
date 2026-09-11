/**
 * duckdb-wasm client — a real columnar engine, in the reader's tab.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * columnspaces makes quantitative claims: 2% of the bytes, ~10x compression,
 * 90% of row groups pruned. A course that asks to be believed on those numbers
 * has already lost the argument it is trying to teach. This module lets a lesson
 * say "run it and read the number" instead.
 *
 * ── Load discipline (non-negotiable) ───────────────────────────────────────
 * 1. The duckdb module is imported DYNAMICALLY, inside `getDuck()`, and nothing
 *    at module scope touches it. Anything the lesson registry imports must stay
 *    out of the shared lesson chunk.
 * 2. The engine binary is fetched from jsDelivr via duckdb's own bundle helper
 *    rather than vendored into `public/`. The .wasm is ~33 MB: shipping it would
 *    put 33 MB into every GitHub Pages deploy for a file most readers of most
 *    lessons never request. The tradeoff is real and is stated to the reader in
 *    the lab UI — the first run of a duck lab downloads an engine.
 * 3. We select the non-threaded bundle path. The COI (cross-origin isolated)
 *    bundle needs `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
 *    response headers, and GitHub Pages cannot set headers. `selectBundle`
 *    already declines COI when the environment is not isolated; we never ask
 *    for it.
 * 4. One database per tab, memoised. Instantiating twice would download twice.
 *
 * Nothing about the reader leaves the machine: this fetches code from a CDN and
 * runs queries locally, in the tab, against data generated in the tab.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

export type DuckStatus =
  | { phase: 'idle' }
  | { phase: 'loading'; detail: string }
  | { phase: 'ready' }
  | { phase: 'error'; message: string }

/** Progress reporting, because a 33 MB download with no feedback looks broken. */
export type StatusSink = (s: DuckStatus) => void

let dbPromise: Promise<AsyncDuckDB> | null = null

/**
 * Instantiate (once per tab) and return the database handle.
 * Safe to call concurrently: callers share one promise.
 */
export async function getDuck(onStatus?: StatusSink): Promise<AsyncDuckDB> {
  if (dbPromise) {
    onStatus?.({ phase: 'ready' })
    return dbPromise
  }

  dbPromise = (async () => {
    onStatus?.({ phase: 'loading', detail: 'fetching the engine' })

    /* Dynamic import: keeps duckdb out of every chunk that does not use it. */
    const duckdb = await import('@duckdb/duckdb-wasm')

    const bundles = duckdb.getJsDelivrBundles()
    const bundle = await duckdb.selectBundle(bundles)

    onStatus?.({ phase: 'loading', detail: 'starting the worker' })

    /*
     * The worker script lives on the CDN, and browsers refuse to construct a
     * Worker from a cross-origin URL directly. The documented workaround is a
     * same-origin blob that importScripts() the real one.
     */
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
    )
    const worker = new Worker(workerUrl)

    try {
      const logger = new duckdb.VoidLogger()
      const db = new duckdb.AsyncDuckDB(logger, worker)
      onStatus?.({ phase: 'loading', detail: 'instantiating (this is the big download)' })
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
      onStatus?.({ phase: 'ready' })
      return db
    } finally {
      /* The blob has been consumed by the worker; release the object URL. */
      URL.revokeObjectURL(workerUrl)
    }
  })()

  try {
    return await dbPromise
  } catch (e) {
    dbPromise = null /* let the reader retry rather than being stuck */
    const message = e instanceof Error ? e.message : String(e)
    onStatus?.({ phase: 'error', message })
    throw e
  }
}

let connPromise: Promise<AsyncDuckDBConnection> | null = null

/** One connection per tab, memoised alongside the database. */
export async function getConnection(onStatus?: StatusSink): Promise<AsyncDuckDBConnection> {
  if (!connPromise) {
    connPromise = getDuck(onStatus).then((db) => db.connect())
  }
  try {
    return await connPromise
  } catch (e) {
    connPromise = null
    throw e
  }
}

/**
 * Run a query and return plain JS row objects.
 *
 * Arrow is the native result format and is faster to keep, but every consumer
 * here is a small aggregate destined for a React table, and BigInt→number
 * normalisation in one place beats it scattered across labs. Counts in this
 * course are byte counts and row counts: they arrive from duckdb as BigInt and
 * would otherwise silently break arithmetic (`1n * 2` throws).
 */
export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const conn = await getConnection()
  const table = await conn.query(sql)
  return table.toArray().map((row) => {
    const obj = row.toJSON() as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'bigint') obj[k] = Number(v)
    }
    return obj as T
  })
}

/** Run statements that return nothing (DDL, COPY). */
export async function exec(sql: string): Promise<void> {
  const conn = await getConnection()
  await conn.query(sql)
}

/** First row of a query, or undefined. */
export async function queryOne<T = Record<string, unknown>>(sql: string): Promise<T | undefined> {
  const rows = await query<T>(sql)
  return rows[0]
}

/** Has the engine already been downloaded in this tab? Drives the UI copy. */
export const isDuckLoaded = (): boolean => dbPromise !== null
