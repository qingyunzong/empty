import { evalExpr, lookupField, isMissing, type Expr, type Row } from './expr.js';
import { DEFAULT_MASK_REPLACEMENT, type MaskRule, type PolicySnapshot } from './policy.js';
import { rowId, type RowId, type Table } from './table.js';

export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface AggregateSpec {
  readonly alias: string;
  readonly fn: AggregateFn;
  readonly field?: string;
}

export interface Query {
  readonly select?: readonly string[];
  readonly where?: Expr;
  readonly groupBy?: readonly string[];
  readonly aggregates?: readonly AggregateSpec[];
}

export interface OutputRow {
  readonly sourceRowIds: readonly RowId[];
  readonly [key: string]: unknown;
}

function projectRow(row: Row, select: readonly string[] | undefined): Record<string, unknown> {
  if (select === undefined) return { ...row };
  const out: Record<string, unknown> = {};
  for (const field of select) {
    const value = lookupField(row, field);
    if (!isMissing(value)) out[field] = value;
  }
  return out;
}

function applyMasks(
  projected: Record<string, unknown>,
  masks: readonly MaskRule[],
  sourceRow: Row,
): Record<string, unknown> {
  for (const rule of masks) {
    if (!Object.prototype.hasOwnProperty.call(projected, rule.field)) continue;
    const verdict = evalExpr(rule.when, sourceRow);
    if (verdict !== 'F') {
      projected[rule.field] = rule.replacement ?? DEFAULT_MASK_REPLACEMENT;
    }
  }
  return projected;
}

interface AggState {
  n: number;
  sum: number;
  best: unknown;
  hasBest: boolean;
}

function emptyAggState(): AggState {
  return { n: 0, sum: 0, best: undefined, hasBest: false };
}

function feedAggState(state: AggState, spec: AggregateSpec, row: Row): void {
  if (spec.fn === 'count' && spec.field === undefined) {
    state.n += 1;
    return;
  }
  const raw = spec.field === undefined ? undefined : lookupField(row, spec.field);
  if (raw === undefined || isMissing(raw) || raw === null) return;
  switch (spec.fn) {
    case 'count':
      state.n += 1;
      return;
    case 'sum':
    case 'avg':
      if (typeof raw !== 'number') return;
      state.n += 1;
      state.sum += raw;
      return;
    case 'min':
    case 'max':
      if (typeof raw !== 'number' && typeof raw !== 'string') return;
      state.n += 1;
      if (!state.hasBest) {
        state.best = raw;
        state.hasBest = true;
      } else if (spec.fn === 'min' ? raw < (state.best as number | string) : raw > (state.best as number | string)) {
        state.best = raw;
      }
      return;
  }
}

function finalizeAggState(state: AggState, spec: AggregateSpec): unknown {
  switch (spec.fn) {
    case 'count':
      return state.n;
    case 'sum':
      return state.n === 0 ? null : state.sum;
    case 'avg':
      return state.n === 0 ? null : state.sum / state.n;
    case 'min':
    case 'max':
      return state.hasBest ? state.best : null;
  }
}

interface GroupState {
  readonly keyValues: unknown[];
  readonly representative: Row;
  readonly sourceRowIds: RowId[];
  readonly accs: AggState[];
}

export function runQuery(table: Table, snapshot: PolicySnapshot, query: Query = {}): OutputRow[] {
  const groupBy = query.groupBy ?? [];
  const aggregates = query.aggregates ?? [];
  const isAggregate = groupBy.length > 0 || aggregates.length > 0;
  if (isAggregate && query.select !== undefined) {
    throw new TypeError('query.select cannot be combined with groupBy/aggregates');
  }

  if (!isAggregate) {
    const out: OutputRow[] = [];
    for (const row of table.rows) {
      if (evalExpr(snapshot.rowFilter, row) !== 'T') continue;
      if (query.where !== undefined && evalExpr(query.where, row) !== 'T') continue;
      const projected = applyMasks(projectRow(row, query.select), snapshot.masks, row);
      out.push({ ...projected, sourceRowIds: [rowId(row)] });
    }
    return out;
  }

  const groups = new Map<string, GroupState>();
  for (const row of table.rows) {
    if (evalExpr(snapshot.rowFilter, row) !== 'T') continue;
    if (query.where !== undefined && evalExpr(query.where, row) !== 'T') continue;
    const keyValues = groupBy.map((field) => {
      const value = lookupField(row, field);
      return isMissing(value) ? null : value;
    });
    const mapKey = JSON.stringify(keyValues);
    let group = groups.get(mapKey);
    if (group === undefined) {
      group = {
        keyValues,
        representative: row,
        sourceRowIds: [],
        accs: aggregates.map(() => emptyAggState()),
      };
      groups.set(mapKey, group);
    }
    group.sourceRowIds.push(rowId(row));
    aggregates.forEach((spec, i) => feedAggState(group!.accs[i]!, spec, row));
  }

  const out: OutputRow[] = [];
  for (const group of groups.values()) {
    const record: Record<string, unknown> = {};
    groupBy.forEach((field, i) => {
      record[field] = group.keyValues[i];
    });
    aggregates.forEach((spec, i) => {
      record[spec.alias] = finalizeAggState(group.accs[i]!, spec);
    });
    const masked = applyMasks(record, snapshot.masks, group.representative);
    out.push({ ...masked, sourceRowIds: group.sourceRowIds });
  }
  return out;
}
