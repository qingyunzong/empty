import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './helpers.js';

const THRESHOLD = 0.05;

function buildChain(store) {
  // R -(consume 60/100)-> W -(split 0.5)-> F1 -> IT1 -> CO1
  //                       \-(split 0.5)-> F2 -> IT2 -> CO2
  // plus an unrelated branch R2 -> W2 to prove incrementality is scoped.
  store.addLot({ id: 'R', kind: 'raw', qty: 100, failed: true });
  store.addLot({ id: 'W', kind: 'wip', qty: 100 });
  store.addLot({ id: 'F1', kind: 'finished', qty: 50 });
  store.addLot({ id: 'F2', kind: 'finished', qty: 50 });
  store.addLot({ id: 'IT1', kind: 'in_transit', qty: 50 });
  store.addLot({ id: 'IT2', kind: 'in_transit', qty: 50 });
  store.addLot({ id: 'CO1', kind: 'customer_order', qty: 50 });
  store.addLot({ id: 'CO2', kind: 'customer_order', qty: 50 });
  store.addLot({ id: 'R2', kind: 'raw', qty: 100 });
  store.addLot({ id: 'W2', kind: 'wip', qty: 100 });
  store.addEdge({ id: 'E0', from: 'R', to: 'W', kind: 'consume', qty: 60 });
  store.addEdge({ id: 'E1', from: 'W', to: 'F1', kind: 'split', qty: 50 });
  store.addEdge({ id: 'E2', from: 'W', to: 'F2', kind: 'split', qty: 50 });
  store.addEdge({ id: 'E3', from: 'F1', to: 'IT1', kind: 'consume', qty: 50 });
  store.addEdge({ id: 'E4', from: 'IT1', to: 'CO1', kind: 'consume', qty: 50 });
  store.addEdge({ id: 'E5', from: 'F2', to: 'IT2', kind: 'consume', qty: 50 });
  store.addEdge({ id: 'E6', from: 'IT2', to: 'CO2', kind: 'consume', qty: 50 });
  store.addEdge({ id: 'E7', from: 'R2', to: 'W2', kind: 'consume', qty: 40 });
}

// Acceptance 3: correcting a split ratio recomputes incrementally, matches
// a full recompute exactly, and undo restores the previous answer.
test('correct split ratio: incremental == full recompute, undo restores', () => {
  const store = openStore();
  buildChain(store);

  const before = store.impact('R', THRESHOLD); // populates the cache
  assert.deepEqual(before.groups.finished, ['F1', 'F2']);
  assert.deepEqual(before.groups.customer_order, ['CO1', 'CO2']);

  // Lab correction: the W->F1 split was actually 5kg, not 50kg.
  // p(F1) drops from 0.3 to 0.6*0.05 = 0.03 < threshold -> F1 branch drops out.
  store.stats.recomputed = 0;
  store.correct('E1', { qty: 5 });

  assert.ok(store.stats.recomputed > 0, 'incremental recompute did run');
  assert.ok(
    store.stats.recomputed < store.graph.lots.size,
    `recomputed ${store.stats.recomputed} nodes, expected fewer than the whole graph`,
  );

  const after = store.impact('R', THRESHOLD); // served from incrementally maintained cache
  const full = store.impactFull('R', THRESHOLD); // ground truth: whole-graph recompute
  assert.deepEqual(after, full, 'incremental result differs from full recompute');
  assert.deepEqual(after.groups.finished, ['F2']);
  assert.deepEqual(after.groups.customer_order, ['CO2']);
  assert.equal(after.minimal, true);

  // Conservation still enforced after the correction.
  assert.equal(store.snapshot().conservation.ok, true);

  // undo restores the pre-correction impact set
  assert.equal(store.undo().undone, true);
  const restored = store.impact('R', THRESHOLD);
  assert.deepEqual(restored, before);
  assert.equal(store.graph.edges.get('E1').qty, 50);

  // redo re-applies the correction
  assert.equal(store.redo().redone, true);
  assert.deepEqual(store.impact('R', THRESHOLD), after);
  assert.equal(store.graph.edges.get('E1').qty, 5);
});

test('split conservation rejects ratios summing above 1', () => {
  const store = openStore();
  store.addLot({ id: 'W', kind: 'wip', qty: 100 });
  store.addLot({ id: 'A', kind: 'finished', qty: 60 });
  store.addLot({ id: 'B', kind: 'finished', qty: 60 });
  store.addEdge({ id: 'E1', from: 'W', to: 'A', kind: 'split', qty: 60 });
  assert.throws(
    () => store.addEdge({ id: 'E2', from: 'W', to: 'B', kind: 'split', qty: 60 }),
    (err) => err.code === 'ERR_CONSERVATION',
  );
  assert.throws(
    () => store.correct('E1', { qty: 101 }),
    (err) => err.code === 'ERR_CONSERVATION',
  );
  assert.equal(store.graph.edges.get('E1').qty, 60, 'failed correction must not modify the edge');
});

test('merge conservation enforced', () => {
  const store = openStore();
  store.addLot({ id: 'A', kind: 'raw', qty: 40 });
  store.addLot({ id: 'B', kind: 'raw', qty: 60 });
  store.addLot({ id: 'M', kind: 'wip', qty: 100 });
  store.addEdge({ id: 'E1', from: 'A', to: 'M', kind: 'merge', qty: 40 });
  store.addEdge({ id: 'E2', from: 'B', to: 'M', kind: 'merge', qty: 60 });
  const c = store.snapshot().conservation;
  assert.equal(c.ok, true, JSON.stringify(c.violations));
});
