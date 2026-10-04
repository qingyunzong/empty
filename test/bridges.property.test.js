import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectedComponents, tarjanBridges } from '../src/network.js';

// Deterministic PRNG (mulberry32) so the property test is reproducible.
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const buildAdjacency = (nodes, edges, skipIndex = -1) => {
  const adjacency = new Map(nodes.map((node) => [node, []]));
  edges.forEach(([a, b], index) => {
    if (index === skipIndex) return;
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  });
  for (const neighbors of adjacency.values()) neighbors.sort();
  return adjacency;
};

// Reference: an edge is a bridge iff deleting it increases the component count.
const bruteForceBridges = (nodes, edges) => {
  const baseline = connectedComponents(nodes, buildAdjacency(nodes, edges)).length;
  const bridges = [];
  edges.forEach(([a, b], index) => {
    const without = connectedComponents(nodes, buildAdjacency(nodes, edges, index)).length;
    if (without > baseline) bridges.push(a < b ? [a, b] : [b, a]);
  });
  return bridges.sort((p, q) => (p[0] === q[0] ? (p[1] < q[1] ? -1 : 1) : p[0] < q[0] ? -1 : 1));
};

describe('property: Tarjan bridges match delete-one-edge enumeration for n <= 8', () => {
  for (let n = 2; n <= 8; n += 1) {
    it(`holds for random graphs with n=${n}`, () => {
      const random = mulberry32(0xc0ffee + n);
      for (let trial = 0; trial < 300; trial += 1) {
        const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
        const edges = [];
        for (let i = 0; i < n; i += 1) {
          for (let j = i + 1; j < n; j += 1) {
            if (random() < 0.4) edges.push([nodes[i], nodes[j]]);
          }
        }
        const adjacency = buildAdjacency(nodes, edges);
        assert.deepEqual(tarjanBridges(nodes, adjacency), bruteForceBridges(nodes, edges));
      }
    });
  }

  it('also holds for all graphs on n=4 (exhaustive)', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const possible = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) possible.push([nodes[i], nodes[j]]);
    }
    for (let mask = 0; mask < 2 ** possible.length; mask += 1) {
      const edges = possible.filter((_, index) => mask & (1 << index));
      assert.deepEqual(tarjanBridges(nodes, buildAdjacency(nodes, edges)), bruteForceBridges(nodes, edges));
    }
  });
});
