import test from 'node:test';
import assert from 'node:assert/strict';
import { optimize, bruteForce } from '../src/optimize.js';
import { runAudit } from '../src/audit.js';

const T = (min) => `2026-01-01T00:${String(min).padStart(2, '0')}:00Z`;
const ISO = (min) => new Date(T(min)).toISOString();

const mkWindow = (min, grossKw, rate, shed) => ({
  windowStart: ISO(min),
  windowStartMs: Date.parse(T(min)),
  grossKw,
  rate,
  shed,
  shedKw: shed.reduce((acc, s) => acc + s.kw, 0),
});

// Acceptance 3: for <= 3 windows the optimizer is checked against exhaustive
// enumeration, including tie-breaking (less shed, then load lexicographic).
test('optimizer matches exhaustive enumeration on 3 windows', () => {
  const windows = [
    mkWindow(0, 100, 2, [{ load: 'HVAC', kw: 50 }]),
    mkWindow(15, 120, 1, [{ load: 'Compressor', kw: 60 }]),
    mkWindow(30, 80, 3, [{ load: 'Pump', kw: 30 }]),
  ];
  const opt = optimize(windows);
  const brute = bruteForce(windows, 1);
  assert.equal(brute.skipped, false);
  assert.ok(Math.abs(opt.cost - brute.cost) < 1e-9);
  assert.ok(Math.abs(opt.totalShedKw - brute.totalShedKw) < 1e-9);
});

test('tie on cost is broken by less total shed', () => {
  // Min peak cost is 20; window 1 must also shed down to 20, no more.
  const windows = [
    mkWindow(0, 100, 1, [{ load: 'b', kw: 80 }]),
    mkWindow(15, 60, 1, [{ load: 'a', kw: 80 }]),
  ];
  const opt = optimize(windows);
  assert.equal(opt.cost, 20);
  const brute = bruteForce(windows, 1);
  assert.ok(Math.abs(opt.cost - brute.cost) < 1e-9);
  assert.ok(Math.abs(opt.totalShedKw - brute.totalShedKw) < 1e-9);
  // w0 sheds 80 (100->20), w1 sheds 40 (60->20); shedding less in w1 would
  // raise the peak, shedding more would violate the min-shed tie-break.
  assert.equal(opt.totalShedKw, 120);
});

test('tie on cost and total shed is broken by load lexicographic order', () => {
  const windows = [
    mkWindow(0, 100, 1, [{ load: 'beta', kw: 30 }, { load: 'alpha', kw: 30 }]),
  ];
  const opt = optimize(windows);
  // need 60 shed... budget is 60, cost = 40; alpha filled before beta
  assert.equal(opt.cost, 40);
  assert.deepEqual(opt.plan, [
    { windowStart: ISO(0), load: 'alpha', kw: 30 },
    { windowStart: ISO(0), load: 'beta', kw: 30 },
  ]);
});

test('partial lexicographic allocation: fill alpha fully before touching beta', () => {
  const windows = [
    mkWindow(0, 100, 1, [{ load: 'beta', kw: 30 }, { load: 'alpha', kw: 30 }]),
    mkWindow(15, 55, 1, []),
  ];
  const opt = optimize(windows);
  // floor = 55 (window 1 cannot shed); w0 needs 45 shed: alpha 30 + beta 15
  assert.equal(opt.cost, 55);
  assert.deepEqual(opt.plan, [
    { windowStart: ISO(0), load: 'alpha', kw: 30 },
    { windowStart: ISO(0), load: 'beta', kw: 15 },
  ]);
  assert.equal(opt.totalShedKw, 45);
});

test('settlement carries exhaustive verification for <= 3 windows', () => {
  const events = [
    { type: 'tariff', eventTs: T(0), name: 'r0', start: T(0), end: T(15), rate: 2 },
    { type: 'tariff', eventTs: T(0), name: 'r1', start: T(15), end: T(30), rate: 1 },
    { type: 'meter', eventTs: T(0), meter: 'M1', kwh: 0, estimated: false },
    { type: 'meter', eventTs: T(15), meter: 'M1', kwh: 25, estimated: false },
    { type: 'meter', eventTs: T(30), meter: 'M1', kwh: 50, estimated: false },
    { type: 'shed', eventTs: T(14), load: 'HVAC', kw: 40 },
    { type: 'shed', eventTs: T(29), load: 'Compressor', kw: 40 },
  ];
  const { settlement } = runAudit(events);
  assert.equal(settlement.exhaustive.skipped, false);
  assert.equal(settlement.exhaustive.windows, 2);
  assert.equal(settlement.exhaustive.verified, true);
  assert.equal(settlement.exhaustive.matches, true);
  assert.equal(settlement.exhaustive.bruteForce.cost, settlement.optimal.demandCost);
});

test('exhaustive check is skipped beyond 3 windows', () => {
  const events = [
    { type: 'tariff', eventTs: T(0), name: 'r', start: T(0), end: '2026-01-01T02:00:00Z', rate: 1 },
    { type: 'meter', eventTs: T(0), meter: 'M1', kwh: 0, estimated: false },
    { type: 'meter', eventTs: T(15), meter: 'M1', kwh: 10, estimated: false },
    { type: 'meter', eventTs: T(30), meter: 'M1', kwh: 20, estimated: false },
    { type: 'meter', eventTs: T(45), meter: 'M1', kwh: 30, estimated: false },
    { type: 'meter', eventTs: '2026-01-01T01:00:00Z', meter: 'M1', kwh: 40, estimated: false },
  ];
  const { settlement } = runAudit(events);
  assert.equal(settlement.windowCount, 4);
  assert.equal(settlement.exhaustive.skipped, true);
});
