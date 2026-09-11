/**
 * DuckDB labs — the empirical tier.
 *
 * Three grading tiers exist in this course and they answer different
 * questions:
 *
 *   forge (Rust → wasm)  "can you build it so the invariants hold?"
 *   browser (TypeScript) "can you reason about it / compute it?"
 *   duck (DuckDB-wasm)   "is what the lesson told you actually true?"
 *
 * This tier exists because columnspaces makes quantitative claims — 2% of the
 * bytes, ~10x compression, 90% of row groups pruned — and a course that asks
 * to be believed on those numbers has already lost the argument it is trying
 * to teach. A duck lab runs a real columnar engine in the tab against a real
 * Parquet fixture and shows the reader the profile output.
 *
 * ── Load discipline (non-negotiable) ────────────────────────────────────────
 * duckdb-wasm is multi-megabyte. It is imported DYNAMICALLY, inside the
 * component, never at module scope, and never from anything the lesson
 * registry imports — otherwise it lands in the shared lesson chunk and undoes
 * the first-paint budget (~60kB) inherited from the platform shell. The non-threaded
 * bundle is the target: GitHub Pages cannot serve cross-origin-isolation
 * headers, so the threaded build is not an option.
 */

import { type ReactNode } from 'react'
import { Database } from 'lucide-react'
import { duckLabMeta } from '@/data/duck-labs'

/**
 * The registry. Populated as each lab lands (phase 2 onward, PLAN.md).
 * Unknown ids render the placeholder rather than throwing — a lesson may
 * legitimately reference a lab that is still being built.
 */
const REGISTRY: Record<string, (p: { trackColor: string }) => ReactNode> = {}

export function DuckLabView({ lab, trackColor }: { lab: string; trackColor: string }) {
  const C = REGISTRY[lab]
  if (!C) {
    const meta = duckLabMeta(lab)
    return (
      <section className="my-8 rounded-lg border border-dashed border-line bg-surface-1 px-5 py-8 text-center">
        <Database className="mx-auto h-5 w-5 text-text-3" strokeWidth={1.75} />
        <p className="mt-2 font-display text-body-sm text-text-2">{meta?.title ?? lab}</p>
        <p className="mt-1 font-mono text-[11px] text-text-3">
          duckdb lab — being built
        </p>
        {meta && <p className="mx-auto mt-3 max-w-prose text-body-sm text-text-3">{meta.hook}</p>}
      </section>
    )
  }
  return <C trackColor={trackColor} />
}
