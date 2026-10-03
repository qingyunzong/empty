import test from 'node:test';
import assert from 'node:assert/strict';
import { kosarajuScc } from '../src/scc.js';
import { enumerationScc } from '../src/scc-enumeration.js';

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(sccs) {
  return sccs
    .map((members) => [...members].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

test('Kosaraju matches enumeration-based grouping for all n <= 8', () => {
  const rand = mulberry32(20261003);
  for (let trial = 0; trial < 400; trial += 1) {
    const n = 1 + Math.floor(rand() * 8); // 1..8 nodes
    const nodes = Array.from({ length: n }, (_, i) => i);
    const edges = [];
    for (let from = 0; from < n; from += 1) {
      for (let to = 0; to < n; to += 1) {
        if (from !== to && rand() < 0.3) edges.push([from, to]);
      }
    }
    assert.deepEqual(
      normalize(kosarajuScc(nodes, edges)),
      normalize(enumerationScc(nodes, edges)),
      `mismatch on trial ${trial} with edges ${JSON.stringify(edges)}`,
    );
  }
});

test('exhaustive: every directed graph on 3 nodes agrees', () => {
  const nodes = [0, 1, 2];
  const possible = [];
  for (const from of nodes) {
    for (const to of nodes) {
      if (from !== to) possible.push([from, to]);
    }
  }
  for (let mask = 0; mask < 2 ** possible.length; mask += 1) {
    const edges = possible.filter((_, bit) => mask & (1 << bit));
    assert.deepEqual(
      normalize(kosarajuScc(nodes, edges)),
      normalize(enumerationScc(nodes, edges)),
      `mismatch for mask ${mask}`,
    );
  }
});
