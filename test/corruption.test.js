import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qrec-'));
}

test('corrupted chunk: E_CRC, boundary isolation, restart consistency', () => {
  const dir = tmpdir();
  const store = Store.open(dir, { maxRecordsPerChunk: 1 });
  store.createBatch('B', { baseline: 0, tolerance: 1, time: 1000 });
  store.append('B', { value: 0.1, time: 2000 });
  store.append('B', { value: 0.2, time: 3000 });
  store.append('B', { value: 0.3, time: 4000 });
  // chunks: [baseline, m1, m2, m3]
  const files = store.manifest.chunks.map((c) => c.file);
  assert.equal(files.length, 4);

  // corrupt a payload byte inside the third chunk (m2), CRC stays stale
  const target = path.join(dir, 'chunks', files[2]);
  const buf = fs.readFileSync(target);
  buf[buf.length - 6] ^= 0xff;
  fs.writeFileSync(target, buf);

  // strict open fails with E_CRC
  assert.throws(() => Store.open(dir, { maxRecordsPerChunk: 1 }), (e) => {
    assert.equal(e.code, 'E_CRC');
    return true;
  });

  // non-strict open: state before the corrupted boundary is intact,
  // nothing at or after the boundary is applied
  const s2 = Store.open(dir, { maxRecordsPerChunk: 1, strict: false });
  assert.equal(s2.errors.length, 1);
  assert.equal(s2.errors[0].code, 'E_CRC');
  assert.equal(s2.errors[0].file, files[2]);
  const d2 = s2.decode('B');
  const vals2 = d2.history.filter((h) => h.type === 'measurement').map((h) => h.value);
  assert.deepEqual(vals2, [0.1]); // m1 survives, m2 (corrupt) and m3 (after boundary) absent
  assert.equal(d2.judgment.pass, true);

  // restart scan: identical result
  const s3 = Store.open(dir, { maxRecordsPerChunk: 1, strict: false });
  assert.deepEqual(s3.decode('B'), s2.decode('B'));
  assert.deepEqual(
    s3.errors.map((e) => e.code),
    ['E_CRC']
  );
});

test('corrupting the CRC bytes themselves is detected', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.createBatch('B', { baseline: 0, tolerance: 1, time: 1000 });
  store.append('B', { value: 0.1, time: 2000 });
  const file = store.manifest.chunks[1].file;
  const target = path.join(dir, 'chunks', file);
  const buf = fs.readFileSync(target);
  buf[buf.length - 1] ^= 0x01; // flip a CRC bit
  fs.writeFileSync(target, buf);
  assert.throws(() => Store.open(dir), (e) => e.code === 'E_CRC');
});
