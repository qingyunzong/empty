// Netting graph primitives. All weights are non-negative integers in base
// currency. Every iteration order is canonical (sorted) so results are
// deterministic for a given input set.

const SEP = '';

const key = (a, b) => a + SEP + b;

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function cloneEdges(edges) {
  const out = new Map();
  for (const [k, e] of edges) out.set(k, { from: e.from, to: e.to, weight: e.weight, tradeIds: [...e.tradeIds] });
  return out;
}

export function sortedEdges(edges) {
  return [...edges.values()].sort((a, b) => cmpStr(a.from, b.from) || cmpStr(a.to, b.to));
}

// Sum converted trade amounts per ordered pair. Trades must already carry
// `baseAmount` (converted by the engine) and be sorted by id.
export function aggregateEdges(sortedTrades) {
  const map = new Map();
  for (const t of sortedTrades) {
    const k = key(t.from, t.to);
    const e = map.get(k);
    if (e) {
      e.weight += t.baseAmount;
      e.tradeIds.push(t.id);
    } else {
      map.set(k, { from: t.from, to: t.to, weight: t.baseAmount, tradeIds: [t.id] });
    }
  }
  return map;
}

// Offset opposite directions of every unordered pair; keep the residual.
export function bilateralOffset(edges) {
  const out = new Map();
  const done = new Set();
  for (const e of sortedEdges(edges)) {
    const k = key(e.from, e.to);
    if (done.has(k)) continue;
    const rev = edges.get(key(e.to, e.from));
    done.add(k);
    done.add(key(e.to, e.from));
    const ids = [...e.tradeIds, ...(rev ? rev.tradeIds : [])].sort();
    const net = e.weight - (rev ? rev.weight : 0);
    if (net > 0) out.set(k, { from: e.from, to: e.to, weight: net, tradeIds: ids });
    else if (net < 0) out.set(key(e.to, e.from), { from: e.to, to: e.from, weight: -net, tradeIds: ids });
  }
  return out;
}

function adjacency(edges) {
  const nodes = new Set();
  const adj = new Map();
  for (const e of edges.values()) {
    nodes.add(e.from);
    nodes.add(e.to);
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  for (const [n, list] of adj) adj.set(n, [...new Set(list)].sort());
  return { nodes, adj };
}

// All elementary cycles of a directed graph, canonicalized: each cycle is
// rotated to start at its smallest node id; the list is sorted by
// (length, node sequence). Deterministic.
export function findSimpleCycles(edges) {
  const { nodes, adj } = adjacency(edges);
  const sorted = [...nodes].sort();
  const index = new Map(sorted.map((n, i) => [n, i]));
  const cycles = [];
  for (const start of sorted) {
    const si = index.get(start);
    const path = [start];
    const seen = new Set([start]);
    const visit = (cur) => {
      for (const nxt of adj.get(cur) ?? []) {
        const ni = index.get(nxt);
        if (ni < si) continue; // start must be the minimum node of the cycle
        if (nxt === start && path.length >= 2) {
          cycles.push([...path]);
          continue;
        }
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        path.push(nxt);
        visit(nxt);
        path.pop();
        seen.delete(nxt);
      }
    };
    visit(start);
  }
  cycles.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i++) {
      const c = cmpStr(a[i], b[i]);
      if (c !== 0) return c;
    }
    return 0;
  });
  return cycles;
}

// Cancel cycles one at a time, always taking the canonically first cycle,
// subtracting its minimum edge weight from every edge. Terminates because
// each step removes at least one edge. The residual is acyclic.
export function reduceCycles(edges) {
  const current = cloneEdges(edges);
  const cancelled = [];
  const allCycles = findSimpleCycles(current); // cycles of the pre-cancellation graph
  for (;;) {
    const cycles = findSimpleCycles(current);
    if (cycles.length === 0) break;
    const cyc = cycles[0];
    const edgeAt = (i) => current.get(key(cyc[i], cyc[(i + 1) % cyc.length]));
    let m = Infinity;
    for (let i = 0; i < cyc.length; i++) m = Math.min(m, edgeAt(i).weight);
    const tradeIds = new Set();
    for (let i = 0; i < cyc.length; i++) {
      const e = edgeAt(i);
      for (const id of e.tradeIds) tradeIds.add(id);
      e.weight -= m;
    }
    for (let i = 0; i < cyc.length; i++) {
      const k = key(cyc[i], cyc[(i + 1) % cyc.length]);
      if (current.get(k).weight === 0) current.delete(k);
    }
    cancelled.push({ nodes: cyc, amount: m, tradeIds: [...tradeIds].sort() });
  }
  return { residual: current, cancelled, allCycles };
}

// Net position per participant from residual edges: in - out.
export function netPositions(residual) {
  const pos = new Map();
  for (const e of residual.values()) {
    pos.set(e.from, (pos.get(e.from) ?? 0) - e.weight);
    pos.set(e.to, (pos.get(e.to) ?? 0) + e.weight);
  }
  return pos;
}

// Trade ids backing the edges of a cycle (node list) in an edge map.
export function cycleTradeIds(edges, cyc) {
  const ids = new Set();
  for (let i = 0; i < cyc.length; i++) {
    const e = edges.get(key(cyc[i], cyc[(i + 1) % cyc.length]));
    if (e) for (const id of e.tradeIds) ids.add(id);
  }
  return [...ids].sort();
}
