import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, SCALE } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qrec-'));
}

test('small-scale values cross-checked by independent sum and extremes', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.createBatch('B1', { baseline: 100, tolerance: 0.5, time: 1000 });
  const values = [100.1, 99.85, 100.42, 99.97, 100.0, 100.49, 99.5, 100.5];
  values.forEach((v, i) => store.append('B1', { value: v, time: 2000 + i }));

  const decoded = store.decode('B1');
  const got = decoded.history.filter((h) => h.type === 'measurement').map((h) => h.valueScaled);
  // independent recomputation straight from the source values
  const expected = values.map((v) => Math.round(v * 1_000_000));
  assert.deepEqual(got, expected);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  assert.equal(sum(got), sum(expected));
  assert.equal(Math.min(...got), Math.min(...expected));
  assert.equal(Math.max(...got), Math.max(...expected));
  assert.equal(decoded.baselineScaled, Math.round(100 * SCALE));

  // persistence: reopen from disk and decode identically
  const reopened = Store.open(dir);
  assert.deepEqual(reopened.decode('B1'), decoded);
});

test('tolerance enumeration: boundary is inclusive, outside fails', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.createBatch('B', { baseline: 50, tolerance: 0.5, time: 1000 });
  const offsets = [];
  for (let o = -0.6; o <= 0.6001; o += 0.05) offsets.push(Number(o.toFixed(2)));
  offsets.forEach((o, i) => store.append('B', { value: 50 + o, time: 2000 + i }));

  const decoded = store.decode('B');
  assert.equal(decoded.effective.length, offsets.length);
  decoded.effective.forEach((m, i) => {
    const expectPass = Math.abs(offsets[i]) <= 0.5 + 1e-12;
    assert.equal(m.passes, expectPass, `offset ${offsets[i]} (value ${m.value})`);
  });
  // exact boundary values pass
  const atLo = decoded.effective[offsets.indexOf(-0.5)];
  const atHi = decoded.effective[offsets.indexOf(0.5)];
  assert.equal(atLo.passes, true);
  assert.equal(atHi.passes, true);
  // out-of-tolerance is a judgment, not a file error
  assert.deepEqual(store.errors, []);
});

test('chunking: multi-record commit splits into CRC-protected chunks', () => {
  const dir = tmpdir();
  const store = Store.open(dir, { maxRecordsPerChunk: 2 });
  store.createBatch('B', { baseline: 0, tolerance: 10, time: 1000 });
  store.appendMany(
    'B',
    [1.1, 2.2, 3.3, 4.4, 5.5].map((v, i) => ({ value: v, time: 2000 + i }))
  );
  // baseline chunk + ceil(5/2) = 3 measurement chunks
  assert.equal(store.manifest.chunks.length, 4);
  const counts = store.manifest.chunks.map((c) => c.records);
  assert.deepEqual(counts, [1, 2, 2, 1]);

  const reopened = Store.open(dir, { maxRecordsPerChunk: 2 });
  const vals = reopened
    .decode('B')
    .history.filter((h) => h.type === 'measurement')
    .map((h) => h.value);
  assert.deepEqual(vals, [1.1, 2.2, 3.3, 4.4, 5.5]);
});

test('time index locates by batch and measurement time, including late arrivals', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.createBatch('B', { baseline: 0, tolerance: 100, time: 1000 });
  store.append('B', { value: 1, time: 5000 });
  store.append('B', { value: 2, time: 2000 }); // late arrival, earlier timestamp
  store.append('B', { value: 3, time: 8000 });

  const at2500 = store.locate('B', 2500);
  assert.equal(at2500.type, 'measurement');
  assert.equal(at2500.value, 2);
  assert.equal(at2500.time, 2000);
  const at9999 = store.locate('B', 9999);
  assert.equal(at9999.value, 3);
  assert.equal(store.locate('B', 500), null);

  const range = store.query('B', { from: 1500, to: 6000 });
  assert.deepEqual(
    range.map((r) => r.value),
    [2, 1]
  );
});
