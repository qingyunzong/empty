import { Memo } from './memo.ts';
import { flattenAnd, predicateColumns } from './rules-helpers.ts';
import type {
  CostModel,
  LogicalTree,
  Predicate,
  PhysicalOp,
  PhysicalPlan,
  PhysicalProps,
  StatsCatalog,
} from './types.ts';

/**
 * Physical implementation catalog.
 *
 * For each logical group expression the catalog enumerates concrete physical
 * candidates with:
 *  - required physical properties per child (property pushdown),
 *  - delivered physical properties of the candidate,
 *  - correlation capability (parameterized paths only use candidates that can
 *    see the outer parameters),
 *  - output cardinality estimation.
 */

export interface PhysicalCandidate {
  op: PhysicalOp;
  planMeta: PlanMeta;
  requiredChildren: PhysicalProps[];
  delivers: PhysicalProps;
  correlationCapable: boolean;
  isEnforcer: boolean;
  /** Cardinality of this candidate's output. */
  outputRows: (childRows: number[]) => number;
}

export interface PlanMeta {
  relation?: string;
  predicates?: Predicate[];
  groupCols?: string[];
  indexCols?: string[];
  params?: string[];
}

export interface CatalogContext {
  memo: Memo;
  stats: StatsCatalog;
  costModel: CostModel;
}

export function candidatesFor(
  expr: LogicalTree,
  childRows: number[],
  ctx: CatalogContext,
): PhysicalCandidate[] {
  switch (expr.op.kind) {
    case 'Get':
      return getCandidates(expr, ctx);
    case 'Select':
      return selectCandidates(expr, childRows, ctx);
    case 'InnerJoin':
      return joinCandidates(expr, childRows, ctx);
    case 'Aggregate':
      return aggregateCandidates(expr, childRows, ctx);
    case 'Apply':
      return applyCandidates(expr);
  }
}

function getCandidates(expr: LogicalTree, ctx: CatalogContext): PhysicalCandidate[] {
  if (expr.op.kind !== 'Get') return [];
  const relation = expr.op.relation;
  const info = ctx.stats[relation];
  const out: PhysicalCandidate[] = [];
  out.push({
    op: 'SeqScan',
    planMeta: { relation },
    requiredChildren: [],
    delivers: { order: null, distribution: 'local' },
    // A sequential scan can still evaluate correlated predicates passed down
    // by an enclosing Filter; it is correlation-capable (just not parameterized).
    correlationCapable: true,
    isEnforcer: false,
    outputRows: () => info?.rows ?? 1,
  });
  for (const indexCols of info?.indexes ?? []) {
    out.push({
      op: 'IndexScan',
      planMeta: { relation, indexCols: [...indexCols] },
      requiredChildren: [],
      delivers: { order: [...indexCols], distribution: 'local' },
      correlationCapable: true,
      isEnforcer: false,
      outputRows: () => info?.rows ?? 1,
    });
  }
  return out;
}

function selectCandidates(
  expr: LogicalTree,
  childRows: number[],
  ctx: CatalogContext,
): PhysicalCandidate[] {
  const preds = expr.op.kind === 'Select' ? expr.op.predicates : [];
  const inputRows = childRows[0] ?? 1;
  return [
    {
      op: 'Filter',
      planMeta: { predicates: preds },
      requiredChildren: [anyReq()],
      delivers: { order: null, distribution: 'local' },
      correlationCapable: true,
      isEnforcer: false,
      outputRows: (rows) =>
        Math.max(
          1,
          Math.round(
            rows[0] *
              flattenAnd(preds).reduce(
                (acc, pred) =>
                  acc * ctx.costModel.selectivity(pred, ctx.stats, inputRows),
                1,
              ),
          ),
        ),
    },
  ];
}

function joinCandidates(
  expr: LogicalTree,
  childRows: number[],
  ctx: CatalogContext,
): PhysicalCandidate[] {
  const preds = expr.op.kind === 'InnerJoin' ? expr.op.predicates : [];
  const leftRows = childRows[0] ?? 1;
  const rightRows = childRows[1] ?? 1;
  const joinSelectivity = flattenAnd(preds).reduce(
    (acc, pred) =>
      acc * ctx.costModel.selectivity(pred, ctx.stats, leftRows * rightRows),
    1,
  );
  const outputRows = (rows: number[]): number =>
    Math.max(1, Math.round(rows[0] * rows[1] * joinSelectivity));

  const candidates: PhysicalCandidate[] = [
    {
      op: 'HashJoin',
      planMeta: { predicates: preds },
      requiredChildren: [anyReq(), anyReq()],
      delivers: { order: null, distribution: 'local' },
      correlationCapable: false,
      isEnforcer: false,
      outputRows,
    },
    {
      op: 'NLJoin',
      planMeta: { predicates: preds },
      requiredChildren: [anyReq(), anyReq()],
      delivers: { order: null, distribution: 'local' },
      correlationCapable: true,
      isEnforcer: false,
      outputRows,
    },
  ];

  // Merge join is only legal when an equality predicate constrains columns
  // available in both inputs; it asks both children for the same order.
  const eqCols = equalityColumns(preds);
  if (eqCols.length > 0) {
    const order = [...eqCols].sort();
    candidates.push({
      op: 'MergeJoin',
      planMeta: { predicates: preds, indexCols: order },
      requiredChildren: [
        { order, distribution: null },
        { order, distribution: null },
      ],
      delivers: { order, distribution: 'local' },
      correlationCapable: false,
      isEnforcer: false,
      outputRows,
    });
  }
  return candidates;
}

