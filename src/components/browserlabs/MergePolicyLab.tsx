/**
 * MergePolicyLab — the C5 browser lab.
 *
 * The reader has been told that merge-on-read moves work from the writer to
 * every subsequent reader, and that compaction moves it back. This lab is where
 * that stops being a sentence: two dials, four counts, and a region of the space
 * where both constraints hold that the reader has to FIND rather than pick.
 *
 * Three decisions carry the pedagogy, all borrowed from the layout designer
 * because they worked there for the same reason:
 *
 *   1. BOTH amplifications are always on screen, side by side, and they move in
 *      opposite directions along both dials. There is no setting that improves
 *      one without paying on the other, so the panel cannot go quiet.
 *   2. The graded task pairs a read CEILING with a write BUDGET. Four of the
 *      thirty policies satisfy both; the policy that minimises read
 *      amplification alone misses the write budget by roughly 6×, and the one
 *      that minimises writes misses the read ceiling. Passing means finding a
 *      policy, not expressing a preference.
 *   3. One graded pick asks the reader to name the target file size that NO
 *      trigger can rescue. That case exists because of stranded tombstones — a
 *      restatement against an already-sealed file is not purged by a compactor
 *      that only merges the pile — and it is the answer to the real-world
 *      question "we compacted more often and read amplification did not move".
 *
 * All arithmetic lives in `@/lib/merge/policy`, which reuses the Warehouse
 * engine's `FOOTER_BYTES` and `DELETE_POS_BYTES` rather than re-choosing them, so
 * a reader comparing this lab's read amplification to the Warehouse's is
 * comparing numbers built from the same figures. Every metric is a COUNT and
 * every run is deterministic: the commit sequence comes from the seeded xorshift
 * in `desks/kit` and is built once per workload, then priced against all thirty
 * policies. No wall-clock, no `Math.random`.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowDownUp, Check, Clock, FileStack, Target, Timer, X } from 'lucide-react'
/* LabShell comes from the registry module, which will import this component back
 * once the orchestrator wires it. The cycle is safe because both sides only touch
 * each other at RENDER time, and `LabTask` is a type-only import. */
import { LabShell } from '@/components/browserlabs'
import type { LabTask } from '@/components/browserlabs/shared'
import { fmtBytes, fmtCount } from '@/lib/desks/kit'
import {
  COMMITS,
  DELETE_POS_BYTES,
  FOOTER_BYTES,
  OPENING_POLICY,
  POLICY_GRID,
  REFERENCE_WORKLOAD,
  RETENTION_COMMITS,
  ROW_BYTES,
  TARGETS,
  TARGET_CHOICES,
  TRIGGER_CHOICES,
  WORKLOADS,
  amplificationCorrelation,
  bestReadPolicy,
  bestWritePolicy,
  commitSequence,
  fmtAmp,
  fmtRows,
  meetsTargets,
  policyKey,
  policyReport,
  solvingPolicies,
  strandedTarget,
  targetAxis,
  triggerAxis,
  workloadSpec,
  type Policy,
} from '@/lib/merge/policy'
import { cn } from '@/lib/utils'

