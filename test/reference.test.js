import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineageGraph } from '../src/graph.js';
import { parseSource } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { execute } from '../src/vm.js';

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

// Independent reference implementation: plain BFS over an edge list,
// written separately from the library code under test.
function refClosure(edgeList, start, direction) {
  const adj = new Map();
  for (const [from, to] of edgeList) {
    const [a, b] = direction === 'down' ? [from, to] : [to, from];
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  seen.delete(start);
  return [...seen].sort();
}

function refShortestPath(edgeList, from, to) {
  if (from === to) return [from];
  const adj = new Map();
  for (const [f, t] of edgeList) {
    if (!adj.has(f)) adj.set(f, []);
    adj.get(f).push(t);
  }
  for (const list of adj.values()) list.sort();
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of adj.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        let p = cur;
        while (p !== null) {
          path.unshift(p);
          p = prev.get(p);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

test('acceptance 4: random DAGs (<=30 nodes) match an independent BFS reference', () => {
  const rng = mulberry32(20251004);
  for (let trial = 0; trial < 60; trial++) {
    const n = 2 + Math.floor(rng() * 29); // 2..30 nodes
    const ids = Array.from({ length: n }, (_, i) => `LOT-2025-${String(i + 1).padStart(4, '0')}`);
    const edgeList = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rng() < 0.12) edgeList.push([ids[i], ids[j]]);
      }
    }
    const g = new LineageGraph();
    g.applyTransaction(
      ids.map((id) => ({ op: 'add', id, attrs: { type: 'raw', date: '2025-01-01' } })),
    );
    if (edgeList.length > 0) {
      g.applyTransaction(edgeList.map(([from, to]) => ({ op: 'link', from, to })));
    }
    for (const id of ids) {
      assert.deepEqual(g.ancestors(id), refClosure(edgeList, id, 'up'), `ancestors ${id} trial ${trial}`);
      assert.deepEqual(g.descendants(id), refClosure(edgeList, id, 'down'), `descendants ${id} trial ${trial}`);
    }
    for (let k = 0; k < 10; k++) {
      const a = ids[Math.floor(rng() * n)];
      const b = ids[Math.floor(rng() * n)];
      assert.deepEqual(g.shortestPath(a, b), refShortestPath(edgeList, a, b), `path ${a}->${b} trial ${trial}`);
    }
    // End-to-end check through the DSL bytecode VM on one random node.
    const probe = ids[Math.floor(rng() * n)];
    const { results } = execute(
      compile(parseSource(`query descendants(${probe});`)),
      g,
    );
    assert.deepEqual(results[0].result, refClosure(edgeList, probe, 'down'), `dsl trial ${trial}`);
  }
});
