'use strict';

// Acceptance 3: a corrected transaction only triggers recomputation of the
// fee-rate intervals it intersects (old and new instants), nothing else.
// Plus: end-to-end differences, rate-interval hits, and the E_REPLAY guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReconEngine } = require('../src/index');
const { ZONE, tableFixedPlus8, tableShifted, registryWith } = require('../testlib/helpers');

function makeRegistry() {
  const stlV2 = JSON.parse(JSON.stringify(tableShifted));
  stlV2.version = 'stl-v2';
  return registryWith({
    txn: [tableFixedPlus8('txn-v1')],
    settlement: [tableFixedPlus8('stl-v1'), stlV2],
    fee: [tableFixedPlus8('fee-v1')],
  });
}

const RATES = [
  { id: 'r-mar', startLocal: '2024-03-01T00:00:00', endLocal: '2024-04-01T00:00:00', rate: '0.010', fx: '7.10' },
  { id: 'r-apr', startLocal: '2024-04-01T00:00:00', endLocal: '2024-05-01T00:00:00', rate: '0.020', fx: '7.20' },
  { id: 'r-may', startLocal: '2024-05-01T00:00:00', endLocal: '2024-06-01T00:00:00', rate: '0.030', fx: '7.30' },
];

function baseInput(overrides = {}) {
  return {
    zone: ZONE,
    policy: 'strict',
    pinned: { txn: 'txn-v1', settlement: 'stl-v1', fee: 'fee-v1' },
    rates: RATES,
    transactions: [
      { id: 't1', utc: '2024-03-10T15:30:00Z', amount: '100.00' }, // local 03-10 23:30, r-mar
      { id: 't2', utc: '2024-03-10T16:30:00Z', amount: '200.00' }, // local 03-11 00:30, r-mar
      { id: 't3', utc: '2024-05-10T08:00:00Z', amount: '50.00' },  // local 05-10 16:00, r-may
    ],
    settlements: [],
    corrections: [],
    ...overrides,
  };
}

test('end-to-end: local-day bucketing, rate hits and differences', () => {
  const engine = new ReconEngine(makeRegistry());
  const input = baseInput({
    settlements: [
      { day: '2024-03-10', amount: '709.00' },
      { day: '2024-03-11', amount: '1418.05' }, // 0.05 over -> mismatch
      { day: '2024-05-10', amount: '363.50' },
    ],
  });
  const out = engine.reconcile(input);

  assert.deepEqual(out.versions, { txn: 'txn-v1', settlement: 'stl-v1', fee: 'fee-v1' });
  assert.deepEqual(Object.keys(out.days), ['2024-03-10', '2024-03-11', '2024-05-10']);

  // t1: 100.00 * 7.10 = 710.00, fee 1% of 100.00 = 1.00 -> net 709.00
  assert.equal(out.days['2024-03-10'].expectedNet, '70900');
  // t2: 200.00 * 7.10 = 1420.00, fee 2.00 -> net 1418.00
  assert.equal(out.days['2024-03-11'].expectedNet, '141800');
  // t3: 50.00 * 7.30 = 365.00, fee 3% of 50.00 = 1.50 -> net 363.50
  assert.equal(out.days['2024-05-10'].expectedNet, '36350');

  assert.deepEqual(out.rateHits.map((h) => [h.txnId, h.intervalId]), [
    ['t1', 'r-mar'], ['t2', 'r-mar'], ['t3', 'r-may'],
  ]);

  const byDay = Object.fromEntries(out.differences.map((d) => [d.day, d]));
  assert.equal(byDay['2024-03-10'].status, 'match');
  assert.equal(byDay['2024-03-11'].status, 'mismatch');
  assert.equal(byDay['2024-03-11'].diff, '5');
  assert.equal(byDay['2024-05-10'].status, 'match');
});

test('correction recomputes only intersecting fee intervals', () => {
  const engine = new ReconEngine(makeRegistry());
  const input = baseInput({
    corrections: [
      // move t1 from March (r-mar) into April (r-apr); r-may untouched
      { id: 'c1', supersedes: 't1', utc: '2024-04-10T15:30:00Z', amount: '100.00' },
    ],
  });
  const out = engine.reconcile(input);

  assert.deepEqual(out.impactSet.intervals, ['r-apr', 'r-mar']);
  assert.ok(!out.impactSet.intervals.includes('r-may'));
  assert.deepEqual(out.impactSet.days, ['2024-03-10', '2024-04-10']);
  assert.deepEqual(out.impactSet.transactions, ['c1', 't1']);

  // t1's contribution moved: 03-10 bucket empty, 04-10 holds corrected net
  // c1: 100.00 * 7.20 = 720.00, fee 2% = 2.00 -> 718.00
  assert.equal(out.days['2024-03-10'].expectedNet, '0');
  assert.equal(out.days['2024-04-10'].expectedNet, '71800');
  // t3 in May is untouched
  assert.equal(out.days['2024-05-10'].expectedNet, '36350');
});

test('E_REPLAY: finalized days cannot be rewritten with a different table version', () => {
  const engine = new ReconEngine(makeRegistry());
  engine.reconcile(baseInput(), { finalize: true });

  // same pinned versions: idempotent recompute is allowed
  engine.reconcile(baseInput(), { finalize: true });

  // different settlement table version for an already-finalized day: rejected
  const replay = baseInput({ pinned: { txn: 'txn-v1', settlement: 'stl-v2', fee: 'fee-v1' } });
  assert.throws(() => engine.reconcile(replay), (e) => e.code === 'E_REPLAY');

  // a fresh engine (no finalized history) may use stl-v2 freely
  const engine2 = new ReconEngine(makeRegistry());
  const out = engine2.reconcile(replay);
  assert.equal(out.versions.settlement, 'stl-v2');
});

test('missing pinned versions raise E_TZVER', () => {
  const engine = new ReconEngine(makeRegistry());
  const input = baseInput({ pinned: { txn: 'txn-v1', settlement: 'stl-v1' } });
  assert.throws(() => engine.reconcile(input), (e) => e.code === 'E_TZVER');
});
