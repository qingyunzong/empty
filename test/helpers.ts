import type {
  CorrCtx,
  LogicalTree,
  Predicate,
  Scalar,
  StatsCatalog,
} from '../src/types.ts';
import { rootCtx } from '../src/types.ts';

export function col(name: string): Scalar {
  return { kind: 'col', name };
}

export function lit(value: string | number | boolean | null): Scalar {
  return { kind: 'lit', value };
}

export function param(name: string): Scalar {
  return { kind: 'param', name };
}

export function eq(left: Scalar, right: Scalar): Predicate {
  return { kind: 'cmp', op: 'eq', left, right };
}

export function lt(left: Scalar, right: Scalar): Predicate {
  return { kind: 'cmp', op: 'lt', left, right };
}

export function andPred(...preds: Predicate[]): Predicate {
  return { kind: 'and', preds };
}

export function get(relation: string, ctx: CorrCtx = rootCtx()): LogicalTree {
  return { op: { kind: 'Get', relation }, children: [], ctx };
}

export function select(
  predicates: Predicate[],
  child: LogicalTree,
  ctx: CorrCtx = child.ctx,
): LogicalTree {
  return { op: { kind: 'Select', predicates }, children: [child], ctx };
}

export function join(
  predicates: Predicate[],
  left: LogicalTree,
  right: LogicalTree,
  ctx: CorrCtx = left.ctx,
): LogicalTree {
  return { op: { kind: 'InnerJoin', predicates }, children: [left, right], ctx };
}

export function aggregate(
  groupCols: string[],
  aggs: { fn: string; input: string; alias: string }[],
  child: LogicalTree,
  ctx: CorrCtx = child.ctx,
): LogicalTree {
  return { op: { kind: 'Aggregate', groupCols, aggs }, children: [child], ctx };
}

export function apply(
  params: string[],
  outer: LogicalTree,
  inner: LogicalTree,
  ctx: CorrCtx = outer.ctx,
): LogicalTree {
  return { op: { kind: 'Apply', params }, children: [outer, inner], ctx };
}

export function ctx(pathId: string, params: string[] = []): CorrCtx {
  return { pathId, params: [...params].sort() };
}

export function smallStats(): StatsCatalog {
  return {
    orders: {
      rows: 1000,
      distinct: { orders_cust: 100, orders_id: 1000, orders_status: 5 },
      indexes: [['orders_cust'], ['orders_id']],
    },
    customer: {
      rows: 100,
      distinct: { customer_id: 100, customer_nation: 10 },
      indexes: [['customer_id'], ['customer_nation']],
    },
    lineitem: {
      rows: 5000,
      distinct: { lineitem_order: 1000, lineitem_part: 500, lineitem_id: 5000 },
      indexes: [['lineitem_order'], ['lineitem_part']],
    },
    part: {
      rows: 500,
      distinct: { part_id: 500, part_type: 20 },
      indexes: [['part_id']],
    },
  };
}

/** Explicit column ownership for the small test schema. */
export function columnOwners(): Record<string, string> {
  return {
    orders_cust: 'orders',
    orders_id: 'orders',
    orders_status: 'orders',
    customer_id: 'customer',
    customer_nation: 'customer',
    lineitem_order: 'lineitem',
    lineitem_part: 'lineitem',
    lineitem_id: 'lineitem',
    part_id: 'part',
    part_type: 'part',
  };
}

/** Count occurrences of a physical operator inside a plan tree. */
export function countOp(plan: { op: string; children: unknown[] }, op: string): number {
  let count = plan.op === op ? 1 : 0;
  for (const child of plan.children as { op: string; children: unknown[] }[]) {
    count += countOp(child, op);
  }
  return count;
}

/** Walk a plan and collect every operator name. */
export function collectOps(plan: { op: string; children: unknown[] }): string[] {
  return [
    plan.op,
    ...(plan.children as { op: string; children: unknown[] }[]).flatMap(collectOps),
  ];
}
