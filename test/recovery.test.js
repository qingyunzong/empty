'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const {
  appendBatch,
  flush,
  recover,
  openDb,
  scanWal,
  walPath,
  readManifest,
  segmentFileName,
  indexFileName,
} = require('../src/storage');
const { executeQuery } = require('../src/query');

const T0 = Date.parse('2026-10-01T00:00:00Z');
const rec = (i) => ({ ts: T0 + i * 1000, device: `dev-${i}`, code: 'X', value: i });

function allRecords(dir) {
  return executeQuery(dir, 'where value >= 0').records;
}

test('fault point 1: crash before WAL commit truncates corrupt tail', () => {
  const dir = tmpDir('rec-');
  appendBatch(dir, [rec(1), rec(2), rec(3)]);
  const sizeBefore = fs.statSync(walPath(dir)).size;
  fs.appendFileSync(walPath(dir), '{"crc":999,"payload":"{"');
  fs.appendFileSync(walPath(dir), 'not json at all\n');
  const stats = recover(dir);
  assert.ok(stats.truncatedBytes > 0);
  assert.equal(fs.statSync(walPath(dir)).size, sizeBefore);
  assert.deepEqual(allRecords(dir).map((r) => r.value), [1, 2, 3]);
});

test('fault point 1b: bad crc batch is dropped, later valid prefix kept', () => {
  const dir = tmpDir('rec-');
  appendBatch(dir, [rec(1)]);
  const wal = fs.readFileSync(walPath(dir), 'utf8');
  const corrupted = wal.replace(/"crc":\d+/, '"crc":1');
  assert.notEqual(corrupted, wal);
  fs.writeFileSync(walPath(dir), corrupted);
  const stats = recover(dir);
  assert.ok(stats.truncatedBytes > 0);
  assert.equal(allRecords(dir).length, 0);
});

test('fault point 2: orphan segment after flush-before-manifest is removed', () => {
  const dir = tmpDir('rec-');
  appendBatch(dir, [rec(1), rec(2)]);
  const orphanName = segmentFileName(7);
  fs.writeFileSync(
    path.join(dir, orphanName),
    JSON.stringify({ ...rec(99), seq: 99 }) + '\n',
  );
  fs.writeFileSync(path.join(dir, indexFileName(7)), '{}');
  const stats = recover(dir);
  assert.deepEqual(stats.removedOrphans.sort(), [indexFileName(7), orphanName].sort());
  assert.ok(!fs.existsSync(path.join(dir, orphanName)));
  assert.deepEqual(allRecords(dir).map((r) => r.value), [1, 2]);
});

test('fault point 3: missing index after manifest update is rebuilt', () => {
  const dir = tmpDir('rec-');
  appendBatch(dir, [rec(1), rec(2), rec(3)]);
  flush(dir);
  const idxPath = path.join(dir, indexFileName(1));
  assert.ok(fs.existsSync(idxPath));
  fs.unlinkSync(idxPath);
  const stats = recover(dir);
  assert.deepEqual(stats.rebuiltIndexes, [1]);
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  assert.equal(idx.count, 3);
  assert.equal(idx.minTs, T0 + 1000);
  assert.equal(idx.maxTs, T0 + 3000);
  assert.deepEqual(allRecords(dir).map((r) => r.value), [1, 2, 3]);
});

test('stale index that disagrees with manifest is rebuilt', () => {
  const dir = tmpDir('rec-');
  appendBatch(dir, [rec(1), rec(2)]);
  flush(dir);
  fs.writeFileSync(path.join(dir, indexFileName(1)), JSON.stringify({ segmentId: 1, count: 999 }));
  const stats = recover(dir);
  assert.deepEqual(stats.rebuiltIndexes, [1]);
});

test('wal records already covered by manifest are dropped on recovery', () => {
  const dir = tmpDir('rec-');
  appendBatch(dir, [rec(1), rec(2)]);
  flush(dir);
  const walContent = fs.readFileSync(walPath(dir), 'utf8');
  assert.equal(walContent, '');
  const manifest = readManifest(dir);
  const dup = [
    { ts: T0 + 1000, device: 'dev-1', code: 'X', value: 1, seq: 1 },
    { ts: T0 + 2000, device: 'dev-2', code: 'X', value: 2, seq: 2 },
  ];
  const payload = JSON.stringify({ records: dup });
  const { crc32 } = require('../src/crc32');
  fs.writeFileSync(walPath(dir), JSON.stringify({ crc: crc32(Buffer.from(payload)), payload }) + '\n');
  const stats = recover(dir);
  assert.equal(stats.droppedWalRecords, 2);
  assert.equal(manifest.lastSeq, 2);
  assert.deepEqual(allRecords(dir).map((r) => r.value), [1, 2]);
});

test('recover on missing directory reports RECOVERY_ERROR via exception', () => {
  const dir = path.join(tmpDir('rec-'), 'no-such-db');
  assert.throws(() => recover(dir), /does not exist/);
});

test('recover on corrupt manifest throws RecoveryError', () => {
  const dir = tmpDir('rec-');
  appendBatch(dir, [rec(1)]);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{not json');
  assert.throws(() => recover(dir), /manifest/);
});

test('recover on missing segment referenced by manifest throws RecoveryError', () => {
  const dir = tmpDir('rec-');
  appendBatch(dir, [rec(1), rec(2)]);
  flush(dir);
  fs.unlinkSync(path.join(dir, segmentFileName(1)));
  assert.throws(() => recover(dir), /segment file/);
});

test('clean database recovers as a no-op', () => {
  const dir = tmpDir('rec-');
  appendBatch(dir, [rec(1), rec(2)]);
  flush(dir);
  appendBatch(dir, [rec(3)]);
  const stats = recover(dir);
  assert.equal(stats.truncatedBytes, 0);
  assert.equal(stats.removedOrphans.length, 0);
  assert.equal(stats.rebuiltIndexes.length, 0);
  assert.deepEqual(allRecords(dir).map((r) => r.value), [1, 2, 3]);
  assert.equal(scanWal(dir).records.length, 1);
});
