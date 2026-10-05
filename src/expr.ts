import { tri, type Tri } from './threeval.js';

export type Scalar = string | number | boolean | null;

export type Expr =
  | { readonly op: 'lit'; readonly value: boolean }
  | { readonly op: 'eq' | 'neq'; readonly field: string; readonly value: Scalar }
  | { readonly op: 'lt' | 'lte' | 'gt' | 'gte'; readonly field: string; readonly value: number | string }
  | { readonly op: 'in'; readonly field: string; readonly values: readonly Scalar[] }
  | { readonly op: 'and' | 'or'; readonly args: readonly Expr[] }
  | { readonly op: 'not'; readonly arg: Expr };

export type Row = Readonly<Record<string, unknown>>;

const MISSING: unique symbol = Symbol('missing-field');

export function lookupField(row: Row, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, field) ? row[field] : MISSING;
}

export function isMissing(value: unknown): boolean {
  return value === MISSING;
}

function scalarEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
}

function compareOrder(a: number | string, b: number | string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function evalExpr(expr: Expr, row: Row): Tri {
  switch (expr.op) {
    case 'lit':
      return tri.fromBool(expr.value);
    case 'and': {
      let acc: Tri = 'T';
      for (const arg of expr.args) {
        acc = tri.and(acc, evalExpr(arg, row));
        if (acc === 'F') return 'F';
      }
      return acc;
    }
    case 'or': {
      let acc: Tri = 'F';
      for (const arg of expr.args) {
        acc = tri.or(acc, evalExpr(arg, row));
        if (acc === 'T') return 'T';
      }
      return acc;
    }
    case 'not':
      return tri.not(evalExpr(expr.arg, row));
    case 'eq':
    case 'neq': {
      const value = lookupField(row, expr.field);
      if (isMissing(value) || value === null || expr.value === null) return 'U';
      const matched = tri.fromBool(scalarEq(value, expr.value));
      return expr.op === 'eq' ? matched : tri.not(matched);
    }
    case 'in': {
      const value = lookupField(row, expr.field);
      if (isMissing(value) || value === null) return 'U';
      let sawNull = false;
      for (const candidate of expr.values) {
        if (candidate === null) {
          sawNull = true;
          continue;
        }
        if (scalarEq(value, candidate)) return 'T';
      }
      return sawNull ? 'U' : 'F';
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const value = lookupField(row, expr.field);
      if (isMissing(value) || value === null) return 'U';
      if (typeof value !== 'number' && typeof value !== 'string') return 'U';
      if (typeof value !== typeof expr.value) return 'U';
      const cmp = compareOrder(value, expr.value);
      switch (expr.op) {
        case 'lt': return tri.fromBool(cmp === -1);
        case 'lte': return tri.fromBool(cmp !== 1);
        case 'gt': return tri.fromBool(cmp === 1);
        case 'gte': return tri.fromBool(cmp !== -1);
      }
    }
  }
}
