import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRoute } from '../src/router.js';
import { emptyGraph, addNode, addEdge } from '../src/graph.js';
import { RouteError } from '../src/errors.js';

// Independent reference: enumerate every simple path, filter by precedence
// and capacity, then take the (time, lexicographic) minimum.
function bruteForce(graph, from, to, capacity) {
  // cycle check (colors)
  const color = new Map();
  const visit = (u) => {
    color.set(u, 1);
    for (const v of graph.edges.get(u) ?? []) {
      if (!graph.nodes.has(v)) continue;
      if (color.get(v) === 1) return true;
      if (!color.get(v) && visit(v)) return true;
    }
    color.set(u, 2);
    return false;
  };
  for (const id of graph.nodes.keys()) {
    if (!color.get(id) && visit(id)) return { cycle: true };
  }

  const paths = [];
  const walk = (cur, path, seen) => {
    if (cur === to) {
      paths.push([...path]);
      return;
    }
    for (const nxt of graph.edges.get(cur) ?? []) {
      if (seen.has(nxt) || !graph.nodes.has(nxt)) continue;
      seen.add(nxt);
      path.push(nxt);
      walk(nxt, path, seen);
      path.pop();
      seen.delete(nxt);
    }
  };
  walk(from, [from], new Set([from]));

  const feasible = [];
  let anyPrecedenceOk = false;
  for (const p of paths) {
    let ok = true;
    for (let i = 1; i < p.length; i++) {
      if (graph.nodes.get(p[i]).op <= graph.nodes.get(p[i - 1]).op) ok = false;
    }
    if (!ok) continue;
    anyPrecedenceOk = true;
    const load = new Map();
    let time = 0;
    for (const id of p) {
      const n = graph.nodes.get(id);
      time += n.time;
      load.set(n.device, (load.get(n.device) ?? 0) + n.time);
    }
    let fits = true;
    for (const [dev, t] of load) {
      if (capacity[dev] !== undefined && (graph.deviceLoad.get(dev) ?? 0) + t > capacity[dev]) {
        fits = false;
      }
    }
    if (fits) feasible.push({ path: p, time });
  }
  if (feasible.length === 0) return { anyPath: anyPrecedenceOk };
  feasible.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    const n = Math.min(a.path.length, b.path.length);
    for (let i = 0; i < n; i++) {
      if (a.path[i] !== b.path[i]) return a.path[i] < b.path[i] ? -1 : 1;
    }
    return a.path.length - b.path.length;
  });
  return { best: feasible[0] };
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomGraph(rand, nNodes) {
  const g = emptyGraph();
  for (let i = 0; i < nNodes; i++) {
    addNode(g, {
      id: `n${i}`,
      op: Math.floor(rand() * nNodes),
      device: rand() < 0.5 ? 'A' : 'B',
      time: 1 + Math.floor(rand() * 9),
    });
  }
  for (let i = 0; i < nNodes; i++) {
    for (let j = 0; j < nNodes; j++) {
      if (i !== j && rand() < 0.3) addEdge(g, `n${i}`, `n${j}`);
    }
  }
  return g;
}

test('findRoute matches brute-force enumeration on random small graphs', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = lcg(seed);
    const g = randomGraph(rand, 5);
    const capacity = { A: Math.floor(rand() * 30), B: Math.floor(rand() * 30) };
    const expected = bruteForce(g, 'n0', 'n4', capacity);
    if (expected.cycle) {
      assert.throws(() => findRoute(g, 'n0', 'n4', capacity), { code: 'E_CYCLE' }, `seed ${seed}`);
    } else if (expected.best) {
      const got = findRoute(g, 'n0', 'n4', capacity);
      assert.deepEqual(got, expected.best, `seed ${seed}`);
    } else if (expected.anyPath) {
      assert.throws(() => findRoute(g, 'n0', 'n4', capacity), { code: 'E_CAPACITY' }, `seed ${seed}`);
    } else {
      assert.throws(() => findRoute(g, 'n0', 'n4', capacity), { code: 'E_NO_PATH' }, `seed ${seed}`);
    }
  }
});

test('picks shortest time, then lexicographically smallest node sequence', () => {
  const g = emptyGraph();
  addNode(g, { id: 's', op: 0, device: 'A', time: 1 });
  addNode(g, { id: 'b', op: 1, device: 'A', time: 5 });
  addNode(g, { id: 'a', op: 1, device: 'A', time: 5 });
  addNode(g, { id: 't', op: 2, device: 'A', time: 1 });
  addEdge(g, 's', 'a');
  addEdge(g, 's', 'b');
  addEdge(g, 'a', 't');
  addEdge(g, 'b', 't');
  addEdge(g, 's', 't');
  // s->t costs 2 (shortest time wins over the 7-cost two-hop paths).
  assert.deepEqual(findRoute(g, 's', 't', {}), { path: ['s', 't'], time: 2 });
  // Remove the direct edge: both two-hop paths cost 7, ['s','a','t'] wins lexicographically.
  g.edges.get('s').delete('t');
  assert.deepEqual(findRoute(g, 's', 't', {}), { path: ['s', 'a', 't'], time: 7 });
});

test('cycle in the graph yields E_CYCLE', () => {
  const g = emptyGraph();
  addNode(g, { id: 's', op: 0, device: 'A', time: 1 });
  addNode(g, { id: 'x', op: 1, device: 'A', time: 1 });
  addNode(g, { id: 't', op: 2, device: 'A', time: 1 });
  addEdge(g, 's', 'x');
  addEdge(g, 'x', 't');
  addEdge(g, 't', 'x'); // cycle x -> t -> x
  assert.throws(() => findRoute(g, 's', 't', {}), { code: 'E_CYCLE' });
});

test('insufficient device capacity yields E_CAPACITY', () => {
  const g = emptyGraph();
  addNode(g, { id: 's', op: 0, device: 'A', time: 4 });
  addNode(g, { id: 'm', op: 1, device: 'A', time: 4 });
  addNode(g, { id: 't', op: 2, device: 'A', time: 4 });
  addEdge(g, 's', 'm');
  addEdge(g, 'm', 't');
  addEdge(g, 's', 't');
  g.deviceLoad.set('A', 3);
  // Direct path needs 3+8=11 > 10; via m needs 15 > 10.
  assert.throws(() => findRoute(g, 's', 't', { A: 10 }), { code: 'E_CAPACITY' });
  // With enough headroom the direct path is feasible and optimal.
  assert.deepEqual(findRoute(g, 's', 't', { A: 11 }), { path: ['s', 't'], time: 8 });
});

test('precedence violations are never routed', () => {
  const g = emptyGraph();
  addNode(g, { id: 's', op: 2, device: 'A', time: 1 });
  addNode(g, { id: 't', op: 1, device: 'A', time: 1 });
  addEdge(g, 's', 't');
  assert.throws(() => findRoute(g, 's', 't', {}), (err) => {
    assert.ok(err instanceof RouteError);
    assert.equal(err.code, 'E_NO_PATH');
    return true;
  });
});
