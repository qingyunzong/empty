import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './helpers.js';

// Acceptance 2: a cycle-closing edge is rejected with ERR_CYCLE and must
// not pollute graph state, undo history, or the WAL.
test('cycle edge reports ERR_CYCLE and leaves state untouched', () => {
  const store = openStore();
  store.addLot({ id: 'A', kind: 'raw', qty: 100 });
  store.addLot({ id: 'B', kind: 'wip', qty: 100 });
  store.addLot({ id: 'C', kind: 'finished', qty: 100 });
  store.addEdge({ id: 'E1', from: 'A', to: 'B', kind: 'consume', qty: 50 });
  store.addEdge({ id: 'E2', from: 'B', to: 'C', kind: 'consume', qty: 50 });

  const before = store.snapshot();
  const walLen = store.wal.records.length;
  const undoDepth = store.undoStack.length;

  assert.throws(
    () => store.addEdge({ id: 'E3', from: 'C', to: 'A', kind: 'rework', qty: 10 }),
    (err) => err.code === 'ERR_CYCLE',
  );
  // self-loop is also a cycle
  assert.throws(
    () => store.addEdge({ id: 'E4', from: 'A', to: 'A', kind: 'rework', qty: 10 }),
    (err) => err.code === 'ERR_CYCLE',
  );

  assert.deepEqual(store.snapshot(), before, 'graph state polluted by rejected edge');
  assert.equal(store.wal.records.length, walLen, 'WAL polluted by rejected edge');
  assert.equal(store.undoStack.length, undoDepth, 'undo stack polluted by rejected edge');

  // undo still operates on the last good transaction (E2), proving the
  // rejected edge left no phantom history entry.
  const u = store.undo();
  assert.equal(u.undone, true);
  assert.equal(store.snapshot().edges.length, 1);
  const r = store.redo();
  assert.equal(r.redone, true);
  assert.equal(store.snapshot().edges.length, 2);
});
