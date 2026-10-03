'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine.js');

const T0 = Date.parse('2026-10-04T00:00:00Z');
const MIN = 60 * 1000;

function upsert(profileId, depth, temp, version, offsetMin) {
  return { type: 'UPSERT', profileId, depth, temp, version, eventTime: T0 + offsetMin * MIN };
}

test('depths arriving in reverse order yield correct inversion layer in certificate', () => {
  const engine = new Engine();
  // Delivered deepest-first (out of order by depth); temps rise with depth.
  const rows = [
    [40, 9.0],
    [30, 8.4],
    [20, 8.0],
    [10, 7.0],
  ];
  const results = rows.map(([d, t], i) => engine.apply(upsert('p1', d, t, 1, i)));
  for (const r of results) assert.equal(r.status, 'applied');

  const cert = engine.apply({ type: 'WATERMARK', profileId: 'p1', time: T0 + 31 * MIN + 3 * MIN });
  assert.equal(cert.type, 'certificate');
  assert.deepEqual(cert.depths, [10, 20, 30, 40]);
  // Adjacent rises: 1.0, 0.4, 0.6 -> inversions at [10,20] and [30,40].
  assert.deepEqual(cert.inversions, [[10, 20], [30, 40]]);
  // Two single-pair layers; tie on pairCount and span (10m) -> shallowest wins.
  assert.deepEqual(cert.maxInversionLayer, { from: 10, to: 20, pairCount: 1 });
  assert.deepEqual(cert.missing.blocks, [
    { start: 11, end: 19, count: 9 },
    { start: 21, end: 29, count: 9 },
    { start: 31, end: 39, count: 9 },
  ]);
  assert.equal(cert.missing.blockCount, 3);
  assert.equal(cert.missing.missingCount, 27);
});

test('retracting a middle depth merges missing blocks and removes the inversion', () => {
  const engine = new Engine();
  // depths 10,20,40 present; missing blocks [11,19] and [21,39].
  engine.apply(upsert('p2', 10, 7.0, 1, 0));
  engine.apply(upsert('p2', 20, 8.0, 1, 1)); // inversion 10->20 (+1.0)
  engine.apply(upsert('p2', 40, 6.0, 1, 2)); // 20->40 cools, no inversion

  const res = engine.apply({ type: 'RETRACT', profileId: 'p2', depth: 20, version: 2, eventTime: T0 + 3 * MIN });
  assert.equal(res.status, 'applied');
  // The only inversion pair [10,20] is gone; new pair 10->40 cools.
  assert.deepEqual(res.inversions, []);
  assert.equal(res.maxInversionLayer, null);
  // Missing blocks merged into one contiguous [11,39].
  assert.deepEqual(res.missing.blocks, [{ start: 11, end: 39, count: 29 }]);
  assert.equal(res.missing.blockCount, 1);
});

test('corrections after watermark close are rejected as LATE', () => {
  const engine = new Engine();
  engine.apply(upsert('p3', 10, 7.0, 1, 0));
  engine.apply(upsert('p3', 20, 6.0, 1, 5));
  const cert = engine.apply({ type: 'WATERMARK', profileId: 'p3', time: T0 + 36 * MIN });
  assert.equal(cert.type, 'certificate');

  const lateUpsert = engine.apply(upsert('p3', 20, 6.5, 2, 40));
  assert.deepEqual({ type: lateUpsert.type, reason: lateUpsert.reason }, { type: 'rejected', reason: 'LATE' });
  const lateRetract = engine.apply({ type: 'RETRACT', profileId: 'p3', depth: 10, version: 2, eventTime: T0 + 41 * MIN });
  assert.equal(lateRetract.reason, 'LATE');
});

test('watermark within 30 minutes of last observation does not close the session', () => {
  const engine = new Engine();
  engine.apply(upsert('p4', 10, 7.0, 1, 0));
  const none1 = engine.apply({ type: 'WATERMARK', profileId: 'p4', time: T0 + 30 * MIN });
  assert.equal(none1, null);
  const cert = engine.apply({ type: 'WATERMARK', profileId: 'p4', time: T0 + 30 * MIN + 1 });
  assert.equal(cert.type, 'certificate');
});

test('out-of-order event times: session end tracks max observation time', () => {
  const engine = new Engine();
  engine.apply(upsert('p5', 10, 7.0, 1, 20)); // later obs arrives first
  engine.apply(upsert('p5', 20, 6.0, 1, 0));  // earlier obs arrives late
  const notYet = engine.apply({ type: 'WATERMARK', profileId: 'p5', time: T0 + 49 * MIN });
  assert.equal(notYet, null);
  const cert = engine.apply({ type: 'WATERMARK', profileId: 'p5', time: T0 + 51 * MIN });
  assert.equal(cert.sessionEnd, new Date(T0 + 20 * MIN).toISOString());
  assert.equal(cert.sessionStart, new Date(T0).toISOString());
});

test('version rollback reports STALE_VERSION; higher version overrides', () => {
  const engine = new Engine();
  engine.apply(upsert('p6', 10, 7.0, 5, 0));
  const stale = engine.apply(upsert('p6', 10, 9.0, 4, 1));
  assert.equal(stale.reason, 'STALE_VERSION');
  const equal = engine.apply(upsert('p6', 10, 9.0, 5, 2));
  assert.equal(equal.reason, 'STALE_VERSION');
  const ok = engine.apply(upsert('p6', 10, 9.0, 6, 3));
  assert.equal(ok.status, 'applied');
  // Retract with rolled-back version is stale too.
  const staleRetract = engine.apply({ type: 'RETRACT', profileId: 'p6', depth: 10, version: 5, eventTime: T0 + 4 * MIN });
  assert.equal(staleRetract.reason, 'STALE_VERSION');
});

test('retracting a nonexistent point reports UNKNOWN_RETRACT', () => {
  const engine = new Engine();
  engine.apply(upsert('p7', 10, 7.0, 1, 0));
  const res = engine.apply({ type: 'RETRACT', profileId: 'p7', depth: 99, version: 1, eventTime: T0 + MIN });
  assert.equal(res.reason, 'UNKNOWN_RETRACT');
  const res2 = engine.apply({ type: 'RETRACT', profileId: 'ghost', depth: 1, version: 1, eventTime: T0 + MIN });
  assert.equal(res2.reason, 'UNKNOWN_RETRACT');
});

test('depth outside 0..1000 or non-integer is rejected as INVALID_DEPTH', () => {
  const engine = new Engine();
  for (const depth of [-1, 1001, 10.5]) {
    const res = engine.apply(upsert('p8', depth, 7.0, 1, 0));
    assert.equal(res.reason, 'INVALID_DEPTH');
  }
  const ok = engine.apply(upsert('p8', 1000, 7.0, 1, 0));
  assert.equal(ok.status, 'applied');
});

test('higher-version upsert at same depth can create or remove an inversion', () => {
  const engine = new Engine();
  engine.apply(upsert('p9', 10, 7.0, 1, 0));
  let res = engine.apply(upsert('p9', 20, 8.0, 1, 1));
  assert.deepEqual(res.inversions, [[10, 20]]);
  res = engine.apply(upsert('p9', 20, 6.0, 2, 2)); // correct temp downward
  assert.deepEqual(res.inversions, []);
  assert.equal(res.maxInversionLayer, null);
});
