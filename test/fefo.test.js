import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, stockBatch } from '../test-utils/helpers.js';

// Acceptance 1: FEFO selection across QC windows, with batch-ID tie-break.
test('FEFO picks earliest expiry even when inspected in a later window', () => {
  const store = makeStore();
  // B1 inspected Monday window, expires later.
  stockBatch(store, 'B1', { qty: 50, expiry: '2026-06-10T00:00:00Z', inspectedAt: '2026-06-01T10:00:00Z' });
  // B2 inspected Tuesday window, expires earlier.
  stockBatch(store, 'B2', { qty: 50, expiry: '2026-06-05T00:00:00Z', inspectedAt: '2026-06-02T10:00:00Z' });

  const res = store.apply({ cmd: 'issue', orderId: 'O1', qty: 30, at: '2026-06-03T12:00:00Z' });
  assert.deepEqual(res.allocations, [{ batch: 'B2', qty: 30 }]);

  const res2 = store.apply({ cmd: 'issue', orderId: 'O2', qty: 40, at: '2026-06-03T12:30:00Z' });
  assert.deepEqual(res2.allocations, [{ batch: 'B2', qty: 20 }, { batch: 'B1', qty: 20 }]);
});

test('equal expiry instants are tied by batch id', () => {
  const store = makeStore();
  stockBatch(store, 'B9', { qty: 20, expiry: '2026-06-20T00:00:00Z' });
  stockBatch(store, 'B3', { qty: 20, expiry: '2026-06-20T00:00:00Z' });

  const res = store.apply({ cmd: 'issue', orderId: 'O3', qty: 25, at: '2026-06-03T12:00:00Z' });
  assert.deepEqual(res.allocations, [{ batch: 'B3', qty: 20 }, { batch: 'B9', qty: 5 }]);
});

test('batches without a passed in-window inspection are not issuable', () => {
  const store = makeStore();
  stockBatch(store, 'B1', { qty: 10, expiry: '2026-06-05T00:00:00Z', inspect: false });
  stockBatch(store, 'B2', { qty: 10, expiry: '2026-06-06T00:00:00Z' });
  store.apply({ cmd: 'quarantine', batch: 'B2', at: '2026-06-02T11:00:00Z' });
  stockBatch(store, 'B3', { qty: 10, expiry: '2026-06-07T00:00:00Z' });

  const issuable = store.apply({ cmd: 'issuable', at: '2026-06-03T12:00:00Z' });
  assert.deepEqual(issuable.batches.map((b) => b.batch), ['B3']);

  store.apply({ cmd: 'release', batch: 'B2', at: '2026-06-03T12:00:00Z' });
  const issuable2 = store.apply({ cmd: 'issuable', at: '2026-06-03T12:00:00Z' });
  assert.deepEqual(issuable2.batches.map((b) => b.batch), ['B2', 'B3']);
});

test('inspection outside the quality window is an error', () => {
  const store = makeStore();
  store.apply({ cmd: 'receive', batch: 'B1', qty: 5, expiry: '2026-06-05T00:00:00Z', span: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'] });
  // Saturday noon UTC is outside the weekday window.
  assert.throws(
    () => store.apply({ cmd: 'inspect', batch: 'B1', inspectedAt: '2026-06-06T12:00:00Z', passed: true }),
    (err) => err.code === 'OUTSIDE_WINDOW',
  );
});
