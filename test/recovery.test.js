import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDb, openStore } from '../testutil/helpers.js';
import { referenceReplay } from '../src/reference.js';

// Recovery (snapshot + incremental WAL tail merge) must equal the naive
// "replay valid committed records by sequence number" reference.
test('incremental recovery matches naive full replay after a mixed workload', () => {
  const dir = tmpDb();
  const store = openStore(dir);

  const ops = [
    { clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0 },
    { clientRecordId: 'c-2', lotId: 'L1', testCode: 'DIM_LEN', value: 10.08 },
    { clientRecordId: 'c-3', lotId: 'L1', testCode: 'WEIGHT', value: 50.1 },
    { clientRecordId: 'c-4', lotId: 'L2', testCode: 'VOLTAGE', value: 3.1 },
    { clientRecordId: 'c-5', lotId: 'L2', testCode: 'VOLTAGE', value: 3.5 },
  ];
  const ids = {};
  for (const op of ops) ids[op.clientRecordId] = store.report(op).record.recordId;
  store.correct({ clientRecordId: 'c-6', correctsRecordId: ids['c-4'], value: 3.3 });
  store.correct({ clientRecordId: 'c-7', correctsRecordId: ids['c-2'], value: 10.6 });
  store.report({ clientRecordId: 'c-8', lotId: 'L1', testCode: 'WEIGHT', value: 49.0 });

  for (let i = 0; i < 3; i += 1) {
    const reopened = openStore(dir);
    assert.deepEqual(reopened.projection(), referenceReplay(dir));
  }

  const final = openStore(dir);
  assert.equal(final.status('L1', 'DIM_LEN').judgment, 'NCR');
  assert.equal(final.status('L1', 'WEIGHT').judgment, 'NG');
  assert.equal(final.status('L2', 'VOLTAGE').judgment, 'OK');
  assert.equal(final.history('L1', 'DIM_LEN').records.length, 3);
  assert.deepEqual(final.verifyChain(), { ok: true, checked: 8, lastHash: final.state.lastHash });
});
