import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QmsStore } from '../src/store.js';
import { BusinessError } from '../src/errors.js';
import { tmpDir, referenceReplay } from './helpers.js';

const NOW = '2026-10-03T00:00:00.000Z';
const openOpts = { now: () => NOW };

function freshStore() {
  const dir = tmpDir();
  QmsStore.init(dir);
  return { dir, store: QmsStore.open(dir, openOpts) };
}

test('duplicate clientRecordId produces one state entry and one certificate', () => {
  const { dir, store } = freshStore();
  const payload = { clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.0 };
  const first = store.report(payload);
  const second = store.report(payload);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.recordId, first.recordId);
  assert.equal(second.hash, first.hash);

  assert.equal(Object.keys(store.state.records).length, 1);
  assert.equal(store.certificates().length, 1);

  const walLines = fs.readFileSync(path.join(dir, 'wal.log'), 'utf8').trim().split('\n');
  assert.equal(walLines.length, 2);

  const reopened = QmsStore.open(dir, openOpts);
  assert.equal(reopened.certificates().length, 1);
  assert.deepEqual(reopened.status('LOT-A', 'dimension.length').judgment, 'OK');
});

test('correction OK -> NG updates judgment, index and chain; old cert still verifies', () => {
  const { dir, store } = freshStore();
  const first = store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.0 });
  assert.equal(first.judgment, 'OK');

  const fix = store.correct({ clientRecordId: 'c-2', correctsRecordId: first.recordId, value: 10.5 });
  assert.equal(fix.judgment, 'NG');
  assert.notEqual(fix.recordId, first.recordId);

  const status = store.status('LOT-A', 'dimension.length');
  assert.equal(status.judgment, 'NG');
  assert.equal(status.recordId, fix.recordId);

  const certs = store.certificates();
  assert.equal(certs.length, 2);
  assert.equal(certs[0].recordId, first.recordId);
  assert.equal(certs[1].recordId, fix.recordId);
  assert.equal(certs[1].prevHash, certs[0].hash);

  assert.equal(store.verify().ok, true);
  const oldCert = store.verify(first.recordId);
  assert.equal(oldCert.ok, true);
  assert.equal(oldCert.hash, certs[0].hash);

  const oldRecord = store.getRecord(first.recordId);
  assert.equal(oldRecord.judgment, 'OK');
  assert.equal(oldRecord.record.value, 10.0);

  const reopened = QmsStore.open(dir, openOpts);
  assert.equal(reopened.status('LOT-A', 'dimension.length').judgment, 'NG');
  assert.equal(reopened.verify(first.recordId).ok, true);
  assert.deepEqual(reopened.snapshot(), referenceReplay(dir));
});

test('unknown test code is a business error', () => {
  const { store } = freshStore();
  assert.throws(
    () => store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'no.such.test', value: 1 }),
    (err) => err instanceof BusinessError && err.code === 'UNKNOWN_TEST_CODE'
  );
});

test('value outside physical range is a business error', () => {
  const { store } = freshStore();
  assert.throws(
    () => store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 500 }),
    (err) => err instanceof BusinessError && err.code === 'VALUE_OUT_OF_RANGE'
  );
  assert.throws(
    () => store.report({ clientRecordId: 'c-2', lotId: 'LOT-A', testCode: 'dimension.length', value: NaN }),
    (err) => err instanceof BusinessError && err.code === 'INVALID_VALUE'
  );
});

test('correction referencing unknown record is a business error', () => {
  const { store } = freshStore();
  assert.throws(
    () => store.correct({ clientRecordId: 'c-9', correctsRecordId: 'rec-99999999', value: 10.0 }),
    (err) => err instanceof BusinessError && err.code === 'UNKNOWN_RECORD'
  );
});

test('consecutive NG escalates to NCR and OK resets', () => {
  const { store } = freshStore();
  const r1 = store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.5 });
  assert.equal(r1.judgment, 'NG');
  const r2 = store.correct({ clientRecordId: 'c-2', correctsRecordId: r1.recordId, value: 10.6 });
  assert.equal(r2.judgment, 'NCR');
  const r3 = store.correct({ clientRecordId: 'c-3', correctsRecordId: r2.recordId, value: 10.0 });
  assert.equal(r3.judgment, 'OK');
  const r4 = store.correct({ clientRecordId: 'c-4', correctsRecordId: r3.recordId, value: 10.6 });
  assert.equal(r4.judgment, 'NG');
});

test('duplicate correction is idempotent', () => {
  const { store } = freshStore();
  const r1 = store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.0 });
  const c1 = store.correct({ clientRecordId: 'c-2', correctsRecordId: r1.recordId, value: 10.5 });
  const c2 = store.correct({ clientRecordId: 'c-2', correctsRecordId: r1.recordId, value: 10.5 });
  assert.equal(c2.duplicate, true);
  assert.equal(c2.recordId, c1.recordId);
  assert.equal(Object.keys(store.state.records).length, 2);
});

test('independent (lotId, testCode) indexes do not interfere', () => {
  const { store } = freshStore();
  store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.5 });
  store.report({ clientRecordId: 'c-2', lotId: 'LOT-A', testCode: 'electrical.voltage', value: 3.3 });
  store.report({ clientRecordId: 'c-3', lotId: 'LOT-B', testCode: 'dimension.length', value: 10.0 });
  assert.equal(store.status('LOT-A', 'dimension.length').judgment, 'NG');
  assert.equal(store.status('LOT-A', 'electrical.voltage').judgment, 'OK');
  assert.equal(store.status('LOT-B', 'dimension.length').judgment, 'OK');
  assert.equal(store.status('LOT-C', 'dimension.length').judgment, null);
});

test('state survives reopen and matches naive reference replay', () => {
  const { dir, store } = freshStore();
  store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.0 });
  store.report({ clientRecordId: 'c-2', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.5 });
  store.report({ clientRecordId: 'c-3', lotId: 'LOT-B', testCode: 'visual.defects', value: 2 });
  const reopened = QmsStore.open(dir, openOpts);
  assert.deepEqual(reopened.snapshot(), referenceReplay(dir));
  assert.equal(reopened.verify().checked, 3);
});
