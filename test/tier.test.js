import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeeEngine } from '../src/engine.js';

const STD_PACKAGE = {
  type: 'package',
  id: 'std',
  version: 1,
  tiers: [
    { upTo: 100000, rate: 0.001 },
    { upTo: null, rate: 0.0008 },
  ],
  minFee: 0,
};

function setup() {
  const engine = new FeeEngine();
  engine.applyEvent(STD_PACKAGE);
  engine.applyEvent({ type: 'trade', id: 'a1', account: 'A', amount: 90000 });
  engine.applyEvent({ type: 'trade', id: 'b1', account: 'B', amount: 50000 });
  engine.stats.fastPaths = 0;
  engine.stats.recomputes = 0;
  engine.stats.invalidated = [];
  return engine;
}

test('cross-tier trade invalidates only the crossing account', () => {
  const engine = setup();
  // A: 90000 -> 110000 crosses the 100000 boundary; B is untouched.
  engine.applyEvent({ type: 'trade', id: 'a2', account: 'A', amount: 20000 });
  assert.deepEqual(engine.stats.invalidated, ['A']);
  const view = engine.accountView('A');
  assert.equal(view.hitTier, 1);
  // 100000 * 0.001 + 10000 * 0.0008 = 100 + 8
  assert.equal(view.feeCents, 10800);
  assert.equal(engine.accountView('B').feeCents, 5000);
});

test('non-crossing trade takes the fast path without invalidation', () => {
  const engine = setup();
  engine.applyEvent({ type: 'trade', id: 'b2', account: 'B', amount: 10000 });
  assert.deepEqual(engine.stats.invalidated, []);
  assert.equal(engine.stats.fastPaths, 1);
  assert.equal(engine.accountView('B').feeCents, 6000);
  assert.equal(engine.accountView('B').hitTier, 0);
});

test('cancel that drops back across the boundary re-invalidates', () => {
  const engine = setup();
  engine.applyEvent({ type: 'trade', id: 'a2', account: 'A', amount: 20000 });
  assert.equal(engine.accountView('A').hitTier, 1);
  engine.applyEvent({ type: 'cancel', id: 'a2' });
  assert.equal(engine.accountView('A').hitTier, 0);
  assert.equal(engine.accountView('A').feeCents, 9000);
  assert.deepEqual(engine.stats.invalidated, ['A']);
});

test('per-tier amounts are maintained differentially across many deltas', () => {
  const engine = new FeeEngine();
  engine.applyEvent(STD_PACKAGE);
  // Random-walk the turnover; the accumulated tier state must always agree
  // with a fresh quote from the raw turnover.
  const deltas = [55000, 30000, 40000, -20000, 90000, -60000, 25000, -15000];
  let turnover = 0;
  deltas.forEach((delta, i) => {
    turnover += delta;
    if (delta >= 0) {
      engine.applyEvent({ type: 'trade', id: `t${i}`, account: 'A', amount: delta });
    } else {
      engine.applyEvent({ type: 'reversal', id: `r${i}`, ref: 't0', amount: delta });
    }
  });
  const expected = 100000 * 0.001 + Math.max(0, turnover - 100000) * 0.0008;
  assert.equal(engine.accountView('A').turnoverCents, turnover * 100);
  assert.equal(engine.accountView('A').feeCents, Math.round(expected * 100));
});
