import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { tmpdir, mulberry32, Model, randomChange, stateToComparable } from '../testlib/helpers.js';

// Acceptance scenario 1: 2000 changes, replay --to 1234 matches the snapshot
// taken at that moment; replay agrees with the live path.
test('2000 changes: replay --to 1234 equals snapshot, replay equals live state', () => {
  const dir = tmpdir();
  const rand = mulberry32(42);
  const keys = Array.from({ length: 120 }, (_, i) => `sensor/${i}`);
  const devices = Array.from({ length: 8 }, (_, i) => `device-${i}`);
  const model = new Model();
  const store = Store.open(dir);

  for (let i = 0; i < 2000; i++) {
    const change = randomChange(rand, keys, devices);
    store.apply(change);
    model.apply(change);
    if (i + 1 === 1000) store.checkpoint(); // checkpoint mid-stream
  }
  assert.equal(store.lastTxn, 2000);

  const replayed1234 = store.replay(1234);
  assert.deepEqual(stateToComparable(replayed1234), stateToComparable(model.at(1234)));

  // Replay must agree with the live (incrementally maintained) state.
  assert.deepEqual(stateToComparable(store.replay(2000)), stateToComparable(store.state));
  assert.deepEqual(stateToComparable(store.state), stateToComparable(model.at(2000)));

  // Boundary targets.
  assert.deepEqual(stateToComparable(store.replay(0)), {});
  assert.deepEqual(stateToComparable(store.replay(1)), stateToComparable(model.at(1)));
  store.close();

  // Replay from a fresh process (checkpoints + WAL only) gives the same answer.
  const reopened = Store.open(dir);
  assert.deepEqual(stateToComparable(reopened.replay(1234)), stateToComparable(model.at(1234)));
  reopened.close();
});

test('replay to a nonexistent txn fails with NO_SUCH_TXN', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.apply({ key: 'a', op: 'set', deviceId: 'd0', value: 1 });
  assert.throws(() => store.replay(2), (err) => {
    assert.equal(err.code, 'NO_SUCH_TXN');
    assert.equal(err.details.requested, 2);
    assert.equal(err.details.lastTxn, 1);
    return true;
  });
  store.close();
});

test('checkpoint snapshot equals replay at the checkpoint txn', () => {
  const dir = tmpdir();
  const rand = mulberry32(7);
  const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
  const devices = ['d0', 'd1'];
  const model = new Model();
  const store = Store.open(dir);
  for (let i = 0; i < 300; i++) {
    const change = randomChange(rand, keys, devices);
    store.apply(change);
    model.apply(change);
  }
  const snapshot = store.checkpoint();
  assert.equal(snapshot.txn, 300);
  const replayed = store.replay(300);
  assert.deepEqual(stateToComparable(new Map(snapshot.state)), stateToComparable(replayed));
  store.close();
});
