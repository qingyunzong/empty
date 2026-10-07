import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('acceptance 1: concurrent same workcenter/timeSlot -> first wins, second E_UNIQUE', () => {
  const store = new Store();
  const t1 = store.begin();
  const t2 = store.begin();
  store.put(t1, 'wo-1', { workcenter: 'wc1', timeSlot: 't1', qty: 10 });
  store.put(t2, 'wo-2', { workcenter: 'wc1', timeSlot: 't1', qty: 20 });
  store.commit(t1);
  assert.throws(() => store.commit(t2), (err) => err.code === 'E_UNIQUE');
  // Loser's data must not leak into committed state.
  const t3 = store.begin();
  assert.equal(store.get(t3, 'wo-2'), null);
  assert.deepEqual(store.get(t3, 'wo-1'), { workcenter: 'wc1', timeSlot: 't1', qty: 10 });
});

test('acceptance 1: concurrent different timeSlots both commit', () => {
  const store = new Store();
  const t1 = store.begin();
  const t2 = store.begin();
  store.put(t1, 'wo-1', { workcenter: 'wc1', timeSlot: 't1' });
  store.put(t2, 'wo-2', { workcenter: 'wc1', timeSlot: 't2' });
  store.commit(t1);
  store.commit(t2); // no conflict: disjoint keys and disjoint slots
  const t3 = store.begin();
  assert.deepEqual(store.get(t3, 'wo-1'), { workcenter: 'wc1', timeSlot: 't1' });
  assert.deepEqual(store.get(t3, 'wo-2'), { workcenter: 'wc1', timeSlot: 't2' });
});

test('acceptance 2: old snapshot keeps begin-time view after many commits', () => {
  const store = new Store();
  const seed = store.begin();
  store.put(seed, 'a', { workcenter: 'w1', timeSlot: 't1' });
  store.put(seed, 'b', { workcenter: 'w2', timeSlot: 't1' });
  store.commit(seed);

  const old = store.begin(); // snapshot pinned here

  for (let i = 0; i < 3; i++) {
    const t = store.begin();
    store.put(t, 'a', { workcenter: 'w1', timeSlot: 't' + (i + 2) });
    store.put(t, 'c' + i, { workcenter: 'w3', timeSlot: 't' + i });
    store.commit(t);
  }

  // Old snapshot still reads the work-order set as of begin.
  assert.deepEqual(store.get(old, 'a'), { workcenter: 'w1', timeSlot: 't1' });
  assert.deepEqual(store.get(old, 'b'), { workcenter: 'w2', timeSlot: 't1' });
  assert.equal(store.get(old, 'c0'), null);

  // Old snapshot cannot overwrite a key modified by a newer version.
  store.put(old, 'a', { workcenter: 'w9', timeSlot: 't9' });
  assert.throws(() => store.commit(old), (err) => err.code === 'E_SNAPSHOT');
});

test('acceptance 2: stale snapshot may commit keys untouched by newer versions', () => {
  const store = new Store();
  const t1 = store.begin();
  store.put(t1, 'k1', { workcenter: 'w1', timeSlot: 't1' });
  store.commit(t1);

  const stale = store.begin();
  const t2 = store.begin();
  store.put(t2, 'k2', { workcenter: 'w2', timeSlot: 't2' });
  store.commit(t2);

  store.put(stale, 'k3', { workcenter: 'w3', timeSlot: 't3' });
  const version = store.commit(stale); // disjoint key + disjoint slot: allowed
  assert.equal(version, 3);
});

test('persistence: committed versions survive reopen and chain continues', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-store-'));
  let store = Store.open(dir);
  const t1 = store.begin();
  store.put(t1, 'wo-1', { workcenter: 'wc1', timeSlot: 't1' });
  assert.equal(store.commit(t1), 1);

  store = Store.open(dir); // reopen from disk
  const t2 = store.begin();
  assert.deepEqual(store.get(t2, 'wo-1'), { workcenter: 'wc1', timeSlot: 't1' });
  // Unique index is still enforced after reload.
  store.put(t2, 'wo-2', { workcenter: 'wc1', timeSlot: 't1' });
  assert.throws(() => store.commit(t2), (err) => err.code === 'E_UNIQUE');
  // Version chain continues where it left off.
  const t3 = store.begin();
  store.put(t3, 'wo-3', { workcenter: 'wc1', timeSlot: 't2' });
  assert.equal(store.commit(t3), 2);
});
