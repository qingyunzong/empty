import { canonical, sha256, hashRow } from './canon.js';
import { ProvError } from './errors.js';

const isNull = (v) => v === null || v === undefined;

export const lineageId = (table, key) => `${table} ${String(key)}`;

function parseRef(ref) {
  const i = ref.indexOf('.');
  return i === -1 ? { alias: null, col: ref } : { alias: ref.slice(0, i), col: ref.slice(i + 1) };
}

function getVal(rows, ref) {
  const { alias, col } = parseRef(ref);
  if (alias !== null) {
    if (!Object.prototype.hasOwnProperty.call(rows, alias)) {
      throw new ProvError('E_KEY', `unknown table alias '${alias}' in reference '${ref}'`);
    }
    return rows[alias]?.[col];
  }
  let found;
  let hits = 0;
  for (const a of Object.keys(rows)) {
    if (rows[a] != null && col in rows[a]) {
      found = rows[a][col];
      hits += 1;
    }
  }
  if (hits > 1) throw new ProvError('E_KEY', `ambiguous column reference '${ref}'; qualify it with a table name`);
  return found; // undefined behaves as NULL
}

export function tableKeys(name, table) {
  if (!table || typeof table !== 'object') throw new ProvError('E_KEY', `unknown table '${name}'`);
  const keyCol = table.key;
  if (typeof keyCol !== 'string' || !keyCol) {
    throw new ProvError('E_KEY', `table '${name}' has no key column declaration`);
  }
  if (!Array.isArray(table.rows)) throw new ProvError('E_KEY', `table '${name}' rows must be an array`);
  const seen = new Set();
  return table.rows.map((row, i) => {
    const k = row?.[keyCol];
    if (isNull(k)) throw new ProvError('E_KEY', `table '${name}' row ${i} has NULL key '${keyCol}'`);
    const id = String(k);
    if (seen.has(id)) throw new ProvError('E_KEY', `table '${name}' has duplicate key '${id}'`);
    seen.add(id);
    return k;
  });
}

function evalPred(pred, rows) {
  if (!pred || typeof pred.col !== 'string') throw new ProvError('E_KEY', 'where predicate requires a "col"');
  const v = getVal(rows, pred.col);
  if (pred.op === 'is-null') return isNull(v);
  if (pred.op === 'not-null') return !isNull(v);
  if (isNull(v) || isNull(pred.value)) return 'unknown';
  switch (pred.op) {
    case '=': return v === pred.value;
    case '!=': return v !== pred.value;
    case '<': return v < pred.value;
    case '<=': return v <= pred.value;
    case '>': return v > pred.value;
    case '>=': return v >= pred.value;
    case 'in': return Array.isArray(pred.value) ? pred.value.includes(v) : false;
    default: throw new ProvError('E_KEY', `unknown predicate op '${pred.op}'`);
  }
}

function validateQuery(query) {
  if (!query || typeof query !== 'object' || typeof query.from !== 'string') {
    throw new ProvError('E_KEY', 'query requires a "from" table');
  }
  for (const j of query.joins ?? []) {
    if (!['inner', 'semi'].includes(j.type)) throw new ProvError('E_KEY', `unknown join type '${j.type}'`);
    if (typeof j.table !== 'string' || !Array.isArray(j.on) || j.on.length === 0) {
      throw new ProvError('E_KEY', 'join requires "table" and a non-empty "on" array of [left, right] pairs');
    }
    for (const pair of j.on) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new ProvError('E_KEY', 'join "on" entries must be [leftRef, rightRef]');
    }
  }
  for (const a of query.aggregates ?? []) {
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(a.fn)) throw new ProvError('E_KEY', `unknown aggregate '${a.fn}'`);
    if (a.fn !== 'count' && typeof a.col !== 'string') throw new ProvError('E_KEY', `aggregate '${a.fn}' requires a "col"`);
    if (a.fn === 'count' && a.col !== '*' && typeof a.col !== 'string') throw new ProvError('E_KEY', 'count requires "col" or "*"');
  }
}

