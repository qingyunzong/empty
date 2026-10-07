import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

test('edge: empty key is a valid key', () => {
  const store = new Store();
  const t = store.begin();
  store.put(t, '', { workcenter: 'wc1', timeSlot: 't1' });
  store.commit(t);
  const r = store.begin();
  assert.deepEqual(store.get(r, ''), { workcenter: 'wc1', timeSlot: 't1' });
});

test('edge: zero-length work order (empty string value) round-trips and skips the index', () => {
  const store = new Store();
  const t1 = store.begin();
  store.put(t1, 'wo-empty', '');
  store.commit(t1);
  const t2 = store.begin();
  assert.equal(store.get(t2, 'wo-empty'), '');
  // A second zero-length work order under another key commits fine (no index).
  store.put(t2, 'wo-empty-2', '');
  store.commit(t2);
});

test('edge: same-value duplicate writes in one tx collapse to one write', () => {
  const store = new Store();
  const t = store.begin();
  const value = { workcenter: 'wc1', timeSlot: 't1' };
  store.put(t, 'k', value);
  store.put(t, 'k', value);
  store.put(t, 'k', value);
  const version = store.commit(t);
  assert.deepEqual(store.versions.get(version).writes, { k: value });
  const r = store.begin();
  assert.deepEqual(store.get(r, 'k'), value);
});

test('edge: two tx writing same key with same value still conflict (first committer wins)', () => {
  const store = new Store();
  const t1 = store.begin();
  const t2 = store.begin();
  const value = { workcenter: 'wc1', timeSlot: 't1' };
  store.put(t1, 'k', value);
  store.put(t2, 'k', value);
  store.commit(t1);
  assert.throws(() => store.commit(t2), (err) => err.code === 'E_SNAPSHOT');
});

test('edge: empty-string workcenter/timeSlot still occupy the unique index', () => {
  const store = new Store();
  const t1 = store.begin();
  const t2 = store.begin();
  store.put(t1, 'a', { workcenter: '', timeSlot: '' });
  store.put(t2, 'b', { workcenter: '', timeSlot: '' });
  store.commit(t1);
  assert.throws(() => store.commit(t2), (err) => err.code === 'E_UNIQUE');
});

test('edge: non-object values never collide in the unique index', () => {
  const store = new Store();
  const t1 = store.begin();
  store.put(t1, 'n1', 42);
  store.commit(t1);
  const t2 = store.begin();
  store.put(t2, 'n2', 42);
  store.put(t2, 'arr', [1, 2]);
  store.commit(t2);
});

test('edge: moving a work order off a slot frees it for another tx', () => {
  const store = new Store();
  const t1 = store.begin();
  store.put(t1, 'a', { workcenter: 'wc1', timeSlot: 't1' });
  store.commit(t1);
  const t2 = store.begin();
  store.put(t2, 'a', { workcenter: 'wc1', timeSlot: 't2' }); // move a
  store.put(t2, 'b', { workcenter: 'wc1', timeSlot: 't1' }); // reuse freed slot
  store.commit(t2);
});

test('edge: abort discards writes and releases nothing', () => {
  const store = new Store();
  const t = store.begin();
  store.put(t, 'k', { workcenter: 'wc1', timeSlot: 't1' });
  store.abort(t);
  const r = store.begin();
  assert.equal(store.get(r, 'k'), null);
  assert.throws(() => store.commit(t), (err) => err.code === 'E_USAGE');
});

test('edge: usage errors for unknown tx, null value, double commit', () => {
  const store = new Store();
  assert.throws(() => store.get('nope', 'k'), (err) => err.code === 'E_USAGE');
  const t = store.begin();
  assert.throws(() => store.put(t, 'k', null), (err) => err.code === 'E_USAGE');
  store.put(t, 'k', 'v');
  store.commit(t);
  assert.throws(() => store.commit(t), (err) => err.code === 'E_USAGE');
});
