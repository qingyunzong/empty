import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDb, openStore, committedEntries, certFiles } from '../testutil/helpers.js';
import { referenceReplay } from '../src/reference.js';

// Acceptance 3: after injecting a crash at either fault point, recovery must
// match the naive "replay valid committed records by sequence number" oracle.

test('crash after data sync: uncommitted record produces no judgment', () => {
  const dir = tmpDb();
  const crashing = openStore(dir, { fault: 'after-data-sync' });
  assert.throws(
    () => crashing.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0 }),
    (err) => err.injected === true && err.point === 'after-data-sync',
  );

  const recovered = openStore(dir);
  assert.equal(recovered.recovered.committed, 0);
  assert.equal(recovered.recovered.discarded, 1);
  assert.equal(recovered.status('L1', 'DIM_LEN').judgment, 'NO_DATA');
  assert.equal(certFiles(dir).length, 0);

  // The clientRecordId was never committed, so the client may safely retry.
  const retry = recovered.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0 });
  assert.equal(retry.deduplicated, false);
  assert.equal(recovered.status('L1', 'DIM_LEN').judgment, 'OK');

  assert.deepEqual(openStore(dir).projection(), referenceReplay(dir));
});

test('crash after commit sync: committed record survives recovery', () => {
  const dir = tmpDb();
  const crashing = openStore(dir, { fault: 'after-commit-sync' });
  assert.throws(
    () => crashing.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.4 }),
    (err) => err.injected === true && err.point === 'after-commit-sync',
  );

  const recovered = openStore(dir);
  assert.equal(recovered.recovered.committed, 1);
  assert.equal(recovered.status('L1', 'DIM_LEN').judgment, 'NG');
  assert.equal(certFiles(dir).length, 1); // cert rebuilt during recovery

  // Retry of the same clientRecordId dedups against the committed record.
  const retry = recovered.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.4 });
  assert.equal(retry.deduplicated, true);
  assert.equal(committedEntries(dir).length, 1);

  assert.deepEqual(openStore(dir).projection(), referenceReplay(dir));
});

test('crashes at both points across a mixed workload recover to the reference replay', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  const r1 = store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0 }).record;
  store.report({ clientRecordId: 'c-2', lotId: 'L1', testCode: 'WEIGHT', value: 51.0 }).record;
  store.correct({ clientRecordId: 'c-3', correctsRecordId: r1.recordId, value: 10.3 });

  // Crash after data sync on the 4th record: it must vanish.
  let crashing = openStore(dir, { fault: 'after-data-sync' });
  assert.throws(() => crashing.report({ clientRecordId: 'c-4', lotId: 'L2', testCode: 'VOLTAGE', value: 3.3 }), (e) => e.injected);

  // Crash after commit sync on the retry: it must survive exactly once.
  crashing = openStore(dir, { fault: 'after-commit-sync' });
  assert.equal(crashing.recovered.discarded, 1); // stale tail of the previous crash discarded
  assert.throws(() => crashing.report({ clientRecordId: 'c-4', lotId: 'L2', testCode: 'VOLTAGE', value: 3.3 }), (e) => e.injected);

  const recovered = openStore(dir);
  assert.equal(recovered.recovered.committed, 4);
  assert.equal(recovered.status('L1', 'DIM_LEN').judgment, 'NG');
  assert.equal(recovered.status('L1', 'WEIGHT').judgment, 'NG');
  assert.equal(recovered.status('L2', 'VOLTAGE').judgment, 'OK');
  assert.equal(committedEntries(dir).length, 4);

  const projection = recovered.projection();
  assert.deepEqual(projection, referenceReplay(dir));
  assert.equal(projection.recordCount, 4);
});
