import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, EngineError } from '../src/engine.js';

function feed(engine, events) {
  const all = [];
  events.forEach((e, i) => all.push(...engine.apply(e, i + 1)));
  return all;
}

test('A: pending payment is not unsatisfiable; quote arrival turns it eligible', () => {
  const engine = createEngine();
  const patches = feed(engine, [
    { type: 'account', budget: 1000, worstRates: { USD: 2 } },
    { type: 'payment', id: 'p1', amount: 100, ccy: 'USD', rate: null },
    { type: 'freeze', paymentId: 'p1' }, // reserves worst-case 200, still pending
    { type: 'quote', paymentId: 'p1', rate: 1.5, ts: 1 }, // actual 150 -> eligible
  ]);
  // Pending after freeze: reserved but not eligible, and not rejected either.
  assert.deepEqual(patches, [{ seq: 1, event: 4, op: 'add', id: 'p1' }]);
  assert.deepEqual(engine.eligibleSet(), ['p1']);
  assert.deepEqual(engine.exposure(), { confirmed: 150, pendingWorst: 0, total: 150, budget: 1000 });
});

test('A2: quote re-evaluation can reject when actual exposure exceeds budget', () => {
  const engine = createEngine();
  feed(engine, [
    { type: 'account', budget: 250, worstRates: { USD: 2 } },
    { type: 'payment', id: 'p1', amount: 100, ccy: 'USD', rate: null },
    { type: 'freeze', paymentId: 'p1' }, // worst-case 200 <= 250
  ]);
  assert.deepEqual(engine.exposure().total, 200);
  const patches = feed(engine, [
    { type: 'quote', paymentId: 'p1', rate: 3, ts: 1 }, // actual 300 > 250 -> rejected
  ]);
  assert.deepEqual(patches, []); // was never eligible, so no remove patch
  assert.deepEqual(engine.eligibleSet(), []);
  assert.equal(engine.exposure().total, 0); // freeze rolled back, budget released
  // Budget is reusable after rejection.
  feed(engine, [
    { type: 'payment', id: 'p2', amount: 200, ccy: 'EUR', rate: 1 },
    { type: 'freeze', paymentId: 'p2' },
  ]);
  assert.deepEqual(engine.eligibleSet(), ['p2']);
});

test('A3: re-quote of an eligible frozen payment can reject and emits remove patch', () => {
  const engine = createEngine();
  const patches = feed(engine, [
    { type: 'account', budget: 100, worstRates: {} },
    { type: 'payment', id: 'p1', amount: 50, ccy: 'EUR', rate: 1 },
    { type: 'freeze', paymentId: 'p1' },
    { type: 'quote', paymentId: 'p1', rate: 3, ts: 1 },
  ]);
  assert.deepEqual(patches, [
    { seq: 1, event: 3, op: 'add', id: 'p1' },
    { seq: 2, event: 4, op: 'remove', id: 'p1' },
  ]);
  assert.deepEqual(engine.eligibleSet(), []);
  assert.equal(engine.exposure().total, 0);
});

test('B: worst-case estimate exactly equal to budget is allowed (boundary)', () => {
  const engine = createEngine();
  feed(engine, [
    { type: 'account', budget: 200, worstRates: { USD: 2 } },
    { type: 'payment', id: 'p1', amount: 100, ccy: 'USD', rate: null },
    { type: 'freeze', paymentId: 'p1' }, // 100 * 2 == 200 == budget -> OK
  ]);
  assert.equal(engine.exposure().total, 200);
  assert.equal(engine.exposure().budget, 200);
  // One more unit of reservation must fail with E_BUDGET.
  feed(engine, [{ type: 'payment', id: 'p2', amount: 1, ccy: 'EUR', rate: 1 }]);
  assert.throws(
    () => engine.apply({ type: 'freeze', paymentId: 'p2' }, 5),
    (err) => err instanceof EngineError && err.code === 'E_BUDGET',
  );
});

test('C: reverse releases the reservation and frees budget', () => {
  const engine = createEngine();
  const patches = feed(engine, [
    { type: 'account', budget: 100, worstRates: {} },
    { type: 'payment', id: 'p1', amount: 60, ccy: 'EUR', rate: 1 },
    { type: 'payment', id: 'p2', amount: 60, ccy: 'EUR', rate: 1 },
    { type: 'freeze', paymentId: 'p1' },
    { type: 'reverse', paymentId: 'p1' },
    { type: 'freeze', paymentId: 'p2' }, // fits only because p1 was reversed
  ]);
  assert.deepEqual(patches, [
    { seq: 1, event: 4, op: 'add', id: 'p1' },
    { seq: 2, event: 5, op: 'remove', id: 'p1' },
    { seq: 3, event: 6, op: 'add', id: 'p2' },
  ]);
  assert.deepEqual(engine.eligibleSet(), ['p2']);
  assert.equal(engine.exposure().total, 60);
});

test('E_RATE_STALE: quote ts must be strictly newer than current rateTs', () => {
  const engine = createEngine();
  feed(engine, [
    { type: 'account', budget: 1000, worstRates: {} },
    { type: 'payment', id: 'p1', amount: 10, ccy: 'EUR', rate: 1, rateTs: 5 },
  ]);
  assert.throws(
    () => engine.apply({ type: 'quote', paymentId: 'p1', rate: 2, ts: 5 }, 3),
    (err) => err.code === 'E_RATE_STALE',
  );
  assert.throws(
    () => engine.apply({ type: 'quote', paymentId: 'p1', rate: 2, ts: 3 }, 4),
    (err) => err.code === 'E_RATE_STALE',
  );
  engine.apply({ type: 'quote', paymentId: 'p1', rate: 2, ts: 6 }, 5); // fresh quote OK
  assert.throws(
    () => engine.apply({ type: 'quote', paymentId: 'p1', rate: 3, ts: 6 }, 6),
    (err) => err.code === 'E_RATE_STALE',
  );
});

test('E_BUDGET: failed freeze leaves state untouched and engine reusable', () => {
  const engine = createEngine();
  feed(engine, [
    { type: 'account', budget: 100, worstRates: {} },
    { type: 'payment', id: 'p1', amount: 80, ccy: 'EUR', rate: 1 },
    { type: 'payment', id: 'p2', amount: 50, ccy: 'EUR', rate: 1 },
    { type: 'freeze', paymentId: 'p1' },
  ]);
  assert.throws(
    () => engine.apply({ type: 'freeze', paymentId: 'p2' }, 5),
    (err) => err.code === 'E_BUDGET',
  );
  assert.deepEqual(engine.eligibleSet(), ['p1']);
  assert.equal(engine.exposure().total, 80);
});

test('patches are incremental: unchanged events emit nothing', () => {
  const engine = createEngine();
  const patches = feed(engine, [
    { type: 'account', budget: 1000, worstRates: { USD: 2 } },
    { type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: null },
    { type: 'payment', id: 'p2', amount: 10, ccy: 'USD', rate: 1 },
    { type: 'freeze', paymentId: 'p1' }, // pending: no patch
    { type: 'freeze', paymentId: 'p2' }, // eligible: add
    { type: 'reverse', paymentId: 'p1' }, // not eligible: no patch
  ]);
  assert.deepEqual(patches, [{ seq: 1, event: 5, op: 'add', id: 'p2' }]);
});
