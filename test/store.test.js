import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StoreError } from '../src/store.js';

const order = (wc, ts, extra = {}) => ({ workcenter: wc, timeSlot: ts, ...extra });

test('acceptance 1: concurrent writers on the same (workcenter, timeSlot) -> first commit wins, second gets E_UNIQUE', () => {
  const store = new Store();
  const t1 = store.begin();
  const t2 = store.begin();
  t1.put('wo-1', order('cnc-1', '2026-10-04T08:00'));
  t2.put('wo-2', order('cnc-1', '2026-10-04T08:00'));
  t1.commit();
  assert.throws(() => t2.commit(), (err) => err instanceof StoreError && err.code === 'E_UNIQUE');
  // Loser can abort cleanly; winner's data is intact.
  t2.abort();
  const reader = store.begin();
  assert.deepEqual(reader.get('wo-1'), order('cnc-1', '2026-10-04T08:00'));
  assert.equal(reader.get('wo-2'), undefined);
});

test('acceptance 1: different time slots commit concurrently without conflict', () => {
  const store = new Store();
  const t1 = store.begin();
  const t2 = store.begin();
  t1.put('wo-1', order('cnc-1', '08:00'));
  t2.put('wo-2', order('cnc-1', '09:00'));
  t1.commit();
  t2.commit();
  const reader = store.begin();
  assert.equal(reader.get('wo-1').timeSlot, '08:00');
  assert.equal(reader.get('wo-2').timeSlot, '09:00');
});

test('acceptance 1: different workcenters, same slot, commit concurrently', () => {
  const store = new Store();
  const t1 = store.begin();
  const t2 = store.begin();
  t1.put('wo-1', order('cnc-1', '08:00'));
  t2.put('wo-2', order('cnc-2', '08:00'));
  t1.commit();
  t2.commit();
});

test('acceptance 2: old snapshot still reads the work-order set from its begin after many commits', () => {
  const store = new Store();
  const setup = store.begin();
  setup.put('wo-1', order('cnc-1', '08:00'));
  setup.put('wo-2', order('cnc-2', '08:00'));
  setup.commit();

  const oldReader = store.begin(); // snapshot taken here
  for (let i = 0; i < 5; i += 1) {
    const tx = store.begin();
    tx.put(`wo-new-${i}`, order('cnc-3', `slot-${i}`));
    tx.put('wo-1', order('cnc-9', '99:00')); // overwrite an existing key too
    tx.commit();
  }

  assert.deepEqual(oldReader.get('wo-1'), order('cnc-1', '08:00'));
  assert.deepEqual(oldReader.get('wo-2'), order('cnc-2', '08:00'));
  assert.equal(oldReader.get('wo-new-0'), undefined);
  oldReader.abort();

  const fresh = store.begin();
  assert.deepEqual(fresh.get('wo-1'), order('cnc-9', '99:00'));
  assert.equal(fresh.get('wo-new-4').workcenter, 'cnc-3');
});

test('acceptance 2: an old snapshot cannot overwrite a newer version (E_SNAPSHOT)', () => {
  const store = new Store();
  const seed = store.begin();
  seed.put('wo-1', order('cnc-1', '08:00'));
  seed.commit();

  const stale = store.begin();
  const updater = store.begin();
  updater.put('wo-1', order('cnc-1', '09:00'));
  updater.commit();

  stale.put('wo-1', order('cnc-1', '10:00'));
  assert.throws(() => stale.commit(), (err) => err.code === 'E_SNAPSHOT');

  // Keys untouched by the other commit are still mergeable from the stale snapshot.
  const stale2 = store.begin();
  const updater2 = store.begin();
  updater2.put('wo-1', order('cnc-1', '11:00'));
  updater2.commit();
  stale2.put('wo-2', order('cnc-2', '11:00'));
  stale2.commit();
});

