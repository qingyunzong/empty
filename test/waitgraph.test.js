import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateCycles } from '../src/waitgraph.js';

const g = (edges) => {
  const map = new Map();
  for (const [from, to] of edges) {
    if (!map.has(from)) map.set(from, new Set());
    map.get(from).add(to);
    if (!map.has(to)) map.set(to, new Set());
  }
  return map;
};

test('no cycles in acyclic graph', () => {
  assert.deepEqual(enumerateCycles(g([[1, 2], [2, 3], [1, 3]])), []);
});

test('single 2-cycle', () => {
  assert.deepEqual(enumerateCycles(g([[1, 2], [2, 1]])), [[1, 2]]);
});

test('single 3-cycle canonicalized to smallest node first', () => {
  assert.deepEqual(enumerateCycles(g([[2, 3], [3, 1], [1, 2]])), [[1, 2, 3]]);
});

test('figure-eight: two cycles sharing a node', () => {
  const cycles = enumerateCycles(g([[1, 2], [2, 1], [2, 3], [3, 2]]));
  assert.deepEqual(cycles, [[1, 2], [2, 3]]);
});

test('self loop', () => {
  assert.deepEqual(enumerateCycles(g([[1, 1]])), [[1]]);
});

test('diamond with one back edge', () => {
  const cycles = enumerateCycles(g([[1, 2], [1, 3], [2, 4], [3, 4], [4, 1]]));
  assert.deepEqual(cycles, [[1, 2, 4], [1, 3, 4]]);
});
