'use strict';

// Cross-checks the library max-flow/min-cut against an independent
// DFS-based Ford-Fulkerson and exhaustive cut-set enumeration.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maxFlow } = require('../src/maxflow');
const { CreditNetwork } = require('../src/credit-network');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent implementation: DFS augmenting-path Ford-Fulkerson.
// capacity: Array<{from,to,cap}> with node list `nodes`.
function fordFulkerson(nodes, edges, source, sink) {
  const residual = new Map();
  for (const u of nodes) residual.set(u, new Map());
  for (const { from, to, cap } of edges) {
    residual.get(from).set(to, (residual.get(from).get(to) || 0) + cap);
    if (!residual.get(to).has(from)) residual.get(to).set(from, 0);
  }
  let total = 0;
  function dfs(u, sinkNode, pushed, seen) {
    if (u === sinkNode) return pushed;
    seen.add(u);
    for (const [v, c] of residual.get(u)) {
      if (c > 0 && !seen.has(v)) {
        const d = dfs(v, sinkNode, Math.min(pushed, c), seen);
        if (d > 0) {
          residual.get(u).set(v, residual.get(u).get(v) - d);
          residual.get(v).set(u, (residual.get(v).get(u) || 0) + d);
          return d;
        }
      }
    }
    return 0;
  }
  for (;;) {
    const pushed = dfs(source, sink, Infinity, new Set());
    if (pushed === 0) break;
    total += pushed;
  }
  return total;
}

// Exhaustive minimum s-t cut by enumerating all subsets containing s, not t.
function enumMinCut(nodes, edges, source, sink) {
  const others = nodes.filter((n) => n !== source && n !== sink);
  let best = Infinity;
  const m = others.length;
  for (let mask = 0; mask < 1 << m; mask++) {
    const side = new Set([source]);
    for (let i = 0; i < m; i++) if (mask & (1 << i)) side.add(others[i]);
    let cap = 0;
    for (const { from, to, cap: c } of edges) {
      if (side.has(from) && !side.has(to)) cap += c;
    }
    if (cap < best) best = cap;
  }
  return best;
}

function randomGraph(rand, n, maxCap) {
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
  const edges = [];
  for (const from of nodes) {
    for (const to of nodes) {
      if (from !== to && rand() < 0.5) {
        edges.push({ from, to, cap: Math.floor(rand() * (maxCap + 1)) });
      }
    }
  }
  return { nodes, edges };
}

test('library max flow matches independent Ford-Fulkerson and cut enumeration (n<=8, cap<=20)', () => {
  const rand = mulberry32(20261004);
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(rand() * 7); // 2..8
    const { nodes, edges } = randomGraph(rand, n, 20);
    const source = nodes[0];
    const sink = nodes[n - 1];

    const capMap = new Map();
    for (const { from, to, cap } of edges) {
      if (!capMap.has(from)) capMap.set(from, new Map());
      capMap.get(from).set(to, (capMap.get(from).get(to) || 0) + cap);
    }
    const lib = maxFlow(capMap, source, sink);
    const ff = fordFulkerson(nodes, edges, source, sink);
    const cut = enumMinCut(nodes, edges, source, sink);

    assert.equal(lib.value, ff, `trial ${trial}: library vs Ford-Fulkerson`);
    assert.equal(lib.value, cut, `trial ${trial}: library vs enumerated min cut`);

    // Library cut certificate must be a valid cut of the same capacity.
    let certCap = 0;
    for (const { from, to, cap } of edges) {
      if (lib.reachable.has(from) && !lib.reachable.has(to)) certCap += cap;
    }
    assert.equal(certCap, lib.value, `trial ${trial}: certificate capacity`);
    assert.ok(lib.reachable.has(source) && !lib.reachable.has(sink));
  }
});

test('CreditNetwork freeze/release invariants under random operations', () => {
  const rand = mulberry32(1234567);
  for (let trial = 0; trial < 100; trial++) {
    const n = 2 + Math.floor(rand() * 7);
    const { nodes, edges } = randomGraph(rand, n, 20);
    const net = new CreditNetwork();
    for (const { from, to, cap } of edges) net.addEdge(from, to, cap);
    const source = nodes[0];
    const sink = nodes[n - 1];
    const ids = [];

    for (let step = 0; step < 40; step++) {
      if (rand() < 0.6 || ids.length === 0) {
        const amount = 1 + Math.floor(rand() * 25);
        let result;
        try {
          result = net.freeze({ source, target: sink, amount });
        } catch (err) {
          // Source/sink isolated from the graph: nothing is freezable.
          assert.match(err.code, /^UNKNOWN_(SOURCE|TARGET)$/);
          const truth = fordFulkerson(nodes, edges, source, sink);
          assert.equal(truth, 0);
          continue;
        }
        if (result.ok) {
          ids.push(result.id);
          assert.equal(result.amount, amount);
        } else {
          // Rejection certificate must equal the true residual max flow.
          const residualEdges = edges.map(({ from, to, cap }) => ({
            from,
            to,
            cap: cap - (net.occupied.get(from)?.get(to) || 0),
          }));
          const truth = fordFulkerson(nodes, residualEdges, source, sink);
          assert.equal(result.cut.capacity, truth, `trial ${trial} step ${step}: cut == residual maxflow`);
          assert.equal(result.maxFreezable, truth);
          assert.ok(truth < amount);
        }
      } else {
        const id = ids[Math.floor(rand() * ids.length)];
        const record = net.freezes.get(id);
        const remaining = record.amount - record.released;
        if (remaining === 0) continue;
        const amount = 1 + Math.floor(rand() * remaining);
        const res = net.release({ id, amount });
        assert.equal(res.ok, true);
      }

      // Invariant: occupied never exceeds capacity on any edge.
      for (const { from, to, cap } of edges) {
        const used = net.occupied.get(from)?.get(to) || 0;
        assert.ok(used >= 0 && used <= cap, `trial ${trial} step ${step}: ${from}->${to}`);
      }
      // Invariant: per-freeze remaining flow value equals amount - released.
      for (const [id, rec] of net.freezes) {
        let outOfSource = 0;
        for (const [v, f] of rec.flows.get(rec.source) || []) outOfSource += f;
        let intoSource = 0;
        for (const [, row] of rec.flows) intoSource += row.get(rec.source) || 0;
        assert.equal(outOfSource - intoSource, rec.amount - rec.released, `freeze ${id} flow value`);
      }
    }
  }
});