function computeAgg(agg, contexts) {
  if (agg.fn === 'count' && agg.col === '*') return contexts.length;
  const vals = contexts.map((c) => getVal(c.rows, agg.col)).filter((v) => !isNull(v));
  if (agg.fn === 'count') return vals.length;
  if (vals.length === 0) return null;
  if (agg.fn === 'sum') return vals.reduce((a, b) => a + b, 0);
  if (agg.fn === 'avg') return vals.reduce((a, b) => a + b, 0) / vals.length;
  if (agg.fn === 'min') return vals.reduce((a, b) => (b < a ? b : a));
  if (agg.fn === 'max') return vals.reduce((a, b) => (b > a ? b : a));
  throw new ProvError('E_KEY', `unknown aggregate '${agg.fn}'`);
}

// Minimal witness set per aggregate. Tied min/max rows are ALL listed.
function minimalForGroup(query, contexts) {
  const result = new Map();
  const addCtx = (c) => { for (const [id, e] of c.lineage) result.set(id, e); };
  const aggs = query.aggregates ?? [];
  if (aggs.length === 0) {
    contexts.forEach(addCtx);
    return [...result.values()];
  }
  for (const agg of aggs) {
    if (agg.fn === 'min' || agg.fn === 'max') {
      const vals = contexts.map((c) => getVal(c.rows, agg.col));
      const nonNull = vals.filter((v) => !isNull(v));
      if (nonNull.length === 0) continue;
      const extreme = nonNull.reduce((a, b) => (agg.fn === 'min' ? (b < a ? b : a) : (b > a ? b : a)));
      contexts.forEach((c, i) => { if (vals[i] === extreme) addCtx(c); });
    } else if (agg.fn === 'sum') {
      contexts.forEach((c) => { if (!isNull(getVal(c.rows, agg.col))) addCtx(c); });
    } else if (agg.fn === 'count' && agg.col !== '*') {
      contexts.forEach((c) => { if (!isNull(getVal(c.rows, agg.col))) addCtx(c); });
    } else {
      contexts.forEach(addCtx);
    }
  }
  return [...result.values()];
}

const sortLineage = (entries) =>
  entries.sort((a, b) => (a.table + canonical(a.key)).localeCompare(b.table + canonical(b.key)));

function selectValues(query, ctx, aggValues, groupCols) {
  const items = query.select ?? [
    ...(groupCols ?? []),
    ...(query.aggregates ?? []).map((a) => a.as ?? `${a.fn}(${a.col})`),
  ];
  const out = {};
  for (const item of items) {
    if (aggValues && Object.prototype.hasOwnProperty.call(aggValues, item)) {
      out[item] = aggValues[item];
    } else {
      out[item] = getVal(ctx.rows, item) ?? null;
    }
  }
  return out;
}

