// Acceptance 3: undo restores the exact pre-add state (genealogy edges and
// propagation conclusions removed together); redo reproduces the result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModel } from '../src/model.js';
import { TraceStore } from '../src/store.js';
import { runTrace } from '../src/trace.js';

const INPUT = {
  batches: [
    { id: 'M1', kind: 'material', quantity: 40, expiry: '2026-06-01' },
    { id: 'M2', kind: 'material', quantity: 30, expiry: '2026-05-01' },
    { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-03', outputQty: 45, loss: 5, expiry: '2026-04-01', candidates: ['M1', 'M2'] },
  ],
};

const EMPTY_STATE = { batches: {}, edges: [], derived: {} };

test('undo/redo restores exact store states across both transactions', () => {
  const model = parseModel(INPUT);
  const { store, result } = runTrace(model);
  assert.equal(result.status, 'feasible');

  const afterSolve = structuredClone(store.state);
  assert.ok(afterSolve.edges.length > 0, 'solve must add genealogy edges');
  assert.ok(afterSolve.derived.propagation, 'solve must add propagation conclusions');

  // Undo the solve transaction: edges and derived conclusions vanish
  // together, batches remain.
  assert.equal(store.undo(), 'solve');
  const afterLoad = structuredClone(store.state);
  assert.deepEqual(afterLoad.edges, []);
  assert.deepEqual(afterLoad.derived, {});
  assert.deepEqual(Object.keys(afterLoad.batches).sort(), ['M1', 'M2', 'P1']);

  // Undo the load transaction: back to the empty pre-add state.
  assert.equal(store.undo(), 'load-input');
  assert.deepEqual(store.state, EMPTY_STATE);
  assert.equal(store.undo(), null, 'nothing left to undo');

  // Redo replays both transactions and reproduces identical state.
  assert.equal(store.redo(), 'load-input');
  assert.deepEqual(store.state, afterLoad);
  assert.equal(store.redo(), 'solve');
  assert.deepEqual(store.state, afterSolve);
  assert.equal(store.redo(), null, 'nothing left to redo');
});

test('a new transaction invalidates the redo stack', () => {
  const model = parseModel(INPUT);
  const { store } = runTrace(model);
  store.undo();
  store.begin('other');
  store.setDerived('marker', 1);
  store.commit();
  assert.equal(store.redo(), null);
});

test('store survives a JSON round-trip (CLI persistence format)', () => {
  const model = parseModel(INPUT);
  const { store } = runTrace(model);
  const revived = TraceStore.from(JSON.parse(JSON.stringify(store.toJSON())));
  assert.deepEqual(revived.state, store.state);
  assert.equal(revived.undo(), 'solve');
  assert.deepEqual(revived.state.edges, []);
  assert.equal(revived.redo(), 'solve');
  assert.deepEqual(revived.state, store.state);
});
