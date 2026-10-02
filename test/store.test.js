import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { ValidationError } from '../src/validate.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-store-'));

const ev = (id, equipment, valid_time, state, tx_id, tx_time) => ({
  id,
  equipment,
  valid_time,
  state,
  tx_id,
  tx_time,
});

const batch1 = {
  tx_id: 'tx1',
  tx_time: '2024-03-10T01:00:00Z',
  events: [ev('e1', 'pump-7', '2024-03-10T00:00:00Z', 'up', 'tx1', '2024-03-10T01:00:00Z')],
};

const batch2 = {
  tx_id: 'tx2',
  tx_time: '2024-03-15T09:00:00Z',
  events: [ev('e2', 'pump-7', '2024-03-10T00:00:00Z', 'down', 'tx2', '2024-03-15T09:00:00Z')],
};

test('committed state survives reopen', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.commit(batch1);
  store.commit(batch2);
  const hash = store.hash();

  const reopened = Store.open(dir);
  assert.equal(reopened.hash(), hash);
  assert.deepEqual(reopened.engine.countsSnapshot(), {
    'pump-7': { '2024-03-10': { up: 0, down: 1 } },
  });
  assert.equal(
    reopened.engine.asOf('pump-7', Date.parse('2024-03-10T00:00:00Z'), Date.parse('2024-03-10T02:00:00Z')),
    'up',
  );
});

test('crash after log append: restart replays the missing record', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.commit(batch1);

  // Simulate a crash after the log append but before the snapshot persist:
  // the record reaches events.log, the derived state never sees it.
  const orphan = {
    kind: 'batch',
    tx_id: batch2.tx_id,
    tx_time: batch2.tx_time,
    events: batch2.events,
  };
  store.appendLog(orphan);

  const recovered = Store.open(dir);
  assert.deepEqual(recovered.engine.countsSnapshot(), {
    'pump-7': { '2024-03-10': { up: 0, down: 1 } },
  });
  assert.equal(recovered.appliedSeq, 2);
  // Recovery result is itself persisted.
  const again = Store.open(dir);
  assert.equal(again.hash(), recovered.hash());
});

test('crash before log append: nothing happened', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.commit(batch1);
  const hashBefore = store.hash();
  const logBefore = fs.readFileSync(store.logPath, 'utf8');

  // A rejected batch never reaches the log (validation precedes append).
  const bad = {
    tx_id: 'tx-bad',
    tx_time: '2024-03-16T00:00:00Z',
    events: [ev('e3', 'pump-7', 'not-a-time', 'up', 'tx-bad', '2024-03-16T00:00:00Z')],
  };
  assert.throws(() => store.commit(bad), ValidationError);
  assert.equal(fs.readFileSync(store.logPath, 'utf8'), logBefore);
  assert.equal(store.hash(), hashBefore);

  const reopened = Store.open(dir);
  assert.equal(reopened.hash(), hashBefore);
});

test('invalid batch is atomic: counts and hash unchanged, no partial state', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.commit({
    tx_id: 'tx-ok',
    tx_time: '2024-06-03T00:00:00Z',
    events: [
      ev('e1', 'motor-1', '2024-06-01T00:00:00Z', 'up', 'tx-ok', '2024-06-03T00:00:00Z'),
      ev('e2', 'motor-1', '2024-06-02T00:00:00Z', 'down', 'tx-ok', '2024-06-03T00:00:00Z'),
    ],
  });
  const countsBefore = store.engine.countsSnapshot();
  const hashBefore = store.hash();

  const mixed = {
    tx_id: 'tx-mixed',
    tx_time: '2024-06-04T00:00:00Z',
    events: [
      ev('e3', 'motor-1', '2024-06-03T00:00:00Z', 'up', 'tx-mixed', '2024-06-04T00:00:00Z'), // valid
      ev('e4', 'motor-1', '2024-06-03T12:00:00Z', 'broken', 'tx-mixed', '2024-06-04T00:00:00Z'), // bad state
    ],
  };
  assert.throws(() => store.commit(mixed), ValidationError);
  assert.deepEqual(store.engine.countsSnapshot(), countsBefore);
  assert.equal(store.hash(), hashBefore);
  assert.equal(store.records.length, 1); // the valid event was not half-applied
});

test('undo maintains snapshot and deltas, and persists across reopen', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.commit(batch1);
  store.commit(batch2);
  const deltas = store.undo('tx2', { tx_time: '2024-03-20T00:00:00Z' });
  assert.deepEqual(deltas, [{ equipment: 'pump-7', date: '2024-03-10', up: 1, down: -1 }]);
  assert.deepEqual(store.engine.countsSnapshot(), {
    'pump-7': { '2024-03-10': { up: 1, down: 0 } },
  });

  const reopened = Store.open(dir);
  assert.deepEqual(reopened.engine.countsSnapshot(), {
    'pump-7': { '2024-03-10': { up: 1, down: 0 } },
  });
  assert.equal(reopened.hash(), store.hash());
  assert.throws(() => reopened.undo('tx2'), /already undone/);
});

test('duplicate tx_id is rejected before anything is written', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.commit(batch1);
  const hash = store.hash();
  assert.throws(() => store.commit(batch1), /duplicate tx_id/);
  assert.equal(store.hash(), hash);
});
