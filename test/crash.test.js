import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { scanWalBuffer } from '../src/wal.js';
import { InjectedCrashError } from '../src/errors.js';
import { tmpdir, mulberry32, Model, randomChange, stateToComparable } from '../testlib/helpers.js';

function walOffsets(dir) {
  const buf = fs.readFileSync(path.join(dir, 'wal.log'));
  return scanWalBuffer(buf).records.map((r) => r.offset);
}

// Acceptance scenario 3: truncate the log mid-way (torn write), restart.
// Everything before the cut replays; the tail is cleanly discarded on
// recovery; checkpointing and new applies continue afterwards.
test('mid-log truncation crash: recover, replay before cut, continue', () => {
  const dir = tmpdir();
  const rand = mulberry32(1234);
  const keys = Array.from({ length: 25 }, (_, i) => `p/${i}`);
  const devices = ['d0', 'd1', 'd2'];
  const model = new Model();
  let store = Store.open(dir);
  for (let i = 0; i < 100; i++) {
    const change = randomChange(rand, keys, devices);
    store.apply(change);
    model.apply(change);
  }
  store.close();

  // Simulate the crash: file is torn a few bytes into record #61 (txn 61).
  const offsets = walOffsets(dir);
  const cut = offsets[60] + 10;
  fs.truncateSync(path.join(dir, 'wal.log'), cut);

  // Read-only restart first: txns before the cut are fully replayable even
  // before recovery discards the tail.
  let reader = Store.open(dir);
  assert.equal(reader.lastTxn, 60);
  assert.deepEqual(stateToComparable(reader.replay(60)), stateToComparable(model.at(60)));
  assert.deepEqual(stateToComparable(reader.replay(37)), stateToComparable(model.at(37)));
  // Beyond the cut the txn does not exist (torn tail not yet discarded ->
  // the reader reports the corruption offset instead of guessing).
  assert.throws(() => reader.replay(61), (err) => {
    assert.equal(err.code, 'CHECKSUM_MISMATCH');
    assert.equal(err.details.offset, offsets[60]);
    return true;
  });
  // A writer must refuse to append on top of a torn log.
  assert.throws(() => reader.apply({ key: 'x', op: 'set', deviceId: 'd0', value: 1 }), /recover/);
  reader.close();

  // Restart with recovery: tail cleanly discarded.
  store = Store.open(dir, { recover: true });
  assert.equal(store.recovery.truncatedAt, offsets[60]);
  assert.equal(store.recovery.reason, 'truncated-payload');
  assert.equal(store.lastTxn, 60);
  assert.equal(fs.statSync(path.join(dir, 'wal.log')).size, offsets[60]);
  assert.throws(() => store.replay(61), (err) => err.code === 'NO_SUCH_TXN');

  // Checkpoint continues to work after recovery...
  model.truncateTo(60);
  const snapshot = store.checkpoint();
  assert.equal(snapshot.txn, 60);
  assert.deepEqual(stateToComparable(new Map(snapshot.state)), stateToComparable(model.at(60)));

  // ...and new changes continue the txn sequence from the truncation point.
  const change = { key: 'p/0', op: 'set', deviceId: 'd9', value: { reading: 1 } };
  const record = store.apply(change);
  assert.equal(record.txn, 61);
  model.apply(change);
  assert.deepEqual(stateToComparable(store.replay(61)), stateToComparable(model.at(61)));
  assert.equal(store.audit().ok, true);
  store.close();
});

test('checksum corruption mid-log: replay/audit report offset and stop', () => {
  const dir = tmpdir();
  const rand = mulberry32(5);
  const keys = ['a', 'b', 'c'];
  const devices = ['d0'];
  let store = Store.open(dir);
  for (let i = 0; i < 30; i++) {
    const change = randomChange(rand, keys, devices);
    store.apply(change);
  }
  store.close();

  const offsets = walOffsets(dir);
  const badOffset = offsets[15] + 10; // payload byte of record #16
  const fd = fs.openSync(path.join(dir, 'wal.log'), 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, badOffset);
  one[0] ^= 0xff;
  fs.writeSync(fd, one, 0, 1, badOffset);
  fs.closeSync(fd);

  const reader = Store.open(dir);
  assert.equal(reader.corruptOffset, offsets[15]);
  assert.throws(() => reader.replay(30), (err) => {
    assert.equal(err.code, 'CHECKSUM_MISMATCH');
    assert.equal(err.details.offset, offsets[15]);
    return true;
  });
  assert.throws(() => reader.audit(), (err) => {
    assert.equal(err.code, 'CHECKSUM_MISMATCH');
    assert.equal(err.details.offset, offsets[15]);
    return true;
  });
  // Targets at or before the last intact record still replay fine.
  assert.equal(reader.replay(15).size >= 0, true);
  reader.close();
});

test('fault injection after-write and after-fsync recover consistently', () => {
  for (const point of ['after-write', 'after-fsync']) {
    const dir = tmpdir();
    const model = new Model();
    let store = Store.open(dir);
    store.apply({ key: 'k1', op: 'set', deviceId: 'd0', value: 1 });
    model.apply({ key: 'k1', op: 'set', deviceId: 'd0', value: 1 });

    assert.throws(
      () => store.apply({ key: 'k2', op: 'set', deviceId: 'd1', value: 2 }, { inject: point }),
      (err) => err instanceof InjectedCrashError && err.point === point && err.txn === 2,
    );
    // Process "dies" here: discard the store without any cleanup.
    store.close();

    // Restart: the record reached the OS (writeSync), so recovery keeps it
    // and the log stays consistent.
    store = Store.open(dir, { recover: true });
    assert.equal(store.lastTxn, 2);
    model.apply({ key: 'k2', op: 'set', deviceId: 'd1', value: 2 });
    assert.deepEqual(stateToComparable(store.replay(2)), stateToComparable(model.at(2)));
    // Live path continues normally after the crash.
    store.apply({ key: 'k3', op: 'set', deviceId: 'd1', value: 3 });
    model.apply({ key: 'k3', op: 'set', deviceId: 'd1', value: 3 });
    assert.deepEqual(stateToComparable(store.replay(3)), stateToComparable(model.at(3)));
    assert.equal(store.audit().ok, true);
    store.close();
  }
});
