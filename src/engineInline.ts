import { evalCondition, type Row } from './conditions.js';
import { evalFieldPolicy, evalPolicy, type Policy } from './policy.js';
import { MASKED, type AggregateSpec, type Query, type QueryResult, type ResultRow } from './query.js';

interface Accumulator {
  as: string;
  op: AggregateSpec['op'];
  field?: string;
  count: number;
  sum: number;
  min: number;
  max: number;
}

function makeAccumulators(specs: AggregateSpec[] | undefined): Accumulator[] {
  return (specs ?? []).map((s) => {
    const acc: Accumulator = { as: s.as, op: s.op, count: 0, sum: 0, min: Infinity, max: -Infinity };
    if (s.field !== undefined) acc.field = s.field;
    return acc;
  });
}

function feed(acc: Accumulator, row: ResultRow, totalRows: number): void {
  if (acc.op === 'count' && acc.field === undefined) {
    acc.count = totalRows;
    return;
  }
  const v = acc.field === undefined ? undefined : row[acc.field];
  if (typeof v !== 'number' || !Number.isFinite(v)) return;
  acc.count += 1;
  acc.sum += v;
  if (v < acc.min) acc.min = v;
  if (v > acc.max) acc.max = v;
}

function finish(acc: Accumulator): number | null {
  switch (acc.op) {
    case 'count': return acc.count;
    case 'sum': return acc.sum;
    case 'avg': return acc.count === 0 ? null : acc.sum / acc.count;
    case 'min': return acc.count === 0 ? null : acc.min;
    case 'max': return acc.count === 0 ? null : acc.max;
  }
}

export function runInline(table: Row[], policy: Policy, query: Query = {}): QueryResult {
  const rows: ResultRow[] = [];
  const accs = makeAccumulators(query.aggregates);
  for (const row of table) {
    if (evalPolicy(policy, row) !== 'allow') continue;
    if (query.where !== undefined && evalCondition(query.where, row) !== 'allow') continue;
    const keys = query.select ?? Object.keys(row);
    const out: ResultRow = { id: row.id };
    for (const key of keys) {
      if (key === 'id') continue;
      const fp = (policy.fields ?? []).find((f) => f.field === key);
      if (fp !== undefined && evalFieldPolicy(fp, row) !== 'allow') {
        out[key] = MASKED;
      } else {
        out[key] = row[key];
      }
    }
    rows.push(out);
    for (const acc of accs) feed(acc, out, rows.length);
  }
  const aggregates: Record<string, number | null> = {};
  for (const acc of accs) aggregates[acc.as] = finish(acc);
  return { rows, aggregates };
}
