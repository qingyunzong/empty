import { tvAnd, tvNot, tvOr, type TV } from './trivalent.js';

export type Scalar = string | number | boolean | null;

export type Row = { id: string | number; [key: string]: unknown };

export type Condition =
  | { op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'; field: string; value: Scalar }
  | { op: 'in'; field: string; values: Scalar[] }
  | { op: 'exists'; field: string }
  | { op: 'and'; conditions: Condition[] }
  | { op: 'or'; conditions: Condition[] }
  | { op: 'not'; condition: Condition };

function hasField(row: Row, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, field) && row[field] !== undefined;
}

function compare(op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte', actual: Scalar, expected: Scalar): TV {
  if (actual === null || expected === null) {
    if (op === 'eq') return actual === expected ? 'allow' : 'deny';
    if (op === 'neq') return actual !== expected ? 'allow' : 'deny';
    return 'unknown';
  }
  if (typeof actual !== typeof expected) return 'unknown';
  switch (op) {
    case 'eq': return actual === expected ? 'allow' : 'deny';
    case 'neq': return actual !== expected ? 'allow' : 'deny';
    case 'lt': return (actual as number) < (expected as number) ? 'allow' : 'deny';
    case 'lte': return (actual as number) <= (expected as number) ? 'allow' : 'deny';
    case 'gt': return (actual as number) > (expected as number) ? 'allow' : 'deny';
    case 'gte': return (actual as number) >= (expected as number) ? 'allow' : 'deny';
  }
}

export function evalCondition(cond: Condition, row: Row): TV {
  switch (cond.op) {
    case 'and':
      return tvAnd(...cond.conditions.map((c) => evalCondition(c, row)));
    case 'or':
      return tvOr(...cond.conditions.map((c) => evalCondition(c, row)));
    case 'not':
      return tvNot(evalCondition(cond.condition, row));
    case 'exists':
      return hasField(row, cond.field) ? 'allow' : 'deny';
    case 'in': {
      if (!hasField(row, cond.field)) return 'unknown';
      return cond.values.some((v) => v === row[cond.field]) ? 'allow' : 'deny';
    }
    default: {
      if (!hasField(row, cond.field)) return 'unknown';
      return compare(cond.op, row[cond.field] as Scalar, cond.value);
    }
  }
}
