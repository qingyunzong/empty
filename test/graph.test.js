import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph, GraphError, MAX_EDGES } from '../src/graph.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brute-force oracles for small graphs.
function componentsOf(vertices, edges) {
  const adj = new Map(vertices.map((v) => [v, []]));
  for (const [u, v] of edges) { adj.get(u).push(v); adj.get(v).push(u); }
  const seen = new Set();
  let count = 0;
  for (const s of vertices) {
    if (seen.has(s)) continue;
    count++;
    const q = [s]; seen.add(s);
    while (q.length) {
      const u = q.pop();
      for (const w of adj.get(u)) if (!seen.has(w)) { seen.add(w); q.push(w); }
    }
  }
  return count;
}

function bruteBridges(vertices, edges) {
  const out = [];
  for (const [u, v] of edges) {
    const rest = edges.filter((e) => e !== undefined && !(e[0] === u && e[1] === v));
    const adj = new Map(vertices.map((x) => [x, []]));
    for (const [a, b] of rest) { adj.get(a).push(b); adj.get(b).push(a); }
    const seen = new Set([u]);
    const q = [u];
    while (q.length) {
      const x = q.pop();
      for (const w of adj.get(x)) if (!seen.has(w)) { seen.add(w); q.push(w); }
    }
    if (!seen.has(v)) out.push([Math.min(u, v), Math.max(u, v)]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function bruteArticulation(vertices, edges) {
  const out = [];
  for (const v of vertices) {
    const comp = [];
    // component containing v
    const adj = new Map(vertices.map((x) => [x, []]));
    for (const [a, b] of edges) { adj.get(a).push(b); adj.get(b).push(a); }
    const seen = new Set([v]);
    const q = [v];
    while (q.length) {
      const x = q.pop();
      for (const w of adj.get(x)) if (!seen.has(w)) { seen.add(w); q.push(w); }
    }
    for (const x of seen) if (x !== v) comp.push(x);
    const restEdges = edges.filter(([a, b]) => a !== v && b !== v);
    if (componentsOf(comp, restEdges) > 1) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

test('chain: every edge is a bridge, internal vertices are articulation points', () => {
  const g = new Graph();
  g.addEdge(0, 1); g.addEdge(1, 2); g.addEdge(2, 3);
  assert.deepEqual(g.bridges(), [[0, 1], [1, 2], [2, 3]]);
  assert.deepEqual(g.articulationPoints(), [1, 2]);
});

test('cycle: no bridges, no articulation points', () => {
  const g = new Graph();
  g.addEdge(0, 1); g.addEdge(1, 2); g.addEdge(2, 3); g.addEdge(3, 0);
  assert.deepEqual(g.bridges(), []);
  assert.deepEqual(g.articulationPoints(), []);
});

test('biconnected components: two triangles sharing one vertex', () => {
  const g = new Graph();
  g.addEdge(0, 1); g.addEdge(1, 2); g.addEdge(2, 0);
  g.addEdge(2, 3); g.addEdge(3, 4); g.addEdge(4, 2);
  assert.deepEqual(g.bridges(), []);
  assert.deepEqual(g.articulationPoints(), [2]);
});

test('triangle with pendant edge: pendant is the only bridge', () => {
  const g = new Graph();
  g.addEdge(0, 1); g.addEdge(1, 2); g.addEdge(2, 0); g.addEdge(2, 3);
  assert.deepEqual(g.bridges(), [[2, 3]]);
  assert.deepEqual(g.articulationPoints(), [2]);
});

test('deletion changes the bridge set', () => {
  const g = new Graph();
  g.addEdge(0, 1); g.addEdge(1, 2); g.addEdge(2, 0); g.addEdge(2, 3);
  assert.deepEqual(g.bridges(), [[2, 3]]);
  g.delEdge(0, 1);
  assert.deepEqual(g.bridges(), [[0, 2], [1, 2], [2, 3]]);
  assert.deepEqual(g.articulationPoints(), [2]);
  g.delEdge(2, 3);
  assert.deepEqual(g.bridges(), [[0, 2], [1, 2]]);
  assert.deepEqual(g.articulationPoints(), [2]);
});

test('disconnected graph handled across components', () => {
  const g = new Graph();
  g.addEdge(0, 1); g.addEdge(5, 6); g.addEdge(6, 7); g.addEdge(7, 5);
  assert.deepEqual(g.bridges(), [[0, 1]]);
  assert.deepEqual(g.articulationPoints(), []);
});

test('input validation: self loop, duplicate, range, unknown edge, edge limit', () => {
  const g = new Graph();
  assert.throws(() => g.addEdge(1, 1), (e) => e instanceof GraphError && e.code === 'INVALID_INPUT');
  assert.throws(() => g.addEdge(-1, 2), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => g.addEdge(0, 300), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => g.addEdge(0, 1.5), (e) => e.code === 'INVALID_INPUT');
  g.addEdge(0, 1);
  assert.throws(() => g.addEdge(1, 0), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => g.delEdge(0, 2), (e) => e.code === 'NO_SUCH_EDGE');
  const big = new Graph();
  let n = 0;
  for (let u = 0; u < 300 && n < MAX_EDGES; u++) {
    for (let v = u + 1; v < 300 && n < MAX_EDGES; v++) { big.addEdge(u, v); n++; }
  }
  assert.equal(big.edgeCount, MAX_EDGES);
  assert.throws(() => big.addEdge(0, 299), (e) => e.code === 'INVALID_INPUT');
});

test('random graphs n<=10 with deletions match brute-force oracle and fresh rebuild', () => {
  const rand = mulberry32(42);
  for (let iter = 0; iter < 60; iter++) {
    const n = 2 + Math.floor(rand() * 9);
    const g = new Graph();
    const edgeSet = new Set();
    const ops = 20 + Math.floor(rand() * 30);
    for (let i = 0; i < ops; i++) {
      const u = Math.floor(rand() * n);
      const v = Math.floor(rand() * n);
      if (u === v) continue;
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (edgeSet.has(key)) {
        if (rand() < 0.5) { g.delEdge(Math.min(u, v), Math.max(u, v)); edgeSet.delete(key); }
      } else {
        g.addEdge(u, v); edgeSet.add(key);
      }
    }
    const edges = g.edges();
    const vertices = g.vertices();
    assert.deepEqual(g.bridges(), bruteBridges(vertices, edges), `bridges iter=${iter}`);
    assert.deepEqual(g.articulationPoints(), bruteArticulation(vertices, edges), `ap iter=${iter}`);
    // snapshot replay: rebuild from edge list, results must be identical
    const fresh = new Graph();
    for (const [u, v] of edges) fresh.addEdge(u, v);
    assert.deepEqual(fresh.bridges(), g.bridges());
    assert.deepEqual(fresh.articulationPoints(), g.articulationPoints());
    assert.equal(fresh.canonical(), g.canonical());
  }
});
