import { createHash } from 'node:crypto';

export type Scalar = number | string;
export type Row = Record<string, Scalar>;

export type Op = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in';

export interface Condition {
  field: string;
  op: Op;
  value: Scalar | Scalar[];
}

export interface QuerySpec {
  /** All conditions must hold (AND). Absent/empty means "match all". */
  where?: Condition[];
  /** Column whose value groups rows (the "key"). */
  groupBy: string;
  /** Numeric column summed per key. */
  sum: string;
  /** Keep the k highest sums; ties broken by key ascending. */
  topK: number;
}

export function matchCondition(row: Row, cond: Condition): boolean {
  const actual = row[cond.field];
  switch (cond.op) {
    case 'eq':
      return actual === cond.value;
    case 'ne':
      return actual !== cond.value;
    case 'lt':
      return actual !== undefined && actual < (cond.value as Scalar);
    case 'lte':
      return actual !== undefined && actual <= (cond.value as Scalar);
    case 'gt':
      return actual !== undefined && actual > (cond.value as Scalar);
    case 'gte':
      return actual !== undefined && actual >= (cond.value as Scalar);
    case 'in':
      return Array.isArray(cond.value) && cond.value.some((v) => v === actual);
  }
}

export function matchAll(row: Row, where: Condition[] | undefined): boolean {
  if (!where) return true;
  return where.every((c) => matchCondition(row, c));
}

/** Stable stringify: object keys sorted so logically equal specs hash equally. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function canonicalSpec(spec: QuerySpec): string {
  const normalized: QuerySpec = {
    groupBy: spec.groupBy,
    sum: spec.sum,
    topK: spec.topK,
    ...(spec.where && spec.where.length > 0 ? { where: spec.where } : {}),
  };
  return stableStringify(normalized);
}

/** Generation id: changes whenever conditions or parameters change. */
export function generationOf(spec: QuerySpec): string {
  return createHash('sha256').update(canonicalSpec(spec)).digest('hex').slice(0, 16);
}