export function execute(query, tables) {
  validateQuery(query);
  const from = query.from;
  const fromTable = tables[from];
  const fromKeys = tableKeys(from, fromTable);

  let contexts = fromTable.rows.map((row, i) => {
    const lineage = new Map();
    lineage.set(lineageId(from, fromKeys[i]), { table: from, key: fromKeys[i], rowHash: hashRow(row) });
    return { rows: { [from]: row }, partial: false, lineage };
  });

  for (const join of query.joins ?? []) {
    const right = tables[join.table];
    const rightKeys = tableKeys(join.table, right);
    const index = new Map(); // canonical join values -> right row indexes; NULL keys never indexed
    right.rows.forEach((row, i) => {
      const vals = join.on.map(([, rref]) => getVal({ [join.table]: row }, rref));
      if (vals.some(isNull)) return; // NULL keys do not join
      const ck = canonical(vals);
      if (!index.has(ck)) index.set(ck, []);
      index.get(ck).push(i);
    });
    const next = [];
    for (const ctx of contexts) {
      const vals = join.on.map(([lref]) => getVal(ctx.rows, lref));
      const matches = vals.some(isNull) ? [] : index.get(canonical(vals)) ?? [];
      if (join.type === 'inner') {
        for (const mi of matches) {
          const lineage = new Map(ctx.lineage);
          lineage.set(lineageId(join.table, rightKeys[mi]), {
            table: join.table, key: rightKeys[mi], rowHash: hashRow(right.rows[mi]),
          });
          next.push({ rows: { ...ctx.rows, [join.table]: right.rows[mi] }, partial: ctx.partial, lineage });
        }
      } else {
        // semi-join: keep the left context once (dedup), record deduped right keys as lineage
        if (matches.length > 0) {
          const lineage = new Map(ctx.lineage);
          for (const mi of matches) {
            lineage.set(lineageId(join.table, rightKeys[mi]), {
              table: join.table, key: rightKeys[mi], rowHash: hashRow(right.rows[mi]),
            });
          }
          next.push({ rows: ctx.rows, partial: ctx.partial, lineage });
        }
      }
    }
    contexts = next;
  }

  if (query.where?.length) {
    const kept = [];
    for (const ctx of contexts) {
      let status = true;
      for (const pred of query.where) {
        const r = evalPred(pred, ctx.rows);
        if (r === false) { status = false; break; }
        if (r === 'unknown') status = 'unknown';
      }
      // UNKNOWN is kept and flagged partial: never dropped, never treated as unsatisfied.
      if (status === false) continue;
      kept.push({ rows: ctx.rows, partial: ctx.partial || status === 'unknown', lineage: ctx.lineage });
    }
    contexts = kept;
  }

  const groupCols = query.groupby ?? [];
  const aggs = query.aggregates ?? [];
  const outputs = [];

  if (groupCols.length > 0 || aggs.length > 0) {
    const groups = new Map();
    for (const ctx of contexts) {
      const keyVals = groupCols.map((ref) => getVal(ctx.rows, ref) ?? null);
      const gk = canonical(keyVals);
      if (!groups.has(gk)) groups.set(gk, { keyVals, contexts: [] });
      groups.get(gk).contexts.push(ctx);
    }
    for (const g of groups.values()) {
      const aggValues = {};
      for (const agg of aggs) aggValues[agg.as ?? `${agg.fn}(${agg.col})`] = computeAgg(agg, g.contexts);
      const values = selectValues(query, g.contexts[0], aggValues, groupCols);
      const merged = new Map();
      for (const ctx of g.contexts) for (const [id, e] of ctx.lineage) merged.set(id, e);
      outputs.push({
        outKey: 'grp:' + canonical(g.keyVals),
        values,
        provenance: g.contexts.some((c) => c.partial) ? 'partial' : 'complete',
        contributions: sortLineage([...merged.values()]),
        minimal: sortLineage(minimalForGroup(query, g.contexts)),
      });
    }
  } else {
    for (const ctx of contexts) {
      const values = selectValues(query, ctx, null, null);
      const contributions = sortLineage([...ctx.lineage.values()]);
      const outKey = 'row:' + sha256(canonical({ v: values, s: contributions.map((c) => lineageId(c.table, c.key)) })).slice(0, 24);
      outputs.push({
        outKey,
        values,
        provenance: ctx.partial ? 'partial' : 'complete',
        contributions,
        minimal: contributions,
      });
    }
  }

  const inputIndex = {};
  for (const o of outputs) {
    for (const c of o.contributions) {
      const id = lineageId(c.table, c.key);
      (inputIndex[id] ??= []).push(o.outKey);
    }
  }
  return { outputs, inputIndex };
}

// Columns whose change can move a row in/out of a join/group/filter (membership),
// versus all columns the query reads (values).
export function referencedColumns(query) {
  const membership = new Set();
  const rest = new Set();
  for (const j of query.joins ?? []) for (const [l, r] of j.on ?? []) { membership.add(l); membership.add(r); }
  for (const w of query.where ?? []) membership.add(w.col);
  for (const g of query.groupby ?? []) membership.add(g);
  for (const s of query.select ?? []) rest.add(s);
  for (const a of query.aggregates ?? []) if (a.col !== '*') rest.add(a.col);
  return { membership, all: new Set([...membership, ...rest]) };
}

export function colMatches(set, table, col) {
  return set.has(col) || set.has(`${table}.${col}`);
}
