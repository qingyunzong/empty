import test from 'node:test';
import assert from 'node:assert/strict';
import { TrustGraph } from '../src/trust-graph.js';
import { enumerationScc } from '../src/scc-enumeration.js';

test('acceptance 1: a loop-closing edge merges multiple zones into one', () => {
  const graph = new TrustGraph();
  // Two separate cycles plus a one-way bridge: zones {0,1} and {2,3}.
  for (const [from, to] of [[0, 1], [1, 0], [1, 2], [2, 3], [3, 2]]) graph.addEdge(from, to);
  let { sccs, topologicalOrder } = graph.query();
  assert.deepEqual(sccs.map((s) => s.members), [[0, 1], [2, 3]]);
  assert.deepEqual(topologicalOrder, [0, 1]);
  // Closing the loop merges both zones into a single reconciliation zone.
  graph.addEdge(3, 0);
  ({ sccs, topologicalOrder } = graph.query());
  assert.deepEqual(sccs.map((s) => s.members), [[0, 1, 2, 3]]);
  assert.deepEqual(topologicalOrder, [0]);
  // Cross-checked against the independent enumeration implementation.
  assert.deepEqual(enumerationScc(graph.nodes(), graph.edges()), [[0, 1, 2, 3]]);
});

test('acceptance 2: direction correction splits a zone and updates topological order', () => {
  const graph = new TrustGraph();
  // One big cycle: a single zone containing every ledger.
  for (const [from, to] of [[0, 1], [1, 2], [2, 3], [3, 0]]) graph.addEdge(from, to);
  let result = graph.query();
  assert.deepEqual(result.sccs.map((s) => s.members), [[0, 1, 2, 3]]);
  // Flipping 3->0 into 0->3 breaks the cycle: four singleton zones remain,
  // ordered 0 -> 1 -> 2 -> 3 (with the extra shortcut 0 -> 3).
  graph.correctDirection(3, 0);
  result = graph.query();
  assert.deepEqual(result.sccs.map((s) => s.members), [[0], [1], [2], [3]]);
  assert.deepEqual(result.topologicalOrder, [0, 1, 2, 3]);
  assert.deepEqual(enumerationScc(graph.nodes(), graph.edges()), [[0], [1], [2], [3]]);
});

test('acceptance 3: rollback restores state and hash exactly', () => {
  const graph = new TrustGraph();
  for (const [from, to] of [[0, 1], [1, 2], [2, 0]]) graph.addEdge(from, to);
  const snap = graph.snapshot();
  const stateAtSnapshot = JSON.stringify(graph.query());
  const hashAtSnapshot = graph.stateHash();
  assert.equal(snap.hash, hashAtSnapshot);
  // Mutate heavily after the snapshot.
  graph.addEdge(2, 3);
  graph.addEdge(3, 4);
  graph.addEdge(4, 3);
  graph.correctDirection(2, 3);
  graph.removeEdge(1, 2);
  const beforeRollback = graph.stateHash();
  assert.notEqual(beforeRollback, hashAtSnapshot);
  const rolled = graph.rollback(snap.snapshotId);
  assert.equal(rolled.hash, hashAtSnapshot);
  assert.equal(graph.stateHash(), hashAtSnapshot);
  assert.equal(JSON.stringify(graph.query()), stateAtSnapshot);
  assert.deepEqual(graph.edges(), [[0, 1], [1, 2], [2, 0]]);
});
