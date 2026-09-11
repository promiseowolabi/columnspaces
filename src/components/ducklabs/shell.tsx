/**
 * Duck lab shell — frame, task checklist and completion recording.
 *
 * Deliberately separate from the browser-lab shell rather than reused: a duck
 * lab has a different contract (it can fail because a CDN is blocked, it states
 * a claim the reader is invited to falsify) and a different progress namespace
 * (`dlab:` not `blab:`), so a reader's empirical work is distinguishable from
 * their conceptual work in an exported snapshot.
 */

import { useEffect, type ReactNode } from 'react'
import { Check, Database } from 'lucide-react'
import { duckLabMeta } from '@/data/duck-labs'
import { useProgress } from '@/lib/progress'
import { cn } from '@/lib/utils'

export interface DuckTask {
  id: string
  label: string
  done: boolean
  /** One-line hint shown until the task is done. */
  hint?: string
}

export function DuckLabShell({
  labId,
  trackColor,
  children,
  tasks,
}: {
  labId: string
  trackColor: string
  children: ReactNode
  tasks: DuckTask[]
}) {
  const meta = duckLabMeta(labId)
  const allDone = tasks.length > 0 && tasks.every((t) => t.done)
  const doneCount = tasks.filter((t) => t.done).length
  const recordSimTask = useProgress((s) => s.recordSimTask)

  useEffect(() => {
    if (allDone) recordSimTask(`dlab:${labId}`, 'complete')
  }, [allDone, labId, recordSimTask])

  return (
    <section className="my-8 overflow-hidden rounded-lg border border-line bg-surface-1" data-ducklab={labId}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-3">
          <Database size={14} style={{ color: trackColor }} strokeWidth={1.75} />
          <span className="font-mono text-label uppercase" style={{ color: trackColor }}>
            duckdb lab
          </span>
          <span className="font-display text-body-sm font-medium text-text-1">{meta?.title ?? labId}</span>
        </div>
        <span className="font-mono text-[11px] text-text-3">
          {allDone ? (
            <span className="text-accent">
              <Check className="mr-1 inline h-3 w-3" />
              complete
            </span>
          ) : (
            `${doneCount}/${tasks.length} observed`
          )}
        </span>
      </div>

      {meta && (
        <div className="border-b border-line px-5 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-3">claim under test</p>
          <p className="mt-1 text-body-sm text-text-2">{meta.claim}</p>
        </div>
      )}

      <div className="px-5 py-5">{children}</div>

      <div className="border-t border-line px-5 py-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-3">what to observe</p>
        <ul className="mt-2 space-y-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-start gap-2 font-mono text-[12px]">
              <span
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                  t.done ? 'border-accent/60 bg-accent/10 text-accent' : 'border-line text-transparent',
                )}
              >
                <Check size={10} strokeWidth={3} />
              </span>
              <span className={t.done ? 'text-text-2 line-through opacity-70' : 'text-text-2'}>
                {t.label}
                {!t.done && t.hint && <span className="block text-[10.5px] text-text-3">{t.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
        {allDone && (
          <p className="mt-3 font-mono text-[12px] text-accent">
            every claim checked against the engine — not against the author.
          </p>
        )}
      </div>
    </section>
  )
}
