/**
 * vfs — a byte-level handle on the files a duck lab writes.
 *
 * ── Why this port exists ───────────────────────────────────────────────────
 * Two C3 labs need something SQL cannot express. `parquet-anatomy` has to hand
 * the reader a genuinely malformed file and show them the engine's own refusal;
 * `snapshot-lab` has to actually delete superseded files to prove the storage
 * comes back. Neither is a query.
 *
 * In the browser those operations exist on the duckdb-wasm database handle
 * (`copyFileToBuffer` / `registerFileBuffer` / `dropFile`) and nowhere else. In
 * the Node test suite the same three operations are `readFileSync` /
 * `writeFileSync` / `unlinkSync`. So the labs take a `FileStore` rather than
 * reaching for either, which keeps one measurement implementation running in
 * both places — the same discipline the rest of `src/lib/duckdb` follows.
 *
 * ── The honesty clause ────────────────────────────────────────────────────
 * `FileStore` is nullable everywhere it is consumed. If a build does not offer
 * these bindings, the lab must say so in the UI and report the observation as
 * NOT MADE. It must never simulate a refusal it did not obtain, or claim to have
 * reclaimed storage it did not free. A fabricated error message is worse than an
 * absent one: it teaches the reader to trust a number nobody measured.
 */

import { getDuck } from './client'

export interface FileStore {
  /** Read a file out of the engine's filesystem as raw bytes. */
  read(path: string): Promise<Uint8Array>
  /** Write raw bytes to a path the engine can then read as a file. */
  write(path: string, bytes: Uint8Array): Promise<void>
  /** Remove a file. Used to perform snapshot expiry rather than estimate it. */
  remove(path: string): Promise<void>
}

/**
 * The duckdb-wasm implementation.
 *
 * `write` drops any existing registration first: duckdb-wasm rejects
 * re-registering a name, and a lab that is run twice must not fail on its second
 * press. The drop is expected to throw for a name that was never registered, so
 * that throw is swallowed and only the register call is allowed to fail.
 */
export function browserFileStore(): FileStore {
  return {
    async read(path: string): Promise<Uint8Array> {
      const db = await getDuck()
      return db.copyFileToBuffer(path)
    },
    async write(path: string, bytes: Uint8Array): Promise<void> {
      const db = await getDuck()
      try {
        await db.dropFile(path)
      } catch {
        /* Nothing registered under that name yet. That is the normal case. */
      }
      await db.registerFileBuffer(path, bytes)
    },
    async remove(path: string): Promise<void> {
      const db = await getDuck()
      await db.dropFile(path)
    },
  }
}

/**
 * Probe the store before a lab depends on it, and return the reason it cannot be
 * used rather than a bare boolean. The reason is printed to the reader verbatim.
 */
export async function fileStoreUnavailableReason(
  store: FileStore | null,
  probePath: string,
): Promise<string | null> {
  if (!store) return 'this build does not expose byte-level access to the engine’s filesystem'
  try {
    const bytes = await store.read(probePath)
    if (bytes.length === 0) return `reading ${probePath} back returned zero bytes`
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
