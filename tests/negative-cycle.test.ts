import test from 'node:test';
import assert from 'node:assert/strict';
import type { Graph } from '../src/graph.ts';
import {
  generateNegativeCycleCertificate,
  generateOptimalityCertificate,
} from '../src/generate.ts';
import {
  verifyNegativeCycle,
  verifyOptimality,
  type NegativeCycleCertificate,
} from '../src/verify.ts';

// x -1-> y -(-3)-> z -1-> x forms a cycle of cost -1.
// Alternative z -> x edge 'zx2' costs 2, making the cycle non-negative.
const graph: Graph = {
  nodes: ['x', 'y', 'z'],
  edges: [
    { id: 'xy', from: 'x', to: 'y', cost: 1, version: 2 },
    { id: 'yz', from: 'y', to: 'z', cost: -3, version: 1 },
    { id: 'zx', from: 'z', to: 'x', cost: 1, version: 5 },
    { id: 'zx2', from: 'z', to: 'x', cost: 2, version: 1 },
  ],
};

test('accepts a handcrafted negative-cycle certificate', () => {
  const cert: NegativeCycleCertificate = {
    kind: 'negative-cycle',
    start: 'x',
    steps: [
      { edgeId: 'xy', edgeVersion: 2 },
      { edgeId: 'yz', edgeVersion: 1 },
      { edgeId: 'zx', edgeVersion: 5 },
    ],
  };
  const result = verifyNegativeCycle(graph, cert);
  assert.ok(result.ok);
  assert.equal(result.value.cost, -1);
});

test('generator finds a negative cycle that verifies', () => {
  const cert = generateNegativeCycleCertificate(graph, 'x');
  assert.ok(cert !== null);
  const result = verifyNegativeCycle(graph, cert);
  assert.ok(result.ok);
  assert.ok(result.value.cost < 0);
});

test('every single-field corruption of a valid negative-cycle certificate is rejected', () => {
  const good = generateNegativeCycleCertificate(graph, 'x');
  assert.ok(good !== null);
  assert.ok(verifyNegativeCycle(graph, good).ok, 'precondition: base certificate is valid');

  const corruptions: [string, (cert: NegativeCycleCertificate) => void][] = [
    ['start', (cert) => { cert.start = 'q'; }],
    ...good.steps.flatMap((_, i): [string, (cert: NegativeCycleCertificate) => void][] => [
      [`steps[${i}].edgeId`, (cert) => { cert.steps[i].edgeId = 'missing'; }],
      [`steps[${i}].edgeVersion`, (cert) => { cert.steps[i].edgeVersion += 100; }],
    ]),
    ['drop last step', (cert) => { cert.steps.pop(); }],
    ['swap first two steps', (cert) => {
      const tmp = cert.steps[0];
      cert.steps[0] = cert.steps[1];
      cert.steps[1] = tmp;
    }],
  ];

  for (const [field, corrupt] of corruptions) {
    const mutated = structuredClone(good);
    corrupt(mutated);
    const result = verifyNegativeCycle(graph, mutated);
    assert.ok(!result.ok, `corrupting ${field} must be rejected, got: ${JSON.stringify(result)}`);
  }
});

test('non-negative cycle is rejected', () => {
  const cert: NegativeCycleCertificate = {
    kind: 'negative-cycle',
    start: 'x',
    steps: [
      { edgeId: 'xy', edgeVersion: 2 },
      { edgeId: 'yz', edgeVersion: 1 },
      { edgeId: 'zx2', edgeVersion: 1 }, // 1 + (-3) + 2 = 0
    ],
  };
  const result = verifyNegativeCycle(graph, cert);
  assert.ok(!result.ok);
  assert.equal(result.code, 'cycle-not-negative');
});

test('open walk is rejected as not-a-cycle', () => {
  const cert: NegativeCycleCertificate = {
    kind: 'negative-cycle',
    start: 'x',
    steps: [
      { edgeId: 'xy', edgeVersion: 2 },
      { edgeId: 'yz', edgeVersion: 1 },
    ],
  };
  const result = verifyNegativeCycle(graph, cert);
  assert.ok(!result.ok);
  assert.equal(result.code, 'not-a-cycle');
});

test('empty certificate is rejected', () => {
  const result = verifyNegativeCycle(graph, { kind: 'negative-cycle', start: 'x', steps: [] });
  assert.ok(!result.ok);
  assert.equal(result.code, 'empty-cycle');
});

const acyclic: Graph = {
  nodes: ['a', 'b', 'c'],
  edges: [
    { id: 'ab', from: 'a', to: 'b', cost: -2, version: 1 },
    { id: 'bc', from: 'b', to: 'c', cost: 1, version: 1 },
  ],
};

test('no negative-cycle certificate exists for a negative-cycle-free graph', () => {
  assert.equal(generateNegativeCycleCertificate(acyclic, 'a'), null);
});

test('optimality certificate cannot be generated on a negative-cycle graph', () => {
  assert.equal(generateOptimalityCertificate(graph, 'x', 'y'), null);
});

test('optimality certificate verifies on negative-edge DAG', () => {
  const cert = generateOptimalityCertificate(acyclic, 'a', 'c');
  assert.ok(cert !== null);
  assert.ok(verifyOptimality(acyclic, cert).ok);
  assert.equal(cert.path.totalCost, -1);
});
