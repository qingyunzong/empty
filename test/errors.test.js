import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDb, openStore } from '../testutil/helpers.js';
import { CorruptionError } from '../src/errors.js';

test('out-of-range measurement is a business error', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  assert.throws(
    () => store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 5000 }),
    (err) => err.code === 'ERR_VALUE_OUT_OF_RANGE' && err.exitCode === 1,
  );
  assert.throws(
    () => store.report({ clientRecordId: 'c-2', lotId: 'L1', testCode: 'DIM_LEN', value: -1 }),
    (err) => err.code === 'ERR_VALUE_OUT_OF_RANGE',
  );
  assert.equal(store.state.lastSeq, 0); // nothing committed
});

test('missing test item / unknown testCode is a business error', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  assert.throws(
    () => store.report({ clientRecordId: 'c-1', lotId: 'L1', value: 1 }),
    (err) => err.code === 'ERR_MISSING_FIELD' && err.exitCode === 1,
  );
  assert.throws(
    () => store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'NOPE', value: 1 }),
    (err) => err.code === 'ERR_UNKNOWN_TEST' && err.exitCode === 1,
  );
});

test('correction referencing an unknown record is a business error', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  assert.throws(
    () => store.correct({ clientRecordId: 'c-1', correctsRecordId: 'rec_missing', value: 1 }),
    (err) => err.code === 'ERR_UNKNOWN_REFERENCE' && err.exitCode === 1,
  );
});

test('corrupted committed WAL data is a corruption error', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10 });
  const walFile = path.join(dir, 'wal.log');
  const content = fs.readFileSync(walFile, 'utf8');
  assert.ok(content.includes('"value":10'));
  fs.writeFileSync(walFile, content.replace('"value":10', '"value":99'));
  assert.throws(() => openStore(dir), (err) => err instanceof CorruptionError && err.exitCode === 2);
});

test('corrupted snapshot is a corruption error', () => {
  const dir = tmpDb();
  const store = openStore(dir);
  store.report({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10 });
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  assert.throws(() => openStore(dir), (err) => err instanceof CorruptionError && err.exitCode === 2);
});
