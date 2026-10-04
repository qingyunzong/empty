import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { makeStore, stockBatch } from '../test-utils/helpers.js';

test('issuing more than issuable stock is a NEGATIVE_INVENTORY error and changes nothing', () => {
  const store = makeStore();
  stockBatch(store, 'B1', { qty: 10, expiry: '2026-07-01T00:00:00Z' });
  assert.throws(
    () => store.apply({ cmd: 'issue', orderId: 'O1', qty: 11, at: '2026-06-02T10:00:00Z' }),
    (err) => err.code === 'NEGATIVE_INVENTORY',
  );
  const status = store.apply({ cmd: 'status' });
  assert.equal(status.batches[0].qty, 10);
  assert.equal(status.issues.length, 0);
});

test('events for unknown batches are errors', () => {
  const store = makeStore();
  for (const cmd of [
    { cmd: 'available', batch: 'NOPE' },
    { cmd: 'quarantine', batch: 'NOPE' },
    { cmd: 'release', batch: 'NOPE' },
    { cmd: 'scrap', batch: 'NOPE' },
    { cmd: 'inspect', batch: 'NOPE', inspectedAt: '2026-06-01T10:00:00Z', passed: true },
  ]) {
    assert.throws(() => store.apply(cmd), (err) => err.code === 'UNKNOWN_BATCH');
  }
});

test('illegal window periods are errors', () => {
  const store = new Store();
  assert.throws(
    () => store.apply({
      cmd: 'config',
      timezones: { 'Etc/UTC': [{ from: null, offsetMinutes: 0 }] },
      window: { zone: 'Etc/UTC', weekly: [{ days: [1], start: '12:00', end: '12:00' }] },
    }),
    (err) => err.code === 'ILLEGAL_PERIOD',
  );
});

test('restore that would drive a batch negative is rejected', () => {
  const store = makeStore();
  stockBatch(store, 'B1', { qty: 10, expiry: '2026-07-01T00:00:00Z' });
  const issue = store.apply({ cmd: 'issue', orderId: 'O1', qty: 10, at: '2026-06-02T10:00:00Z' });
  store.apply({ cmd: 'undo', issueId: issue.issueId });
  store.apply({ cmd: 'issue', orderId: 'O2', qty: 10, at: '2026-06-02T11:00:00Z' });
  assert.throws(
    () => store.apply({ cmd: 'restore', issueId: issue.issueId }),
    (err) => err.code === 'NEGATIVE_INVENTORY',
  );
});
