import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tarjanScc, kosarajuScc, componentsEqual, canonicalComponents } from '../src/graph.js';

test('tarjan finds SCCs in a simple graph', () => {
  const nodes = ['A', 'B', 'C'];
  const edges = [
    ['A', 'B'],
    ['B', 'A'],
    ['B', 'C'],
  ];
  assert.deepEqual(canonicalComponents(tarjanScc(nodes, edges)), [['A', 'B'], ['C']]);
});

test('independent SCC algorithms agree on exhaustive small graphs (n <= 7)', () => {
  // Deterministic PRNG for reproducibility.
  let seed = 0xdeadbeef;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let n = 1; n <= 7; n += 1) {
    for (let trial = 0; trial < 200; trial += 1) {
      const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
      const edges = [];
      for (const u of nodes) {
        for (const v of nodes) {
          if (rand() < 0.3) edges.push([u, v]);
        }
      }
      const a = tarjanScc(nodes, edges);
      const b = kosarajuScc(nodes, edges);
      assert.ok(
        componentsEqual(a, b),
        `mismatch for n=${n} edges=${JSON.stringify(edges)}`,
      );
    }
  }
});
