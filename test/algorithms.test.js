'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  connectedComponents,
  tarjanBridges,
  enumerationBridges,
  shortestPath,
} = require('../index');

// Deterministic PRNG (mulberry32) so the property test is reproducible.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(rand, n, edgeProbability, allowParallel) {
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
  const edges = [];
  let nextId = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (rand() < edgeProbability) {
        edges.push({ id: `e${nextId}`, a: nodes[i], b: nodes[j] });
        nextId += 1;
        if (allowParallel && rand() < 0.25) {
          edges.push({ id: `e${nextId}`, a: nodes[i], b: nodes[j] });
          nextId += 1;
        }
      }
    }
  }
  return { nodes, edges };
}

test('property: Tarjan bridges match delete-each-edge enumeration for n<=8', () => {
  const rand = mulberry32(20261004);
  for (let trial = 0; trial < 500; trial += 1) {
    const n = 1 + Math.floor(rand() * 8); // 1..8 nodes
    const { nodes, edges } = randomGraph(rand, n, rand(), trial % 2 === 0);
    const tarjan = tarjanBridges(nodes, edges).sort();
    const enumerated = enumerationBridges(nodes, edges).sort();
    assert.deepEqual(tarjan, enumerated, `mismatch on trial ${trial}: ${JSON.stringify({ nodes, edges })}`);
  }
});

test('property: connected components are consistent with reachability', () => {
  const rand = mulberry32(7);
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 1 + Math.floor(rand() * 8);
    const { nodes, edges } = randomGraph(rand, n, rand(), false);
    const components = connectedComponents(nodes, edges);
    assert.equal(components.flat().length, n);
    for (const component of components) {
      for (let i = 0; i < component.length; i += 1) {
        for (let j = 0; j < component.length; j += 1) {
          assert.notEqual(shortestPath(nodes, edges, component[i], component[j]), null);
        }
      }
    }
    for (let i = 0; i < components.length; i += 1) {
      for (let j = i + 1; j < components.length; j += 1) {
        assert.equal(shortestPath(nodes, edges, components[i][0], components[j][0]), null);
      }
    }
  }
});

test('shortestPath: lexicographically smallest among shortest paths', () => {
  const nodes = ['S', 'A', 'B', 'T'];
  const edges = [
    { id: 'e1', a: 'S', b: 'B' },
    { id: 'e2', a: 'B', b: 'T' },
    { id: 'e3', a: 'S', b: 'A' },
    { id: 'e4', a: 'A', b: 'T' },
  ];
  assert.deepEqual(shortestPath(nodes, edges, 'S', 'T'), ['S', 'A', 'T']);
  assert.deepEqual(shortestPath(nodes, edges, 'T', 'S'), ['T', 'A', 'S']);
  assert.equal(shortestPath(nodes, edges, 'S', 'nowhere'), null);
});

test('shortestPath prefers fewer hops over lexicography', () => {
  const nodes = ['S', 'Z', 'T'];
  const edges = [
    { id: 'e1', a: 'S', b: 'T' }, // direct edge wins over S-Z-T
    { id: 'e2', a: 'S', b: 'Z' },
    { id: 'e3', a: 'Z', b: 'T' },
  ];
  assert.deepEqual(shortestPath(nodes, edges, 'S', 'T'), ['S', 'T']);
});

test('parallel edges are not bridges', () => {
  const nodes = ['A', 'B'];
  const edges = [
    { id: 'e1', a: 'A', b: 'B' },
    { id: 'e2', a: 'A', b: 'B' },
  ];
  assert.deepEqual(tarjanBridges(nodes, edges), []);
  assert.deepEqual(enumerationBridges(nodes, edges), []);
});
