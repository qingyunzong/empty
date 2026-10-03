import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.js';
import { encodeRecord, scanWalBuffer, scanWalStrict, HEADER_SIZE } from '../src/wal.js';

test('crc32 known vectors', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('hello world', 'utf8')), 0x0d4a1185);
});

test('encode/scan roundtrip preserves records and offsets', () => {
  const recs = [
    { txn: 1, op: 'set', key: 'a', deviceId: 'dev-1', oldValue: null, newValue: 1 },
    { txn: 2, op: 'set', key: 'b', deviceId: 'dev-2', oldValue: null, newValue: { x: [1, 2] } },
    { txn: 3, op: 'del', key: 'a', deviceId: 'dev-1', oldValue: 1, newValue: null },
  ];
  const buf = Buffer.concat(recs.map(encodeRecord));
  const { records, corruptOffset } = scanWalBuffer(buf);
  assert.equal(corruptOffset, null);
  assert.deepEqual(records.map((r) => r.record), recs);
  let expected = 0;
  for (let i = 0; i < recs.length; i++) {
    assert.equal(records[i].offset, expected);
    expected += encodeRecord(recs[i]).length;
  }
});

test('checksum failure reports the exact record offset', () => {
  const recs = [
    { txn: 1, op: 'set', key: 'a', deviceId: 'd', oldValue: null, newValue: 1 },
    { txn: 2, op: 'set', key: 'b', deviceId: 'd', oldValue: null, newValue: 2 },
    { txn: 3, op: 'set', key: 'c', deviceId: 'd', oldValue: null, newValue: 3 },
  ];
  const encoded = recs.map(encodeRecord);
  const secondOffset = encoded[0].length;
  const buf = Buffer.concat(encoded);
  buf[secondOffset + HEADER_SIZE] ^= 0xff; // flip a payload byte of record 2
  const { records, corruptOffset, reason } = scanWalBuffer(buf);
  assert.equal(reason, 'checksum');
  assert.equal(corruptOffset, secondOffset);
  assert.deepEqual(records.map((r) => r.record), [recs[0]]);
  assert.throws(() => scanWalStrict(buf), (err) => {
    assert.equal(err.code, 'CHECKSUM_MISMATCH');
    assert.equal(err.details.offset, secondOffset);
    return true;
  });
});

test('torn tail (truncated header and payload) is detected at the cut point', () => {
  const recs = [
    { txn: 1, op: 'set', key: 'a', deviceId: 'd', oldValue: null, newValue: 1 },
    { txn: 2, op: 'set', key: 'b', deviceId: 'd', oldValue: null, newValue: 2 },
  ];
  const encoded = recs.map(encodeRecord);
  const full = Buffer.concat(encoded);

  const cutPayload = encoded[0].length + HEADER_SIZE + 3;
  const scan1 = scanWalBuffer(full.subarray(0, cutPayload));
  assert.equal(scan1.reason, 'truncated-payload');
  assert.equal(scan1.corruptOffset, encoded[0].length);
  assert.equal(scan1.records.length, 1);

  const cutHeader = encoded[0].length + 3;
  const scan2 = scanWalBuffer(full.subarray(0, cutHeader));
  assert.equal(scan2.reason, 'truncated-header');
  assert.equal(scan2.corruptOffset, encoded[0].length);
  assert.equal(scan2.records.length, 1);
});
