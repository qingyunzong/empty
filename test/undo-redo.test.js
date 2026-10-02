import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-undo-'));
}

test('commit -> undo -> redo restores the exact post-commit state', () => {
  const store = new Store(tmpdir());
  const t1 = store.begin();
  t1.set('temp', 20.5);
  t1.set('humidity', 61);
  t1.commit();
  const t2 = store.begin();
  t2.set('temp', 21.1);
  t2.set('wind', 3.4);
  t2.del('humidity');
  t2.commit();

  const afterCommit = store.snapshot();
  assert.deepEqual(afterCommit, { temp: 21.1, wind: 3.4 });

  store.undo();
  assert.deepEqual(store.snapshot(), { temp: 20.5, humidity: 61 });

  store.redo();
  assert.deepEqual(store.snapshot(), afterCommit);
  store.close();
});

test('undo with empty undo stack returns NOTHING_TO_UNDO', () => {
  const store = new Store(tmpdir());
  assert.throws(() => store.undo(), (err) => err.code === 'NOTHING_TO_UNDO');
  assert.throws(() => store.redo(), (err) => err.code === 'NOTHING_TO_REDO');
  store.close();
});

test('undo conflicting with later writes returns CONFLICT and does not execute', () => {
  const store = new Store(tmpdir());
  const t1 = store.begin();
  t1.set('a', 1);
  t1.commit();
  const t2 = store.begin();
  t2.set('a', 2);
  t2.commit();

  const before = store.snapshot();
  assert.throws(() => store.undo(t1.id), (err) => err.code === 'CONFLICT');
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(store.undoStack, [t1.id, t2.id]);

  store.undo();
  store.undo();
  assert.deepEqual(store.snapshot(), {});
  store.close();
});

test('undo/redo history survives reopen (crash recovery)', () => {
  const dir = tmpdir();
  let store = new Store(dir);
  const t1 = store.begin();
  t1.set('a', 1);
  t1.commit();
  const t2 = store.begin();
  t2.set('b', 2);
  t2.commit();
  store.undo();
  store.close();

  store = new Store(dir);
  assert.deepEqual(store.snapshot(), { a: 1 });
  assert.deepEqual(store.undoStack, [t1.id]);
  assert.deepEqual(store.redoStack, [t2.id]);
  store.redo();
  assert.deepEqual(store.snapshot(), { a: 1, b: 2 });
  store.undo(t1.id);
  assert.deepEqual(store.snapshot(), { b: 2 });
  store.close();
});

test('a new committed write clears the redo stack', () => {
  const store = new Store(tmpdir());
  const t1 = store.begin();
  t1.set('a', 1);
  t1.commit();
  store.undo();
  const t2 = store.begin();
  t2.set('b', 2);
  t2.commit();
  assert.throws(() => store.redo(), (err) => err.code === 'NOTHING_TO_REDO');
  store.close();
});
