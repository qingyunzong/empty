import type { Expr, Row } from './expr.js';
import type { MaskRule, PolicySnapshot } from './policy.js';
import type { AggregateSpec, OutputRow, Query } from './engine.js';
import type { RowId, Table } from './table.js';

type Tri = true | false | 'unknown';

const T: Tri = true;
const F: Tri = false;
const U: Tri = 'unknown';

function triAnd(a: Tri, b: Tri): Tri {
  if (a === F || b === F) return F;
  if (a === T && b === T) return T;
  return U;
}

function triOr(a: Tri, b: Tri): Tri {
  if (a === T || b === T) return T;
  if (a === F && b === F) return F;
  return U;
}

function triNot(a: Tri): Tri {
  if (a === T) return F;
  if (a === F) return T;
  return U;
}

function eqScalar(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
}

function evalModel(expr: Expr, row: Row): Tri {
  switch (expr.op) {
    case 'lit':
      return expr.value ? T : F;
    case 'not':
      return triNot(evalModel(expr.arg, row));
    case 'and': {
      let acc: Tri = T;
      for (const arg of expr.args) {
        acc = triAnd(acc, evalModel(arg, row));
        if (acc === F) break;
      }
      return acc;
    }
    case 'or': {
      let acc: Tri = F;
      for (const arg of expr.args) {
        acc = triOr(acc, evalModel(arg, row));
        if (acc === T) break;
      }
      return acc;
    }
    case 'eq':
    case 'neq': {
      if (!Object.prototype.hasOwnProperty.call(row, expr.field)) return U;
      const value = row[expr.field];
      if (value === null || value === undefined || expr.value === null) return U;
      const matched = eqScalar(value, expr.value) ? T : F;
      return expr.op === 'eq' ? matched : triNot(matched);
    }
    case 'in': {
      if (!Object.prototype.hasOwnProperty.call(row, expr.field)) return U;
      const value = row[expr.field];
      if (value === null || value === undefined) return U;
      let sawNull = false;
      for (const candidate of expr.values) {
        if (candidate === null) {
          sawNull = true;
        } else if (eqScalar(value, candidate)) {
          return T;
        }
      }
      return sawNull ? U : F;
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (!Object.prototype.hasOwnProperty.call(row, expr.field)) return U;
      const value = row[expr.field];
      if (value === null || value === undefined) return U;
      if (typeof value !== 'number' && typeof value !== 'string') return U;
      if (typeof value !== typeof expr.value) return U;
      const cmp = value < expr.value ? -1 : value > expr.value ? 1 : 0;
      if (expr.op === 'lt') return cmp === -1 ? T : F;
      if (expr.op === 'lte') return cmp !== 1 ? T : F;
      if (expr.op === 'gt') return cmp === 1 ? T : F;
      return cmp !== -1 ? T : F;
    }
  }
}

function maskValue(rule: MaskRule): unknown {
  return rule.replacement === undefined ? '***' : rule.replacement;
}

function projectModel(row: Row, select: readonly string[] | undefined): Record<string, unknown> {
  const source = select === undefined ? Object.keys(row) : select;
  const out: Record<string, unknown> = {};
  for (const field of source) {
    if (Object.prototype.hasOwnProperty.call(row, field)) out[field] = row[field];
  }
  return out;
}

function maskModel(
  projected: Record<string, unknown>,
  masks: readonly MaskRule[],
  sourceRow: Row,
): Record<string, unknown> {
  const out = { ...projected };
  for (const rule of masks) {
    if (!Object.prototype.hasOwnProperty.call(out, rule.field)) continue;
    if (evalModel(rule.when, sourceRow) !== F) {
      out[rule.field] = maskValue(rule);
    }
  }
  return out;
}

function aggregateModel(spec: AggregateSpec, rows: readonly Row[]): unknown {
  if (spec.fn === 'count' && spec.field === undefined) return rows.length;
  const values: unknown[] = [];
  for (const row of rows) {
    if (spec.field === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(row, spec.field)) continue;
    const value = row[spec.field];
    if (value === null || value === undefined) continue;
    values.push(value);
  }
  switch (spec.fn) {
    case 'count':
      return values.length;
    case 'sum': {
      const nums = values.filter((v): v is number => typeof v === 'number');
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
    }
    case 'avg': {
      const nums = values.filter((v): v is number => typeof v === 'number');
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case 'min':
    case 'max': {
      const usable = values.filter((v) => typeof v === 'number' || typeof v === 'string');
      if (usable.length === 0) return null;
      let best = usable[0] as number | string;
      for (const v of usable as (number | string)[]) {
        if (spec.fn === 'min' ? v < best : v > best) best = v;
      }
      return best;
    }
  }
}

export function runAuthorizeThenQuery(table: Table, snapshot: PolicySnapshot, query: Query = {}): OutputRow[] {
  const groupBy = query.groupBy ?? [];
  const aggregates = query.aggregates ?? [];
  const isAggregate = groupBy.length > 0 || aggregates.length > 0;
  if (isAggregate && query.select !== undefined) {
    throw new TypeError('query.select cannot be combined with groupBy/aggregates');
  }

  const authorized: Row[] = [];
  for (const row of table.rows) {
    if (evalModel(snapshot.rowFilter, row) === T) authorized.push(row);
  }

  const matched: Row[] = [];
  for (const row of authorized) {
    if (query.where === undefined || evalModel(query.where, row) === T) matched.push(row);
  }

  if (!isAggregate) {
    return matched.map((row) => ({
      ...maskModel(projectModel(row, query.select), snapshot.masks, row),
      sourceRowIds: [row.id as RowId] as readonly RowId[],
    }));
  }

  const buckets = new Map<string, { keyValues: unknown[]; rows: Row[] }>();
  for (const row of matched) {
    const keyValues = groupBy.map((field) =>
      Object.prototype.hasOwnProperty.call(row, field) ? (row[field] ?? null) : null,
    );
    const mapKey = JSON.stringify(keyValues);
    const bucket = buckets.get(mapKey);
    if (bucket === undefined) {
      buckets.set(mapKey, { keyValues, rows: [row] });
    } else {
      bucket.rows.push(row);
    }
  }

  const out: OutputRow[] = [];
  for (const bucket of buckets.values()) {
    const record: Record<string, unknown> = {};
    groupBy.forEach((field, i) => {
      record[field] = bucket.keyValues[i];
    });
    for (const spec of aggregates) {
      record[spec.alias] = aggregateModel(spec, bucket.rows);
    }
    const masked = maskModel(record, snapshot.masks, bucket.rows[0]!);
    out.push({
      ...masked,
      sourceRowIds: bucket.rows.map((row) => row.id as RowId),
    });
  }
  return out;
}
