import test from 'node:test';
import assert from 'node:assert/strict';
import { kosaraju, bruteForceComponents, condensation } from '../src/graph.js';

function normalize(components) {
  return components
    .map((component) => [...component].sort((a, b) => a - b).join(','))
    .sort()
    .join('|');
}

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('kosaraju matches brute-force mutual-reachability grouping for n <= 8', () => {
  const random = makeRandom(0xC0FFEE);
  for (let n = 1; n <= 8; n += 1) {
    for (let trial = 0; trial < 300; trial += 1) {
      const nodes = Array.from({ length: n }, (_, i) => i);
      const edges = [];
      for (let u = 0; u < n; u += 1) {
        for (let v = 0; v < n; v += 1) {
          if (random() < 0.3) edges.push([u, v]);
        }
      }
      assert.equal(
        normalize(kosaraju(nodes, edges)),
        normalize(bruteForceComponents(nodes, edges)),
        `mismatch for n=${n} edges=${JSON.stringify(edges)}`,
      );
    }
  }
});

test('kosaraju matches brute force exhaustively for n = 3', () => {
  const nodes = [0, 1, 2];
  const pairs = [];
  for (const u of nodes) for (const v of nodes) pairs.push([u, v]);
  for (let mask = 0; mask < 2 ** pairs.length; mask += 1) {
    const edges = pairs.filter((_, bit) => mask & (1 << bit));
    assert.equal(normalize(kosaraju(nodes, edges)), normalize(bruteForceComponents(nodes, edges)));
  }
});

test('condensation topological order respects every cross-component edge', () => {
  const random = makeRandom(42);
  for (let trial = 0; trial < 500; trial += 1) {
    const n = 1 + Math.floor(random() * 8);
    const nodes = Array.from({ length: n }, (_, i) => i);
    const edges = [];
    for (let u = 0; u < n; u += 1) {
      for (let v = 0; v < n; v += 1) {
        if (u !== v && random() < 0.35) edges.push([u, v]);
      }
    }
    const components = kosaraju(nodes, edges);
    const { topo } = condensation(nodes, edges, components);
    assert.equal(topo.length, components.length);
    const position = new Map();
    components.forEach((component, index) => {
      for (const node of component) position.set(node, topo.indexOf(index));
    });
    for (const [u, v] of edges) {
      assert.ok(
        position.get(u) <= position.get(v),
        `edge ${u}->${v} violates topological order`,
      );
    }
  }
});
