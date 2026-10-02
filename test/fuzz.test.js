'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, mulberry32 } = require('./helpers');
const { appendBatch, flush } = require('../src/storage');
const { executeQuery } = require('../src/query');

const T0 = Date.parse('2026-09-15T00:00:00Z');
const DEVICES = ['pump-01', 'pump-02', 'pump-11', 'valve-1', 'valve-2', 'mixer-3'];
const CODES = ['TEMP', 'PRESS', 'FLOW'];

function genRecords(seed, n) {
  const rnd = mulberry32(seed);
  const records = [];
  for (let i = 0; i < n; i++) {
    records.push({
      ts: T0 + Math.floor(rnd() * 7200) * 1000,
      device: DEVICES[Math.floor(rnd() * DEVICES.length)],
      code: CODES[Math.floor(rnd() * CODES.length)],
      value: Math.round(rnd() * 3000 * 10) / 10,
    });
  }
  return records;
}

function cmpRef(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return a.seq - b.seq;
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function refQuery(records, pred) {
  return records.filter(pred).sort(cmpRef);
}

function strip(records) {
  return records.map((r) => ({ ts: r.ts, device: r.device, code: r.code, value: r.value, seq: r.seq }));
}

for (const [seed, count] of [[1, 137], [2, 500], [3, 42]]) {
  test(`random dataset (seed=${seed}, n=${count}) matches reference full scan`, () => {
    const dir = tmpDir('fuzz-');
    const raw = genRecords(seed, count);
    const rnd = mulberry32(seed * 1000 + 7);
    const expected = [];
    let seq = 0;
    let i = 0;
    while (i < raw.length) {
      const batchSize = 1 + Math.floor(rnd() * 60);
      const batch = raw.slice(i, i + batchSize);
      for (const r of batch) expected.push({ ...r, seq: ++seq });
      appendBatch(dir, batch);
      if (rnd() < 0.4) flush(dir);
      i += batchSize;
    }
    flush(dir);

    const cases = [
      ['where ts >= 2026-09-15T00:30:00Z and ts < 2026-09-15T01:00:00Z',
        (r) => r.ts >= T0 + 1800000 && r.ts < T0 + 3600000],
      ['where device matches "pump-*"',
        (r) => globToRegex('pump-*').test(r.device)],
      ['where device matches "valve-?" and value > 1.5k',
        (r) => globToRegex('valve-?').test(r.device) && r.value > 1500],
      ['where code == "TEMP" and (value < 100 or value > 2.5k)',
        (r) => r.code === 'TEMP' && (r.value < 100 || r.value > 2500)],
      ['where not device matches "pump-*" and ts >= 2026-09-15T01:00:00Z',
        (r) => !globToRegex('pump-*').test(r.device) && r.ts >= T0 + 3600000],
      ['let hot = value > 2k\nlet p = device matches "pump-*"\nwhere hot and p or code == "FLOW" and value < 50',
        (r) => (r.value > 2000 && globToRegex('pump-*').test(r.device)) || (r.code === 'FLOW' && r.value < 50)],
      ['where value >= 0',
        () => true],
    ];
    for (const [dsl, pred] of cases) {
      const got = executeQuery(dir, dsl).records;
      assert.deepEqual(strip(got), strip(refQuery(expected, pred)), `query: ${dsl}`);
    }

    const agg = executeQuery(dir, 'select count(), sum(value), avg(value), min(value), max(value) where device matches "pump-*"');
    const refSet = refQuery(expected, (r) => globToRegex('pump-*').test(r.device));
    const values = refSet.map((r) => r.value);
    assert.equal(agg.result['count()'], refSet.length);
    assert.ok(Math.abs(agg.result['sum(value)'] - values.reduce((a, b) => a + b, 0)) < 1e-6);
    assert.ok(Math.abs(agg.result['avg(value)'] - values.reduce((a, b) => a + b, 0) / values.length) < 1e-9);
    assert.equal(agg.result['min(value)'], Math.min(...values));
    assert.equal(agg.result['max(value)'], Math.max(...values));
  });
}

test('time-index pruning path returns identical results to unpruned scan', () => {
  const dir = tmpDir('fuzz-');
  const raw = genRecords(9, 300);
  appendBatch(dir, raw);
  flush(dir);
  appendBatch(dir, genRecords(10, 50));
  const dsl = 'where ts >= 2026-09-15T00:20:00Z and ts <= 2026-09-15T00:40:00Z and value > 500';
  const withIndex = executeQuery(dir, dsl).records;
  const db = require('../src/storage').openDb(dir);
  const all = [...db.segments.flatMap((s) => s.records), ...db.walRecords];
  const lo = T0 + 1200000;
  const hi = T0 + 2400000;
  const manual = all.filter((r) => r.ts >= lo && r.ts <= hi && r.value > 500).sort(cmpRef);
  assert.deepEqual(strip(withIndex), strip(manual));
});
