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

test('compensation from a pre-rename crash is invisible after restart', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.createBatch('B', { baseline: 10, tolerance: 0.1, time: 1000 });
  store.append('B', { value: 10.5, time: 2000 }); // out of tolerance -> FAIL
  assert.equal(store.decode('B').judgment.pass, false);

  // Simulate a crashed commit: the chunk data file was written and the new
  // manifest was staged as a temp file, but the manifest rename never ran.
  const st = store._batches.get('B');
  const chunkSeq = store.manifest.nextChunkSeq;
  const file = `chunk-${String(chunkSeq).padStart(6, '0')}.bin`;
  const buf = encodeChunk({
    chunkSeq,
    batchId: 'B',
    baseTime: 3000,
    baseValueScaled: st.chainValueScaled,
    records: [
      {
        type: RecordType.COMPENSATE,
        targetSeq: 1,
        time: 3000,
        valueScaled: Math.round(10.05 * 1e6),
        reason: 'crashed fix',
      },
    ],
  });
  fs.writeFileSync(path.join(dir, 'chunks', file), buf); // orphan data file
  const stagedManifest = {
    ...store.manifest,
    nextChunkSeq: chunkSeq + 1,
    chunks: [...store.manifest.chunks, { file, batchId: 'B', records: 1 }],
  };
  fs.writeFileSync(
    path.join(dir, 'manifest.json.tmp-1234'),
    JSON.stringify(stagedManifest)
  );

  // Restart: only the committed manifest is read; the orphan chunk and the
  // staged manifest temp file are ignored, so the compensation is invisible.
  const reopened = Store.open(dir);
  const d = reopened.decode('B');
  assert.equal(d.judgment.pass, false);
  assert.equal(d.corrections.length, 0);
  assert.equal(d.history.filter((h) => h.type === 'compensation').length, 0);
  assert.equal(reopened.manifest.chunks.some((c) => c.file === file), false);

  // The store still works afterwards: a real commit reuses the chunk sequence
  // and becomes visible.
  reopened.correct('B', 1, { value: 10.05, reason: 'real fix', time: 4000 });
  const again = Store.open(dir);
  assert.equal(again.decode('B').judgment.pass, true);
  assert.equal(again.decode('B').corrections.length, 1);
});
