import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-crash-'));
}

class SimulatedCrash extends Error {}

test('crash after undo WAL data but before commit marker: undo fully absent after restart', () => {
  const dir = tmpdir();
  let store = new Store(dir);
  const t1 = store.begin();
  t1.set('a', 1);
  t1.set('b', 2);
  t1.commit();
  const before = store.snapshot();

  // Inject a crash at the exact point where the undo's data records are
  // fsynced but its commit marker is not yet written.
  store.hooks.beforeCommitMarker = () => {
    throw new SimulatedCrash('process died before commit marker');
  };
  assert.throws(() => store.undo(), SimulatedCrash);
  // Simulate process death: discard this instance without any cleanup.
  store = null;

  const recovered = new Store(dir);
  // The undo is completely absent: state and stacks look like it never ran.
  assert.deepEqual(recovered.snapshot(), before);
  assert.deepEqual(recovered.undoStack, [t1.id]);
  assert.deepEqual(recovered.redoStack, []);

  // The redo/undo chain still works afterwards.
  recovered.undo();
  assert.deepEqual(recovered.snapshot(), {});
  recovered.redo();
  assert.deepEqual(recovered.snapshot(), before);
  recovered.close();
});

test('crash after commit marker: undo fully applied after restart', () => {
  const dir = tmpdir();
  let store = new Store(dir);
  const t1 = store.begin();
  t1.set('a', 1);
  t1.commit();
  store.undo(); // commit marker written and fsynced
  const undoTxId = store.redoStack[0];
  store = null; // crash after completion

  const recovered = new Store(dir);
  assert.deepEqual(recovered.snapshot(), {});
  assert.deepEqual(recovered.undoStack, []);
  assert.deepEqual(recovered.redoStack, [t1.id]);
  recovered.redo();
  assert.deepEqual(recovered.snapshot(), { a: 1 });
  assert.equal(typeof undoTxId, 'number');
  recovered.close();
});

test('crash during a normal commit: transaction fully absent after restart', () => {
  const dir = tmpdir();
  let store = new Store(dir);
  const t1 = store.begin();
  t1.set('x', 1);
  t1.commit();
  store.hooks.beforeCommitMarker = () => {
    throw new SimulatedCrash();
  };
  const t2 = store.begin();
  t2.set('y', 2);
  assert.throws(() => t2.commit(), SimulatedCrash);
  store = null;

  const recovered = new Store(dir);
  assert.deepEqual(recovered.snapshot(), { x: 1 });
  assert.deepEqual(recovered.undoStack, [t1.id]);
  recovered.close();
});

test('torn last WAL line from a crash is tolerated on replay', () => {
  const dir = tmpdir();
  let store = new Store(dir);
  const t1 = store.begin();
  t1.set('a', 1);
  t1.commit();
  store.close();
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"type":"begin","tx":99,"ki');

  store = new Store(dir);
  assert.deepEqual(store.snapshot(), { a: 1 });
  assert.deepEqual(store.undoStack, [t1.id]);
  store.close();
});
