import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from '../src/crc32.js';
import { encodeChunk, decodeChunk } from '../src/chunk.js';
import { Store } from '../src/store.js';
import { tmpRoot, at } from './helpers.js';

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('chunk encode/decode roundtrip', () => {
  const records = [
    { type: 'baseline', seq: 0, value: 100, at: at(0) },
    { type: 'measure', seq: 1, delta: 0.5, at: at(1) },
  ];
  const buf = encodeChunk(0, records);
  assert.deepEqual(decodeChunk(buf, 0), records);
});

test('delta encoding across chunks: independent sum/extremes/tolerance cross-check', () => {
  const root = tmpRoot();
  const store = new Store(root);
  const batchId = 'B-001';
  const baseline = 100;
  const min = 95;
  const max = 105;
  const measures = [100.5, 99.5, 101, 98, 103, 104.5];
  store.initBatch({ batchId, baseline, min, max, chunkSize: 2, at: at(0) });
  measures.forEach((v, i) => store.appendMeasure(batchId, { value: v, at: at(i + 1) }));

  const view = store.decode(batchId);
  const expectedValues = [baseline, ...measures];
  assert.deepEqual(view.history.map((h) => h.value), expectedValues);
  assert.equal(view.history.length, 7);
  assert.equal(view.effective.value, 104.5);
  assert.equal(view.effective.judgment, 'pass');

  // Independent cross-check straight from the chunk files on disk:
  // re-parse payloads, re-sum deltas, recompute extremes and judgments.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, batchId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.chunks.length, 4); // ceil(7 / 2)
  const rawRecords = [];
  for (const meta of manifest.chunks) {
    const buf = fs.readFileSync(path.join(root, batchId, meta.file));
    const nl = buf.indexOf(0x0a);
    const header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    const payload = buf.subarray(nl + 1);
    assert.equal(crc32(payload), header.crc32, `crc of ${meta.file}`);
    rawRecords.push(...payload.toString('utf8').trim().split('\n').map((l) => JSON.parse(l)));
  }
  // independent sum: baseline + sum(deltas) must equal the final value
  let sum = 0;
  for (const r of rawRecords) if (r.type !== 'baseline') sum += r.delta;
  assert.equal(baseline + sum, expectedValues[expectedValues.length - 1]);
  // independent extremes
  assert.equal(Math.min(...expectedValues), Math.min(...view.history.map((h) => h.value)));
  assert.equal(Math.max(...expectedValues), Math.max(...view.history.map((h) => h.value)));
  // independent tolerance enumeration
  for (const h of view.history) {
    const expected = h.value >= min && h.value <= max ? 'pass' : 'fail';
    assert.equal(h.judgment, expected, `judgment of seq ${h.seq}`);
  }
});

test('out-of-tolerance measurement is a judgment, not a file error', () => {
  const root = tmpRoot();
  const store = new Store(root);
  store.initBatch({ batchId: 'B-002', baseline: 100, min: 95, max: 105, at: at(0) });
  store.appendMeasure('B-002', { value: 120, at: at(1) });
  const view = store.decode('B-002');
  assert.equal(view.effective.value, 120);
  assert.equal(view.effective.judgment, 'fail');
  assert.equal(view.history[1].judgment, 'fail');
});

test('invalid input rejected', () => {
  const root = tmpRoot();
  const store = new Store(root);
  assert.throws(() => store.initBatch({ batchId: 'x', baseline: 1, min: 5, max: 0 }), /min must be <= max/);
  assert.throws(() => store.initBatch({ batchId: 'bad/id', baseline: 1, min: 0, max: 2 }), /invalid batch id/);
  store.initBatch({ batchId: 'B-003', baseline: 1, min: 0, max: 2 });
  assert.throws(() => store.initBatch({ batchId: 'B-003', baseline: 1, min: 0, max: 2 }), /already exists/);
  assert.throws(() => store.appendMeasure('B-003', { value: NaN }), /finite/);
  assert.throws(() => store.decode('nope'), /unknown batch/);
});
