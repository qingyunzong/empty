import assert from 'node:assert/strict';
import test from 'node:test';
import { TraceStore } from '../src/store.js';
import { solve } from '../src/solve.js';

const txn1 = {
  materials: [{ id: 'M1', quantity: 100, expiry: '2026-12-01' }],
  batches: [
    {
      id: 'P1',
      line: 'L1',
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-01T02:00:00Z',
      output: 10,
      loss: 2,
      expiry: '2026-06-01',
      candidates: ['M1'],
    },
  ],
};

const txn2 = {
  materials: [],
  batches: [
    {
      id: 'P2',
      line: 'L2',
      start: '2026-01-01T04:00:00Z',
      end: '2026-01-01T06:00:00Z',
      output: 5,
      loss: 0,
      expiry: '2026-06-01',
      candidates: ['P1'],
    },
  ],
};

// Acceptance 3: undo restores the exact pre-add state (facts and derived
// conclusions), redo reproduces the exact same solve result.
test('undo removes genealogy edges and propagation conclusions; redo restores them', () => {
  const store = new TraceStore();
  store.applyTransaction(structuredClone(txn1));
  const first = solve(store);
  assert.equal(first.status, 'feasible');
  const derivedAfterFirst = store.derived;
  assert.ok(derivedAfterFirst !== null);
  store.applyTransaction(structuredClone(txn2));
  const second = solve(store);
  assert.equal(second.status, 'feasible');
  assert.deepEqual(second.assignment.P2, { P1: 5 });
  assert.ok(store.derived !== derivedAfterFirst);
  // Undo: the edge P2 -> P1 and every conclusion derived from it disappear.
  store.undo();
  assert.equal(store.derived, null);
  assert.equal(store.batches.has('P2'), false);
  const backToFirst = solve(store);
  assert.deepEqual(backToFirst, first);
  // Redo: identical state and identical result.
  store.redo();
  assert.equal(store.derived, null);
  assert.equal(store.batches.has('P2'), true);
  const redone = solve(store);
  assert.deepEqual(redone, second);
});

test('undo/redo on empty stacks are no-ops', () => {
  const store = new TraceStore();
  assert.equal(store.undo(), null);
  assert.equal(store.redo(), null);
});

test('a new transaction clears the redo stack', () => {
  const store = new TraceStore();
  store.applyTransaction(structuredClone(txn1));
  store.undo();
  store.applyTransaction({ materials: [{ id: 'M9', quantity: 1, expiry: '2026-12-01' }], batches: [] });
  assert.equal(store.redo(), null);
});

test('store round-trips through JSON for CLI persistence', () => {
  const store = new TraceStore();
  store.applyTransaction(structuredClone(txn1));
  store.applyTransaction(structuredClone(txn2));
  store.undo();
  const revived = TraceStore.from(JSON.parse(JSON.stringify(store.toJSON())));
  assert.deepEqual(solve(revived), solve(store));
  revived.redo();
  store.redo();
  assert.deepEqual(solve(revived), solve(store));
});
