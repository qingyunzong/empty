// Restricted relational algebra: selection predicates over a single evidence
// relation, plus scalar aggregates. Predicates use SQL-style three-valued
// logic: any comparison touching NULL yields null (unknown).

const CMP_OPS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);

export function evalPred(pred, fields) {
  if (pred == null) return true;
  const op = pred.op;
  switch (op) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'and': {
      let sawNull = false;
      for (const arg of pred.args ?? []) {
        const r = evalPred(arg, fields);
        if (r === false) return false;
        if (r === null) sawNull = true;
      }
      return sawNull ? null : true;
    }
    case 'or': {
      let sawNull = false;
      for (const arg of pred.args ?? []) {
        const r = evalPred(arg, fields);
        if (r === true) return true;
        if (r === null) sawNull = true;
      }
      return sawNull ? null : false;
    }
    case 'not': {
      const r = evalPred(pred.arg, fields);
      return r === null ? null : !r;
    }
    case 'isnull':
      return fields[pred.field] == null;
    case 'notnull':
      return fields[pred.field] != null;
    case 'in': {
      const v = fields[pred.field];
      if (v == null) return null;
      return (pred.values ?? []).some((x) => x === v);
    }
    default:
      break;
  }
  if (CMP_OPS.has(op)) {
    const v = fields[pred.field];
    const w = pred.value;
    if (v == null || w == null) return null;
    switch (op) {
      case 'eq': return v === w;
      case 'ne': return v !== w;
      case 'lt': return v < w;
      case 'lte': return v <= w;
      case 'gt': return v > w;
      case 'gte': return v >= w;
      default: return null;
    }
  }
  throw new Error(`unknown predicate op: ${op}`);
}

// Aggregate state with NULL semantics: NULL field values are ignored by
// sum/min/max and by count(field); count(*) counts rows.
export function emptyAggState() {
  return { rows: 0, nonNull: 0, sum: 0, min: null, max: null };
}

export function aggStateOfRow(agg, row) {
  const state = emptyAggState();
  state.rows = 1;
  if (agg.field && agg.field !== '*') {
    const v = row.fields[agg.field];
    if (v != null) {
      if (agg.op === 'sum' && typeof v !== 'number') {
        throw new Error(`sum requires numeric field, got ${typeof v} for key ${row.key}`);
      }
      state.nonNull = 1;
      state.sum = v;
      state.min = v;
      state.max = v;
    }
  }
  return state;
}

export function combineAggState(a, b) {
  const out = emptyAggState();
  out.rows = a.rows + b.rows;
  out.nonNull = a.nonNull + b.nonNull;
  out.sum = a.sum + b.sum;
  if (a.min === null) out.min = b.min;
  else if (b.min === null) out.min = a.min;
  else out.min = a.min < b.min ? a.min : b.min;
  if (a.max === null) out.max = b.max;
  else if (b.max === null) out.max = a.max;
  else out.max = a.max > b.max ? a.max : b.max;
  return out;
}

export function finalizeAgg(agg, state) {
  switch (agg.op) {
    case 'count':
      return !agg.field || agg.field === '*' ? state.rows : state.nonNull;
    case 'sum':
      return state.nonNull === 0 ? null : state.sum;
    case 'min':
      return state.nonNull === 0 ? null : state.min;
    case 'max':
      return state.nonNull === 0 ? null : state.max;
    default:
      throw new Error(`unknown aggregate op: ${agg.op}`);
  }
}

export function aggregateRows(agg, rows) {
  let state = emptyAggState();
  for (const row of rows) state = combineAggState(state, aggStateOfRow(agg, row));
  return finalizeAgg(agg, state);
}

// Three-valued comparison: NULL on either side yields null (unknown).
export function compare(value, cmp) {
  if (value == null || cmp.value == null) return null;
  switch (cmp.op) {
    case 'eq': return value === cmp.value;
    case 'ne': return value !== cmp.value;
    case 'lt': return value < cmp.value;
    case 'lte': return value <= cmp.value;
    case 'gt': return value > cmp.value;
    case 'gte': return value >= cmp.value;
    default: throw new Error(`unknown comparison op: ${cmp.op}`);
  }
}
