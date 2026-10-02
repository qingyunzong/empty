'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir } = require('./helpers');
const { appendBatch, flush, openDb } = require('../src/storage');
const { executeQuery } = require('../src/query');

const T0 = Date.parse('2026-10-01T00:00:00Z');

test('out-of-order appends are sorted by (ts, device, seq)', () => {
  const dir = tmpDir('ord-');
  appendBatch(dir, [
    { ts: T0 + 3000, device: 'b', code: 'X', value: 1 },
    { ts: T0 + 1000, device: 'b', code: 'X', value: 2 },
  ]);
  appendBatch(dir, [
    { ts: T0 + 1000, device: 'a', code: 'X', value: 3 },
    { ts: T0 + 2000, device: 'a', code: 'X', value: 4 },
    { ts: T0 + 1000, device: 'b', code: 'X', value: 5 },
  ]);
  const res = executeQuery(dir, 'where value > 0');
  assert.deepEqual(
    res.records.map((r) => [r.ts - T0, r.device, r.seq]),
    [
      [1000, 'a', 3],
      [1000, 'b', 2],
      [1000, 'b', 5],
      [2000, 'a', 4],
      [3000, 'b', 1],
    ],
  );
});

test('ordering holds across segments and wal', () => {
  const dir = tmpDir('ord-');
  appendBatch(dir, [
    { ts: T0 + 9000, device: 'z', code: 'X', value: 1 },
    { ts: T0 + 1000, device: 'z', code: 'X', value: 2 },
  ]);
  flush(dir);
  appendBatch(dir, [
    { ts: T0 + 5000, device: 'a', code: 'X', value: 3 },
  ]);
  const res = executeQuery(dir, 'where value > 0');
  assert.deepEqual(
    res.records.map((r) => [r.ts - T0, r.device, r.seq]),
    [
      [1000, 'z', 2],
      [5000, 'a', 3],
      [9000, 'z', 1],
    ],
  );
  const db = openDb(dir);
  assert.equal(db.segments.length, 1);
  assert.equal(db.walRecords.length, 1);
});
