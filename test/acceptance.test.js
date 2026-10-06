import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LimitEngine } from '../src/engine.js';

const DAY = 1440;

// Acceptance 1: three overlapping freezes crossing a period reset,
// with cross-period carryover and automatic release on expiry.
test('three overlapping freezes across a period reset', () => {
  const engine = new LimitEngine({
    totalCap: 1000,
    categoryCaps: { DINE: 700, SHOP: 700 },
    period: { origin: 0, length: DAY, count: 3 },
  });

  const f1 = engine.submitOne({ op: 'freeze', id: 'F1', category: 'DINE', amount: 400, start: 1000, end: 2000 });
  const f2 = engine.submitOne({ op: 'freeze', id: 'F2', category: 'DINE', amount: 300, start: 1200, end: 1600 });
  const f3 = engine.submitOne({ op: 'freeze', id: 'F3', category: 'SHOP', amount: 300, start: 1300, end: 2500 });
  assert.ok(f1.ok && f2.ok && f3.ok);

  // Normalized interval set: sorted, disjoint, coalesced, summed occupancy.
  assert.deepEqual(
    f3.normalized.map(({ start, end, occupancy }) => [start, end, occupancy]),
    [
      [1000, 1200, 400],
      [1200, 1300, 700],
      [1300, 1600, 1000],
      [1600, 2000, 700],
      [2000, 2500, 300],
    ],
  );

  // Cross-period carryover: F1/F2 count toward DINE in both period 0 and 1.
  const usage = engine.periodUsage().filter((r) => r.category === 'DINE');
  assert.deepEqual(
    usage.map(({ period, usage }) => [period, usage]),
    [
      [0, 700],
      [1, 700],
    ],
  );

  // A 4th DINE freeze fits the total cap but overflows the carried-over
  // DINE sub-cap in period 1 -> deterministic E_LIMIT, no partial effect.
  const denied = engine.submitOne({ op: 'freeze', id: 'F4', category: 'DINE', amount: 100, start: 1600, end: 1800 });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'E_LIMIT');
  assert.match(denied.reason, /category 'DINE' cap exceeded in period 1/);
  assert.equal(engine.groups.has('F4'), false);
  assert.equal(engine.normalized().length, 5); // unchanged

  // Automatic release on expiry: advancing past 2000 expires F1 and F2.
  const adv = engine.submitOne({ op: 'advance', now: 2001 });
  assert.deepEqual(
    adv.expired.filter((e) => !e.truncated).map((e) => e.group).sort(),
    ['F1', 'F2'],
  );
  assert.deepEqual(adv.expired.find((e) => e.group === 'F3').truncated, [1300, 2001]);
  assert.deepEqual(
    engine.normalized().map(({ start, end, occupancy }) => [start, end, occupancy]),
    [[2001, 2500, 300]], // elapsed prefix of F3 auto-released
  );
});

// Acceptance 2: partial unfreeze splits an interval, re-freeze merges it back.
test('partial unfreeze splits, group re-freeze merges (with proof)', () => {
  const engine = new LimitEngine({
    totalCap: 1000,
    categoryCaps: {},
    period: { origin: 0, length: 100, count: 5 },
  });

  engine.submitOne({ op: 'freeze', id: 'F1', category: 'ANY', amount: 500, start: 0, end: 100 });

  const split = engine.submitOne({ op: 'unfreeze', group: 'F1', start: 30, end: 60 });
  assert.ok(split.ok);
  assert.deepEqual(
    split.fragments.map(({ start, end }) => [start, end]),
    [
      [0, 30],
      [60, 100],
    ],
  );
  assert.deepEqual(
    split.normalized.map(({ start, end, occupancy }) => [start, end, occupancy]),
    [
      [0, 30, 500],
      [60, 100, 500],
    ],
  );

  // Re-freeze the gap under the same group: inherits amount/category, merges.
  const rejoin = engine.submitOne({ op: 'freeze', group: 'F1', start: 30, end: 60 });
  assert.ok(rejoin.ok);
  assert.equal(rejoin.amount, 500);
  assert.equal(rejoin.merges.length, 2); // [0,30)+[30,60) then +[60,100)
  assert.deepEqual(rejoin.merges[0].interval, [0, 60]);
  assert.deepEqual(rejoin.merges[1].interval, [0, 100]);
  assert.deepEqual(
    engine.fragmentsOf('F1').map(({ start, end }) => [start, end]),
    [[0, 100]],
  );
  assert.deepEqual(
    rejoin.normalized.map(({ start, end, occupancy }) => [start, end, occupancy]),
    [[0, 100, 500]],
  );
});

