/**
 * Core logical/physical IR for the embeddable memo optimizer.
 *
 * A logical tree is a plain, serializable value. Correlation is explicit via
 * `CorrCtx` (path id + outer parameter columns): two trees that differ only in
 * their correlation context are never treated as equivalent.
 */

export type Scalar =
  | { kind: 'col'; name: string }
  | { kind: 'lit'; value: string | number | boolean | null }
  | { kind: 'param'; name: string }
  | { kind: 'fn'; fn: string; args: Scalar[] };

export type Predicate =
  | { kind: 'and'; preds: Predicate[] }
  | { kind: 'cmp'; op: 'eq' | 'lt' | 'le' | 'gt' | 'ge' | 'ne'; left: Scalar; right: Scalar };

export type LogicalOp =
  | { kind: 'Get'; relation: string }
  | { kind: 'Select'; predicates: Predicate[] }
  | { kind: 'InnerJoin'; predicates: Predicate[] }
  | { kind: 'Aggregate'; groupCols: string[]; aggs: { fn: string; input: string; alias: string }[] }
  | { kind: 'Apply'; params: string[] };

export interface LogicalTree {
  op: LogicalOp;
  children: LogicalTree[];
  /** Correlation context of this subtree; defaults to the uncorrelated root context. */
  ctx: CorrCtx;
}

export interface CorrCtx {
  /** Stable identifier of the (sub)query scope this tree belongs to. */
  pathId: string;
  /** Outer parameter columns visible inside this scope, sorted. */
  params: string[];
}

export const ROOT_PATH = 'root';

export function rootCtx(): CorrCtx {
  return { pathId: ROOT_PATH, params: [] };
}

export interface PhysicalProps {
  /** Required/present sort order (prefix semantics); null = any order. */
  order: string[] | null;
  /** Required/present data distribution; null = no requirement. */
  distribution: 'local' | 'hash' | null;
}

export function anyProps(): PhysicalProps {
  return { order: null, distribution: null };
}

export type PhysicalOp =
  | 'SeqScan'
  | 'IndexScan'
  | 'ParamIndexScan'
  | 'Filter'
  | 'HashJoin'
  | 'MergeJoin'
  | 'NLJoin'
  | 'HashAgg'
  | 'SortedAgg'
  | 'ApplyNL'
  | 'Sort'
  | 'Exchange';

export interface PhysicalPlan {
  op: PhysicalOp;
  children: PhysicalPlan[];
  relation?: string;
  predicates?: Predicate[];
  groupCols?: string[];
  indexCols?: string[];
  params?: string[];
  order?: string[] | null;
  distribution?: 'local' | 'hash';
  /** Correlation context this plan fragment belongs to. */
  ctx: CorrCtx;
}

export interface RelationStats {
  rows: number;
  /** Distinct-value counts per column. */
  distinct: Record<string, number>;
  /** Declared indexes (ordered column lists). */
  indexes: string[][];
}

export type StatsCatalog = Record<string, RelationStats>;

export interface SubtreeStats {
  rows: number;
}

export interface CostModel {
  /** Selectivity of a predicate evaluated against rows described by `stats`. */
  selectivity(pred: Predicate, stats: StatsCatalog, childRows: number): number;
  /** Output row count of an aggregate. */
  aggregateRows(groupCols: string[], inputRows: number, stats: StatsCatalog): number;
  /** Non-negative local cost of a physical operator given its child stats. */
  localCost(op: PhysicalOp, childStats: SubtreeStats[], ctx: CostContext): number;
}

export interface CostContext {
  relation?: string;
  predicates?: Predicate[];
  groupCols?: string[];
  indexCols?: string[];
  stats: StatsCatalog;
}
