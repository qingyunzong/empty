import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core.js';

// Independent brute-force enumeration of all source->target paths,
// written separately from Graph.pathsTo on purpose.
function bruteForcePaths(n, edgeList, target) {
  const adj = new Map();
  const indeg = new Array(n).fill(0);
  for (const [from, to] of edgeList) {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
    indeg[to]++;
  }
  const paths = [];
  const stack = [];
  const dfs = (node) => {
    stack.push(node);
    if (node === target) {
      paths.push([...stack]);
    } else {
      for (const next of adj.get(node) ?? []) dfs(next);
    }
    stack.pop();
  };
  for (let s = 0; s < n; s++) if (indeg[s] === 0) dfs(s);
  return paths.map((p) => p.join('>')).sort();
}

function bruteForceAncestors(n, edgeList, target) {
  const preds = new Map();
  for (const [from, to] of edgeList) {
    if (!preds.has(to)) preds.set(to, []);
    preds.get(to).push(from);
  }
  const seen = new Set([target]);
  const queue = [target];
  while (queue.length) {
    for (const p of preds.get(queue.pop()) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

function buildGraph(n, edgeList) {
  const g = new Graph();
  for (let i = 0; i < n; i++) {
    g.addLot({ kind: 'lot', id: String(i), mass: 1, unit: 'kg', status: 'open', createdAt: 0, site: 't', seq: i });
  }
  edgeList.forEach(([from, to], i) => {
    g.addEdgeRaw({ id: `e${i}`, event: `ev${i}`, op: 'split', from: String(from), to: String(to), mass: 1, ts: 1, site: 't', seq: i });
  });
  return g;
}

function checkGraph(n, edgeList) {
  const g = buildGraph(n, edgeList);
  for (let target = 0; target < n; target++) {
    const libPaths = g.pathsTo(String(target)).map((p) => p.join('>')).sort();
    assert.deepEqual(libPaths, bruteForcePaths(n, edgeList, target), `paths mismatch n=${n} target=${target}`);
    const libAnc = [...g.ancestry(String(target)).lots].map(Number).sort((a, b) => a - b);
    assert.deepEqual(libAnc, bruteForceAncestors(n, edgeList, target), `ancestors mismatch n=${n} target=${target}`);
  }
}

test('exhaustive ancestor/path cross-check for all DAGs with n <= 4', () => {
  for (let n = 1; n <= 4; n++) {
    const possible = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) possible.push([i, j]);
    for (let mask = 0; mask < 2 ** possible.length; mask++) {
      const edgeList = possible.filter((_, k) => mask & (1 << k));
      checkGraph(n, edgeList);
    }
  }
});

test('exhaustive ancestor/path cross-check for all 1024 DAGs with n = 5', () => {
  const n = 5;
  const possible = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) possible.push([i, j]);
  for (let mask = 0; mask < 2 ** possible.length; mask++) {
    const edgeList = possible.filter((_, k) => mask & (1 << k));
    checkGraph(n, edgeList);
  }
});

test('sampled ancestor/path cross-check for n in {6,7,8}', () => {
  let seed = 0xC0FFEE;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const n of [6, 7, 8]) {
    for (let trial = 0; trial < 300; trial++) {
      const edgeList = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (rand() < 0.35) edgeList.push([i, j]);
        }
      }
      checkGraph(n, edgeList);
    }
  }
});
