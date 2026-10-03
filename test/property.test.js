import test from 'node:test';
import assert from 'node:assert/strict';
import { CreditNetwork } from '../lib/network.js';

// Deterministic RNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Independent reference: classic Ford-Fulkerson with DFS augmenting paths.
 * edges: array of { from, to, capacity } using node indices 0..n-1.
 */
function fordFulkerson(n, edges, s, t) {
  const residual = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const e of edges) residual[e.from][e.to] += e.capacity;
  let total = 0;
  for (;;) {
    const seen = new Array(n).fill(false);
    const dfs = (u, bound) => {
      if (u === t) return bound;
      seen[u] = true;
      for (let v = 0; v < n; v++) {
        if (!seen[v] && residual[u][v] > 0) {
          const pushed = dfs(v, Math.min(bound, residual[u][v]));
          if (pushed > 0) {
            residual[u][v] -= pushed;
            residual[v][u] += pushed;
            return pushed;
          }
        }
      }
      return 0;
    };
    const pushed = dfs(s, Infinity);
    if (pushed === 0) return total;
    total += pushed;
  }
}

/** Brute-force min s-t cut: enumerate every subset containing s, not t. */
function bruteForceMinCut(n, edges, s, t) {
  const middle = [];
  for (let i = 0; i < n; i++) if (i !== s && i !== t) middle.push(i);
  let best = Infinity;
  for (let mask = 0; mask < 1 << middle.length; mask++) {
    const inS = new Array(n).fill(false);
    inS[s] = true;
    middle.forEach((node, bit) => {
      if (mask & (1 << bit)) inS[node] = true;
    });
    let cut = 0;
    for (const e of edges) if (inS[e.from] && !inS[e.to]) cut += e.capacity;
    best = Math.min(best, cut);
  }
  return best;
}

function randomNetwork(rand) {
  // Retry until source (0) and sink (n-1) each touch at least one edge, so
  // both are known accounts in the network.
  for (;;) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 nodes
    const edges = [];
    for (let u = 0; u < n; u++) {
      for (let v = 0; v < n; v++) {
        if (u !== v && rand() < 0.4) {
          edges.push({ from: u, to: v, capacity: 1 + Math.floor(rand() * 20) });
        }
      }
    }
    const touches = (node) => edges.some((e) => e.from === node || e.to === node);
    if (touches(0) && touches(n - 1)) return { n, edges };
  }
}

test('property: library max-flow matches Ford-Fulkerson and enumerated min cut (n<=8, cap<=20)', () => {
  const rand = mulberry32(20261003);
  for (let trial = 0; trial < 300; trial++) {
    const { n, edges } = randomNetwork(rand);
    const s = 0;
    const t = n - 1;
    const net = new CreditNetwork();
    for (const e of edges) net.addEdge(String(e.from), String(e.to), e.capacity);

    const libValue = net.maxFlowValue(String(s), String(t));
    const ffValue = fordFulkerson(n, edges, s, t);
    const cutValue = bruteForceMinCut(n, edges, s, t);
    assert.equal(libValue, ffValue, `trial ${trial}: library vs Ford-Fulkerson`);
    assert.equal(libValue, cutValue, `trial ${trial}: library vs brute-force min cut`);

    // The certificate of a rejected freeze must carry exactly this capacity.
    const rejected = net.freeze(String(s), String(t), libValue + 1);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.maxFreezable, libValue, `trial ${trial}: maxFreezable`);
    assert.equal(rejected.cut.capacity, libValue, `trial ${trial}: cut capacity`);
    assert.ok(rejected.cut.nodes.includes(String(t)), 'cut contains target side');
    assert.ok(!rejected.cut.nodes.includes(String(s)), 'cut excludes source');
  }
});

test('property: random freeze/release sequences keep invariants and match residual max-flow', () => {
  const rand = mulberry32(987654321);
  for (let trial = 0; trial < 100; trial++) {
    const { n, edges } = randomNetwork(rand);
    const net = new CreditNetwork();
    for (const e of edges) net.addEdge(String(e.from), String(e.to), e.capacity);
    const s = '0';
    const t = String(n - 1);
    const liveFreezes = [];

    for (let step = 0; step < 50; step++) {
      const residualEdges = edges.map((e) => ({
        from: e.from,
        to: e.to,
        capacity: e.capacity - net.frozenOn(String(e.from), String(e.to)),
      }));
      const expectedMax = fordFulkerson(n, residualEdges, 0, n - 1);

      if (liveFreezes.length > 0 && rand() < 0.4) {
        // Release a random live freeze (partial or full).
        const idx = Math.floor(rand() * liveFreezes.length);
        const record = liveFreezes[idx];
        const amount = 1 + Math.floor(rand() * record.remaining);
        const result = net.release(record.id, amount);
        assert.equal(result.ok, true);
        record.remaining -= amount;
        if (record.remaining === 0) liveFreezes.splice(idx, 1);
      } else {
        const amount = 1 + Math.floor(rand() * 25);
        const before = JSON.stringify(net.getState().edges);
        const result = net.freeze(s, t, amount);
        if (amount <= expectedMax) {
          assert.equal(result.ok, true, `trial ${trial} step ${step}: freeze ${amount} <= ${expectedMax}`);
          assert.equal(
            result.paths.reduce((sum, p) => sum + p.amount, 0),
            amount,
            'path decomposition carries the full amount'
          );
          liveFreezes.push({ id: result.freezeId, remaining: amount });
        } else {
          assert.equal(result.ok, false, `trial ${trial} step ${step}: freeze ${amount} > ${expectedMax}`);
          assert.equal(result.maxFreezable, expectedMax);
          assert.equal(result.cut.capacity, expectedMax);
          assert.equal(
            JSON.stringify(net.getState().edges),
            before,
            'rejected freeze leaves state untouched'
          );
        }
      }

      // Invariants after every step.
      for (const e of edges) {
        const frozen = net.frozenOn(String(e.from), String(e.to));
        assert.ok(frozen >= 0 && frozen <= e.capacity, `frozen within [0, capacity] on ${e.from}->${e.to}`);
      }
    }
  }
});
