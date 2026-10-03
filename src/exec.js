import { tvCompare, tvAnd, tvOr, tvNot, TRUE, UNKNOWN } from './tvl.js';
import { typeError } from './errors.js';
import { canon } from './hash.js';

// ---------- predicate evaluation (three-valued) ----------

export function evalOperand(op, row) {
  if (op.kind === 'lit') return op.value;
  const v = row[op.ref];
  return v === undefined ? null : v;
}

export function evalPred(e, row) {
  switch (e.kind) {
    case 'and': {
      let acc = TRUE;
      for (const a of e.args) acc = tvAnd(acc, evalPred(a, row));
      return acc;
    }
    case 'or': {
      let acc = 'false';
      for (const a of e.args) acc = tvOr(acc, evalPred(a, row));
      return acc;
    }
    case 'not':
      return tvNot(evalPred(e.arg, row));
    case 'isnull': {
      const v = evalOperand(e.operand, row);
      const isNull = v === null || v === undefined;
      return (isNull !== !!e.negated) ? TRUE : 'false';
    }
    case 'cmp':
      return tvCompare(e.op, evalOperand(e.left, row), evalOperand(e.right, row));
    default:
      throw new Error(`evalPred: unknown kind ${e.kind}`);
  }
}

// ---------- aggregates (NULLs ignored; empty non-null set -> NULL, COUNT -> 0) ----------

function nonNullValues(rows, ref) {
  const vals = [];
  for (const r of rows) {
    const v = r[ref];
    if (v !== null && v !== undefined) vals.push(v);
  }
  return vals;
}

export function computeAgg(agg, rows) {
  const { func, arg } = agg;
  if (func === 'count') return arg === '*' ? rows.length : nonNullValues(rows, arg).length;
  const vals = nonNullValues(rows, arg);
  if (func === 'sum' || func === 'avg') {
    let s = 0;
    for (const v of vals) {
      if (typeof v !== 'number') throw typeError(`${func.toUpperCase()}() requires numeric input, got ${typeof v}`);
      s += v;
    }
    if (vals.length === 0) return null;
    return func === 'sum' ? s : s / vals.length;
  }
  if (func === 'min' || func === 'max') {
    if (vals.length === 0) return null;
    const t = typeof vals[0];
    if (t !== 'number' && t !== 'string') throw typeError(`${func.toUpperCase()}() requires numeric or string input`);
    for (const v of vals) if (typeof v !== t) throw typeError(`${func.toUpperCase()}() got mixed types`);
    return vals.reduce((a, b) => (func === 'min' ? (b < a ? b : a) : (b > a ? b : a)));
  }
  throw new Error(`computeAgg: unknown func ${func}`);
}

// partial-aggregation state machine used by the aggregate_pushdown rewrite
export function initState(agg) {
  switch (agg.func) {
    case 'count': return { n: 0 };
    case 'sum': case 'avg': return { s: 0, n: 0 };
    case 'min': case 'max': return { m: null, n: 0, t: null };
    default: throw new Error(`initState: unknown func ${agg.func}`);
  }
}

export function accumState(agg, st, row) {
  const raw = agg.arg === '*' ? 1 : row[agg.arg];
  const v = raw === undefined ? null : raw;
  switch (agg.func) {
    case 'count':
      if (agg.arg === '*' || v !== null) st.n++;
      break;
    case 'sum':
    case 'avg':
      if (v !== null) {
        if (typeof v !== 'number') throw typeError(`${agg.func.toUpperCase()}() requires numeric input, got ${typeof v}`);
        st.s += v; st.n++;
      }
      break;
    case 'min':
    case 'max':
      if (v !== null) {
        const t = typeof v;
        if (t !== 'number' && t !== 'string') throw typeError(`${agg.func.toUpperCase()}() requires numeric or string input`);
        if (st.n > 0 && st.t !== t) throw typeError(`${agg.func.toUpperCase()}() got mixed types`);
        if (st.n === 0 || (agg.func === 'min' ? v < st.m : v > st.m)) { st.m = v; st.t = t; }
        st.n++;
      }
      break;
    default:
      break;
  }
}

