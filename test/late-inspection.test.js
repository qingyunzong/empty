import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, stockBatch } from '../test-utils/helpers.js';

// Acceptance 2: a late failing inspection stops two batches from issuing and
// produces certificates proving the historical orders they fed.
test('late failed inspection halts two batches and certifies historical orders', () => {
  const store = makeStore();
  stockBatch(store, 'B1', { qty: 100, expiry: '2026-07-01T00:00:00Z', inspectedAt: '2026-06-01T10:00:00Z' });
  stockBatch(store, 'B2', { qty: 100, expiry: '2026-07-02T00:00:00Z', inspectedAt: '2026-06-01T11:00:00Z' });
  stockBatch(store, 'B3', { qty: 100, expiry: '2026-07-03T00:00:00Z', inspectedAt: '2026-06-01T12:00:00Z' });

  const o1 = store.apply({ cmd: 'issue', orderId: 'O1', qty: 40, at: '2026-06-02T09:30:00Z' });
  assert.deepEqual(o1.allocations, [{ batch: 'B1', qty: 40 }]);
  const o2 = store.apply({ cmd: 'issue', orderId: 'O2', qty: 80, at: '2026-06-02T10:30:00Z' });
  assert.deepEqual(o2.allocations, [{ batch: 'B1', qty: 60 }, { batch: 'B2', qty: 20 }]);

  // Correction arrives: B1 actually failed an inspection predating O1/O2.
  const late1 = store.apply({
    cmd: 'inspect', batch: 'B1', inspectedAt: '2026-06-01T15:00:00Z', passed: false, at: '2026-06-03T09:30:00Z',
  });
  assert.equal(late1.late, true);
  assert.deepEqual(
    late1.certificates.map((c) => [c.orderId, c.batch, c.qty]),
    [['O1', 'B1', 40], ['O2', 'B1', 60]],
  );

  // Second late correction for B2, also predating O2.
  const late2 = store.apply({
    cmd: 'inspect', batch: 'B2', inspectedAt: '2026-06-01T16:00:00Z', passed: false, at: '2026-06-03T09:45:00Z',
  });
  assert.deepEqual(late2.certificates.map((c) => [c.orderId, c.batch, c.qty]), [['O2', 'B2', 20]]);

  // Both batches stop issuing; FEFO falls through to B3.
  const issuable = store.apply({ cmd: 'issuable', at: '2026-06-03T10:00:00Z' });
  assert.deepEqual(issuable.batches.map((b) => b.batch), ['B3']);
  const o3 = store.apply({ cmd: 'issue', orderId: 'O3', qty: 50, at: '2026-06-03T10:00:00Z' });
  assert.deepEqual(o3.allocations, [{ batch: 'B3', qty: 50 }]);

  // Historical issues are NOT auto-recalled: deductions stand, certificates
  // accumulate as the proof of affected downstream orders.
  const status = store.apply({ cmd: 'status' });
  const byId = Object.fromEntries(status.batches.map((b) => [b.batch, b]));
  assert.equal(byId.B1.qty, 0);
  assert.equal(byId.B2.qty, 80);
  assert.equal(status.issues.find((i) => i.orderId === 'O1').undone, false);
  assert.equal(status.issues.find((i) => i.orderId === 'O2').undone, false);
  assert.equal(status.certificates.length, 3);
  assert.ok(status.certificates.every((c) => c.type === 'AFFECTED_DOWNSTREAM_CERTIFICATE'));
});

test('on-time inspection produces no certificates', () => {
  const store = makeStore();
  stockBatch(store, 'B1', { qty: 10, expiry: '2026-07-01T00:00:00Z' });
  const res = store.apply({ cmd: 'inspect', batch: 'B1', inspectedAt: '2026-06-01T14:00:00Z', passed: false });
  assert.equal(res.late, false);
  assert.equal(res.certificates, undefined);
});
