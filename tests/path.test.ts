import test from 'node:test';
import assert from 'node:assert/strict';
import type { Graph } from '../src/graph.ts';
import { pathCertificateFromEdges } from '../src/generate.ts';
import { verifyPath, type PathCertificate } from '../src/verify.ts';

// a -2-> b -3-> c -1-> d
//  \-5-> c        b <-4- d   (d -> b)
const graph: Graph = {
  nodes: ['a', 'b', 'c', 'd'],
  edges: [
    { id: 'ab', from: 'a', to: 'b', cost: 2, version: 3 },
    { id: 'bc', from: 'b', to: 'c', cost: 3, version: 1 },
    { id: 'cd', from: 'c', to: 'd', cost: 1, version: 2 },
    { id: 'ac', from: 'a', to: 'c', cost: 5, version: 7 },
    { id: 'db', from: 'd', to: 'b', cost: 4, version: 1 },
  ],
};

test('accepts a handcrafted valid path certificate', () => {
  const cert: PathCertificate = {
    kind: 'path',
    start: 'a',
    steps: [
      { edgeId: 'ab', edgeVersion: 3 },
      { edgeId: 'bc', edgeVersion: 1 },
      { edgeId: 'cd', edgeVersion: 2 },
    ],
    totalCost: 6,
  };
  const result = verifyPath(graph, cert);
  assert.ok(result.ok);
  assert.equal(result.value.end, 'd');
  assert.equal(result.value.cost, 6);
});

test('repeated nodes rejected by default, allowed when configured', () => {
  // a -> b -> c -> d -> b repeats b
  const cert = pathCertificateFromEdges(graph, 'a', ['ab', 'bc', 'cd', 'db']);
  const rejected = verifyPath(graph, cert);
  assert.ok(!rejected.ok);
  assert.equal(rejected.code, 'repeated-node');
  assert.equal(rejected.position, 3);

  const allowed = verifyPath(graph, cert, { allowRepeatedNodes: true });
  assert.ok(allowed.ok);
  assert.equal(allowed.value.end, 'b');
});

test('wrong edge version is rejected at the right position', () => {
  const cert = pathCertificateFromEdges(graph, 'a', ['ab', 'bc', 'cd']);
  cert.steps[1].edgeVersion = 99;
  const result = verifyPath(graph, cert);
  assert.ok(!result.ok);
  assert.equal(result.code, 'version-mismatch');
  assert.equal(result.position, 1);
});

test('edge that does not continue the walk is rejected', () => {
  const cert = pathCertificateFromEdges(graph, 'a', ['ab', 'cd']);
  const result = verifyPath(graph, cert);
  assert.ok(!result.ok);
  assert.equal(result.code, 'not-a-path');
  assert.equal(result.position, 1);
});

test('unknown edge id is rejected', () => {
  const cert = pathCertificateFromEdges(graph, 'a', ['ab']);
  cert.steps[0].edgeId = 'nope';
  const result = verifyPath(graph, cert);
  assert.ok(!result.ok);
  assert.equal(result.code, 'unknown-edge');
  assert.equal(result.position, 0);
});

test('wrong totalCost is rejected', () => {
  const cert = pathCertificateFromEdges(graph, 'a', ['ab', 'bc']);
  cert.totalCost += 1;
  const result = verifyPath(graph, cert);
  assert.ok(!result.ok);
  assert.equal(result.code, 'cost-mismatch');
});

test('unknown start node is rejected', () => {
  const cert = pathCertificateFromEdges(graph, 'a', ['ab']);
  cert.start = 'zzz';
  const result = verifyPath(graph, cert);
  assert.ok(!result.ok);
  assert.equal(result.code, 'unknown-node');
});

test('error reports the first failing position', () => {
  const cert = pathCertificateFromEdges(graph, 'a', ['ab', 'bc', 'cd']);
  cert.steps[1].edgeVersion = 42; // bad
  cert.steps[2].edgeId = 'gone'; // also bad, but later
  const result = verifyPath(graph, cert);
  assert.ok(!result.ok);
  assert.equal(result.code, 'version-mismatch');
  assert.equal(result.position, 1);
});

test('every single-field corruption of a valid certificate is rejected', () => {
  const good = pathCertificateFromEdges(graph, 'a', ['ab', 'bc', 'cd']);
  assert.ok(verifyPath(graph, good).ok, 'precondition: base certificate is valid');

  const corruptions: [string, (cert: PathCertificate) => void][] = [
    ['start', (cert) => { cert.start = 'd'; }],
    ['totalCost', (cert) => { cert.totalCost += 1; }],
    ...good.steps.flatMap((_, i): [string, (cert: PathCertificate) => void][] => [
      [`steps[${i}].edgeId`, (cert) => { cert.steps[i].edgeId = 'missing'; }],
      [`steps[${i}].edgeVersion`, (cert) => { cert.steps[i].edgeVersion += 100; }],
    ]),
  ];

  for (const [field, corrupt] of corruptions) {
    const mutated = structuredClone(good);
    corrupt(mutated);
    const result = verifyPath(graph, mutated);
    assert.ok(!result.ok, `corrupting ${field} must be rejected, got: ${JSON.stringify(result)}`);
  }
});
