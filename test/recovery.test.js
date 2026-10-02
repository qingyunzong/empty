import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendBatch, recover, allCommittedRecords, readManifest, RecoveryError,
} from '../src/storage.js';

function tmpDb() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logdb-recovery-'));
}

const rec = (ts, device, value) => ({ ts, device, code: 'E1', value });

test('fault point 1: crash before WAL commit leaves a corrupt tail that is truncated', () => {
  const dir = tmpDb();
  appendBatch(dir, [rec(1000, 'a', 1), rec(2000, 'a', 2)]);
  // simulate a torn write at the WAL tail
  fs.appendFileSync(path.join(dir, 'wal.log'), Buffer.from([0x20, 0x00, 0x00]));
  const summary = recover(dir);
  assert.equal(summary.truncatedWalBytes, 3);
  assert.deepEqual(allCommittedRecords(dir).map((r) => r.value), [1, 2]);
});

test('fault point 1b: checksum failure mid-WAL drops only the uncommitted suffix', () => {
  const dir = tmpDb();
  appendBatch(dir, [rec(1000, 'a', 1)]);
  // two more batches committed to the WAL but never flushed to a segment
  appendBatch(dir, [rec(2000, 'a', 2)], { stopAfter: 'wal' });
  appendBatch(dir, [rec(3000, 'a', 3)], { stopAfter: 'wal' });
  // corrupt the first of the two pending WAL frames: everything from the
  // corruption point on (both pending records) must be dropped
  const wal = path.join(dir, 'wal.log');
  const buf = fs.readFileSync(wal);
  buf[6] ^= 0xff; // flip a payload byte in the first frame -> crc mismatch
  fs.writeFileSync(wal, buf);
  const summary = recover(dir);
  assert.ok(summary.truncatedWalBytes > 0);
  assert.equal(summary.replayedRecords, 0); // first frame already in a segment
  assert.deepEqual(allCommittedRecords(dir).map((r) => r.value), [1]);
});

test('fault point 2: segment flushed but manifest not updated -> orphan removed, WAL replayed', () => {
  const dir = tmpDb();
  appendBatch(dir, [rec(1000, 'a', 1)]);
  appendBatch(dir, [rec(2000, 'b', 2), rec(3000, 'b', 3)], { stopAfter: 'segment' });
  // orphan segment exists on disk but is not in the manifest
  const before = fs.readdirSync(path.join(dir, 'segments')).filter((f) => f.endsWith('.jsonl'));
  assert.equal(before.length, 2);
  const summary = recover(dir);
  assert.equal(summary.orphansRemoved.length, 1);
  assert.equal(summary.replayedRecords, 2);
  const committed = allCommittedRecords(dir);
  assert.deepEqual(committed.map((r) => r.value), [1, 2, 3]);
  assert.deepEqual(committed.map((r) => r.seq), [0, 1, 2]);
});

test('fault point 3: manifest updated but index missing -> index rebuilt, no duplicates', () => {
  const dir = tmpDb();
  appendBatch(dir, [rec(1000, 'a', 1)]);
  appendBatch(dir, [rec(2000, 'b', 2), rec(1500, 'c', 3)], { stopAfter: 'manifest' });
  const idxFiles = () => fs.readdirSync(path.join(dir, 'segments')).filter((f) => f.endsWith('.idx.json'));
  assert.equal(idxFiles().length, 1); // second segment has no index yet
  const summary = recover(dir);
  assert.equal(summary.indexesRebuilt.length, 1);
  assert.equal(summary.replayedRecords, 0); // WAL prefix already committed
  assert.equal(fs.statSync(path.join(dir, 'wal.log')).size, 0);
  const committed = allCommittedRecords(dir);
  assert.deepEqual(committed.map((r) => r.value), [1, 2, 3]);
  assert.equal(idxFiles().length, 2);
});

test('recovery exposes exactly the last committed prefix after mixed crashes', () => {
  const dir = tmpDb();
  appendBatch(dir, [rec(1, 'a', 10)]);
  appendBatch(dir, [rec(2, 'a', 20)], { stopAfter: 'wal' });
  appendBatch(dir, [rec(3, 'a', 30)], { stopAfter: 'segment' });
  recover(dir);
  assert.deepEqual(allCommittedRecords(dir).map((r) => r.value), [10, 20, 30]);
  // database keeps working after recovery
  appendBatch(dir, [rec(4, 'a', 40)]);
  assert.deepEqual(allCommittedRecords(dir).map((r) => r.value), [10, 20, 30, 40]);
});

test('corrupt manifest raises RecoveryError', () => {
  const dir = tmpDb();
  appendBatch(dir, [rec(1, 'a', 1)]);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"version":1,"nextSeq":99');
  assert.throws(() => recover(dir), RecoveryError);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    version: 1, nextSeq: 99, nextSeg: 2, segments: [], checksum: 12345,
  }));
  assert.throws(() => recover(dir), /checksum/);
});

test('recover on missing directory raises RecoveryError', () => {
  assert.throws(() => recover(path.join(os.tmpdir(), 'logdb-does-not-exist-xyz')), RecoveryError);
});
