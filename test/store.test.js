'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  Store,
  encodeChunk,
  HEADER_LEN,
  DATA_FILE,
  MANIFEST_FILE,
} = require('../src/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planline-'));
}

const O1 = { id: 'WO-1', quantity: 10, due: 5, machine: 'M1' };
const O2 = { id: 'WO-2', quantity: 20, due: 8, machine: 'M2' };
const O3 = { id: 'WO-3', quantity: 7, due: 6, machine: 'M1' };

test('append then reopen decodes orders and cumulative machine loads', () => {
  const dir = tmpdir();
  const store = Store.create(dir);
  store.appendOrder(O1);
  store.appendOrder(O2);
  store.appendOrder(O3);

  const reopened = Store.open(dir);
  assert.deepEqual(reopened.orders, [O1, O2, O3]);
  assert.deepEqual(reopened.loads, { M1: 17, M2: 20 });
});

test('duplicate order id is rejected with E_USAGE', () => {
  const dir = tmpdir();
  const store = Store.create(dir);
  store.appendOrder(O1);
  assert.throws(() => store.appendOrder(O1), { code: 'E_USAGE' });
});

test('rollback restores the checkpoint snapshot without decoding rolled-back chunks', () => {
  const dir = tmpdir();
  const store = Store.create(dir);
  store.appendOrder(O1);
  store.appendOrder(O2);
  store.checkpoint('cp1');

  const sizeAtCp = fs.statSync(path.join(dir, DATA_FILE)).size;
  store.appendOrder(O3);

  // Any decode during rollback would blow up here; rollback must rely solely
  // on the manifest index and the checkpoint snapshot.
  store.decode = () => {
    throw new Error('decode must not be called during rollback');
  };
  store.rollback('cp1');

  assert.deepEqual(store.loads, { M1: 10, M2: 20 });
  assert.deepEqual(store.orders, [O1, O2]);
  assert.equal(store.manifest.chunks.length, 2);
  assert.equal(fs.statSync(path.join(dir, DATA_FILE)).size, sizeAtCp);

  const reopened = Store.open(dir);
  assert.deepEqual(reopened.orders, [O1, O2]);
  assert.deepEqual(reopened.loads, { M1: 10, M2: 20 });
});

test('replay after rollback reproduces a byte-identical manifest', () => {
  const dir = tmpdir();
  const store = Store.create(dir);
  store.appendOrder(O1);
  store.appendOrder(O2);
  store.checkpoint('cp1');
  store.appendOrder(O3);

  const manifestPath = path.join(dir, MANIFEST_FILE);
  const dataPath = path.join(dir, DATA_FILE);
  const manifestBefore = fs.readFileSync(manifestPath);
  const dataBefore = fs.readFileSync(dataPath);

  store.rollback('cp1');
  store.appendOrder(O3);

  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
  assert.deepEqual(fs.readFileSync(dataPath), dataBefore);
});

test('corrupting one byte reports the chunk number and keeps a clean prefix', () => {
  const dir = tmpdir();
  const store = Store.create(dir);
  store.appendOrder(O1);
  store.appendOrder(O2);
  store.appendOrder(O3);

  const manifestBefore = fs.readFileSync(path.join(dir, MANIFEST_FILE));
  const dataPath = path.join(dir, DATA_FILE);
  const chunk1 = store.manifest.chunks[1];
  const fd = fs.openSync(dataPath, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, chunk1.offset + HEADER_LEN); // first payload byte
  one[0] ^= 0xff;
  fs.writeSync(fd, one, 0, 1, chunk1.offset + HEADER_LEN);
  fs.closeSync(fd);

  let err;
  try {
    Store.open(dir);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'open must fail on the corrupted chunk');
  assert.equal(err.code, 'E_CRC');
  assert.equal(err.chunk, 1);
  // The prefix before the bad chunk is fully decodable...
  assert.deepEqual(err.state.orders, [O1]);
  assert.deepEqual(err.state.loads, { M1: 10 });
  // ...and the failure does not pollute persisted state: manifest untouched,
  // data file size unchanged, and a repeated open fails identically.
  assert.deepEqual(fs.readFileSync(path.join(dir, MANIFEST_FILE)), manifestBefore);
  assert.equal(fs.statSync(dataPath).size, store.dataSize);
  assert.throws(() => Store.open(dir), (e2) => {
    assert.equal(e2.code, 'E_CRC');
    assert.equal(e2.chunk, 1);
    assert.deepEqual(e2.state.orders, [O1]);
    return true;
  });
});

test('crash before manifest rename: tail is ignored and append stays safe', () => {
  const dir = tmpdir();
  const store = Store.create(dir);
  store.appendOrder(O1);

  // Simulate a power loss after the chunk bytes hit data.bin but before
  // manifest.tmp was renamed: an unindexed tail plus a stale temp file.
  const dataPath = path.join(dir, DATA_FILE);
  const payload = Buffer.from(JSON.stringify({ t: 'order', order: O2 }), 'utf8');
  fs.appendFileSync(dataPath, encodeChunk(payload));
  fs.writeFileSync(path.join(dir, 'manifest.tmp'), '{"version":1,"chunks":[');
  const sizeWithTail = fs.statSync(dataPath).size;

  const reopened = Store.open(dir);
  assert.deepEqual(reopened.orders, [O1]);
  assert.deepEqual(reopened.loads, { M1: 10 });
  assert.ok(fs.statSync(dataPath).size < sizeWithTail, 'tail must be truncated');

  // Appending after the crash reuses the truncated tail safely.
  reopened.appendOrder(O2);
  reopened.appendOrder(O3);
  const again = Store.open(dir);
  assert.deepEqual(again.orders, [O1, O2, O3]);
  assert.deepEqual(again.loads, { M1: 17, M2: 20 });
});

test('inconsistent manifest index raises E_INDEX', () => {
  const dir = tmpdir();
  const store = Store.create(dir);
  store.appendOrder(O1);
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.chunks[0].offset = 4; // index no longer lines up with the data
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => Store.open(dir), { code: 'E_INDEX' });
});

test('opening a non-store directory raises E_STATE', () => {
  assert.throws(() => Store.open(tmpdir()), { code: 'E_STATE' });
});

test('unknown checkpoint raises E_STATE', () => {
  const dir = tmpdir();
  const store = Store.create(dir);
  assert.throws(() => store.rollback('nope'), { code: 'E_STATE' });
});
