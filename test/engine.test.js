'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine, XborderError } = require('../src/engine');

function baseAccount() {
  return { type: 'account', budget: 100, quoteTtl: 10, worstRate: { USD: 2 }, frozen: { USD: 5 } };
}

test('A: pending payment is not eligible, quote arrival flips it to eligible', () => {
  const engine = new Engine();
  engine.apply(baseAccount());
  let patch = engine.apply({ type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: null, ts: 1 });
  assert.deepEqual(patch, { add: [], remove: [] });
  assert.equal(engine.eligible.has('p1'), false);

  patch = engine.apply({ type: 'quote', paymentId: 'p1', rate: 1.5, ts: 2 });
  assert.deepEqual(patch.add, ['p1']);
  assert.deepEqual(patch.remove, []);
  assert.equal(engine.eligible.has('p1'), true);
});

test('A: quote can also turn a payment rejected when it cannot fit the budget', () => {
  const engine = new Engine();
  engine.apply(baseAccount());
  engine.apply({ type: 'payment', id: 'big', amount: 60, ccy: 'USD', rate: null, ts: 1 });
  const patch = engine.apply({ type: 'quote', paymentId: 'big', rate: 2, ts: 2 });
  // 5 frozen + 60*2 = 125 > 100 -> rejected, stays out of eligibleSet
  assert.deepEqual(patch, { add: [], remove: [] });
  assert.equal(engine.eligible.has('big'), false);
});

test('B: worst-case estimate boundary exactly equal to budget is admissible', () => {
  const engine = new Engine();
  engine.apply({ type: 'account', budget: 100, quoteTtl: 10, worstRate: { USD: 2 }, frozen: {} });
  engine.apply({ type: 'payment', id: 'pend', amount: 10, ccy: 'USD', rate: null, ts: 1 });
  // pending worst case = 10 * 2 = 20; headroom left = 80
  engine.apply({ type: 'payment', id: 'exact', amount: 80, ccy: 'USD', rate: 1, ts: 2 });
  assert.equal(engine.eligible.has('exact'), true, '80 + 20 == 100 must be eligible');
  engine.apply({ type: 'freeze', paymentId: 'exact', ts: 3 }); // must not throw

  const engine2 = new Engine();
  engine2.apply({ type: 'account', budget: 100, quoteTtl: 10, worstRate: { USD: 2 }, frozen: {} });
  engine2.apply({ type: 'payment', id: 'pend', amount: 10, ccy: 'USD', rate: null, ts: 1 });
  engine2.apply({ type: 'payment', id: 'over', amount: 81, ccy: 'USD', rate: 1, ts: 2 });
  assert.equal(engine2.eligible.has('over'), false, '81 + 20 > 100 must be rejected');
  assert.throws(
    () => engine2.apply({ type: 'freeze', paymentId: 'over', ts: 3 }),
    (err) => err instanceof XborderError && err.code === 'E_BUDGET'
  );
});

test('B: account pre-frozen amounts count toward confirmed exposure at the boundary', () => {
  const engine = new Engine();
  engine.apply({ type: 'account', budget: 100, quoteTtl: 10, worstRate: { USD: 2 }, frozen: { USD: 5 } });
  engine.apply({ type: 'payment', id: 'pend', amount: 10, ccy: 'USD', rate: null, ts: 1 });
  // 5 confirmed + 20 worst-case pending -> headroom 75
  engine.apply({ type: 'payment', id: 'fit', amount: 75, ccy: 'USD', rate: 1, ts: 2 });
  assert.equal(engine.eligible.has('fit'), true);
  engine.apply({ type: 'payment', id: 'nofit', amount: 76, ccy: 'USD', rate: 1, ts: 3 });
  assert.equal(engine.eligible.has('nofit'), false);
});

test('C: reversing a freeze releases budget and restores eligibility', () => {
  const engine = new Engine();
  engine.apply({ type: 'account', budget: 100, quoteTtl: 100, worstRate: { USD: 2 }, frozen: {} });
  engine.apply({ type: 'payment', id: 'p1', amount: 80, ccy: 'USD', rate: 1, ts: 1 });
  engine.apply({ type: 'payment', id: 'p2', amount: 30, ccy: 'USD', rate: 1, ts: 2 });
  assert.equal(engine.eligible.has('p1'), true);
  assert.equal(engine.eligible.has('p2'), true);

  engine.apply({ type: 'freeze', paymentId: 'p1', ts: 3 });
  assert.equal(engine.eligible.has('p1'), false, 'frozen payment leaves eligibleSet');
  // 80 confirmed + 30 = 110 > 100 -> p2 no longer eligible
  assert.equal(engine.eligible.has('p2'), false);
  assert.throws(
    () => engine.apply({ type: 'freeze', paymentId: 'p2', ts: 4 }),
    (err) => err.code === 'E_BUDGET'
  );

  const patch = engine.apply({ type: 'reverse', paymentId: 'p1', ts: 5 });
  assert.deepEqual(patch.add, ['p1', 'p2']);
  assert.equal(engine.confirmedExposure(), 0, 'reverse releases confirmed exposure');
  assert.equal(engine.eligible.has('p1'), true);
  assert.equal(engine.eligible.has('p2'), true);
});

test('E_RATE_STALE: freezing after quote ttl expires fails', () => {
  const engine = new Engine();
  engine.apply({ type: 'account', budget: 100, quoteTtl: 5, worstRate: { USD: 2 }, frozen: {} });
  engine.apply({ type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: 1, ts: 1 });
  assert.equal(engine.eligible.has('p1'), true);
  engine.apply({ type: 'payment', id: 'tick', amount: 1, ccy: 'USD', rate: 1, ts: 10 });
  // now = 10, p1 quoteTs = 1, ttl = 5 -> stale
  assert.equal(engine.eligible.has('p1'), false);
  assert.throws(
    () => engine.apply({ type: 'freeze', paymentId: 'p1', ts: 11 }),
    (err) => err.code === 'E_RATE_STALE'
  );
});

test('E_RATE_STALE: quote older than the current quote is rejected', () => {
  const engine = new Engine();
  engine.apply(baseAccount());
  engine.apply({ type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: null, ts: 1 });
  engine.apply({ type: 'quote', paymentId: 'p1', rate: 1.5, ts: 5 });
  assert.throws(
    () => engine.apply({ type: 'quote', paymentId: 'p1', rate: 1.4, ts: 4 }),
    (err) => err.code === 'E_RATE_STALE'
  );
});

test('freeze of a pending (rate-less) payment is invalid, not a budget error', () => {
  const engine = new Engine();
  engine.apply(baseAccount());
  engine.apply({ type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: null, ts: 1 });
  assert.throws(
    () => engine.apply({ type: 'freeze', paymentId: 'p1', ts: 2 }),
    (err) => err.code === 'E_INVALID'
  );
});

test('patches are deltas, never a full snapshot', () => {
  const engine = new Engine();
  engine.apply(baseAccount());
  engine.apply({ type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: 1, ts: 1 });
  engine.apply({ type: 'payment', id: 'p2', amount: 10, ccy: 'USD', rate: 1, ts: 2 });
  const patch = engine.apply({ type: 'payment', id: 'p3', amount: 10, ccy: 'USD', rate: 1, ts: 3 });
  assert.deepEqual(patch, { add: ['p3'], remove: [] });
});
