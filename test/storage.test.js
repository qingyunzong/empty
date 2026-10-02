import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBatch, allCommittedRecords, readManifest } from '../src/storage.js';
import { executeQuery } from '../src/query.js';

function tmpDb() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logdb-storage-'));
}

test('append commits records and clears the WAL', () => {
  const dir = tmpDb();
  const recs = [
    { ts: 1000, device: 'a', code: 'I1', value: 1 },
    { ts: 2000, device: 'b', code: 'I2', value: 2 },
  ];
  const { appended } = appendBatch(dir, recs);
  assert.equal(appended, 2);
  const committed = allCommittedRecords(dir);
  assert.equal(committed.length, 2);
  assert.deepEqual(committed.map((r) => r.seq), [0, 1]);
  assert.equal(fs.statSync(path.join(dir, 'wal.log')).size, 0);
  const m = readManifest(dir);
  assert.equal(m.nextSeq, 2);
  assert.equal(m.segments.length, 1);
});

test('sequence numbers keep increasing across batches', () => {
  const dir = tmpDb();
  appendBatch(dir, [{ ts: 1, device: 'a', code: 'c', value: 1 }]);
  appendBatch(dir, [
    { ts: 2, device: 'a', code: 'c', value: 2 },
    { ts: 3, device: 'a', code: 'c', value: 3 },
  ]);
  assert.deepEqual(allCommittedRecords(dir).map((r) => r.seq), [0, 1, 2]);
});

test('out-of-order timestamps are output sorted by ts, device, seq', () => {
  const dir = tmpDb();
  appendBatch(dir, [
    { ts: 3000, device: 'b', code: 'c', value: 1 }, // seq 0
    { ts: 1000, device: 'z', code: 'c', value: 2 }, // seq 1
    { ts: 1000, device: 'a', code: 'c', value: 3 }, // seq 2
    { ts: 1000, device: 'a', code: 'c', value: 4 }, // seq 3
    { ts: 2000, device: 'a', code: 'c', value: 5 }, // seq 4
  ]);
  const out = executeQuery(dir, 'value > 0');
  assert.deepEqual(out.result.map((r) => r.seq), [2, 3, 1, 4, 0]);
  assert.deepEqual(
    out.result.map((r) => [r.ts, r.device, r.seq]),
    [[1000, 'a', 2], [1000, 'a', 3], [1000, 'z', 1], [2000, 'a', 4], [3000, 'b', 0]],
  );
});