function aggregateCandidates(
  expr: LogicalTree,
  childRows: number[],
  ctx: CatalogContext,
): PhysicalCandidate[] {
  const op = expr.op.kind === 'Aggregate' ? expr.op : { groupCols: [], aggs: [] };
  const groupCols = [...op.groupCols].sort();
  const outputRows = (rows: number[]): number =>
    ctx.costModel.aggregateRows(groupCols, rows[0], ctx.stats);
  const candidates: PhysicalCandidate[] = [
    {
      op: 'HashAgg',
      planMeta: { groupCols },
      requiredChildren: [anyReq()],
      delivers: { order: null, distribution: 'local' },
      correlationCapable: false,
      isEnforcer: false,
      outputRows,
    },
  ];
  if (groupCols.length > 0) {
    candidates.push({
      op: 'SortedAgg',
      planMeta: { groupCols },
      requiredChildren: [{ order: groupCols, distribution: null }],
      delivers: { order: groupCols, distribution: 'local' },
      correlationCapable: false,
      isEnforcer: false,
      outputRows,
    });
  }
  void childRows;
  return candidates;
}

function applyCandidates(expr: LogicalTree): PhysicalCandidate[] {
  const params = expr.op.kind === 'Apply' ? [...expr.op.params].sort() : [];
  return [
    {
      op: 'ApplyNL',
      planMeta: { params },
      requiredChildren: [anyReq(), anyReq()],
      delivers: { order: null, distribution: 'local' },
      correlationCapable: true,
      isEnforcer: false,
      // Apply repeats the inner plan per outer row.
      outputRows: (rows) => Math.max(1, rows[0] * rows[1]),
    },
  ];
}

/**
 * Parameterized index scan: available only inside a correlated context and
 * only when a correlated equality predicate (`column = $param`) constrains the
 * leading column of a declared index on the scanned relation.
 */
export function parameterizedScanCandidates(
  relation: string,
  ctx: CatalogContext,
  visibleParams: string[],
  predicates: Predicate[] = [],
): PhysicalCandidate[] {
  const info = ctx.stats[relation];
  if (!info || visibleParams.length === 0) return [];
  const paramEqualCols = correlatedEqualityColumns(predicates, visibleParams);
  if (paramEqualCols.size === 0) return [];
  const out: PhysicalCandidate[] = [];
  for (const indexCols of info.indexes) {
    if (indexCols.length === 0) continue;
    if (!paramEqualCols.has(indexCols[0])) continue;
    out.push({
      op: 'ParamIndexScan',
      planMeta: { relation, indexCols: [...indexCols], params: [...visibleParams].sort() },
      requiredChildren: [],
      delivers: { order: [...indexCols], distribution: 'local' },
      correlationCapable: true,
      isEnforcer: false,
      outputRows: () => Math.max(1, Math.round(info.rows / Math.max(info.distinct[indexCols[0]] ?? 1, 1))),
    });
  }
  return out;
}

/**
 * Columns that appear on the data side of an equality whose other side is a
 * visible outer parameter, e.g. `l_order = $o_id` yields `l_order`.
 */
function correlatedEqualityColumns(preds: Predicate[], visibleParams: string[]): Set<string> {
  const params = new Set(visibleParams);
  const cols = new Set<string>();
  for (const pred of flattenAnd(preds)) {
    if (pred.kind !== 'cmp' || pred.op !== 'eq') continue;
    const leftParam = pred.left.kind === 'param' && params.has(pred.left.name);
    const rightParam = pred.right.kind === 'param' && params.has(pred.right.name);
    if (leftParam && pred.right.kind === 'col') cols.add(pred.right.name);
    if (rightParam && pred.left.kind === 'col') cols.add(pred.left.name);
  }
  return cols;
}

/** Enforcers that can make a child satisfy otherwise-missing properties. */
export function enforcerCandidates(required: PhysicalProps): PhysicalCandidate[] {
  const out: PhysicalCandidate[] = [];
  if (required.order !== null && required.order.length > 0) {
    const order = [...required.order];
    out.push({
      op: 'Sort',
      planMeta: { indexCols: order },
      requiredChildren: [anyReq()],
      delivers: { order, distribution: 'local' },
      correlationCapable: false,
      isEnforcer: true,
      outputRows: (rows) => rows[0],
    });
  }
  if (required.distribution === 'hash') {
    out.push({
      op: 'Exchange',
      planMeta: {},
      requiredChildren: [anyReq()],
      delivers: { order: null, distribution: 'hash' },
      correlationCapable: false,
      isEnforcer: true,
      outputRows: (rows) => rows[0],
    });
  }
  return out;
}

export function satisfies(delivered: PhysicalProps, required: PhysicalProps): boolean {
  if (required.order !== null) {
    if (delivered.order === null) return false;
    if (!prefixMatch(delivered.order, required.order)) return false;
  }
  if (required.distribution !== null && delivered.distribution !== required.distribution) {
    return false;
  }
  return true;
}

export function planDelivers(plan: PhysicalPlan): PhysicalProps {
  return {
    order: plan.order ?? null,
    distribution: plan.distribution ?? 'local',
  };
}

function equalityColumns(preds: Predicate[]): string[] {
  const cols = new Set<string>();
  for (const pred of flattenAnd(preds)) {
    if (pred.kind !== 'cmp' || pred.op !== 'eq') continue;
    for (const col of predicateColumns(pred)) cols.add(col);
  }
  return [...cols];
}

function prefixMatch(delivered: string[], required: string[]): boolean {
  if (delivered.length < required.length) return false;
  return required.every((col, index) => delivered[index] === col);
}

function anyReq(): PhysicalProps {
  return { order: null, distribution: null };
}