export default function MergePolicyLab({ trackColor }: { trackColor: string }) {
  const [workloadId, setWorkloadId] = useState<string>(REFERENCE_WORKLOAD)
  /* Every policy the reader has priced, oldest first. Keeping the trail rather
   * than a pile of booleans means the latched tasks are DERIVED from what
   * happened rather than from an effect firing at the right moment. */
  const [visited, setVisited] = useState<Policy[]>([OPENING_POLICY])
  const [targetPick, setTargetPick] = useState<number | null>(null)

  const policy = visited[visited.length - 1]
  const report = useMemo(() => policyReport(policy, workloadId), [policy, workloadId])
  const check = useMemo(() => meetsTargets(policy, workloadId), [policy, workloadId])
  const spec = workloadSpec(workloadId)

  const bestRead = useMemo(() => bestReadPolicy(workloadId), [workloadId])
  const bestWrite = useMemo(() => bestWritePolicy(workloadId), [workloadId])
  const bestReadReport = policyReport(bestRead, workloadId)
  const bestWriteReport = policyReport(bestWrite, workloadId)
  const solving = useMemo(() => solvingPolicies(workloadId), [workloadId])
  const stranded = useMemo(() => strandedTarget(workloadId), [workloadId])
  const corr = useMemo(() => amplificationCorrelation(workloadId), [workloadId])

  const trigTrend = useMemo(() => triggerAxis(policy.targetFileRows, workloadId), [policy, workloadId])
  const tgtTrend = useMemo(() => targetAxis(policy.triggerFiles, workloadId), [policy, workloadId])

  const commits = useMemo(() => commitSequence(spec), [spec])
  const opCounts = useMemo(
    () => ({
      append: commits.filter((c) => c.kind === 'append').length,
      update: commits.filter((c) => c.kind === 'update').length,
      delete: commits.filter((c) => c.kind === 'delete').length,
      rowsWritten: commits.reduce((n, c) => n + c.rowsWritten, 0),
      rowsDeleted: commits.reduce((n, c) => n + c.rowsDeleted, 0),
    }),
    [commits],
  )

  const choose = useCallback((patch: Partial<Policy>) => {
    setVisited((prev) => [...prev, { ...prev[prev.length - 1], ...patch }])
  }, [])

  /* ------------------------------ grading ------------------------------ */

  /** Did the reader see the two amplifications move against each other? */
  const sawOpposition = useMemo(() => {
    for (let i = 1; i < visited.length; i++) {
      const a = policyReport(visited[i - 1], workloadId)
      const b = policyReport(visited[i], workloadId)
      const dr = b.readAmplification - a.readAmplification
      const dw = b.writeAmplification - a.writeAmplification
      if (dr !== 0 && dw !== 0 && Math.sign(dr) !== Math.sign(dw)) return true
    }
    return false
  }, [visited, workloadId])

  const sawReadOptimum = useMemo(
    () => visited.some((p) => policyKey(p) === policyKey(bestRead)),
    [visited, bestRead],
  )
  const sawWriteOptimum = useMemo(
    () => visited.some((p) => policyKey(p) === policyKey(bestWrite)),
    [visited, bestWrite],
  )
  const heldBoth = useMemo(
    () => visited.some((p) => meetsTargets(p, workloadId).ok),
    [visited, workloadId],
  )
  const allConserved = useMemo(
    () => visited.every((p) => policyReport(p, workloadId).rowsConserved),
    [visited, workloadId],
  )

  const tasks: LabTask[] = useMemo(
    () => [
      {
        id: 'oppose',
        label: 'Move a dial and observe read amplification and write amplification go in opposite directions',
        done: sawOpposition,
        hint: 'Either dial will do it. There is no direction on this surface that improves both.',
      },
      {
        id: 'read-optimal',
        label: `Price the policy that minimises read amplification, and read its write bill`,
        done: sawReadOptimum,
        hint: `Compact constantly into the largest files you can. Read amplification goes to ${fmtAmp(bestReadReport.readAmplification)} — and the same ingested bytes get written ${fmtAmp(bestReadReport.writeAmplification)} over.`,
      },
      {
        id: 'write-optimal',
        label: 'Price the policy that minimises write amplification, and read its read bill',
        done: sawWriteOptimum,
        hint: `Barely compact, into small files. Write amplification bottoms out at ${fmtAmp(bestWriteReport.writeAmplification)} and the readers pay ${fmtAmp(bestWriteReport.readAmplification)} for it, on every query, forever.`,
      },
      {
        id: 'both',
        label: `Hold read amplification at or under ${fmtAmp(TARGETS.readAmpCeiling)} AND write amplification at or under ${fmtAmp(TARGETS.writeAmpBudget)}`,
        done: heldBoth,
        hint: `${solving.length} of the ${POLICY_GRID.length} policies do both. Neither single-objective optimum is one of them, so the answer is not at either end of either dial.`,
      },
      {
        id: 'stranded',
        label: 'Name the target file size that NO trigger setting can bring under the read ceiling',
        done: stranded !== undefined && targetPick === stranded,
        hint: 'Sweep the trigger at each target and watch the best achievable read amplification. One column never gets there, and the reason is not the trigger.',
      },
      {
        id: 'conserved',
        label: 'Observe the row accounting hold in every policy you priced',
        done: visited.length >= 4 && allConserved,
        hint: 'Physical rows − tombstoned rows = live rows, checked after every commit. A policy is allowed to cost more; it is not allowed to lose a row.',
      },
    ],
    [
      sawOpposition,
      sawReadOptimum,
      sawWriteOptimum,
      heldBoth,
      stranded,
      targetPick,
      visited.length,
      allConserved,
      bestReadReport,
      bestWriteReport,
      solving.length,
    ],
  )

  return (
    <LabShell labId="merge-policy" trackColor={trackColor} tasks={tasks}>
      <p className="text-body-sm text-text-2">
        A merge-on-read table, {fmtCount(COMMITS)} commits of appends, updates and deletes, and{' '}
        <strong>two decisions</strong>: how many uncompacted files you tolerate before compacting,
        and how large a compacted file is allowed to get. The lab reports{' '}
        <strong>read amplification</strong> and <strong>write amplification</strong> side by side,
        because every setting that improves one worsens the other — and the graded task asks you to
        hold a ceiling on the first and a budget on the second at the same time.
      </p>
      <p className="mt-2 text-body-sm text-text-3">
        Every number is a count of bytes, rows or files. The commit sequence is seeded and built once
        per write rate, then priced against all {POLICY_GRID.length} policies, so any difference you
        see is caused by your policy and by nothing else.
      </p>

      {/* ------------------------------ the write rate ------------------------ */}
      <div className="mt-5 space-y-3">
        <Knob
          icon={<Timer size={13} />}
          label="write rate"
          note={`${fmtCount(spec.baseRows)} rows to start · ${opCounts.append} appends, ${opCounts.update} updates, ${opCounts.delete} deletes · ${fmtCount(opCounts.rowsWritten)} rows written, ${fmtCount(opCounts.rowsDeleted)} tombstoned`}
        >
          {WORKLOADS.map((w) => (
            <Chip
              key={w.id}
              active={workloadId === w.id}
              color={trackColor}
              onClick={() => {
                setWorkloadId(w.id)
                setTargetPick(null)
              }}
            >
              {w.label}
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<Clock size={13} />}
          label="compaction trigger"
          note={`compact once ${policy.triggerFiles} uncompacted files are live · ${report.compactions} compactions over the run · read amp goes ${trigTrend.readMonotone === 'up' ? 'UP' : trigTrend.readMonotone === 'down' ? 'DOWN' : trigTrend.readMonotone} and write amp goes ${trigTrend.writeMonotone === 'up' ? 'UP' : trigTrend.writeMonotone === 'down' ? 'DOWN' : trigTrend.writeMonotone} as this rises`}
        >
          {TRIGGER_CHOICES.map((t) => (
            <Chip
              key={t}
              active={policy.triggerFiles === t}
              color={trackColor}
              onClick={() => choose({ triggerFiles: t })}
            >
              {t} files
            </Chip>
          ))}
        </Knob>

        <Knob
          icon={<FileStack size={13} />}
          label="target file size"
          note={`${fmtRows(policy.targetFileRows)} rows ≈ ${fmtBytes(policy.targetFileRows * ROW_BYTES)} per sealed file · ${fmtCount(report.sealedFiles)} sealed at the end · read amp goes ${tgtTrend.readMonotone === 'up' ? 'UP' : tgtTrend.readMonotone === 'down' ? 'DOWN' : tgtTrend.readMonotone} and write amp goes ${tgtTrend.writeMonotone === 'up' ? 'UP' : tgtTrend.writeMonotone === 'down' ? 'DOWN' : tgtTrend.writeMonotone} as this rises`}
        >
          {TARGET_CHOICES.map((t) => (
            <Chip
              key={t}
              active={policy.targetFileRows === t}
              color={trackColor}
              onClick={() => choose({ targetFileRows: t })}
            >
              {fmtRows(t)}
            </Chip>
          ))}
        </Knob>
      </div>

      {/* ------------------------------ the four counts ----------------------- */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="read amplification"
          value={fmtAmp(report.readAmplification)}
          sub={`${fmtBytes(report.bytesScannedData + report.bytesScannedMetadata)} scanned ÷ ${fmtBytes(report.bytesNeeded)} needed, over ${fmtCount(report.reads)} reads`}
          color={report.readAmplification <= TARGETS.readAmpCeiling ? trackColor : '#FB7185'}
        />
        <Metric
          label="write amplification"
          value={fmtAmp(report.writeAmplification)}
          sub={`${fmtBytes(report.bytesIngested)} ingested + ${fmtBytes(report.bytesRewritten)} rewritten by ${fmtCount(report.compactions)} compactions`}
          color={report.writeAmplification <= TARGETS.writeAmpBudget ? trackColor : '#FB7185'}
        />
        <Metric
          label="storage held"
          value={fmtBytes(report.storageHeldBytes)}
          sub={`${fmtBytes(report.liveBytes)} live + ${fmtBytes(report.deadRows * ROW_BYTES)} tombstoned + ${fmtBytes(report.retainedBytes)} superseded but inside the ${RETENTION_COMMITS}-commit retention window`}
        />
        <Metric
          label="files live"
          value={fmtCount(report.filesLive)}
          sub={`${fmtCount(report.sealedFiles)} sealed · ${fmtCount(report.deltaFiles)} uncompacted · ${fmtCount(report.deleteFiles)} delete vectors · ${report.meanFilesPerRead.toFixed(1)} opened per read`}
        />
      </div>

      {/* ------------------------------ the two ends -------------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <ArrowDownUp size={12} /> the two ends of the space
        </p>
        <p className="mt-2 text-body-sm text-text-2">
          The policy that minimises reads —{' '}
          <span className="font-mono text-[11.5px] text-text-1">
            {bestRead.triggerFiles} files / {fmtRows(bestRead.targetFileRows)} rows
          </span>{' '}
          — gets read amplification to {fmtAmp(bestReadReport.readAmplification)} and writes every
          ingested byte {fmtAmp(bestReadReport.writeAmplification)} over, which is{' '}
          {fmtBytes(bestReadReport.bytesRewritten)} of rewriting to save{' '}
          {fmtBytes(
            bestWriteReport.bytesScannedData +
              bestWriteReport.bytesScannedMetadata -
              (bestReadReport.bytesScannedData + bestReadReport.bytesScannedMetadata),
          )}{' '}
          of reading. The policy that minimises writes —{' '}
          <span className="font-mono text-[11.5px] text-text-1">
            {bestWrite.triggerFiles} files / {fmtRows(bestWrite.targetFileRows)} rows
          </span>{' '}
          — costs {fmtAmp(bestWriteReport.writeAmplification)} on writes and{' '}
          {fmtAmp(bestWriteReport.readAmplification)} on every read for the rest of the table’s life.
          Across the whole {POLICY_GRID.length}-policy space the two amplifications are rank
          correlated at {corr.toFixed(2)}: this is a frontier, not a dashboard with a best setting.
        </p>
      </div>

      {/* ------------------------------ the grid ------------------------------ */}
      <div className="mt-5">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
          the whole space — read amp / write amp
        </p>
        <p className="mt-1 max-w-2xl text-body-sm text-text-3">
          Rows are triggers, columns are target sizes. Green cells hold both constraints; there are{' '}
          {solving.length} of them. Click any cell to price it.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wide text-text-3">
                  trigger ↓ / target →
                </th>
                {TARGET_CHOICES.map((t) => (
                  <th
                    key={t}
                    className="py-2 pr-3 font-mono text-[10px] uppercase tracking-wide text-text-3"
                  >
                    {fmtRows(t)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TRIGGER_CHOICES.map((trig) => (
                <tr key={trig} className="border-b border-line/60">
                  <td className="py-2 pr-3 font-mono text-[11.5px] text-text-2">{trig} files</td>
                  {TARGET_CHOICES.map((tgt) => {
                    const p = { triggerFiles: trig, targetFileRows: tgt }
                    const r = policyReport(p, workloadId)
                    const c = meetsTargets(p, workloadId)
                    const here =
                      policy.triggerFiles === trig && policy.targetFileRows === tgt
                    return (
                      <td key={tgt} className="py-1 pr-3">
                        <button
                          type="button"
                          onClick={() => choose(p)}
                          aria-pressed={here}
                          className={cn(
                            'w-full rounded-sm border px-2 py-1 text-left font-mono text-[10.5px] transition-colors',
                            c.ok
                              ? 'border-accent/50 bg-accent/[0.08] text-accent'
                              : 'border-line text-text-3 hover:border-text-3 hover:text-text-2',
                            here && 'ring-1',
                          )}
                          style={here ? { borderColor: trackColor } : undefined}
                        >
                          {r.readAmplification.toFixed(3)}
                          <span className="block opacity-70">{r.writeAmplification.toFixed(2)}</span>
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ------------------------------ the targets ---------------------------- */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-3">
          <Target size={12} /> the policy task
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Gauge
            label={`read amplification ≤ ${fmtAmp(TARGETS.readAmpCeiling)}`}
            value={fmtAmp(check.readAmplification)}
            ok={check.readOk}
          />
          <Gauge
            label={`write amplification ≤ ${fmtAmp(TARGETS.writeAmpBudget)}`}
            value={fmtAmp(check.writeAmplification)}
            ok={check.writeOk}
          />
        </div>
        <p className="mt-3 text-body-sm text-text-3">
          {check.ok
            ? `Both held. Say the trade out loud, because that sentence is what a compaction review is: you accepted ${fmtAmp(report.writeAmplification)} of rewriting and ${fmtBytes(report.storageHeldBytes - report.liveBytes)} of non-live storage to keep readers inside ${fmtAmp(TARGETS.readAmpCeiling)}.`
            : `${solving.length} of the ${POLICY_GRID.length} policies hold both. Dragging one dial to its end will not do it — each end fails the other constraint.`}
        </p>
      </div>

      {/* --------------------------- the stranded target ----------------------- */}
      <div className="mt-5 rounded-md border border-line px-4 py-3">
        <p className="text-body-sm text-text-2">
          One target file size cannot be rescued by any trigger. Which one?
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TARGET_CHOICES.map((t) => (
            <Chip key={t} active={targetPick === t} color={trackColor} onClick={() => setTargetPick(t)}>
              {fmtRows(t)} rows
            </Chip>
          ))}
        </div>
        {targetPick !== null && (
          <p
            className={cn(
              'mt-2 flex items-center gap-1.5 font-mono text-[11.5px]',
              targetPick === stranded ? 'text-accent' : 'text-rose-400',
            )}
          >
            {targetPick === stranded ? <Check size={12} /> : <X size={12} />}
            {targetPick === stranded
              ? `correct — best achievable read amp at ${fmtRows(targetPick)} rows is ${fmtAmp(Math.min(...TRIGGER_CHOICES.map((trig) => policyReport({ triggerFiles: trig, targetFileRows: targetPick }, workloadId).readAmplification)))}, above the ceiling at every trigger`
              : `not ${fmtRows(targetPick)} — some trigger gets that column under the ceiling. Read the grid column downwards.`}
          </p>
        )}
        <p className="mt-2 text-body-sm text-text-3">
          The mechanism is <strong>stranded tombstones</strong>. A restatement that arrives against a
          row already sealed into a base file cannot be purged by a compactor that only merges the
          pile, so it is read and discarded on every scan from then on. This policy currently strands{' '}
          {fmtCount(report.deadStranded)} rows —{' '}
          {fmtBytes(report.deadStranded * ROW_BYTES)} that every query pays for and no trigger
          setting touches. Sealing small files seals them often, which strands tombstones faster than
          compaction cleans up. That is why “we compacted more often and read amplification did not
          move” is a real sentence people say.
        </p>
      </div>

      {/* ------------------------------ honesty -------------------------------- */}
      <div className="mt-5 rounded-md border border-line bg-surface-2/50 px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-wide text-text-3">
          what this models, and what a real table adds
        </p>
        <ul className="mt-2 space-y-1.5 text-body-sm text-text-3">
          <li>
            · <strong>This is a model, not a compactor.</strong> There is no Parquet here, no merge
            and no data — a file is a row count, a delete vector is a position count, and a read is
            an arithmetic sum. What it does have is the mechanism, and the two file constants come
            from the same figures the Warehouse engine uses: {DELETE_POS_BYTES} bytes per delete
            position and {fmtBytes(FOOTER_BYTES)} of footer per file opened.
          </li>
          <li>
            · <strong>Write amplification here is a floor.</strong> The compactor merges the pile and
            the open file; it never rewrites a sealed file to purge tombstones, which a real
            maintenance job eventually must. Add that pass and writes go up while the stranded-row
            term goes down.
          </li>
          <li>
            · <strong>Read amplification is averaged over a read after every commit</strong>, not
            measured at the end of the run — otherwise the number would grade where the last
            compaction happened to fall. It also assumes the reader scans the current state of the
            table; a query with a selective predicate on a well-clustered column pays less of this
            bill, which is C2’s subject rather than this one’s.
          </li>
          <li>
            · A real platform adds concurrent writers and commit conflicts, per-file statistics that
            let a compaction be scoped to a range, delete-vector compaction as a separate pass, and
            object-store request counts that make {fmtCount(report.filesLive)} files expensive
            independently of their bytes.
          </li>
          <li>
            · Everything above is a <strong>cost band</strong>. The one absolute is the row
            accounting: physical − tombstoned = live, checked after every commit, and reported as{' '}
            <span className={report.rowsConserved ? 'text-accent' : 'text-rose-400'}>
              {report.rowsConserved ? 'conserved' : 'BROKEN'}
            </span>
            . A policy may cost more; it may not lose a row.
          </li>
        </ul>
      </div>

      <p className="mt-5 font-mono text-[10.5px] text-text-3">
        policy {policyKey(policy)} · {visited.length} priced · {fmtCount(COMMITS)} commits ·{' '}
        {ROW_BYTES} B/row · seed {spec.seed.toString(16)}
      </p>
    </LabShell>
  )
}

/* ------------------------------- fragments ------------------------------ */

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

function Gauge({ label, value, ok }: { label: string; value: string; ok: boolean }) {
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
    </div>
  )
}
