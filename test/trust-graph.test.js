import test from 'node:test';
import assert from 'node:assert/strict';
import { TrustGraph, TrustGraphError, verifySccCertificate } from '../src/trust-graph.js';

test('duplicate edge is rejected', () => {
  const graph = new TrustGraph();
  graph.addEdge(1, 2);
  assert.throws(() => graph.addEdge(1, 2), (err) => err instanceof TrustGraphError && err.code === 'DUPLICATE_EDGE');
});

test('negative and non-integer ids are rejected', () => {
  const graph = new TrustGraph();
  assert.throws(() => graph.addEdge(-1, 2), (err) => err.code === 'NEGATIVE_ID');
  assert.throws(() => graph.addEdge(1, -2), (err) => err.code === 'NEGATIVE_ID');
  assert.throws(() => graph.addEdge(1.5, 2), (err) => err.code === 'INVALID_ID');
  assert.throws(() => graph.addEdge('1', 2), (err) => err.code === 'INVALID_ID');
  assert.throws(() => graph.rollback(-3), (err) => err.code === 'NEGATIVE_ID');
});

test('removing or correcting a missing edge is rejected', () => {
  const graph = new TrustGraph();
  assert.throws(() => graph.removeEdge(1, 2), (err) => err.code === 'EDGE_NOT_FOUND');
  assert.throws(() => graph.correctDirection(1, 2), (err) => err.code === 'EDGE_NOT_FOUND');
});

test('correct-direction rejects an existing reverse edge', () => {
  const graph = new TrustGraph();
  graph.addEdge(1, 2);
  graph.addEdge(2, 1);
  assert.throws(() => graph.correctDirection(1, 2), (err) => err.code === 'DUPLICATE_EDGE');
});

test('snapshot returns sequential ids and a stable hash', () => {
  const graph = new TrustGraph();
  graph.addEdge(0, 1);
  const first = graph.snapshot();
  const second = graph.snapshot();
  assert.equal(first.snapshotId, 1);
  assert.equal(second.snapshotId, 2);
  assert.equal(first.hash, second.hash);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
});

test('rollback to a future snapshot id is rejected', () => {
  const graph = new TrustGraph();
  graph.snapshot();
  assert.throws(() => graph.rollback(2), (err) => err.code === 'FUTURE_SNAPSHOT');
  assert.throws(() => graph.rollback(99), (err) => err.code === 'FUTURE_SNAPSHOT');
});

test('rollback invalidates later snapshots; they become unknown', () => {
  const graph = new TrustGraph();
  graph.addEdge(0, 1);
  const first = graph.snapshot();
  graph.addEdge(1, 2);
  const second = graph.snapshot();
  graph.rollback(first.snapshotId);
  assert.throws(() => graph.rollback(second.snapshotId), (err) => err.code === 'UNKNOWN_SNAPSHOT');
  // Rolling back to the still-valid snapshot again is a no-op and stays valid.
  const again = graph.rollback(first.snapshotId);
  assert.equal(again.hash, first.hash);
});

test('rollback never resurrects events deleted before the snapshot', () => {
  const graph = new TrustGraph();
  graph.addEdge(0, 1);
  graph.addEdge(1, 2);
  const first = graph.snapshot();
  // These events are discarded by the rollback below.
  graph.addEdge(2, 3);
  graph.addEdge(3, 0);
  graph.rollback(first.snapshotId);
  // New history after the rollback point.
  graph.addEdge(5, 6);
  const second = graph.snapshot();
  graph.addEdge(6, 5);
  // Rolling back to the second snapshot must not resurrect edges 2->3 / 3->0.
  graph.rollback(second.snapshotId);
  assert.deepEqual(graph.edges(), [[0, 1], [1, 2], [5, 6]]);
  assert.equal(graph.stateHash(), second.hash);
});

test('query certificates verify against the current edge set', () => {
  const graph = new TrustGraph();
  const edges = [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 3], [4, 5]];
  for (const [from, to] of edges) graph.addEdge(from, to);
  const { sccs, topologicalOrder, certificates } = graph.query();
  assert.deepEqual(sccs.map((s) => s.members), [[0, 1, 2], [3, 4], [5]]);
  assert.deepEqual(topologicalOrder, [0, 1, 2]);
  assert.equal(certificates.length, sccs.length);
  for (const certificate of certificates) {
    assert.ok(verifySccCertificate(graph.edges(), certificate), `certificate for scc ${certificate.sccId}`);
  }
  // Tampering with a certificate must be detected.
  const tampered = { ...certificates[0], members: [...certificates[0].members, 9] };
  assert.equal(verifySccCertificate(graph.edges(), tampered), false);
});

test('topological order respects the component DAG direction', () => {
  const graph = new TrustGraph();
  // Two zones: {0,1} and {2,3}; cross-zone edge 1->2 means {0,1} precedes {2,3}.
  for (const [from, to] of [[0, 1], [1, 0], [1, 2], [2, 3], [3, 2]]) graph.addEdge(from, to);
  const { sccs, topologicalOrder } = graph.query();
  assert.deepEqual(sccs.map((s) => s.members), [[0, 1], [2, 3]]);
  assert.deepEqual(topologicalOrder, [0, 1]);
});
