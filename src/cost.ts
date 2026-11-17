import { predicateColumns } from './rules-helpers.ts';
import type {
  CostContext,
  CostModel,
  PhysicalOp,
  Predicate,
  StatsCatalog,
  SubtreeStats,
} from './types.ts';

/**
 * Deterministic default cost model.
 *
 * Costs are additive non-negative numbers derived solely from relation
 * statistics and operator shape, so the same plan always gets the same cost.
 * Callers can replace any hook by passing a partial `CostModel` to
 * `createCostModel`.
 */

const DEFAULT_SELECTIVITY = 0.1;

export function defaultSelectivity(
  pred: Predicate,
  stats: StatsCatalog,
  childRows: number,
): number {
  if (pred.kind === 'and') {
    let factor = 1;
    for (const part of pred.preds) factor *= defaultSelectivity(part, stats, childRows);
    return clamp(factor);
  }
  const cols = predicateColumns(pred);
  if (pred.op !== 'eq') {
    return clamp(pred.op === 'ne' ? 1 - DEFAULT_SELECTIVITY : DEFAULT_SELECTIVITY);
  }
  // Equality on a column: use 1/NDV when statistics are known.
  let ndv = 0;
  for (const col of cols) {
    for (const relation of Object.keys(stats)) {
      const value = stats[relation].distinct[col];
      if (value !== undefined) ndv = Math.max(ndv, value);
    }
  }
  if (ndv > 0) return clamp(1 / ndv);
  return DEFAULT_SELECTIVITY;
}

export function defaultAggregateRows(
  groupCols: string[],
  inputRows: number,
  stats: StatsCatalog,
): number {
  if (groupCols.length === 0) return 1;
  let ndv = 1;
  for (const col of groupCols) {
    let columnNdv = 0;
    for (const relation of Object.keys(stats)) {
      const value = stats[relation].distinct[col];
      if (value !== undefined) columnNdv = Math.max(columnNdv, value);
    }
    ndv *= Math.max(columnNdv, 1);
  }
  return clampRows(Math.min(inputRows, ndv));
}

export function defaultLocalCost(
  op: PhysicalOp,
  childStats: SubtreeStats[],
  ctx: CostContext,
): number {
  const rows = (index: number): number => childStats[index]?.rows ?? 0;
  const relationRows = ctx.relation ? ctx.stats[ctx.relation]?.rows ?? 0 : 0;
  switch (op) {
    case 'SeqScan':
      return relationRows;
    case 'IndexScan':
      return Math.sqrt(Math.max(relationRows, 1)) + rows(0);
    case 'ParamIndexScan':
      // Cheap per-execution index probe; strictly cheaper than a full
      // sequential scan so a usable parameterized index always wins inside
      // a correlated scope. Total cost still scales with outer rows via the
      // additive Apply/NL accumulation.
      return Math.log2(Math.max(relationRows, 2)) * 0.1;
    case 'Filter':
      return rows(0);
    case 'HashJoin':
      return rows(0) + rows(1);
    case 'MergeJoin':
      return rows(0) + rows(1);
    case 'NLJoin':
      return rows(0) * Math.max(rows(1), 1);
    case 'HashAgg':
      return rows(0);
    case 'SortedAgg':
      return rows(0);
    case 'ApplyNL':
      return rows(0) * Math.max(rows(1), 1);
    case 'Sort':
      return rows(0) * Math.log2(Math.max(rows(0), 2));
    case 'Exchange':
      return rows(0);
  }
}

export interface PartialCostModel {
  selectivity?: CostModel['selectivity'];
  aggregateRows?: CostModel['aggregateRows'];
  localCost?: CostModel['localCost'];
}

export function createCostModel(partial: PartialCostModel = {}): CostModel {
  return {
    selectivity: partial.selectivity ?? defaultSelectivity,
    aggregateRows: partial.aggregateRows ?? defaultAggregateRows,
    localCost: partial.localCost ?? defaultLocalCost,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0.0001;
  return Math.min(1, value);
}

function clampRows(value: number): number {
  return Math.max(1, Math.round(value));
}
