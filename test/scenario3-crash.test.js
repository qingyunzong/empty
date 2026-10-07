import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, CrashInjected } from '../src/store.js';
import { referenceWindows } from '../src/reference.js';
import { tmpdir, stripVersion } from '../test-support/helpers.js';

// Scenario 3: the two fixed crash points.
//   - crash after append, before index -> restart replays the log, batch applied once
//   - crash before append -> the batch has no effect at all
// Each Store.open(dir) simulates a fresh process start (log replay included).
test('scenario3: both crash types keep query results consistent', () => {
  const dir = tmpdir('scenario3-');
  const batchA = [
    { id: 'a1', device: 'd1', ts: 10000, state: 'up' },
    { id: 'a2', device: 'd1', ts: 13000, state: 'down' },
  ];
  const batchB = [
    { id: 'b1', device: 'd1', ts: 16000, state: 'up' },
    { id: 'b2', device: 'd1', ts: 11000, state: 'down' }, // late event
  ];
  const batchC = [{ id: 'c1', device: 'd1', ts: 20000, state: 'down' }];

  // Normal append of batch A.
  let store = Store.open(dir);
  store.appendBatch(batchA);

  // Crash after append, before index: batch B reaches the log only.
  store = Store.open(dir);
  assert.throws(
    () => store.appendBatch(batchB, { crash: 'after-append' }),
    (err) => err instanceof CrashInjected && err.point === 'after-append',
  );
  // Log has the batch, index does not: exactly the fixed crash point.
  const logLines = fs.readFileSync(path.join(dir, 'events.log'), 'utf8').trim().split('\n');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(logLines.length, 4, 'batch B is durable in the log');
  assert.equal(index.offset, 2, 'index stopped before batch B');

  // Restart replays the unindexed tail: batch B applied exactly once.
  store = Store.open(dir);
  const referenceAB = referenceWindows([...batchA, ...batchB], 'd1', 9000, 21600);
  const rowsAfterReplay = store.query('d1', 9000, 21600);
  assert.deepEqual(rowsAfterReplay.map(stripVersion), referenceAB, 'replay matches reference');
  assert.equal(store.events.length, 4, 'no event applied twice');

  // A second restart is idempotent (index now covers the whole log).
  store = Store.open(dir);
  assert.deepEqual(store.query('d1', 9000, 21600), rowsAfterReplay);

  // Crash before append: batch C leaves no trace whatsoever.
  assert.throws(
    () => store.appendBatch(batchC, { crash: 'before-append' }),
    (err) => err instanceof CrashInjected && err.point === 'before-append',
  );
  store = Store.open(dir);
  assert.deepEqual(store.query('d1', 9000, 21600), rowsAfterReplay, 'batch C had no effect');
  assert.equal(store.events.length, 4);

  // Compaction folds the log into the snapshot; queries stay identical.
  store.compact();
  assert.equal(fs.readFileSync(path.join(dir, 'events.log'), 'utf8'), '');
  store = Store.open(dir);
  assert.deepEqual(store.query('d1', 9000, 21600), rowsAfterReplay, 'compact preserves results');
});
