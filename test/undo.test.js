import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, stockBatch } from '../test-utils/helpers.js';

test('undo returns stock and restore deducts it again', () => {
  const store = makeStore();
  stockBatch(store, 'B1', { qty: 30, expiry: '2026-07-01T00:00:00Z' });
  stockBatch(store, 'B2', { qty: 30, expiry: '2026-07-02T00:00:00Z' });

  const issue = store.apply({ cmd: 'issue', orderId: 'O1', qty: 40, at: '2026-06-02T10:00:00Z' });
  assert.deepEqual(issue.allocations, [{ batch: 'B1', qty: 30 }, { batch: 'B2', qty: 10 }]);

  store.apply({ cmd: 'undo', issueId: issue.issueId });
  let status = store.apply({ cmd: 'status' });
  assert.deepEqual(status.batches.map((b) => b.qty), [30, 30]);
  assert.equal(status.issues[0].undone, true);

  store.apply({ cmd: 'restore', issueId: issue.issueId });
  status = store.apply({ cmd: 'status' });
  assert.deepEqual(status.batches.map((b) => b.qty), [0, 20]);
  assert.equal(status.issues[0].undone, false);
});

test('double undo / double restore are state errors', () => {
  const store = makeStore();
  stockBatch(store, 'B1', { qty: 10, expiry: '2026-07-01T00:00:00Z' });
  const issue = store.apply({ cmd: 'issue', orderId: 'O1', qty: 5, at: '2026-06-02T10:00:00Z' });
  store.apply({ cmd: 'undo', issueId: issue.issueId });
  assert.throws(() => store.apply({ cmd: 'undo', issueId: issue.issueId }), (err) => err.code === 'INVALID_STATE');
  store.apply({ cmd: 'restore', issueId: issue.issueId });
  assert.throws(() => store.apply({ cmd: 'restore', issueId: issue.issueId }), (err) => err.code === 'INVALID_STATE');
  assert.throws(() => store.apply({ cmd: 'undo', issueId: 'I999' }), (err) => err.code === 'UNKNOWN_ISSUE');
});
