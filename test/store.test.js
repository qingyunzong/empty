import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store, encodeRecord, decodeRecords } from '../src/store.js';
import { History } from '../src/history.js';
import { tmpdir } from '../support/helpers.js';

function buildStore() {
  const dir = tmpdir();
  const h = new History(dir);
  const r1 = h.put({ tradeId: 'T1', price: 100, quantity: 10, author: 'alice' }).hash;
  const r2 = h.replace({ tradeId: 'T1', price: 101, author: 'bob' }).hash;
  const r3 = h.replace({ tradeId: 'T1', quantity: 20, author: 'carol' }).hash;
  return { dir, h, hashes: [r1, r2, r3] };
}

test('append and read back records with offsets and crc', () => {
  const { dir, hashes } = buildStore();
  const store = new Store(dir);
  const { records, error } = store.readAll();
  assert.equal(error, null);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.rev.hash), hashes);
  const index = store.loadIndex();
  for (const { offset, rev } of records) assert.equal(index.offsets[rev.hash], offset);
  assert.deepEqual(index.heads.T1, [hashes[2]]);
});

test('corrupted payload is detected via crc32', () => {
  const { dir } = buildStore();
  const store = new Store(dir);
  const buf = fs.readFileSync(store.dataFile);
  buf[buf.length - 2] ^= 0xff;
  fs.writeFileSync(store.dataFile, buf);
  const { error } = store.readAll();
  assert.ok(error && error.message.includes('crc32'));
  const v = store.verify();
  assert.equal(v.ok, false);
  assert.equal(v.code, 'DATA_CORRUPT');
});

test('deleted index is rebuilt from the reverse chain', () => {
  const { dir, hashes } = buildStore();
  const store = new Store(dir);
  fs.rmSync(store.indexFile);
  let v = store.verify();
  assert.equal(v.ok, false);
  assert.equal(v.code, 'INDEX_MISSING');
  v = store.verify({ rebuild: true });
  assert.equal(v.ok, true);
  assert.equal(v.rebuilt, true);
  assert.deepEqual(v.heads.T1, [hashes[2]]);
  // rebuilt index matches a fresh scan
  assert.deepEqual(store.loadIndex().heads.T1, [hashes[2]]);
});

test('corrupted index is rebuilt by verify --rebuild', () => {
  const { dir, hashes } = buildStore();
  const store = new Store(dir);
  fs.writeFileSync(store.indexFile, '{"offsets":{"deadbeef":0},"heads":{}}');
  let v = store.verify();
  assert.equal(v.ok, false);
  assert.equal(v.code, 'INDEX_CORRUPT');
  v = store.verify({ rebuild: true });
  assert.equal(v.ok, true);
  assert.equal(v.wasCorrupt, true);
  assert.deepEqual(v.heads.T1, [hashes[2]]);
});

test('broken reverse chain reports the first missing version', () => {
  const { dir, hashes } = buildStore();
  const store = new Store(dir);
  const { records } = store.readAll();
  // drop the middle record (r2) so r3's parent is missing
  const kept = records.filter((r) => r.rev.hash !== hashes[1]);
  fs.writeFileSync(store.dataFile, Buffer.concat(kept.map((r) => encodeRecord(r.rev))));
  const v = store.verify({ rebuild: true });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'BROKEN_CHAIN');
  assert.equal(v.missing, hashes[1]);
});

test('encode/decode roundtrip preserves revision fields', () => {
  const rev = {
    tradeId: 'T9',
    op: 'merge',
    parents: ['aaa', 'bbb'],
    author: 'zoe',
    seq: 4,
    changes: { price: 1.5 },
    winner: null,
    ts: 123,
  };
  rev.hash = 'x'.repeat(32);
  // hash must be valid for decode; recompute via a real store append instead
  const dir = tmpdir();
  const h = new History(dir);
  const put = h.put({ tradeId: 'T9', price: 1.5, quantity: 2, author: 'zoe' });
  const buf = encodeRecord(put.revision);
  const { records, error } = decodeRecords(buf);
  assert.equal(error, null);
  assert.equal(records[0].rev.hash, put.hash);
  assert.equal(records[0].offset, 0);
});