export function mergeState(agg, st, p) {
  switch (agg.func) {
    case 'count': st.n += p.n; break;
    case 'sum': case 'avg': st.s += p.s; st.n += p.n; break;
    case 'min': case 'max':
      if (p.n > 0) {
        if (st.n === 0 || (agg.func === 'min' ? p.m < st.m : p.m > st.m)) { st.m = p.m; st.t = p.t; }
        st.n += p.n;
      }
      break;
    default:
      break;
  }
}

export function finalizeAgg(agg, st) {
  switch (agg.func) {
    case 'count': return st.n;
    case 'sum': return st.n > 0 ? st.s : null;
    case 'avg': return st.n > 0 ? st.s / st.n : null;
    case 'min': case 'max': return st.n > 0 ? st.m : null;
    default: throw new Error(`finalizeAgg: unknown func ${agg.func}`);
  }
}

// ---------- shared row helpers ----------

function scanRows(node, ctx, columns) {
  const table = ctx.tables[node.table];
  if (!table) throw typeError(`unknown table ${node.table}`);
  return table.rows.map((r) => {
    const out = {};
    for (const c of columns) {
      const v = r[c];
      out[`${node.alias}.${c}`] = v === undefined ? null : v;
    }
    return out;
  });
}

function keysMatch(l, r, leftKeys, rightKeys) {
  for (let i = 0; i < leftKeys.length; i++) {
    const a = l[leftKeys[i]];
    const b = r[rightKeys[i]];
    // NULL join keys never match (three-valued: equality with NULL is UNKNOWN)
    if (a === null || a === undefined || b === null || b === undefined) return false;
    if (typeof a !== typeof b) throw typeError(`join key type mismatch: ${typeof a} vs ${typeof b}`);
    if (a !== b) return false;
  }
  return true;
}

function nestedJoinRows(L, R, leftKeys, rightKeys) {
  const out = [];
  for (const l of L) {
    for (const r of R) {
      if (keysMatch(l, r, leftKeys, rightKeys)) out.push({ ...l, ...r });
    }
  }
  return out;
}

function hashJoinRows(L, R, leftKeys, rightKeys) {
  const table = new Map();
  for (const r of R) {
    const kv = [];
    let skip = false;
    for (const k of rightKeys) {
      const v = r[k];
      if (v === null || v === undefined) { skip = true; break; }
      kv.push(v);
    }
    if (skip) continue; // NULL join keys never join
    const key = canon(kv);
    let bucket = table.get(key);
    if (!bucket) { bucket = []; table.set(key, bucket); }
    bucket.push(r);
  }
  const out = [];
  for (const l of L) {
    const kv = [];
    let skip = false;
    for (const k of leftKeys) {
      const v = l[k];
      if (v === null || v === undefined) { skip = true; break; }
      kv.push(v);
    }
    if (skip) continue;
    const bucket = table.get(canon(kv));
    if (!bucket) continue;
    for (const r of bucket) {
      if (keysMatch(l, r, leftKeys, rightKeys)) out.push({ ...l, ...r });
    }
  }
  return out;
}

function projectRows(rows, items) {
  return rows.map((r) => {
    const o = {};
    for (const it of items) {
      let name = it.name;
      let i = 2;
      while (name in o) name = `${it.name}_${i++}`;
      const v = r[it.ref];
      o[name] = v === undefined ? null : v;
    }
    return o;
  });
}

function groupRowsBy(rows, keys) {
  const groups = new Map();
  for (const row of rows) {
    const kv = keys.map((k) => {
      const v = row[k];
      return v === undefined ? null : v;
    });
    const gk = canon(kv);
    let g = groups.get(gk);
    if (!g) { g = { kv, rows: [] }; groups.set(gk, g); }
    g.rows.push(row);
  }
  if (keys.length === 0 && groups.size === 0) groups.set('[]', { kv: [], rows: [] });
  return groups;
}

function buildGroupRow(keys, kv) {
  const grow = {};
  keys.forEach((k, i) => { grow[k] = kv[i]; });
  return grow;
}

// FALSE groups are dropped (standard SQL); UNKNOWN groups are reported, never silently dropped
function havingBucket(having, grow) {
  const hv = having ? evalPred(having, grow) : TRUE;
  if (hv === TRUE) return 'rows';
  if (hv === UNKNOWN) return 'unknown';
  return null;
}

