import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamicGraph } from '../src/graph.js';

function build(edges) {
  const g = new DynamicGraph();
  for (const [u, v] of edges) g.addEdge(u, v);
  return g;
}

test('chain: every edge is a bridge, internal vertices are articulation points', () => {
  const g = build([[1, 2], [2, 3], [3, 4]]);
  assert.deepEqual(g.bridges(), [[1, 2], [2, 3], [3, 4]]);
  assert.deepEqual(g.articulationPoints(), [2, 3]);
});

test('cycle: no bridges, no articulation points', () => {
  const g = build([[1, 2], [2, 3], [3, 4], [4, 1]]);
  assert.deepEqual(g.bridges(), []);
  assert.deepEqual(g.articulationPoints(), []);
});

test('figure-eight (two cycles sharing one vertex): shared vertex is the only articulation point', () => {
  const g = build([[1, 2], [2, 3], [3, 1], [3, 4], [4, 5], [5, 3]]);
  assert.deepEqual(g.bridges(), []);
  assert.deepEqual(g.articulationPoints(), [3]);
});

test('biconnected component plus tail: only the tail edges are bridges', () => {
  // K4 on {1,2,3,4} plus tail 4-5-6
  const g = build([
    [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4],
    [4, 5], [5, 6],
  ]);
  assert.deepEqual(g.bridges(), [[4, 5], [5, 6]]);
  assert.deepEqual(g.articulationPoints(), [4, 5]);
});

test('deletion changes the bridge set', () => {
  // triangle 1-2-3 with tail 3-4: only (3,4) is a bridge
  const g = build([[1, 2], [2, 3], [1, 3], [3, 4]]);
  assert.deepEqual(g.bridges(), [[3, 4]]);
  // deleting (1,3) breaks the cycle: the whole chain becomes bridges
  assert.equal(g.delEdge(1, 3), true);
  assert.deepEqual(g.bridges(), [[1, 2], [2, 3], [3, 4]]);
  assert.deepEqual(g.articulationPoints(), [2, 3]);
  // deleting a bridge isolates a vertex
  assert.equal(g.delEdge(3, 4), true);
  assert.deepEqual(g.bridges(), [[1, 2], [2, 3]]);
});

test('duplicate edge insertion is an idempotent no-op', () => {
  const g = build([[1, 2]]);
  assert.equal(g.addEdge(1, 2), false);
  assert.equal(g.addEdge(2, 1), false);
  assert.equal(g.edgeCount(), 1);
  assert.deepEqual(g.edges(), [[1, 2]]);
});

test('deleting an unknown edge reports failure and changes nothing', () => {
  const g = build([[1, 2]]);
  assert.equal(g.delEdge(2, 3), false);
  assert.equal(g.delEdge(5, 6), false);
  assert.deepEqual(g.edges(), [[1, 2]]);
});

test('disconnected components are all analysed', () => {
  const g = build([[1, 2], [10, 11], [11, 12], [12, 10]]);
  assert.deepEqual(g.bridges(), [[1, 2]]);
  assert.deepEqual(g.articulationPoints(), []);
});

test('empty graph has no bridges and no articulation points', () => {
  const g = new DynamicGraph();
  assert.deepEqual(g.bridges(), []);
  assert.deepEqual(g.articulationPoints(), []);
  assert.deepEqual(g.edges(), []);
});
