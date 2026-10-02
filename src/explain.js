import { diffSnapshots } from './diff.js';
import { fail } from './errors.js';

const SEP = '';

// Causal graph nodes:
//   param:<path>     a parameter whose value differs between the runs
//   row:<table>:<k>  a row (by primary key) that differs / exists on one side
// Edges:
//   param -> row     when the table declares dependsOn for that parameter
//   row  -> row      when a differing row references another differing row
//                    via schema refs (foreign-key style)
export function buildCausalGraph(snapA, snapB, diff) {
  const nodes = new Map();
  const edges = new Map();
  const addNode = (id, kind, detail) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, ...detail });
  };
  const addEdge = (from, to) => {
    if (from === to) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };
  const params = diff.params.map((p) => `param:${p.path}`);
  for (const p of diff.params) addNode(`param:${p.path}`, 'param', { path: p.path });
  const diffRows = [];
  for (const [table, td] of Object.entries(diff.tables)) {
    if (td.tableMissing) continue;
    const keys = [...td.onlyInA, ...td.onlyInB, ...td.changed.map((c) => c.key)];
    for (const key of keys) {
      const id = `row:${table}:${key}`;
      addNode(id, 'row', { table, key });
      diffRows.push(id);
    }
  }
  const schemaTables = snapB.schema?.tables && Object.keys(snapB.schema.tables).length
    ? snapB.schema.tables
    : (snapA.schema?.tables ?? {});
  for (const [table, meta] of Object.entries(schemaTables)) {
    for (const pid of params) {
      const pname = pid.slice('param:'.length);
      if ((meta.dependsOn ?? []).includes(pname)) {
        for (const id of diffRows) {
          if (nodes.get(id).table === table) addEdge(pid, id);
        }
      }
    }
  }
  // refs: row in `table` references a row in another table via column value
  const rowMaps = new Map();
  const rowMapFor = (snap, table) => {
    const cacheKey = `${snap.name} ${table}`;
    if (!rowMaps.has(cacheKey)) {
      const tdef = snap.tables[table];
      const m = new Map();
      if (tdef?.key?.length) {
        const idx = tdef.key.map((k) => tdef.columns.indexOf(k));
        for (const r of tdef.rows) m.set(idx.map((i) => r[i]).join(SEP), r);
      }
      rowMaps.set(cacheKey, m);
    }
    return rowMaps.get(cacheKey);
  };
  for (const [table, meta] of Object.entries(schemaTables)) {
    for (const [col, target] of Object.entries(meta.refs ?? {})) {
      const targetMeta = schemaTables[target];
      if (!targetMeta || targetMeta.key.length !== 1) continue;
      const snap = snapB.tables[table] ? snapB : snapA;
      const tdef = snap.tables[table];
      if (!tdef) continue;
      const colIdx = tdef.columns.indexOf(col);
      if (colIdx === -1 || !tdef.key?.length) continue;
      const rowsByKey = rowMapFor(snap, table);
      for (const id of diffRows) {
        const node = nodes.get(id);
        if (node.table !== table) continue;
        const row = rowsByKey.get(node.key);
        if (!row) continue;
        const refId = `row:${target}:${row[colIdx]}`;
        if (nodes.has(refId)) addEdge(refId, id);
      }
    }
  }
  return { nodes, edges, params, diffRows };
}

function reachableFrom(start, edges) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    for (const next of edges.get(cur) ?? []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return seen;
}

// All minimum-cardinality explanation sets: every differing row must be
// reachable from at least one chosen node. Rows always cover themselves.
export function minimalExplanations(graph) {
  const { edges, params, diffRows } = graph;
  const reachCache = new Map();
  const reach = (id) => {
    if (!reachCache.has(id)) reachCache.set(id, reachableFrom(id, edges));
    return reachCache.get(id);
  };
  const candidates = [...params, ...diffRows];
  const forced = diffRows.filter((r) => !candidates.some((c) => c !== r && reach(c).has(r)));
  const forcedCover = new Set();
  for (const f of forced) for (const t of reach(f)) forcedCover.add(t);
  const remaining = diffRows.filter((t) => !forcedCover.has(t));
  const tIdx = new Map(remaining.map((t, i) => [t, i]));
  const full = remaining.length ? (1n << BigInt(remaining.length)) - 1n : 0n;
  const forcedSet = new Set(forced);
  const pool = candidates.filter((c) => !forcedSet.has(c) && remaining.some((t) => reach(c).has(t)));
  const masks = pool.map((c) => {
    let m = 0n;
    for (const t of reach(c)) {
      const i = tIdx.get(t);
      if (i !== undefined) m |= 1n << BigInt(i);
    }
    return m;
  });
  const suffix = new Array(pool.length + 1).fill(0n);
  for (let i = pool.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] | masks[i];
  for (let k = 0; k <= pool.length; k += 1) {
    const sols = [];
    const dfs = (start, chosen, covered) => {
      if (covered === full) { sols.push(chosen.map((i) => pool[i])); return; }
      if (chosen.length === k) return;
      if ((covered | suffix[start]) !== full) return;
      const need = k - chosen.length;
      for (let i = start; i <= pool.length - need; i += 1) {
        const next = covered | masks[i];
        if (next === covered) continue;
        dfs(i + 1, [...chosen, i], next);
      }
    };
    dfs(0, [], 0n);
    if (sols.length) {
      return sols.map((s) => [...forced, ...s].sort());
    }
  }
  return [forced.slice().sort()];
}

export function explain(snapA, snapB, tolOverride, { one = false } = {}) {
  const diff = diffSnapshots(snapA, snapB, tolOverride);
  const graph = buildCausalGraph(snapA, snapB, diff);
  const explanations = minimalExplanations(graph);
  if (one && explanations.length > 1) {
    fail('E_AMBIG_MIN', `${explanations.length} tied minimal explanations exist; rerun without --one to list all`);
  }
  return { diff, explanations, ambiguous: explanations.length > 1 };
}
