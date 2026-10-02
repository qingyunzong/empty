import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from '../src/crc32.js';
import { encodeRecord, scanBuffer, recoverWal, WalWriter, WalError } from '../src/wal.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walstore-wal-'));
}

test('crc32 matches known vectors', () => {
  // CRC-32/ISO-HDLC of "123456789" is 0xCBF43926.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('encode/scan round-trips records', () => {
  const records = [
    { seq: 1, txn: 1, op: 'set', device: 'd1', key: 'k', oldValue: null, newValue: 1 },
    { seq: 2, txn: 2, op: 'del', device: 'd1', key: 'k', oldValue: 1, newValue: null },
  ];
  const buf = Buffer.concat(records.map(encodeRecord));
  const { records: scanned, endOffset, truncated } = scanBuffer(buf);
  assert.deepEqual(scanned, records);
  assert.equal(endOffset, buf.length);
  assert.equal(truncated, false);
});

test('scan reports a partial tail as truncated at the record offset', () => {
  const good = encodeRecord({ seq: 1 });
  const torn = encodeRecord({ seq: 2 }).subarray(0, 11); // torn mid-payload
  const { records, endOffset, truncated } = scanBuffer(Buffer.concat([good, torn]));
  assert.equal(records.length, 1);
  assert.equal(endOffset, good.length);
  assert.equal(truncated, true);
});

test('checksum mismatch on a complete frame throws with the record offset', () => {
  const first = encodeRecord({ seq: 1 });
  const second = Buffer.from(encodeRecord({ seq: 2, payload: 'x'.repeat(30) }));
  second[second.length - 1] ^= 0xff; // flip a payload bit, keep length intact
  assert.throws(
    () => scanBuffer(Buffer.concat([first, second])),
    (error) => {
      assert.ok(error instanceof WalError);
      assert.equal(error.code, 'CHECKSUM_MISMATCH');
      assert.equal(error.offset, first.length);
      assert.match(error.message, new RegExp(`offset ${first.length}`));
      return true;
    },
  );
});

test('recoverWal truncates a torn tail so appends stay well-formed', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'wal.log');
  const writer = new WalWriter(walPath);
  writer.append({ seq: 1 });
  writer.append({ seq: 2 });
  writer.close();
  const size = fs.statSync(walPath).size;
  fs.truncateSync(walPath, size - 5); // tear the tail of record 2
  const recovered = recoverWal(walPath);
  assert.equal(recovered.truncated, true);
  assert.deepEqual(recovered.records, [{ seq: 1 }]);
  assert.equal(fs.statSync(walPath).size, recovered.endOffset);
  const writer2 = new WalWriter(walPath);
  writer2.append({ seq: 2 });
  writer2.close();
  assert.deepEqual(recoverWal(walPath).records, [{ seq: 1 }, { seq: 2 }]);
});

test('append hooks fire at the write and fsync fault-injection points', () => {
  const dir = tmpdir();
  const writer = new WalWriter(path.join(dir, 'wal.log'));
  const calls = [];
  writer.append({ seq: 1 }, {
    onAfterWrite: () => calls.push('write'),
    onAfterFsync: () => calls.push('fsync'),
  });
  writer.close();
  assert.deepEqual(calls, ['write', 'fsync']);
});
