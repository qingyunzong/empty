import test from 'node:test';
import assert from 'node:assert/strict';
import type { Graph } from '../src/graph.ts';
import {
  generateOptimalityCertificate,
  pathCertificateFromEdges,
} from '../src/generate.ts';
import { verifyOptimality, type OptimalityCertificate } from '../src/verify.ts';
import { allSimplePaths, minSimplePathCost, mulberry32, randomGraph } from './helpers.ts';

// Graph with negative edges but no negative cycle.
// a -4-> b -(-2)-> c -3-> d ; a -1-> c ; b -2-> d ; c -(-1)-> b would cycle, so:
const graph: Graph = {
  nodes: ['a', 'b', 'c', 'd'],
  edges: [
    { id: 'ab', from: 'a', to: 'b', cost: 4, version: 1 },
    { id: 'bc', from: 'b', to: 'c', cost: -2, version: 2 },
    { id: 'cd', from: 'c', to: 'd', cost: 3, version: 1 },
    { id: 'ac', from: 'a', to: 'c', cost: 1, version: 4 },
    { id: 'bd', from: 'b', to: 'd', cost: 2, version: 1 },
  ],
};

test('accepts a handcrafted optimality certificate (not generator output)', () => {
  // shortest a -> d is a -> c -> d with cost 1 + 3 = 4.
  // potentials = shortest distances from a: a=0, b=4, c=1, d=4.
  const cert: OptimalityCertificate = {
    kind: 'optimality',
    source: 'a',
    target: 'd',
    path: {
      kind: 'path',
      start: 'a',
      steps: [
        { edgeId: 'ac', edgeVersion: 4 },
        { edgeId: 'cd', edgeVersion: 1 },
      ],
      totalCost: 4,
    },
    potentials: { a: 0, b: 4, c: 1, d: 4 },
  };
  const result = verifyOptimality(graph, cert);
  assert.ok(result.ok, `handcrafted certificate rejected: ${JSON.stringify(result)}`);
  assert.equal(result.value.cost, 4);
});

test('accepts generated certificates with negative edges', () => {
  for (const target of ['b', 'c', 'd']) {
    const cert = generateOptimalityCertificate(graph, 'a', target);
    assert.ok(cert !== null, `no certificate for a -> ${target}`);
    const result = verifyOptimality(graph, cert);
    assert.ok(result.ok, `generated certificate for a -> ${target} rejected`);
  }
});

test('every single-field corruption of a valid optimality certificate is rejected', () => {
  const good = generateOptimalityCertificate(graph, 'a', 'd');
  assert.ok(good !== null);
  assert.ok(verifyOptimality(graph, good).ok, 'precondition: base certificate is valid');

  const corruptions: [string, (cert: OptimalityCertificate) => void][] = [
    ['source', (cert) => { cert.source = 'b'; }],
    ['target', (cert) => { cert.target = 'b'; }],
    ['path.start', (cert) => { cert.path.start = 'c'; }],
    ['path.totalCost', (cert) => { cert.path.totalCost += 1; }],
    ...good.path.steps.flatMap((_, i): [string, (cert: OptimalityCertificate) => void][] => [
      [`path.steps[${i}].edgeId`, (cert) => { cert.path.steps[i].edgeId = 'missing'; }],
      [`path.steps[${i}].edgeVersion`, (cert) => { cert.path.steps[i].edgeVersion += 100; }],
    ]),
    // potential of source: any change breaks tightness
    ['potentials[a] +1', (cert) => { cert.potentials['a'] += 1; }],
    ['potentials[a] -1', (cert) => { cert.potentials['a'] -= 1; }],
    // potential of target: any change breaks tightness
    ['potentials[d] +1', (cert) => { cert.potentials['d'] += 1; }],
    ['potentials[d] -1', (cert) => { cert.potentials['d'] -= 1; }],
    // potentials of inner nodes: large deltas break some triangle inequality
    ['potentials[b] +1e6', (cert) => { cert.potentials['b'] += 1e6; }],
    ['potentials[b] -1e6', (cert) => { cert.potentials['b'] -= 1e6; }],
    ['potentials[c] +1e6', (cert) => { cert.potentials['c'] += 1e6; }],
    ['potentials[c] -1e6', (cert) => { cert.potentials['c'] -= 1e6; }],
    ['potentials missing c', (cert) => { delete cert.potentials['c']; }],
  ];

  for (const [field, corrupt] of corruptions) {
    const mutated = structuredClone(good);
    corrupt(mutated);
    const result = verifyOptimality(graph, mutated);
    assert.ok(!result.ok, `corrupting ${field} must be rejected, got: ${JSON.stringify(result)}`);
  }
});

test('triangle inequality violation is reported with the edge position', () => {
  const good = generateOptimalityCertificate(graph, 'a', 'd');
  assert.ok(good !== null);
  good.potentials['c'] = 100; // breaks edge bc (index 1): 100 > 4 + (-2)
  const result = verifyOptimality(graph, good);
  assert.ok(!result.ok);
  assert.equal(result.code, 'triangle-inequality');
  assert.equal(result.position, 1);
});

test('suboptimal path with true potentials is rejected (bound not tight)', () => {
  // a -> b -> d costs 4 + 2 = 6, but optimum is 4.
  const cert: OptimalityCertificate = {
    kind: 'optimality',
    source: 'a',
    target: 'd',
    path: pathCertificateFromEdges(graph, 'a', ['ab', 'bd']),
    potentials: { a: 0, b: 4, c: 1, d: 4 },
  };
  const result = verifyOptimality(graph, cert);
  assert.ok(!result.ok);
  assert.equal(result.code, 'bound-not-tight');
});

test('random small graphs: verifier agrees with exhaustive all-paths reference', () => {
  const rng = mulberry32(20261008);
  for (let trial = 0; trial < 100; trial++) {
    const g = randomGraph(rng, 5, 6, -3, 6);
    for (const target of g.nodes.slice(1)) {
      const reference = minSimplePathCost(g, 'n0', target);
      const cert = generateOptimalityCertificate(g, 'n0', target);
      if (cert === null) {
        continue; // reachable negative cycle: no optimality certificate exists
      }
      const result = verifyOptimality(g, cert);
      assert.ok(result.ok, `trial ${trial} target ${target}: valid certificate rejected`);
      assert.equal(
        cert.path.totalCost,
        reference,
        `trial ${trial} target ${target}: certified cost must equal exhaustive reference`,
      );

      // False-accept check: every strictly suboptimal simple path, presented
      // with the true potentials, must be rejected.
      for (const path of allSimplePaths(g, 'n0', target)) {
        if (path.cost <= reference) {
          continue;
        }
        const forged: OptimalityCertificate = {
          kind: 'optimality',
          source: 'n0',
          target,
          path: pathCertificateFromEdges(g, 'n0', path.edgeIds),
          potentials: { ...cert.potentials },
        };
        const forgedResult = verifyOptimality(g, forged);
        assert.ok(
          !forgedResult.ok,
          `trial ${trial} target ${target}: suboptimal path (cost ${path.cost} > ${reference}) accepted`,
        );
      }

      // False-accept check: optimal path with randomly perturbed potentials
      // must be rejected whenever tightness or a triangle inequality breaks.
      const perturbed = structuredClone(cert);
      const victim = g.nodes[Math.floor(rng() * g.nodes.length)];
      perturbed.potentials[victim] += 1e6;
      const perturbedResult = verifyOptimality(g, perturbed);
      assert.ok(
        !perturbedResult.ok,
        `trial ${trial} target ${target}: +1e6 potential on ${victim} accepted`,
      );
    }
  }
});
