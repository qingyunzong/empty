import { canonicalize, hashValue } from './canon.js';
import { ProvError, E_KEY } from './errors.js';

const norm = (v) => (v === undefined ? null : v);

const OPS = {
  '=': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

export function ridOf(table, row, keyCol) {
  const key = norm(row[keyCol]);
  if (key === null) {
    throw new ProvError(E_KEY, `row in table '${table}' is missing key column '${keyCol}'`);
  }
  return `${table}:${String(key)}`;
}

export function validateTable(name, table) {
  const seen = new Set();
  for (const row of table.rows) {
    const id = ridOf(name, row, table.key);
    if (seen.has(id)) throw new ProvError(E_KEY, `duplicate key '${id}' in table '${name}'`);
    seen.add(id);
  }
}

function prefixed(table, row) {
  const vals = {};
  for (const [k, v] of Object.entries(row)) vals[`${table}.${k}`] = v;
  return vals;
}

function colName(ref) {
  return ref.slice(ref.indexOf('.') + 1);
}

// Three-valued predicate evaluation: true | false | null (unknown).
function evalPred(pred, get) {
  const op = pred.op;
  if (op === 'isNull') return get(pred.col) === null;
  if (op === 'notNull') return get(pred.col) !== null;
  const fn = OPS[op];
  if (!fn) throw new Error(`unsupported predicate op '${op}'`);
  const a = get(pred.col);
  const b = pred.value !== undefined ? pred.value : get(pred.other);
  if (a === null || b === null) return null; // unknown: never dropped, never failed
  return fn(a, b);
}

function predText(pred) {
  if (pred.op === 'isNull' || pred.op === 'notNull') return `${pred.col} ${pred.op}`;
  const rhs = pred.value !== undefined ? JSON.stringify(pred.value) : pred.other;
  return `${pred.col} ${pred.op} ${rhs}`;
}

function applyJoin(tuples, join, tables) {
  const right = tables.get(join.table);
  if (!right) throw new ProvError(E_KEY, `unknown join table '${join.table}'`);
  const pairs = join.on;
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('join.on must be [[left,right],...]');
  const index = new Map();
  for (const row of right.rows) {
    const kvals = pairs.map(([, r]) => norm(row[colName(r)]));
    if (kvals.some((v) => v === null)) continue; // NULL keys never connect
    const h = hashValue(kvals);
    if (!index.has(h)) index.set(h, []);
    index.get(h).push(row);
  }
  const out = [];
  for (const t of tuples) {
    const lvals = pairs.map(([l]) => norm(t.vals[l]));
    if (lvals.some((v) => v === null)) continue; // NULL keys never connect
    const matches = index.get(hashValue(lvals)) ?? [];
    if (join.type === 'semi') {
      if (matches.length === 0) continue;
      const prov = new Set(t.prov);
      for (const m of matches) prov.add(ridOf(join.table, m, right.key));
      out.push({ ...t, prov }); // de-duplicated: left tuple kept once
    } else {
      for (const m of matches) {
        const prov = new Set(t.prov);
        prov.add(ridOf(join.table, m, right.key));
        out.push({
          vals: { ...t.vals, ...prefixed(join.table, m) },
          prov,
          partial: t.partial,
          unknowns: t.unknowns,
        });
      }
    }
  }
  return out;
}

function applyWhere(tuples, pred) {
  const table = pred.col.slice(0, pred.col.indexOf('.'));
  const desc = predText(pred);
  const out = [];
  for (const t of tuples) {
    const r = evalPred(pred, (c) => norm(t.vals[c]));
    if (r === true) {
      out.push(t);
    } else if (r === null) {
      // unknown predicate: keep the row, mark provenance partial
      const inputs = [...t.prov].filter((id) => id.startsWith(`${table}:`)).sort();
      out.push({ ...t, partial: true, unknowns: [...t.unknowns, { predicate: desc, inputs }] });
    }
    // false: dropped
  }
  return out;
}

function allProv(members) {
  const s = new Set();
  for (const m of members) for (const p of m.prov) s.add(p);
  return s;
}

function computeAgg(agg, members) {
  const { fn, col } = agg;
  if (fn === 'count') {
    if (!col) return { value: members.length, minimalProv: allProv(members) };
    const vals = members.filter((m) => norm(m.vals[col]) !== null);
    return { value: vals.length, minimalProv: allProv(vals) };
  }
  const valued = members.filter((m) => norm(m.vals[col]) !== null);
  const vals = valued.map((m) => norm(m.vals[col]));
  if (fn === 'sum') return { value: vals.reduce((a, b) => a + b, 0), minimalProv: allProv(valued) };
  if (fn === 'avg') {
    return {
      value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      minimalProv: allProv(valued),
    };
  }
  if (fn === 'min' || fn === 'max') {
    if (!vals.length) return { value: null, minimalProv: new Set() };
    const extreme = fn === 'min' ? Math.min(...vals) : Math.max(...vals);
    // tied minimal contribution sets: every tied row is listed
    const tied = valued.filter((m) => norm(m.vals[col]) === extreme);
    return { value: extreme, minimalProv: allProv(tied) };
  }
  throw new Error(`unsupported aggregate '${fn}'`);
}

function selectOutput(query, tuples) {
  const select = query.select ?? [];
  return tuples.map((t) => {
    const row = {};
    for (const s of select) {
      if (typeof s === 'string') row[colName(s)] = norm(t.vals[s]);
      else row[s.as ?? colName(s.col)] = norm(t.vals[s.col]);
    }
    const contributors = [...t.prov].sort();
    return {
      outKey: `row|${contributors.join('+')}`,
      row,
      provenance: { contributors, minimal: contributors, partial: t.partial, unknowns: t.unknowns },
    };
  });
}

function groupOutput(query, tuples) {
  const groupBy = query.groupBy ?? [];
  const aggs = query.aggregates ?? [];
  const groups = new Map();
  for (const t of tuples) {
    const gvals = groupBy.map((c) => norm(t.vals[c]));
    const gh = hashValue(gvals);
    if (!groups.has(gh)) groups.set(gh, { gvals, members: [] });
    groups.get(gh).members.push(t);
  }
  const outputs = [];
  for (const { gvals, members } of groups.values()) {
    const row = {};
    groupBy.forEach((c, i) => {
      row[colName(c)] = gvals[i];
    });
    const contributors = [...allProv(members)].sort();
    const minimal = new Set();
    for (const agg of aggs) {
      const { value, minimalProv } = computeAgg(agg, members);
      row[agg.as ?? `${agg.fn}_${agg.col ? colName(agg.col) : 'all'}`] = value;
      for (const p of minimalProv) minimal.add(p);
    }
    if (aggs.length === 0) for (const c of contributors) minimal.add(c);
    outputs.push({
      outKey: `grp|${canonicalize(gvals)}`,
      row,
      provenance: {
        contributors,
        minimal: [...minimal].sort(),
        partial: members.some((m) => m.partial),
        unknowns: members.flatMap((m) => m.unknowns),
      },
    });
  }
  return outputs;
}

function dedupeOutKeys(outputs) {
  const seen = new Map();
  for (const o of outputs) {
    const n = (seen.get(o.outKey) ?? 0) + 1;
    seen.set(o.outKey, n);
    if (n > 1) o.outKey = `${o.outKey}#${n}`;
  }
  return outputs.sort((a, b) => (a.outKey < b.outKey ? -1 : a.outKey > b.outKey ? 1 : 0));
}

export function execute(query, tables) {
  if (!query || typeof query !== 'object') throw new Error('query must be an object');
  const from = tables.get(query.from);
  if (!from) throw new ProvError(E_KEY, `unknown from-table '${query.from}'`);
  for (const [name, t] of tables) validateTable(name, t);
  let tuples = from.rows.map((row) => ({
    vals: prefixed(query.from, row),
    prov: new Set([ridOf(query.from, row, from.key)]),
    partial: false,
    unknowns: [],
  }));
  for (const join of query.joins ?? []) tuples = applyJoin(tuples, join, tables);
  for (const pred of query.where ?? []) tuples = applyWhere(tuples, pred);
  const outputs =
    (query.groupBy?.length || query.aggregates?.length)
      ? groupOutput(query, tuples)
      : selectOutput(query, tuples);
  return dedupeOutKeys(outputs);
}
