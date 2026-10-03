import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyGraph } from '../src/graph.js';
import { Ledger } from '../src/ledger.js';

// --- Independent reference implementations (used only by tests) ---

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

/** Brute-force reachable set by explicit enumeration (BFS per node). */
function bruteForceReach(nodes, edges, start) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [u, v] of edges) adj.get(u).push(v);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const u = queue.shift();
    for (const v of adj.get(u)) {
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return seen;
}

/** Independent Kosaraju SCC implementation. */
function kosarajuSCC(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]));
  const radj = new Map(nodes.map((n) => [n, []]));
  for (const [u, v] of edges) {
    adj.get(u).push(v);
    radj.get(v).push(u);
  }
  const visited = new Set();
  const order = [];
  function dfs1(u) {
    visited.add(u);
    for (const v of adj.get(u)) if (!visited.has(v)) dfs1(v);
    order.push(u);
  }
  for (const n of nodes) if (!visited.has(n)) dfs1(n);
  const compOf = new Map();
  const components = [];
  function dfs2(u, idx) {
    compOf.set(u, idx);
    components[idx].push(u);
    for (const v of radj.get(u)) if (!compOf.has(v)) dfs2(v, idx);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const u = order[i];
    if (!compOf.has(u)) {
      components.push([]);
      dfs2(u, components.length - 1);
    }
  }
  return { components, compOf };
}

function randomGraph(rand, n) {
  const nodes = Array.from({ length: n }, (_, i) => `t${i}`);
  const edges = [];
  for (const u of nodes) {
    for (const v of nodes) {
      if (rand() < 0.3) edges.push([u, v]);
    }
  }
  return { nodes, edges };
}

function normalizeComponents(components) {
  return components
    .map((c) => [...c].sort().join(','))
    .sort()
    .join('|');
}

test('n<=8: Tarjan SCC matches independent Kosaraju and brute-force reachability', () => {
  const rand = mulberry32(20261004);
  for (let n = 1; n <= 8; n++) {
    for (let trial = 0; trial < 40; trial++) {
      const { nodes, edges } = randomGraph(rand, n);
      const graph = new DependencyGraph();
      for (const node of nodes) graph.addNode(node);
      for (const [u, v] of edges) graph.addEdge(u, v);

      // 1) Library reachability equals brute-force enumeration.
      const reachSets = new Map();
      for (const node of nodes) {
        const expected = bruteForceReach(nodes, edges, node);
        reachSets.set(node, expected);
        assert.deepEqual(
          graph.reachableFrom(node),
          [...expected].sort(),
          `reachability mismatch from ${node} (n=${n})`,
        );
      }

      // 2) Tarjan components equal Kosaraju components (as sets of sets).
      const tarjan = graph.tarjanSCC();
      const kosaraju = kosarajuSCC(nodes, edges);
      assert.equal(
        normalizeComponents(tarjan.components),
        normalizeComponents(kosaraju.components),
        `SCC mismatch (n=${n})`,
      );

      // 3) Tarjan co-membership equals mutual brute-force reachability.
      for (const u of nodes) {
        for (const v of nodes) {
          const mutual = reachSets.get(u).has(v) && reachSets.get(v).has(u);
          assert.equal(
            tarjan.compOf.get(u) === tarjan.compOf.get(v),
            mutual,
            `co-membership mismatch for ${u},${v} (n=${n})`,
          );
        }
      }

      // 4) Condensation is a DAG and topo order respects condensation edges.
      const condensation = graph.condensation();
      const pos = new Map(condensation.topoOrder.map((id, i) => [id, i]));
      assert.equal(pos.size, condensation.components.length);
      for (const [cu, cv] of condensation.condensationEdges) {
        assert.notEqual(cu, cv, 'condensation must have no self loops');
        assert.ok(pos.get(cu) < pos.get(cv), 'topo order violated');
      }
    }
  }
});

test('n<=8: cancel affected set equals brute-force reachable ACTIVE set', () => {
  const rand = mulberry32(7);
  for (let n = 1; n <= 8; n++) {
    for (let trial = 0; trial < 20; trial++) {
      const { nodes, edges } = randomGraph(rand, n);
      const ledger = new Ledger();
      for (const [u, v] of edges) ledger.addDep(u, v);
      const known = [...new Set(edges.flat())];
      if (known.length === 0) continue;
      const target = known[Math.floor(rand() * known.length)];
      const expected = [...bruteForceReach(nodes, edges, target)].sort();
      const res = ledger.cancel(target, `evt-${n}-${trial}`);
      assert.deepEqual(res.affected, expected, `cancel mismatch (n=${n})`);
      // Every affected node shares an SCC with the target iff mutually reachable.
      for (const node of expected) {
        const mutual =
          bruteForceReach(nodes, edges, target).has(node) &&
          bruteForceReach(nodes, edges, node).has(target);
        assert.equal(res.scc[node] === res.scc[target], mutual);
      }
    }
  }
});
