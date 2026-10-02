import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendBatch, readManifest } from '../src/storage.js';
import { executeQuery, referenceScan, compareRecords } from '../src/query.js';

function tmpDb() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logdb-query-'));
}

// deterministic PRNG so failures are reproducible
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeLogs(n, seed) {
  const rnd = mulberry32(seed);
  const devices = ['pump-1', 'pump-2', 'pump-10', 'valve-1', 'valve-2', 'sensor-a', 'sensor-b'];
  const codes = ['I100', 'I101', 'E200', 'E201', 'W300'];
  const base = Date.parse('2026-09-01T00:00:00Z');
  const span = 40 * 24 * 3600 * 1000; // 40 days, deliberately out of order
  const logs = [];
  for (let i = 0; i < n; i++) {
    logs.push({
      ts: base + Math.floor(rnd() * span),
      device: devices[Math.floor(rnd() * devices.length)],
      code: codes[Math.floor(rnd() * codes.length)],
      value: Math.floor(rnd() * 500000) / 100,
    });
  }
  return logs;
}

// Independent reference: reads committed records straight from the on-disk
// segments + WAL frames and filters with plain JavaScript predicates.
function independentScan(dir, predicate) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const records = [];
  for (const seg of manifest.segments) {
    const raw = fs.readFileSync(path.join(dir, 'segments', seg.file), 'utf8');
    for (const line of raw.split('\n')) {
      if (line) records.push(JSON.parse(line));
    }
  }
  const wal = fs.readFileSync(path.join(dir, 'wal.log'));
  let off = 0;
  while (off + 8 <= wal.length) {
    const len = wal.readUInt32LE(off);
    if (off + 8 + len > wal.length) break;
    const rec = JSON.parse(wal.subarray(off + 4, off + 4 + len).toString('utf8'));
    if (rec.seq >= manifest.nextSeq) records.push(rec); // not yet flushed to a segment
    off += 8 + len;
  }
  return records.filter(predicate)
    .sort(compareRecords);
}

function glob(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

const T = (s) => Date.parse(s);

const CASES = [
  {
    name: 'range query',
    dsl: `ts >= 2026-09-05T00:00:00Z and ts < 2026-09-20T00:00:00Z and value >= 2500`,
    pred: (r) => r.ts >= T('2026-09-05T00:00:00Z') && r.ts < T('2026-09-20T00:00:00Z') && r.value >= 2500,
  },
  {
    name: 'pattern query',
    dsl: `device =~ "pump-*" and code == "E200"`,
    pred: (r) => glob('pump-*').test(r.device) && r.code === 'E200',
  },
  {
    name: 'negated pattern with or',
    dsl: `device !~ "sensor-?" and (code == "I100" or code == "W300")`,
    pred: (r) => !glob('sensor-?').test(r.device) && (r.code === 'I100' || r.code === 'W300'),
  },
  {
    name: 'let subqueries with shadowing',
    dsl: `let hot = value > 4k; let hot = value > 3k and hot; hot and device =~ "valve-*"`,
    pred: (r) => (r.value > 3000 && r.value > 4000) && glob('valve-*').test(r.device),
  },
  {
    name: 'not and numeric units',
    dsl: `not (value < 1.5k or code =~ "I*") and ts < 2026-09-10`,
    pred: (r) => !(r.value < 1500 || glob('I*').test(r.code)) && r.ts < T('2026-09-10T00:00:00Z'),
  },
  {
    name: 'exact ts equality uses the index window',
    dsl: `ts >= 2026-09-01 and ts <= 2026-09-30 and (ts == 2026-09-15T12:00:00Z or value > 4.9k)`,
    pred: (r) => r.ts >= T('2026-09-01T00:00:00Z') && r.ts <= T('2026-09-30T00:00:00Z')
      && (r.ts === T('2026-09-15T12:00:00Z') || r.value > 4900),
  },
  {
    name: 'top-level ts equality',
    dsl: `ts == 2026-09-15T12:00:00Z and device =~ "sensor-*"`,
    pred: (r) => r.ts === T('2026-09-15T12:00:00Z') && glob('sensor-*').test(r.device),
  },
];

for (const size of [0, 1, 7, 128, 500]) {
  test(`random logs (n=${size}): engine matches independent full scan`, () => {
    const dir = tmpDb();
    const logs = makeLogs(size, 1234 + size);
    // append in several batches to create multiple segments
    const batch = Math.max(1, Math.ceil(size / 5));
    if (logs.length === 0) appendBatch(dir, []); // initialise an empty db
    for (let i = 0; i < logs.length; i += batch) {
      appendBatch(dir, logs.slice(i, i + batch));
    }
    for (const c of CASES) {
      const expected = independentScan(dir, c.pred);
      const got = executeQuery(dir, c.dsl).result;
      assert.deepEqual(got, expected, `${c.name} (n=${size})`);
      // index path must also equal the no-index full scan of the same engine
      assert.deepEqual(got, referenceScan(independentScan(dir, () => true), c.dsl).result, `${c.name} scan-path`);
    }
  });
}

test('aggregation queries', () => {
  const dir = tmpDb();
  const logs = makeLogs(300, 99);
  appendBatch(dir, logs.slice(0, 150));
  appendBatch(dir, logs.slice(150));
  const committed = independentScan(dir, () => true);

  const out = executeQuery(dir, 'value >= 2000 | count, avg(value), min(value), max(value), sum(value) by device');
  const filtered = committed.filter((r) => r.value >= 2000);
  const byDevice = new Map();
  for (const r of filtered) {
    if (!byDevice.has(r.device)) byDevice.set(r.device, []);
    byDevice.get(r.device).push(r.value);
  }
  const expected = [...byDevice.keys()].sort().map((d) => {
    const vals = byDevice.get(d);
    return {
      device: d,
      count: vals.length,
      avg_value: vals.reduce((s, v) => s + v, 0) / vals.length,
      min_value: Math.min(...vals),
      max_value: Math.max(...vals),
      sum_value: vals.reduce((s, v) => s + v, 0),
    };
  });
  assert.deepEqual(out.result, expected);

  const total = executeQuery(dir, 'device =~ "pump-*" | count');
  assert.deepEqual(total.result, { count: committed.filter((r) => glob('pump-*').test(r.device)).length });
});

test('results are sorted by ts, device, seq for out-of-order appends', () => {
  const dir = tmpDb();
  const logs = makeLogs(200, 7);
  appendBatch(dir, logs);
  const out = executeQuery(dir, 'value >= 0');
  const sorted = [...out.result].sort(compareRecords);
  assert.deepEqual(out.result, sorted);
  // ts values must be non-decreasing even though appends were out of order
  for (let i = 1; i < out.result.length; i++) {
    assert.ok(out.result[i].ts >= out.result[i - 1].ts);
  }
});

test('query sees committed WAL records not yet flushed to a segment', () => {
  const dir = tmpDb();
  appendBatch(dir, [{ ts: 1000, device: 'a', code: 'E1', value: 1 }]);
  appendBatch(dir, [{ ts: 2000, device: 'b', code: 'E1', value: 2 }], { stopAfter: 'wal' });
  const out = executeQuery(dir, 'value > 0');
  assert.deepEqual(out.result.map((r) => r.value), [1, 2]);
  // manifest still only knows the first record
  assert.equal(readManifest(dir).nextSeq, 1);
});
