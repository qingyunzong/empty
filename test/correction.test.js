import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDb, openStore, certFiles } from '../testutil/helpers.js';
import { verifyCertificateData } from '../src/certs.js';

// Acceptance 2: correcting a measurement from OK to NG updates the latest
// judgment, the (lotId,testCode) index and the certificate chain, while the
// old certificate remains independently verifiable.
test('correction OK -> NG updates judgment, index and chain; old cert still verifies', () => {
  const dir = tmpDb();
  const store = openStore(dir);

  const original = store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0, reportedAt: 1 }).record;
  assert.equal(store.status('L1', 'DIM_LEN').judgment, 'OK');

  const correction = store.correct({ clientRecordId: 'c-2', correctsRecordId: original.recordId, value: 10.4, reportedAt: 2 }).record;

  // Latest judgment and secondary index updated.
  const status = store.status('L1', 'DIM_LEN');
  assert.equal(status.judgment, 'NG');
  assert.equal(status.head.recordId, correction.recordId);
  assert.equal(correction.correctsRecordId, original.recordId);
  assert.equal(correction.lotId, 'L1');
  assert.equal(correction.testCode, 'DIM_LEN');

  // Certificate chain: correction links to the original via prevHash.
  assert.equal(correction.prevHash, original.hash);
  assert.deepEqual(store.verifyChain(), { ok: true, checked: 2, lastHash: correction.hash });
  assert.equal(certFiles(dir).length, 2);

  // Old certificate is still independently verifiable (self-contained).
  const oldCert = JSON.parse(fs.readFileSync(path.join(dir, 'certs', `${original.recordId}.json`), 'utf8'));
  assert.equal(oldCert.judgment, 'OK');
  assert.deepEqual(verifyCertificateData(oldCert), { valid: true });
  assert.deepEqual(store.verifyCertificate(original.recordId).valid, true);

  // Traceability: history shows both records and the invalidation link.
  const history = store.history('L1', 'DIM_LEN');
  assert.equal(history.records.length, 2);
  assert.equal(history.records[0].invalidatedBy, correction.recordId);
  assert.equal(history.records[1].correctsRecordId, original.recordId);

  // State survives restart.
  const reopened = openStore(dir);
  assert.equal(reopened.status('L1', 'DIM_LEN').judgment, 'NG');
  assert.equal(reopened.status('L1', 'DIM_LEN').head.recordId, correction.recordId);
});

test('correction into NCR territory yields NCR', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  const original = store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0 }).record;
  store.correct({ clientRecordId: 'c-2', correctsRecordId: original.recordId, value: 10.6 });
  assert.equal(store.status('L1', 'DIM_LEN').judgment, 'NCR');
});

test('correcting an already-corrected record is rejected', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  const original = store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0 }).record;
  store.correct({ clientRecordId: 'c-2', correctsRecordId: original.recordId, value: 10.4 });
  assert.throws(
    () => store.correct({ clientRecordId: 'c-3', correctsRecordId: original.recordId, value: 10.45 }),
    (err) => err.code === 'ERR_ALREADY_CORRECTED' && err.exitCode === 1,
  );
});