function groupbyExec({ keys, aggs, having }, inputRows) {
  const groups = groupRowsBy(inputRows, keys);
  const out = [], unknown = [];
  for (const g of groups.values()) {
    const grow = buildGroupRow(keys, g.kv);
    for (const a of aggs) grow[a.alias] = computeAgg(a, g.rows);
    const bucket = havingBucket(having, grow);
    if (bucket === 'rows') out.push(grow);
    else if (bucket === 'unknown') unknown.push(grow);
  }
  return { rows: out, unknown };
}

function partaggExec({ keys, aggs }, inputRows) {
  const groups = groupRowsBy(inputRows, keys);
  const out = [];
  for (const g of groups.values()) {
    const prow = buildGroupRow(keys, g.kv);
    aggs.forEach((a, i) => {
      const st = initState(a);
      for (const r of g.rows) accumState(a, st, r);
      prow[`__st${i}`] = st;
    });
    out.push(prow);
  }
  return out;
}

function finalaggExec({ keys, aggs, having }, inputRows) {
  const groups = groupRowsBy(inputRows, keys);
  const out = [], unknown = [];
  for (const g of groups.values()) {
    const grow = buildGroupRow(keys, g.kv);
    aggs.forEach((a, i) => {
      const st = initState(a);
      for (const prow of g.rows) mergeState(a, st, prow[`__st${i}`]);
      grow[a.alias] = finalizeAgg(a, st);
    });
    const bucket = havingBucket(having, grow);
    if (bucket === 'rows') out.push(grow);
    else if (bucket === 'unknown') unknown.push(grow);
  }
  return { rows: out, unknown };
}

// ---------- direct enumeration over the logical plan (ground truth) ----------

export function execLogical(node, ctx) {
  switch (node.type) {
    case 'scan':
      return { rows: scanRows(node, ctx, node.columns), unknown: [] };
    case 'select': {
      const { rows } = execLogical(node.input, ctx);
      return { rows: rows.filter((r) => evalPred(node.predicate, r) === TRUE), unknown: [] };
    }
    case 'project': {
      const inner = execLogical(node.input, ctx);
      return { rows: projectRows(inner.rows, node.items), unknown: projectRows(inner.unknown, node.items) };
    }
    case 'join': {
      const L = execLogical(node.left, ctx).rows;
      const R = execLogical(node.right, ctx).rows;
      return { rows: nestedJoinRows(L, R, node.leftKeys, node.rightKeys), unknown: [] };
    }
    case 'groupby': {
      const { rows } = execLogical(node.input, ctx);
      return groupbyExec(node, rows);
    }
    case 'aggpartial': {
      const { rows } = execLogical(node.input, ctx);
      return { rows: partaggExec(node, rows), unknown: [] };
    }
    case 'aggfinal': {
      const { rows } = execLogical(node.input, ctx);
      return finalaggExec(node, rows);
    }
    default:
      throw new Error(`execLogical: unknown node type ${node.type}`);
  }
}

// ---------- physical operator execution ----------

export function execPhysical(node, ctx) {
  switch (node.op) {
    case 'seqscan':
      return { rows: scanRows(node, ctx, node.columns), unknown: [] };
    case 'filter': {
      const inner = execPhysical(node.input, ctx);
      return { ...inner, rows: inner.rows.filter((r) => evalPred(node.predicate, r) === TRUE) };
    }
    case 'project': {
      const inner = execPhysical(node.input, ctx);
      return { rows: projectRows(inner.rows, node.items), unknown: projectRows(inner.unknown, node.items) };
    }
    case 'nestedjoin': {
      const L = execPhysical(node.left, ctx).rows;
      const R = execPhysical(node.right, ctx).rows;
      return { rows: nestedJoinRows(L, R, node.leftKeys, node.rightKeys), unknown: [] };
    }
    case 'hashjoin': {
      const L = execPhysical(node.left, ctx).rows;
      const R = execPhysical(node.right, ctx).rows;
      return { rows: hashJoinRows(L, R, node.leftKeys, node.rightKeys), unknown: [] };
    }
    case 'hashagg': {
      const { rows } = execPhysical(node.input, ctx);
      return groupbyExec(node, rows);
    }
    case 'partagg': {
      const { rows } = execPhysical(node.input, ctx);
      return { rows: partaggExec(node, rows), unknown: [] };
    }
    case 'finalagg': {
      const { rows } = execPhysical(node.input, ctx);
      return finalaggExec(node, rows);
    }
    default:
      throw new Error(`execPhysical: unknown op ${node.op}`);
  }
}
