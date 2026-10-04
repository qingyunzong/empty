import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDb, openStore, committedEntries, certFiles } from '../testutil/helpers.js';

// Acceptance 1: reporting the same clientRecordId twice produces exactly one
// state change and one certificate.
test('duplicate clientRecordId is idempotent: one record, one certificate', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  const input = { clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0, reportedAt: 1000 };

  const first = store.report(input);
  const second = store.report(input);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.record.recordId, first.record.recordId);
  assert.equal(second.record.hash, first.record.hash);

  assert.equal(committedEntries(dir).length, 1);
  assert.equal(certFiles(dir).length, 1);
  assert.equal(Object.keys(store.state.records).length, 1);
  assert.equal(store.status('L1', 'DIM_LEN').judgment, 'OK');

  // Idempotency survives a restart (dedup state is recovered).
  const reopened = openStore(dir);
  const third = reopened.report(input);
  assert.equal(third.deduplicated, true);
  assert.equal(committedEntries(dir).length, 1);
  assert.equal(certFiles(dir).length, 1);
});

test('same clientRecordId with a different payload is rejected', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0 });
  assert.throws(
    () => store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.05 }),
    (err) => err.code === 'ERR_CLIENT_ID_CONFLICT' && err.exitCode === 1,
  );
  assert.equal(committedEntries(dir).length, 1);
});
