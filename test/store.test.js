import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MaintenanceStore, StoreError } from '../src/store.js';
import { solveSelection } from '../src/solver.js';
import { parseRational } from '../src/rational.js';

const batchA = [
  { id: 'a', priority: '2', cost: ['1/2', '1'], duration: ['0', '1'] },
  { id: 'b', priority: '3', cost: ['0', '1'], duration: ['0', '1'], requires: ['a'] },
];

function solve(store, budget = '2', limit = '2') {
  return solveSelection(store.tasks, parseRational(budget), parseRational(limit));
}

test('acceptance 3: cyclic dependency rolls back the whole batch, prior plan unchanged', () => {
  const store = new MaintenanceStore();
  store.importBatch(batchA);
  const before = solve(store);
  assert.deepEqual(before.selected, ['a', 'b']);
  const snapshotBefore = store.snapshot();

  assert.throws(
    () =>
      store.importBatch([
        { id: 'c', priority: '1', cost: ['0', '1'], duration: ['0', '1'], requires: ['d'] },
        { id: 'd', priority: '1', cost: ['0', '1'], duration: ['0', '1'], requires: ['c'] },
      ]),
    (e) => e instanceof StoreError && e.code === 'E_CYCLE',
  );

  assert.deepEqual(store.snapshot(), snapshotBefore);
  const after = solve(store);
  assert.deepEqual(after.selected, before.selected);
  assert.equal(after.prioritySum, before.prioritySum);
});

test('cycle spanning existing and new tasks is rejected', () => {
  const store = new MaintenanceStore();
  store.importBatch([{ id: 'x', priority: '1', cost: ['0', '1'], duration: ['0', '1'] }]);
  assert.throws(
    () =>
      store.importBatch([
        { id: 'y', priority: '1', cost: ['0', '1'], duration: ['0', '1'], requires: ['z'] },
        { id: 'z', priority: '1', cost: ['0', '1'], duration: ['0', '1'], requires: ['y'] },
      ]),
    (e) => e.code === 'E_CYCLE',
  );
  assert.equal(store.tasks.size, 1);
});

test('invalid interval cl>ch rolls back the whole batch atomically', () => {
  const store = new MaintenanceStore();
  assert.throws(
    () =>
      store.importBatch([
        { id: 'ok', priority: '1', cost: ['0', '1'], duration: ['0', '1'] },
        { id: 'bad', priority: '1', cost: ['2', '1'], duration: ['0', '1'] },
      ]),
    (e) => e.code === 'E_INTERVAL',
  );
  assert.equal(store.tasks.size, 0);
  assert.equal(store.history.length, 0);
});

test('duplicate id (within batch or against committed tasks) rolls back', () => {
  const store = new MaintenanceStore();
  store.importBatch(batchA);
  assert.throws(
    () => store.importBatch([{ id: 'a', priority: '1', cost: ['0', '1'], duration: ['0', '1'] }]),
    (e) => e.code === 'E_DUPLICATE',
  );
  assert.throws(
    () =>
      store.importBatch([
        { id: 'q', priority: '1', cost: ['0', '1'], duration: ['0', '1'] },
        { id: 'q', priority: '2', cost: ['0', '1'], duration: ['0', '1'] },
      ]),
    (e) => e.code === 'E_DUPLICATE',
  );
  assert.equal(store.tasks.size, 2);
});

test('invalid fraction in a task yields E_RATIONAL and rolls back', () => {
  const store = new MaintenanceStore();
  assert.throws(
    () => store.importBatch([{ id: 'r', priority: 'abc', cost: ['0', '1'], duration: ['0', '1'] }]),
    (e) => e.code === 'E_RATIONAL',
  );
  assert.equal(store.tasks.size, 0);
});

test('acceptance 4: undoing an import restores the empty state, redo reapplies it', () => {
  const store = new MaintenanceStore();
  assert.deepEqual(store.undo(), { ok: false, error: 'E_NOTHING_TO_UNDO' });
  store.importBatch(batchA);
  store.importBatch([{ id: 'c', priority: '1', cost: ['0', '1/2'], duration: ['0', '0'] }]);

  assert.equal(store.undo().ok, true);
  assert.deepEqual([...store.tasks.keys()], ['a', 'b']);
  assert.equal(store.undo().ok, true);

  assert.equal(store.tasks.size, 0);
  const snap = store.snapshot();
  assert.deepEqual(snap.tasks, []);
  assert.equal(snap.canUndo, false);
  assert.equal(snap.canRedo, true);
  const empty = solve(store, '0', '0');
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.selected, []);
  assert.equal(empty.prioritySum, '0');
  assert.deepEqual(empty.costInterval, ['0', '0']);
  assert.deepEqual(empty.durationInterval, ['0', '0']);

  assert.equal(store.redo().ok, true);
  assert.deepEqual([...store.tasks.keys()], ['a', 'b']);
  assert.equal(store.redo().ok, true);
  assert.deepEqual([...store.tasks.keys()], ['a', 'b', 'c']);
  assert.deepEqual(store.redo(), { ok: false, error: 'E_NOTHING_TO_REDO' });
});

test('a new import clears the redo stack', () => {
  const store = new MaintenanceStore();
  store.importBatch(batchA);
  store.undo();
  store.importBatch([{ id: 'z', priority: '1', cost: ['0', '1'], duration: ['0', '1'] }]);
  assert.deepEqual(store.redo(), { ok: false, error: 'E_NOTHING_TO_REDO' });
  assert.deepEqual([...store.tasks.keys()], ['z']);
});
