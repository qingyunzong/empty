import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { encodeChunk, RecordType } from '../src/chunk.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qrec-'));
}

test('late correction changes final judgment; audit reproduces old judgment', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.createBatch('B', { baseline: 10, tolerance: 0.1, time: 1000 });
  store.append('B', { value: 10.05, time: 2000 }); // seq 1, in tolerance
  store.append('B', { value: 10.5, time: 3000 }); // seq 2, out of tolerance

  const before = store.decode('B');
  assert.equal(before.judgment.pass, false);
  assert.deepEqual(before.judgment.failures, [2]);
  const recordCountBefore = before.recordCount;

  // late correction: must not overwrite, appends a compensation record
  store.correct('B', 2, { value: 10.08, reason: 'sensor recalibrated', time: 4000 });

  const after = store.decode('B');
  assert.equal(after.judgment.pass, true);
  assert.deepEqual(after.judgment.failures, []);

  // original history preserved and marked superseded
  const orig = after.history.find((h) => h.type === 'measurement' && h.seq === 2);
  assert.equal(orig.value, 10.5);
  assert.equal(orig.superseded, true);
  assert.equal(orig.passes, false);

  // compensation carries the correction reason and old/new values
  assert.equal(after.corrections.length, 1);
  assert.equal(after.corrections[0].targetSeq, 2);
  assert.equal(after.corrections[0].reason, 'sensor recalibrated');
  assert.equal(after.corrections[0].oldValue, 10.5);
  assert.equal(after.corrections[0].newValue, 10.08);

  // effective value reflects the correction
  const eff2 = after.effective.find((m) => m.seq === 2);
  assert.equal(eff2.value, 10.08);
  assert.equal(eff2.corrected, true);
  assert.equal(eff2.reason, 'sensor recalibrated');
  assert.equal(eff2.passes, true);

  // audit: replaying only the records known at the time reproduces the old judgment
  const audit = store.decode('B', { upToRecords: recordCountBefore });
  assert.equal(audit.judgment.pass, false);
  assert.deepEqual(audit.judgment.failures, [2]);
  assert.equal(audit.corrections.length, 0);

  // persistence: same story after reopen
  const reopened = Store.open(dir);
  assert.equal(reopened.decode('B').judgment.pass, true);
  assert.equal(reopened.decode('B', { upToRecords: recordCountBefore }).judgment.pass, false);
});

test('compensation referencing unknown measurement -> E_REFERENCE (API path)', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.createBatch('B', { baseline: 0, tolerance: 1, time: 1000 });
  store.append('B', { value: 0.1, time: 2000 });
  assert.throws(() => store.correct('B', 99, { value: 0.2, reason: 'x' }), (e) => {
    assert.equal(e.code, 'E_REFERENCE');
    return true;
  });
  // failed correction leaves no trace
  assert.equal(store.decode('B').corrections.length, 0);
});

test('compensation referencing unknown measurement -> E_REFERENCE (scan path)', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.createBatch('B', { baseline: 0, tolerance: 1, time: 1000 });
  store.append('B', { value: 0.1, time: 2000 });

  // hand-craft a chunk whose compensation points at a nonexistent seq
  const st = store._batches.get('B');
  const chunkSeq = store.manifest.nextChunkSeq;
  const file = `chunk-${String(chunkSeq).padStart(6, '0')}.bin`;
  const buf = encodeChunk({
    chunkSeq,
    batchId: 'B',
    baseTime: 3000,
    baseValueScaled: st.chainValueScaled,
    records: [
      { type: RecordType.COMPENSATE, targetSeq: 42, time: 3000, valueScaled: 100000, reason: 'bad' },
    ],
  });
  fs.writeFileSync(path.join(dir, 'chunks', file), buf);
  const manifest = {
    ...store.manifest,
    nextChunkSeq: chunkSeq + 1,
    chunks: [...store.manifest.chunks, { file, batchId: 'B', records: 1 }],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

  assert.throws(() => Store.open(dir), (e) => {
    assert.equal(e.code, 'E_REFERENCE');
    return true;
  });
  const lax = Store.open(dir, { strict: false });
  assert.equal(lax.errors.length, 1);
  assert.equal(lax.errors[0].code, 'E_REFERENCE');
  // the bad record is not applied
  assert.equal(lax.decode('B').corrections.length, 0);
});
