'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { spawnNode } = require('../test-support/helpers');

test('crash after data fsync but before commit marker: txn invisible, prior data intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-crash-'));
  Store.init(dir);

  const child = spawnNode(
    [path.join(__dirname, '..', 'test-support', 'fixtures', 'crash_commit.js'), dir],
    { env: { ...process.env, KVSTORE_FAULT: 'afterDataFsync' } }
  );
  assert.notEqual(child.status, 0, 'child must have been killed at the fault point');
  assert.equal(child.stdout.trim(), '', 'child must not reach past the doomed commit');

  // Reopen: recovery replays the WAL, discards the uncommitted data record.
  const store = new Store(dir);
  assert.equal(store.get('stable-key'), 'stable-value');
  assert.throws(() => store.get('doomed-key'), (err) => err.code === 'NOT_FOUND');
  assert.equal(store.currentVersion, 1);

  // The store keeps working: a new commit lands cleanly after the truncated tail.
  const txn = store.begin();
  txn.put('after-crash', 'ok');
  const { version } = txn.commit();
  assert.equal(version, 2);
  store.close();

  // And survives another reopen.
  const reopened = new Store(dir);
  assert.equal(reopened.get('stable-key'), 'stable-value');
  assert.equal(reopened.get('after-crash'), 'ok');
  assert.throws(() => reopened.get('doomed-key'), (err) => err.code === 'NOT_FOUND');
  reopened.close();
});

test('torn tail record (partial write) is truncated on recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-torn-'));
  Store.init(dir);

  const store = new Store(dir);
  const txn = store.begin();
  txn.put('k', 'v');
  txn.commit();
  store.close();

  // Simulate a crash mid-append: half a record at the tail.
  const walPath = path.join(dir, 'store.wal');
  fs.appendFileSync(walPath, Buffer.from([0x30, 0x00, 0x00, 0x00, 0x7b, 0x22]));

  const recovered = new Store(dir);
  assert.equal(recovered.get('k'), 'v');
  assert.equal(fs.statSync(walPath).size, recovered.truncatedTo);
  recovered.close();
});

test('corrupt checksum at tail is truncated on recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-corrupt-'));
  Store.init(dir);

  const store = new Store(dir);
  const txn = store.begin();
  txn.put('k', 'v');
  txn.commit();
  store.close();

  const walPath = path.join(dir, 'store.wal');
  const good = fs.statSync(walPath).size;
  // Append a well-framed record with a bad checksum.
  const { encodeRecord } = require('../src/wal');
  const frame = encodeRecord({ t: 'commit', txn: 'bogus', ver: 99 });
  frame[frame.length - 1] ^= 0xff;
  fs.appendFileSync(walPath, frame);

  const recovered = new Store(dir);
  assert.equal(recovered.get('k'), 'v');
  assert.equal(recovered.currentVersion, 1);
  assert.equal(fs.statSync(walPath).size, good);
  recovered.close();
});
