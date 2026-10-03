import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine, MARGIN_RATE } from '../src/engine.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'txeng-'));
  const store = new Store(dir);
  return new Engine(store);
}

test('put + replace keeps old versions and recomputes margin freeze', () => {
  const e = fresh();
  const p = e.put({ txId: 'T1', price: 100, qty: 5, author: 'alice' });
  assert.equal(p.status, 'OK');
  const r = e.replace({ txId: 'T1', price: 120, author: 'bob' });
  assert.equal(r.status, 'OK');
  const m = e.materialize({ txId: 'T1' });
  assert.equal(m.price, 120);
  assert.equal(m.qty, 5);
  assert.equal(m.frozen, 120 * 5 * MARGIN_RATE);
  const h = e.history({ txId: 'T1' });
  assert.equal(h.revisions.length, 2); // old version preserved
  assert.equal(h.revisions[0].patch.price, 100);
  assert.equal(h.revisions[1].parents[0], p.head);
  assert.equal(h.revisions[1].author, 'bob');
  assert.equal(h.revisions[1].seq, 1);
});

test('acceptance 1: disjoint concurrent fields auto-merge', () => {
  const e = fresh();
  const p = e.put({ txId: 'T1', price: 100, qty: 5, author: 'alice' });
  const r1 = e.replace({ txId: 'T1', base: p.head, price: 101, author: 'bob' });
  assert.equal(r1.status, 'OK');
  const r2 = e.replace({ txId: 'T1', base: p.head, qty: 9, author: 'carol' });
  assert.equal(r2.status, 'MERGED');
  assert.deepEqual(r2.mergedHeads.sort(), [r1.head, r2.revision.hash].sort());
  const m = e.materialize({ txId: 'T1' });
  assert.equal(m.status, 'OK');
  assert.equal(m.price, 101);
  assert.equal(m.qty, 9);
  assert.equal(m.frozen, 101 * 9 * MARGIN_RATE);
  assert.equal(m.version, r2.head);
});

test('acceptance 1: same-field conflict keeps parallel heads, blocks successors, explicit resolve', () => {
  const e = fresh();
  const p = e.put({ txId: 'T1', price: 100, qty: 5, author: 'alice' });
  const r1 = e.replace({ txId: 'T1', base: p.head, price: 101, author: 'bob' });
  const r2 = e.replace({ txId: 'T1', base: p.head, price: 102, author: 'carol' });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 'CONFLICT');
  assert.deepEqual(r2.fields, ['price']);
  assert.deepEqual(r2.heads.sort(), [r1.head, r2.revision.hash].sort());
  // materialize is blocked while conflicted
  const mc = e.materialize({ txId: 'T1' });
  assert.equal(mc.ok, false);
  assert.equal(mc.error, 'UNRESOLVED_CONFLICT');
  // successors blocked until resolve
  const blocked = e.replace({ txId: 'T1', qty: 7, author: 'dave' });
  assert.equal(blocked.error, 'UNRESOLVED_CONFLICT');
  const blockedCancel = e.cancel({ txId: 'T1', author: 'dave' });
  assert.equal(blockedCancel.error, 'UNRESOLVED_CONFLICT');
  // explicit resolve unblocks
  const res = e.resolve({ txId: 'T1', price: 102, author: 'dave' });
  assert.equal(res.status, 'RESOLVED');
  assert.deepEqual(res.resolvedHeads.sort(), [r1.head, r2.revision.hash].sort());
  const m = e.materialize({ txId: 'T1' });
  assert.equal(m.price, 102);
  assert.equal(m.qty, 5);
  // successors allowed again
  const r3 = e.replace({ txId: 'T1', qty: 8, author: 'erin' });
  assert.equal(r3.status, 'OK');
  assert.equal(e.materialize({ txId: 'T1' }).qty, 8);
});

test('acceptance 2: cancel beats concurrent field modify, later modifies rejected', () => {
  const e = fresh();
  const p = e.put({ txId: 'T1', price: 100, qty: 5, author: 'alice' });
  e.replace({ txId: 'T1', base: p.head, price: 101, author: 'bob' });
  const c = e.cancel({ txId: 'T1', base: p.head, author: 'carol' });
  assert.equal(c.status, 'MERGED_CANCEL');
  const m = e.materialize({ txId: 'T1' });
  assert.equal(m.status, 'CANCELLED');
  assert.equal(m.cancelled, true);
  assert.equal(m.frozen, 0); // margin freeze released
  const r = e.replace({ txId: 'T1', qty: 3, author: 'dave' });
  assert.equal(r.error, 'TX_CANCELLED');
  const c2 = e.cancel({ txId: 'T1', author: 'dave' });
  assert.equal(c2.error, 'TX_CANCELLED');
});

test('acceptance 2: modify after sequential cancel is rejected', () => {
  const e = fresh();
  e.put({ txId: 'T1', price: 10, qty: 2, author: 'alice' });
  const c = e.cancel({ txId: 'T1', author: 'alice' });
  assert.equal(c.status, 'OK');
  const r = e.replace({ txId: 'T1', price: 11, author: 'bob' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TX_CANCELLED');
  assert.equal(e.materialize({ txId: 'T1' }).frozen, 0);
});

test('put duplicate tx and unknown tx errors', () => {
  const e = fresh();
  e.put({ txId: 'T1', price: 1, qty: 1, author: 'a' });
  assert.equal(e.put({ txId: 'T1', price: 1, qty: 1, author: 'a' }).error, 'TX_EXISTS');
  assert.equal(e.replace({ txId: 'NOPE', price: 1, author: 'a' }).error, 'TX_NOT_FOUND');
  assert.equal(e.materialize({ txId: 'NOPE' }).error, 'TX_NOT_FOUND');
  assert.equal(e.resolve({ txId: 'T1', price: 2, author: 'a' }).error, 'NO_CONFLICT');
});

test('author sequence numbers increment per author', () => {
  const e = fresh();
  e.put({ txId: 'T1', price: 1, qty: 1, author: 'a' });
  e.replace({ txId: 'T1', price: 2, author: 'a' });
  e.replace({ txId: 'T1', price: 3, author: 'b' });
  const h = e.history({ txId: 'T1' });
  assert.deepEqual(h.revisions.map((r) => [r.author, r.seq]), [['a', 1], ['a', 2], ['b', 1]]);
});
