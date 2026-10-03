import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeeEngine } from '../src/engine.js';

const MIN_PACKAGE = {
  type: 'package',
  id: 'min',
  version: 1,
  tiers: [{ upTo: null, rate: 0.0001 }],
  minFee: 5,
};

test('cancel drops raw fee below the minimum: minimum fee applies', () => {
  const engine = new FeeEngine();
  engine.applyEvent(MIN_PACKAGE);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 10000 });
  // raw fee 1.00 -> clamped to minimum 5.00
  assert.equal(engine.accountView('A').feeCents, 500);
  engine.applyEvent({ type: 'trade', id: 't2', account: 'A', amount: 10000 });
  // raw fee 2.00 -> still the minimum
  assert.equal(engine.accountView('A').feeCents, 500);
  engine.applyEvent({ type: 'cancel', id: 't2' });
  assert.equal(engine.accountView('A').feeCents, 500);
});

test('cancelling everything drops the fee to zero, not the minimum', () => {
  const engine = new FeeEngine();
  engine.applyEvent(MIN_PACKAGE);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 10000 });
  assert.equal(engine.accountView('A').feeCents, 500);
  engine.applyEvent({ type: 'cancel', id: 't1' });
  const view = engine.accountView('A');
  assert.equal(view.feeCents, 0);
  assert.equal(view.hitTier, null);
  assert.equal(view.turnoverCents, 0);
});

test('raw fee above the minimum is charged as-is', () => {
  const engine = new FeeEngine();
  engine.applyEvent(MIN_PACKAGE);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100000 });
  assert.equal(engine.accountView('A').feeCents, 1000); // 10.00 > 5.00
});

test('rebates reduce the fee after the minimum is applied', () => {
  const engine = new FeeEngine();
  engine.applyEvent({
    type: 'package',
    id: 'reb',
    version: 1,
    tiers: [{ upTo: null, rate: 0.001 }],
    minFee: 5,
    rebates: [{ minTurnover: 50000, percent: 10 }],
  });
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100000 });
  // gross 100.00, rebate 10% -> 90.00
  assert.equal(engine.accountView('A').feeCents, 9000);
  engine.applyEvent({ type: 'cancel', id: 't1' });
  engine.applyEvent({ type: 'trade', id: 't2', account: 'A', amount: 40000 });
  // below the rebate threshold: gross 40.00, no rebate
  assert.equal(engine.accountView('A').feeCents, 4000);
});
