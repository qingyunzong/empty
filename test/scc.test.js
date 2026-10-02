import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/graph.js';

// Independent reference SCC: two nodes are in the same component iff each
// reaches the other (BFS both ways). O(n * (n + e)), fine for n <= 7.
function referenceScc(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [u, v] of edges) adj.get(u).push(v);

  const reachable = (start) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift();
      for (const next of adj.get(node)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };

  const reach = new Map(nodes.map((n) => [n, reachable(n)]));
  const assigned = new Set();
  const components = [];
  for (const node of [...nodes].sort()) {
    if (assigned.has(node)) continue;
    const component = nodes
      .filter((other) => reach.get(node).has(other) && reach.get(other).has(node))
      .sort();
    for (const member of component) assigned.add(member);
    components.push(component);
  }
  components.sort((a, b) => {
    const byFirst = a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    return byFirst !== 0 ? byFirst : a.length - b.length;
  });
  return components;
}

function randomGraph(rng, n) {
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
  const edges = [];
  for (const u of nodes) {
    for (const v of nodes) {
      if (rng() < 0.3) edges.push([u, v]);
    }
  }
  return { nodes, edges };
}

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

test('Tarjan SCC matches independent reachability-based SCC for n<=7', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const rng = mulberry32(seed);
    const n = 1 + Math.floor(rng() * 7);
    const { nodes, edges } = randomGraph(rng, n);
    const graph = new Graph();
    for (const node of nodes) graph.addNode(node);
    for (const [u, v] of edges) graph.addEdge(u, v);
    assert.deepEqual(graph.scc(), referenceScc(nodes, edges), `seed=${seed} n=${n}`);
  }
});

test('exhaustive n<=3 graphs match reference SCC', () => {
  for (let n = 1; n <= 3; n += 1) {
    const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
    const allEdges = [];
    for (const u of nodes) for (const v of nodes) allEdges.push([u, v]);
    for (let mask = 0; mask < 2 ** allEdges.length; mask += 1) {
      const edges = allEdges.filter((_, i) => mask & (1 << i));
      const graph = new Graph();
      for (const node of nodes) graph.addNode(node);
      for (const [u, v] of edges) graph.addEdge(u, v);
      assert.deepEqual(graph.scc(), referenceScc(nodes, edges), `n=${n} mask=${mask}`);
    }
  }
});
