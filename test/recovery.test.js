'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store } = require('../src/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-store-rec-'));
}

const CHILD_SCRIPT = `
const { Store } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'store.js'))});
const dir = process.argv[1];
delete process.env.OBS_STORE_FAULT; // arm the fault only for the second commit
const store = Store.open(dir);
const t1 = store.begin();
t1.put('committed-before', 'yes');
t1.commit();
process.env.OBS_STORE_FAULT = 'after-data-fsync';
const t2 = store.begin();
t2.put('crashed-txn', 'should-be-invisible');
t2.commit(); // fault injected: dies after data fsync, before commit marker
`;

test('acceptance 2: crash after data fsync, before commit marker -> txn invisible, prior txns intact', () => {
  const dir = tmpdir();
  const res = spawnSync(process.execPath, ['-e', CHILD_SCRIPT, dir], {
    env: { ...process.env, OBS_STORE_FAULT: 'after-data-fsync' },
  });
  assert.equal(res.status, 77, `child should die at fault point, got ${res.status}: ${res.stderr}`);

  // Restart: replay the WAL.
  const store = Store.open(dir);
  assert.equal(store.get('committed-before'), 'yes', 'pre-crash commit must survive');
  assert.throws(() => store.get('crashed-txn'), (err) => err.code === 'NOT_FOUND',
    'transaction without commit marker must be invisible');

  // The store must keep working: new commits reuse no stale txn ids.
  const t = store.begin();
  t.put('after-recovery', 'ok');
  t.commit();
  store.close();

  const reopened = Store.open(dir);
  assert.equal(reopened.get('after-recovery'), 'ok');
  assert.equal(reopened.get('committed-before'), 'yes');
  assert.throws(() => reopened.get('crashed-txn'), (err) => err.code === 'NOT_FOUND');
  reopened.close();
});

test('torn tail record is truncated on recovery and store continues', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const t = store.begin();
  t.put('k', 'v');
  t.commit();
  store.close();

  const walPath = path.join(dir, 'store.wal');
  const goodSize = fs.statSync(walPath).size;
  // Simulate a crash mid-append: partial record at the tail.
  fs.appendFileSync(walPath, Buffer.from([0x20, 0x00, 0x00, 0x00, 0xde, 0xad]));

  const reopened = Store.open(dir);
  assert.equal(reopened.get('k'), 'v', 'valid records survive torn tail');
  assert.equal(fs.statSync(walPath).size, goodSize, 'torn tail must be truncated');

  const t2 = reopened.begin();
  t2.put('k2', 'v2');
  t2.commit();
  reopened.close();

  const again = Store.open(dir);
  assert.equal(again.get('k2'), 'v2');
  again.close();
});

test('corrupt commit checksum leaves transaction invisible', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const t = store.begin();
  t.put('good', '1');
  t.commit();
  store.close();

  // Hand-craft a commit whose checksum does not match its write records.
  const { encodeRecord } = require('../src/wal');
  const walPath = path.join(dir, 'store.wal');
  fs.appendFileSync(walPath, encodeRecord({ t: 'put', txn: 999, key: 'bad', value: 'x' }));
  fs.appendFileSync(walPath, encodeRecord({ t: 'commit', txn: 999, version: 2, checksum: 12345 }));

  const reopened = Store.open(dir);
  assert.equal(reopened.get('good'), '1');
  assert.throws(() => reopened.get('bad'), (err) => err.code === 'NOT_FOUND');
  reopened.close();
});

test('abort record in WAL leaves writes invisible after restart', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const t = store.begin();
  t.put('k', 'v');
  t.abort();
  store.close();

  const reopened = Store.open(dir);
  assert.throws(() => reopened.get('k'), (err) => err.code === 'NOT_FOUND');
  reopened.close();
});
