'use strict';
const { leq } = require('./clock');

// History = set of committed transactions:
//   {id, node, seq, clock, reads: {key: value|null}, writes: {key: value}}
// reads record the pre-image observed by the transaction (null = key absent).

// Deterministic merged order: topological order of causal (vector clock)
// order, ties broken by transaction id.
function mergedOrder(txns) {
  const ids = txns.map((t) => t.id).sort();
  const byId = new Map(txns.map((t) => [t.id, t]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, []]));
  for (const a of txns) {
    for (const b of txns) {
      if (a.id !== b.id && leq(a.clock, b.clock)) {
        adj.get(a.id).push(b.id);
        indeg.set(b.id, indeg.get(b.id) + 1);
      }
    }
  }
  const ready = ids.filter((id) => indeg.get(id) === 0).sort();
  const out = [];
  while (ready.length) {
    const id = ready.shift();
    out.push(byId.get(id));
    for (const m of adj.get(id)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) {
        ready.push(m);
        ready.sort();
      }
    }
  }
  if (out.length !== txns.length) throw new Error('causal cycle (impossible for vector clocks)');
  return out;
}

// Dependency graph over the merged order:
//   ww: consecutive writers of a key keep merged order
//   wr: reader reads-from the writer of its recorded value
//   rw: reader must precede every later writer of the key (anti-dependency)
// A read of a value nobody wrote is unsatisfiable -> self-loop.
function buildGraph(order) {
  const ids = order.map((t) => t.id);
  const pos = new Map(ids.map((id, i) => [id, i]));
  const adj = new Map(ids.map((id) => [id, new Set()]));
  const labels = new Map();
  const addEdge = (from, to, label) => {
    adj.get(from).add(to);
    labels.set(`${from}->${to}`, label);
  };

  const writersByKey = new Map();
  for (const t of order) {
    for (const k of Object.keys(t.writes)) {
      if (!writersByKey.has(k)) writersByKey.set(k, []);
      writersByKey.get(k).push(t);
    }
  }
  for (const ws of writersByKey.values()) {
    for (let i = 0; i + 1 < ws.length; i++) addEdge(ws[i].id, ws[i + 1].id, 'ww');
  }

  for (const t of order) {
    for (const [k, v] of Object.entries(t.reads)) {
      const writers = (writersByKey.get(k) || []).filter((w) => w.id !== t.id);
      if (v === null) {
        // read observed the key absent: must precede every writer
        for (const w of writers) addEdge(t.id, w.id, 'rw');
        continue;
      }
      const matching = writers.filter((w) => w.writes[k] === v);
      if (matching.length === 0) {
        addEdge(t.id, t.id, 'orphan-read');
        continue;
      }
      // reads-from: last matching writer before t, else last matching overall
      const before = matching.filter((w) => pos.get(w.id) < pos.get(t.id));
      const src = before.length ? before[before.length - 1] : matching[matching.length - 1];
      addEdge(src.id, t.id, 'wr');
      for (const w of writers) {
        if (pos.get(w.id) > pos.get(src.id)) addEdge(t.id, w.id, 'rw');
      }
    }
  }
  return { ids, adj, labels };
}

// Returns a cycle as [id, ..., id] (first repeated at end), or null.
function findCycle(ids, adj) {
  const color = new Map(ids.map((id) => [id, 0]));
  const stack = [];
  const dfs = (u) => {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u)) {
      if (color.get(v) === 0) {
        const r = dfs(v);
        if (r) return r;
      } else if (color.get(v) === 1) {
        return stack.slice(stack.indexOf(v)).concat(v);
      }
    }
    stack.pop();
    color.set(u, 2);
    return null;
  };
  for (const id of ids) {
    if (color.get(id) === 0) {
      const r = dfs(id);
      if (r) return r;
    }
  }
  return null;
}

function topoSort(ids, adj) {
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) for (const m of adj.get(id)) indeg.set(m, indeg.get(m) + 1);
  const ready = ids.filter((id) => indeg.get(id) === 0).sort();
  const out = [];
  while (ready.length) {
    const id = ready.shift();
    out.push(id);
    for (const m of adj.get(id)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) {
        ready.push(m);
        ready.sort();
      }
    }
  }
  return out;
}

// Replay a serial order: verify recorded reads, then apply writes.
function replay(byId, orderIds) {
  const state = {};
  for (const id of orderIds) {
    const t = byId.get(id);
    for (const [k, v] of Object.entries(t.reads)) {
      const cur = state[k] === undefined ? null : state[k];
      if (cur !== v) return { ok: false, at: id, key: k, expected: v, actual: cur };
    }
    Object.assign(state, t.writes);
  }
  return { ok: true, state };
}

// Final state of the merged history (writes applied in merged order).
function applyWrites(byId, orderIds) {
  const state = {};
  for (const id of orderIds) Object.assign(state, byId.get(id).writes);
  return state;
}

function stateEqual(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

// Main entry: decide whether the merged history is serializable.
function check(txns) {
  const order = mergedOrder(txns);
  const orderIds = order.map((t) => t.id);
  const byId = new Map(txns.map((t) => [t.id, t]));
  const target = applyWrites(byId, orderIds);
  const { ids, adj, labels } = buildGraph(order);
  const cycle = findCycle(ids, adj);
  if (cycle) {
    return { status: 'NON_SERIALIZABLE', cycle, mergedOrder: orderIds, state: target };
  }
  const topo = topoSort(ids, adj);
  const rep = replay(byId, topo);
  if (!rep.ok || !stateEqual(rep.state, target)) {
    return { status: 'NON_SERIALIZABLE', reason: 'replay-mismatch', detail: rep, mergedOrder: orderIds, state: target };
  }
  return { status: 'SERIALIZABLE', order: topo, state: rep.state, mergedOrder: orderIds };
}

module.exports = { mergedOrder, buildGraph, findCycle, topoSort, replay, applyWrites, stateEqual, check };
