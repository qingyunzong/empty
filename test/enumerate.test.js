import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/graph.js';
import { buildCert } from '../src/cert.js';

// Deterministic PRNG (mulberry32) for reproducible random DAGs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent bottom-up enumeration: paths(v) = union over parents u of
// (paths(u) with v appended); sources have a single trivial path.
function enumeratePathsDP(n, edges, root) {
  const parents = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) parents[v].push(u);
  const memo = new Map();
  const solve = (v) => {
    if (memo.has(v)) return memo.get(v);
    memo.set(v, []); // guard (graph is a DAG)
    const res = parents[v].length === 0
      ? [[v]]
      : parents[v].flatMap((u) => solve(u).map((p) => [...p, v]));
    memo.set(v, res);
    return res;
  };
  return solve(root);
}

// Simpler robust constructor: insert a split whenever a node has >1 child.
function buildGraph(n, edges) {
  const children = Array.from({ length: n }, () => []);
  const parents = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) { children[u].push(v); parents[v].push(u); }
  const g = new Graph({ tolerance: 0.01 });
  let seq = 0;
  const add = (op, inputs, outputs) => {
    seq++;
    g.apply({ site: 'E', seq, ts: seq, op, in: inputs, out: outputs, id: `op${seq}` });
  };
  // node naming: original lots are L<i>; when a node fans out, insert split
  // lots S<i>_<j> so each child consumes its own piece.
  const consumeLot = new Map(); // child v -> lot id it consumes
  for (let v = 0; v < n; v++) {
    const ins = parents[v].map((u) => {
      const shares = children[u];
      const idx = shares.indexOf(v);
      return shares.length === 1 ? `L${u}` : `S${u}_${idx}`;
    });
    if (ins.length === 0) {
      add('register', [], [{ lot: `L${v}`, mass: 100 }]);
    } else {
      const inputs = ins.map((lot) => ({ lot, mass: g.lots.get(lot).remaining }));
      const total = inputs.reduce((a, b) => a + b.mass, 0);
      const op = inputs.length === 1 ? 'relabel' : 'merge';
      add(op, inputs, [{ lot: `L${v}`, mass: total }]);
    }
    if (children[v].length > 1) {
      const k = children[v].length;
      const share = g.lots.get(`L${v}`).remaining / k;
      add('split', [{ lot: `L${v}`, mass: share * k }], children[v].map((_, j) => ({ lot: `S${v}_${j}`, mass: share })));
    }
  }
  // Map graph lots back to logical DAG nodes for comparison: L<i> ~ node i.
  return { g, parents };
}

test('n<=8: exhaustive ancestor-path enumeration matches independent DP', () => {
  for (let n = 2; n <= 8; n++) {
    for (let trial = 0; trial < 12; trial++) {
      const rand = rng(n * 1000 + trial);
      const edges = [];
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
          if (rand() < 0.35) edges.push([i, j]);
      const { g } = buildGraph(n, edges);
      for (let root = 0; root < n; root++) {
        // method A: library DFS over lot graph, projected to DAG nodes
        const lotPaths = g.enumeratePaths(`L${root}`);
        const projected = lotPaths.map((p) => p.filter((l) => l.startsWith('L')).map((l) => Number(l.slice(1))));
        const normA = projected.map((p) => p.join(',')).sort();
        // method B: independent bottom-up DP on the raw DAG
        const normB = enumeratePathsDP(n, edges, root).map((p) => p.join(',')).sort();
        assert.deepEqual(normA, normB, `n=${n} trial=${trial} root=${root}`);
        // ancestor set agrees with certificate contents
        const anc = [...g.ancestors(`L${root}`)].filter((l) => l.startsWith('L')).sort();
        const cert = buildCert(g, `L${root}`);
        const certLots = cert.entries.filter((e) => e.kind === 'lot' && e.lot.startsWith('L')).map((e) => e.lot).sort();
        assert.deepEqual(certLots, anc, `cert ancestor set n=${n} root=${root}`);
      }
    }
  }
});