// Acceptance 3: concurrent equal requests -> exactly one wins, the rest get
// deterministic rejections; priority beats submission order; stale version -> E_RACE.
test('concurrent equal requests: one succeeds, others deterministically rejected', () => {
  const engine = new LimitEngine({
    totalCap: 1000,
    categoryCaps: { A: 1000 },
    period: { origin: 0, length: 60, count: 2 },
  });

  const mk = () => ({ op: 'freeze', category: 'A', amount: 600, start: 10, end: 50, priority: 5 });
  const results = engine.submit([mk(), mk(), mk()]);
  const ok = results.filter((r) => r.ok);
  const denied = results.filter((r) => !r.ok);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].seq, 0); // earliest submission wins at equal priority
  assert.equal(denied.length, 2);
  for (const d of denied) {
    assert.equal(d.code, 'E_LIMIT');
    assert.match(d.reason, /total cap exceeded at \[10, 50\): need 600, available 400/);
  }
  // Atomicity: losers left no partial occupancy.
  assert.equal(engine.occupancyAt(30), 600);

  // Priority arbitration: later-submitted higher priority wins the race.
  const engine2 = new LimitEngine({
    totalCap: 1000,
    categoryCaps: {},
    period: { origin: 0, length: 60, count: 2 },
  });
  const res2 = engine2.submit([
    { op: 'freeze', id: 'LOW', category: 'A', amount: 700, start: 0, end: 30, priority: 1 },
    { op: 'freeze', id: 'HIGH', category: 'A', amount: 700, start: 0, end: 30, priority: 9 },
  ]);
  assert.equal(res2[0].group, 'HIGH');
  assert.equal(res2[0].ok, true);
  assert.equal(res2[1].id, 'LOW');
  assert.equal(res2[1].ok, false);
  assert.equal(res2[1].code, 'E_LIMIT');

  // Optimistic concurrency: stale expectedVersion -> E_RACE.
  const engine3 = new LimitEngine({
    totalCap: 1000,
    categoryCaps: {},
    period: { origin: 0, length: 60, count: 2 },
  });
  const v0 = engine3.version;
  const res3 = engine3.submit([
    { op: 'freeze', id: 'A', category: 'C', amount: 100, start: 0, end: 10, expectedVersion: v0 },
    { op: 'freeze', id: 'B', category: 'C', amount: 100, start: 20, end: 30, expectedVersion: v0 },
  ]);
  assert.equal(res3[0].ok, true);
  assert.equal(res3[1].ok, false);
  assert.equal(res3[1].code, 'E_RACE');
  assert.match(res3[1].reason, /stale expectedVersion 0, current version is 1/);
});

// Error taxonomy: E_INTERVAL / E_PERIOD.
test('interval and period validation errors', () => {
  const engine = new LimitEngine({
    totalCap: 100,
    categoryCaps: {},
    period: { origin: 0, length: 60, count: 2 },
  });
  const bad1 = engine.submitOne({ op: 'freeze', category: 'A', amount: 10, start: 50, end: 50 });
  assert.equal(bad1.code, 'E_INTERVAL');
  const bad2 = engine.submitOne({ op: 'freeze', category: 'A', amount: 10, start: 0, end: 121 });
  assert.equal(bad2.code, 'E_PERIOD');
  engine.submitOne({ op: 'advance', now: 60 });
  const bad3 = engine.submitOne({ op: 'freeze', category: 'A', amount: 10, start: 10, end: 20 });
  assert.equal(bad3.code, 'E_PERIOD'); // starts in the past
  const bad4 = engine.submitOne({ op: 'advance', now: 30 });
  assert.equal(bad4.code, 'E_PERIOD'); // backwards clock
  assert.throws(
    () => new LimitEngine({ totalCap: 100, period: { origin: 0, length: 0, count: 1 } }),
    /E_PERIOD|period/,
  );
});

// Capture: partial and full, never exceeding the frozen amount.
test('capture deducts atomically and closes the group when fully captured', () => {
  const engine = new LimitEngine({
    totalCap: 1000,
    categoryCaps: {},
    period: { origin: 0, length: 100, count: 2 },
  });
  engine.submitOne({ op: 'freeze', id: 'F1', category: 'A', amount: 500, start: 0, end: 100 });
  const c1 = engine.submitOne({ op: 'capture', group: 'F1', amount: 200 });
  assert.ok(c1.ok);
  assert.equal(c1.remaining, 300);
  assert.equal(engine.occupancyAt(50), 300);
  const tooMuch = engine.submitOne({ op: 'capture', group: 'F1', amount: 301 });
  assert.equal(tooMuch.code, 'E_LIMIT');
  const c2 = engine.submitOne({ op: 'capture', group: 'F1', amount: 300 });
  assert.ok(c2.ok);
  assert.equal(c2.status, 'captured');
  assert.equal(engine.occupancyAt(50), 0);
});
