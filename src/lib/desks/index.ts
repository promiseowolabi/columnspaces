/**
 * index.ts — the desk registry.
 *
 * Eight numeric labs. Each one owns a decision an architect is actually asked
 * to make, and each is graded against a reference model in BANDS rather than
 * against a single value — a sizing model is not "correct", it is within
 * tolerance and honestly caveated.
 *
 * The registry is the contract between the lessons and the grading: a lesson
 * that promises what a desk grades must match the `checks` array below. If a
 * lesson opens `the-cfo` without ever teaching cost-per-query, the reader
 * loses the room for a reason the course never covered — which is the specific
 * failure this file exists to prevent.
 *
 * Reference models land one file at a time (PLAN.md phase 6). The metadata is
 * here first, deliberately: it is what the lessons are written against.
 */

import type { DeskId, Level } from '@/data/lessons/types'

export * from './kit'

export interface DeskMeta {
  id: DeskId
  level: Level
  name: string
  /** The decision this desk stands in for. */
  decision: string
  /** What the learner submits. */
  submits: string
  /** The check ids the desk grades, in order. */
  checks: string[]
  /** The one number a learner should leave with. */
  takeaway: string
}

export const DESKS: DeskMeta[] = [
  {
    id: 'scan-desk',
    level: 300,
    name: 'The Scan Desk',
    decision: 'What will this workload scan per day, and what does that cost in the pricing shape you are on?',
    submits: 'daily bytes scanned, per-query bytes, pricing shape, growth term',
    checks: ['per_query', 'daily_total', 'shape_stated', 'growth_modelled'],
    takeaway:
      'Bytes scanned is a product of 3 factors — columns projected, blocks pruned, queries per day — so improving 2 of them by 3x each is a 9x cut, and the factor still sitting at 1x is the whole story.',
  },
  {
    id: 'layout-desk',
    level: 300,
    name: 'The Layout Desk',
    decision: 'Which partition, sort and clustering design — and what pruning ratio will you promise?',
    submits: 'partition key, sort key, row-group size, promised pruning ratio, worst-query caveat',
    checks: ['prunes_target', 'file_count_sane', 'worst_query_stated', 'no_false_negatives'],
    takeaway:
      'Partitioning cuts the file list; sorting cuts the bytes inside each file. A table has exactly 1 physical order, so every layout privileges some predicates and starves others — name the starved one.',
  },
  {
    id: 'ingest-desk',
    level: 400,
    name: 'The Ingest Desk',
    decision: 'Which ingest topology meets the freshness requirement without creating a small-file problem?',
    submits: 'batch interval, target file size, p99 staleness, compaction capacity',
    checks: ['freshness_sla', 'file_size', 'compaction_keeps_up', 'tradeoff_stated'],
    takeaway:
      'p99 staleness is batch interval plus commit time; halving the interval doubles the file count, and the file count is what the planner pays for.',
  },
  {
    id: 'tenancy-desk',
    level: 400,
    name: 'The Tenancy Desk',
    decision: 'How do many uneven tenants share tables, compute and one catalog without breaking isolation or cost attribution?',
    submits: 'chosen model, isolation boundary, attribution method, worst-tenant cost',
    checks: ['isolation', 'attribution', 'worst_tenant', 'catalog_ceiling', 'noisy_neighbour'],
    takeaway:
      'Tenant sizes are Zipf-distributed, so the mean is a fiction: 1 tenant sets your capacity ceiling and the smallest ones set your per-query metadata overhead. Model both ends, never the average.',
  },
  {
    id: 'compaction-desk',
    level: 400,
    name: 'The Compaction Desk',
    decision: 'What compaction and expiry policy keeps read amplification bounded — and what does running it cost?',
    submits: 'trigger threshold, target file size, expiry window, write amplification budget',
    checks: ['read_amp_bounded', 'write_amp_budget', 'expiry_stated', 'storage_stable', 'cost_counted'],
    takeaway:
      'Compaction trades write amplification for read amplification: rewriting a file 4 times to keep read amp near 1x is a choice, and a policy with no stated write-amp number is an unbounded background bill.',
  },
  {
    id: 'capacity-desk',
    level: 500,
    name: 'The Capacity Desk',
    decision: 'What does this platform need over 24 months, and what breaks first?',
    submits: 'storage growth, compute concurrency, metadata scale, first bottleneck',
    checks: ['storage_plan', 'concurrency', 'metadata_scale', 'first_limit', 'headroom'],
    takeaway:
      'Storage grows with data and metadata grows with file count, and those are different curves — halving the commit interval doubles files at constant data, so limit 1 is usually the catalog, not the disk.',
  },
  {
    id: 'tco-desk',
    level: 500,
    name: 'The TCO Desk',
    decision: 'Managed warehouse, engine-on-your-own-storage, or an appliance-class platform — over three years, with labour costed?',
    submits: 'recommendation, three-year total, ongoing ops, migration cost, exit cost',
    checks: ['total', 'ongoing_ops', 'migration', 'exit_costed', 'honest_answer'],
    takeaway:
      'At a 36-month horizon labour is routinely half the total of a self-operated platform: a build cost amortises, an on-call rotation does not.',
  },
  {
    id: 'dr-desk',
    level: 500,
    name: 'The DR Desk',
    decision: 'What is the RPO and RTO — and what does "restore" mean when the table is a manifest tree?',
    submits: 'RPO, RTO, restore procedure, tested date, metadata recovery path',
    checks: ['rpo', 'rto', 'metadata_path', 'tested', 'cross_region'],
    takeaway:
      'Time travel is not backup: it lives in the same metadata tree it would have to recover from, so an RPO that relies on it has 1 failure domain where you believed you had 2.',
  },
]

export function getDesk(id: DeskId): DeskMeta | undefined {
  return DESKS.find((d) => d.id === id)
}

export const desksForLevel = (level: Level): DeskMeta[] => DESKS.filter((d) => d.level === level)

/*
 * Reference models, one namespace each. Namespaced rather than flattened
 * because the desks legitimately share vocabulary — `Component`, `Option`,
 * `computeLine` — and a flat re-export would either collide or force each desk
 * to prefix its own types with its own name, which reads worse in the models
 * themselves. `desks.capacity.gradeCapacity(...)` says where it came from.
 */
export * as capacity from './capacity'
export * as tco from './tco'
export * as dr from './dr'
export * as scan from './scan'
export * as layout from './layout'
export * as ingest from './ingest'
export * as tenancy from './tenancy'
export * as compaction from './compaction'
