import { evalCondition, type Row } from './conditions.js';
import type { Policy } from './policy.js';
import { buildSnapshot, type RowDecision } from './snapshot.js';
import { MASKED, type Query, type QueryResult, type ResultRow } from './query.js';

function projectAndMask(row: Row, decision: RowDecision, select: string[] | undefined): ResultRow {
  const keys = select ?? Object.keys(row);
  const out: ResultRow = { id: row.id };
  for (const key of keys) {
    if (key === 'id') continue;
    if (decision.fields[key] !== undefined && decision.fields[key] !== 'allow') {
      out[key] = MASKED;
    } else {
      out[key] = row[key];
    }
  }
  return out;
}

function aggregate(rows: ResultRow[], query: Query): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const spec of query.aggregates ?? []) {
    if (spec.op === 'count' && spec.field === undefined) {
      result[spec.as] = rows.length;
      continue;
    }
    const values: number[] = [];
    for (const r of rows) {
      const v = spec.field === undefined ? undefined : r[spec.field];
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
    switch (spec.op) {
      case 'count':
        result[spec.as] = values.length;
        break;
      case 'sum':
        result[spec.as] = values.reduce((a, b) => a + b, 0);
        break;
      case 'avg':
        result[spec.as] = values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
        break;
      case 'min':
        result[spec.as] = values.length === 0 ? null : Math.min(...values);
        break;
      case 'max':
        result[spec.as] = values.length === 0 ? null : Math.max(...values);
        break;
    }
  }
  return result;
}

export function runAuthorizeFirst(table: Row[], policy: Policy, query: Query = {}): QueryResult {
  const snapshot = buildSnapshot(table, policy);
  const rows: ResultRow[] = [];
  for (let i = 0; i < table.length; i++) {
    const row = table[i]!;
    const decision = snapshot.decisions[i]!;
    if (decision.access !== 'allow') continue;
    if (query.where !== undefined && evalCondition(query.where, row) !== 'allow') continue;
    rows.push(projectAndMask(row, decision, query.select));
  }
  return { rows, aggregates: aggregate(rows, query) };
}