test('unique index is maintained across updates and deletes', () => {
  const store = new Store();
  const t1 = store.begin();
  t1.put('wo-1', order('cnc-1', '08:00'));
  t1.commit();

  // Moving wo-1 to another slot frees (cnc-1, 08:00).
  const t2 = store.begin();
  t2.put('wo-1', order('cnc-1', '09:00'));
  t2.commit();
  const t3 = store.begin();
  t3.put('wo-2', order('cnc-1', '08:00'));
  t3.commit();

  // Deleting wo-2 frees the slot again.
  const t4 = store.begin();
  t4.put('wo-2', null);
  t4.commit();
  const t5 = store.begin();
  t5.put('wo-3', order('cnc-1', '08:00'));
  t5.commit();

  // Two keys in one commit claiming the same slot conflict.
  const t6 = store.begin();
  t6.put('wo-4', order('cnc-5', '12:00'));
  t6.put('wo-5', order('cnc-5', '12:00'));
  assert.throws(() => t6.commit(), (err) => err.code === 'E_UNIQUE');

  // Atomic slot swap inside a single commit is allowed.
  const seed = store.begin();
  seed.put('a', order('w', 's1'));
  seed.put('b', order('w', 's2'));
  seed.commit();
  const swap = store.begin();
  swap.put('a', order('w', 's2'));
  swap.put('b', order('w', 's1'));
  swap.commit();
});

test('edge: empty key is a valid key', () => {
  const store = new Store();
  const tx = store.begin();
  tx.put('', order('cnc-1', '08:00'));
  tx.commit();
  const reader = store.begin();
  assert.deepEqual(reader.get(''), order('cnc-1', '08:00'));
  assert.equal(reader.get('missing'), undefined);
});

test('edge: zero-length work order (empty string value) round-trips and is not indexed', () => {
  const store = new Store();
  const tx = store.begin();
  tx.put('wo-empty', '');
  tx.put('wo-empty-2', '');
  tx.commit(); // two zero-length values must not trip the unique index
  const reader = store.begin();
  assert.equal(reader.get('wo-empty'), '');
  assert.equal(reader.get('wo-empty-2'), '');
});

test('edge: same-value repeated writes are idempotent and commit cleanly', () => {
  const store = new Store();
  const tx = store.begin();
  const value = order('cnc-1', '08:00');
  tx.put('wo-1', value);
  tx.put('wo-1', value);
  tx.put('wo-1', value);
  tx.commit();
  const tx2 = store.begin();
  tx2.put('wo-1', value); // overwrite committed value with an identical value
  tx2.commit();
  const reader = store.begin();
  assert.deepEqual(reader.get('wo-1'), value);
});

test('edge: empty-object work order is stored but not indexed', () => {
  const store = new Store();
  const tx = store.begin();
  tx.put('wo-1', {});
  tx.put('wo-2', {});
  tx.commit();
  assert.deepEqual(store.begin().get('wo-1'), {});
});

test('abort discards buffered writes', () => {
  const store = new Store();
  const tx = store.begin();
  tx.put('wo-1', order('cnc-1', '08:00'));
  tx.abort();
  assert.equal(store.begin().get('wo-1'), undefined);
  assert.equal(store.version, 0);
});

test('read-your-writes inside a transaction', () => {
  const store = new Store();
  const tx = store.begin();
  tx.put('k', { workcenter: 'w', timeSlot: 's', n: 1 });
  assert.deepEqual(tx.get('k'), { workcenter: 'w', timeSlot: 's', n: 1 });
  tx.put('k', null);
  assert.equal(tx.get('k'), undefined);
});

test('mutating a fetched value does not corrupt the store', () => {
  const store = new Store();
  const tx = store.begin();
  tx.put('k', order('w', 's'));
  tx.commit();
  const reader = store.begin();
  const value = reader.get('k');
  value.workcenter = 'hacked';
  assert.equal(store.begin().get('k').workcenter, 'w');
});
