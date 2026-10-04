'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sign } = require('../src/frames');
const engine = require('../src/engine');
const { refRun } = require('./reference');

// Acceptance 5: <=7 instructions, enumerate every legal interleaving of
// arrival order, and check the engine against an independent reference.

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

// Seven instructions: limits, two orders, match, cancel, settle, fail.
const FRAMES = [
  { type: 'limits', seq: 0, funds: 100, securities: 8, window: 1000 },
  { type: 'new', seq: 1, clOrdId: 'B1', side: 'buy', qty: 5, price: 10, ts: 0 },
  { type: 'new', seq: 2, clOrdId: 'S1', side: 'sell', qty: 8, price: 9, ts: 0 },
  { type: 'match', seq: 3, ts: 1 },
  { type: 'cancel', seq: 4, origId: 'S1', ts: 2 },
  { type: 'settle', seq: 5, ts: 3 },
  { type: 'fail', seq: 6, origId: 'B1', ts: 4 },
].map(sign);

const EXPECTED = {
  accounts: {
    funds: { limit: 100, frozen: 0, spent: 0, available: 100 },
    securities: { limit: 8, frozen: 0, spent: 0, available: 8 },
  },
  orders: [
    { clOrdId: 'B1', status: 'filled', filled: 5, remaining: 0 },
    { clOrdId: 'S1', status: 'cancelled', filled: 5, remaining: 0 },
  ],
  fills: [
    { fillId: 'F1', buyId: 'B1', sellId: 'S1', qty: 5, price: 10, settled: true, compensated: true },
  ],
  compensations: [
    { fillId: 'F1', triggeredBy: 'B1', fundsCredited: 50, securitiesCredited: 5 },
  ],
};

function snapshot(r) {
  return {
    accounts: r.accounts,
    orders: r.orders.map((o) => ({
      clOrdId: o.clOrdId, status: o.status, filled: o.filled, remaining: o.remaining,
    })),
    fills: r.fills.map((f) => ({
      fillId: f.fillId, buyId: f.buyId, sellId: f.sellId,
      qty: f.qty, price: f.price, settled: f.settled, compensated: f.compensated,
    })),
    compensations: r.compensations,
  };
}

test('acceptance 5: all 7! = 5040 interleavings agree with the independent reference', () => {
  const roots = new Set();
  let count = 0;
  for (const perm of permutations(FRAMES)) {
    const r = engine.run(perm);
    assert.deepEqual(snapshot(r), refRun(perm), `engine != reference for seq order ${perm.map((f) => f.seq)}`);
    roots.add(r.auditRoot);
    count++;
  }
  assert.equal(count, 5040);
  // arrival order never changes the replayed audit trail
  assert.equal(roots.size, 1);
});

test('acceptance 5: reference result matches the hand-computed expectation', () => {
  assert.deepEqual(refRun(FRAMES), EXPECTED);
  assert.deepEqual(snapshot(engine.run(FRAMES)), EXPECTED);
});

test('acceptance 5: retransmitted frames inside interleavings are deduplicated', () => {
  const base = FRAMES.slice(0, 5); // 5 instructions -> 120 interleavings
  for (const perm of permutations(base)) {
    const withResend = [...perm, perm[2], perm[0]]; // duplicate two frames verbatim
    const r = engine.run(withResend);
    assert.deepEqual(snapshot(r), refRun(perm));
  }
});
