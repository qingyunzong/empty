import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { ERR } from '../src/errors.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'txstore-'));
}

const CERT = { batch: 1, rootId: 'R', terms: ['foo', 'bar'], slop: 0, budget: 10, totalAmount: 5, nodeCount: 1, nodes: [] };

test('commit then load round-trips the batch', () => {
  const store = new StateStore(tmpDir());
  store.commit(1, { undone: ['B', 'A'], certificate: CERT });
  const state = store.load();
  assert.equal(state.batch, 1);
  assert.deepEqual(state.undone, ['A', 'B']);
  assert.deepEqual(state.certificates, [CERT]);
});

test('missing COMMIT marker: batch file is treated as never undone', () => {
  const dir = tmpDir();
  const store = new StateStore(dir);
  store.commit(1, { undone: ['A'], certificate: CERT });
  // Simulate a crash after the batch file but before the marker landed.
  fs.rmSync(path.join(dir, 'COMMIT'));
  assert.deepEqual(store.load(), { batch: 0, undone: [], certificates: [] });
});

test('stale COMMIT marker pointing past existing batches is corrupt', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'COMMIT'), '3\n');
  assert.throws(() => new StateStore(dir).load(), (err) => err.code === ERR.CORRUPT_STATE);
});

test('leftover tmp files from a crashed write are ignored', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'batches'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'batches', `1.json.tmp-${process.pid}`), '{"partial":');
  fs.writeFileSync(path.join(dir, `COMMIT.tmp-${process.pid}`), '1\n');
  assert.deepEqual(new StateStore(dir).load(), { batch: 0, undone: [], certificates: [] });
});

test('sequential commits accumulate undo history across batches', () => {
  const store = new StateStore(tmpDir());
  store.commit(1, { undone: ['A'], certificate: { ...CERT, batch: 1 } });
  store.commit(2, { undone: ['A', 'D'], certificate: { ...CERT, batch: 2 } });
  const state = store.load();
  assert.equal(state.batch, 2);
  assert.deepEqual(state.undone, ['A', 'A', 'D']);
  assert.equal(state.certificates.length, 2);
});
