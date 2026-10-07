import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/graph.js';
import { findBestPath, comparePaths } from '../src/scheduler.js';

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

function enumeratePaths(graph, start, end) {
  const paths = [];
  const visited = new Set();
  const path = [];
  (function dfs(u) {
    visited.add(u);
    path.push(u);
    if (u === end) paths.push(path.slice());
    else {
      for (const v of graph.neighbors(u)) {
        if (!visited.has(v) && graph.nodes.has(v)) dfs(v);
      }
    }
    path.pop();
    visited.delete(u);
  })(start);
  return paths;
}

function pathFeasible(graph, path) {
  const loads = new Map();
  for (const id of path) {
    const n = graph.nodes.get(id);
    if (n.device == null) continue;
    const cap = graph.devices.has(n.device) ? graph.devices.get(n.device).capacity : Infinity;
    const next = (loads.get(n.device) ?? 0) + n.load;
    if (next > cap) return false;
    loads.set(n.device, next);
  }
  return true;
}

function pathTime(graph, path) {
  return path.reduce((s, id) => s + graph.nodes.get(id).time, 0);
}

function bruteForce(graph, start, end) {
  const all = enumeratePaths(graph, start, end);
  const feasible = all.filter((p) => pathFeasible(graph, p));
  if (all.length === 0) return { code: 'E_NO_PATH' };
  if (feasible.length === 0) return { code: 'E_CAPACITY' };
  let best = null;
  for (const p of feasible) {
    const t = pathTime(graph, p);
    if (!best || t < best.time || (t === best.time && comparePaths(p, best.path) < 0)) {
      best = { path: p, time: t };
    }
  }
  return { code: 'OK', best };
}

function randomDag(rand) {
  const n = 2 + Math.floor(rand() * 7);
  const deviceIds = ['d0', 'd1', 'd2'].slice(0, 1 + Math.floor(rand() * 3));
  const g = new Graph();
  for (const d of deviceIds) g.addDevice(d, 2 + Math.floor(rand() * 10));
  for (let i = 0; i < n; i++) {
    g.addNode({
      id: `n${i}`,
      device: rand() < 0.85 ? deviceIds[Math.floor(rand() * deviceIds.length)] : null,
      time: 1 + Math.floor(rand() * 6),
      load: Math.floor(rand() * 5),
    });
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rand() < 0.35) g.addEdge(`n${i}`, `n${j}`);
    }
  }
  return { g, n };
}

test('matches brute-force enumeration on random small DAGs', () => {
  const rand = mulberry32(20261007);
  const counts = { OK: 0, E_NO_PATH: 0, E_CAPACITY: 0 };
  for (let iter = 0; iter < 300; iter++) {
    const { g, n } = randomDag(rand);
    const start = 'n0';
    const end = `n${n - 1}`;
    const expected = bruteForce(g, start, end);
    counts[expected.code]++;
    if (expected.code === 'OK') {
      const best = findBestPath(g, start, end);
      assert.deepEqual(best, expected.best, `iter ${iter}`);
    } else {
      assert.throws(() => findBestPath(g, start, end), (err) => err.code === expected.code, `iter ${iter}`);
    }
  }
  assert.ok(counts.OK > 50, `expected many OK cases, got ${JSON.stringify(counts)}`);
  assert.ok(counts.E_CAPACITY > 0, `expected some E_CAPACITY cases, got ${JSON.stringify(counts)}`);
});

test('picks shortest time, then lexicographically smallest node sequence', () => {
  const g = Graph.fromJSON({
    devices: [],
    nodes: [
      { id: 'A', time: 1 },
      { id: 'B', time: 2 },
      { id: 'C', time: 2 },
      { id: 'D', time: 1 },
    ],
    edges: [
      { from: 'A', to: 'C' },
      { from: 'A', to: 'B' },
      { from: 'B', to: 'D' },
      { from: 'C', to: 'D' },
    ],
  });
  const best = findBestPath(g, 'A', 'D');
  assert.deepEqual(best.path, ['A', 'B', 'D']);
  assert.equal(best.time, 4);
});

test('capacity constraints eliminate overloaded paths', () => {
  const g = Graph.fromJSON({
    devices: [{ id: 'm', capacity: 4 }],
    nodes: [
      { id: 'A', device: 'm', time: 1, load: 1 },
      { id: 'B', device: 'm', time: 1, load: 5 },
      { id: 'C', device: 'm', time: 3, load: 2 },
      { id: 'D', device: 'm', time: 1, load: 1 },
    ],
    edges: [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'B', to: 'D' },
      { from: 'C', to: 'D' },
    ],
  });
  const best = findBestPath(g, 'A', 'D');
  assert.deepEqual(best.path, ['A', 'C', 'D']);
});

test('E_CAPACITY when every path exceeds device daily load', () => {
  const g = Graph.fromJSON({
    devices: [{ id: 'm', capacity: 2 }],
    nodes: [
      { id: 'A', device: 'm', time: 1, load: 2 },
      { id: 'B', device: 'm', time: 1, load: 2 },
    ],
    edges: [{ from: 'A', to: 'B' }],
  });
  assert.throws(() => findBestPath(g, 'A', 'B'), (err) => err.code === 'E_CAPACITY');
});

test('E_CYCLE on cyclic graphs', () => {
  const g = Graph.fromJSON({
    devices: [],
    nodes: [{ id: 'A', time: 1 }, { id: 'B', time: 1 }, { id: 'C', time: 1 }],
    edges: [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'C', to: 'A' },
    ],
  });
  assert.throws(() => findBestPath(g, 'A', 'C'), (err) => err.code === 'E_CYCLE');
});

test('E_NO_PATH when end is unreachable', () => {
  const g = Graph.fromJSON({
    devices: [],
    nodes: [{ id: 'A', time: 1 }, { id: 'B', time: 1 }],
    edges: [],
  });
  assert.throws(() => findBestPath(g, 'A', 'B'), (err) => err.code === 'E_NO_PATH');
});

test('start equals end yields a single-node path', () => {
  const g = Graph.fromJSON({ devices: [], nodes: [{ id: 'A', time: 7 }], edges: [] });
  assert.deepEqual(findBestPath(g, 'A', 'A'), { path: ['A'], time: 7 });
});
