import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph, CycleError } from '../src/graph.js';

test('rejects edges that would create a cycle', () => {
  const g = new Graph();
  for (const id of ['a', 'b', 'c']) g.addNode(id, () => 0);
  g.addEdge('a', 'b');
  g.addEdge('b', 'c');
  assert.throws(() => g.addEdge('c', 'a'), CycleError);
  assert.throws(() => g.addEdge('a', 'a'), CycleError);
  // Non-cyclic edge still accepted afterwards.
  g.addEdge('a', 'c');
});

test('invalidation propagates only to affected dependents', () => {
  const g = new Graph();
  const counts = { m: 0, b: 0, u: 0 };
  g.addNode('s1', () => 0);
  g.addNode('s2', () => 0);
  g.addNode('m', (deps) => {
    counts.m += 1;
    return deps.get('s1') * 2;
  });
  g.addNode('b', (deps) => {
    counts.b += 1;
    return deps.get('m') + deps.get('s2');
  });
  g.addNode('u', (deps) => {
    counts.u += 1;
    return deps.get('s2');
  });
  g.addEdge('s1', 'm');
  g.addEdge('m', 'b');
  g.addEdge('s2', 'b');
  g.addEdge('s2', 'u');
  g.setValue('s1', 1);
  g.setValue('s2', 10);
  g.sync();
  assert.equal(g.value('b'), 12);
  assert.deepEqual(counts, { m: 1, b: 1, u: 1 });

  g.setValue('s1', 5); // only m and b are downstream of s1
  g.sync();
  assert.equal(g.value('b'), 20);
  assert.deepEqual(counts, { m: 2, b: 2, u: 1 });
});

test('dynamic edge removal stops propagation', () => {
  const g = new Graph();
  let bCount = 0;
  g.addNode('s', () => 0);
  g.addNode('b', (deps) => {
    bCount += 1;
    return deps.get('s') ?? 0;
  });
  g.addEdge('s', 'b');
  g.setValue('s', 1);
  g.sync();
  assert.equal(bCount, 1);
  g.removeEdge('s', 'b');
  g.setValue('s', 99);
  g.sync();
  assert.equal(bCount, 2); // recomputed once for the removal, not for the setValue
});
