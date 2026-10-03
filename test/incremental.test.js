import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine } from '../src/engine.js';
import { CODES } from '../src/errors.js';
import { replayEvents, LockLedger } from '../src/ledger.js';

const RATES_V1 = { USD: 1000000, EUR: 1000000 };

// Two disconnected components: a EUR cycle (a,b,c) and a USD pair (d,e).
function twoComponentEngine() {
  const e = new ClearingEngine({ base: 'USD' });
  e.addRateVersion(1, RATES_V1);
  e.setTrades([
    { id: 't1', from: 'a', to: 'b', ccy: 'EUR', amount: 100 },
    { id: 't2', from: 'b', to: 'c', ccy: 'EUR', amount: 100 },
    { id: 't3', from: 'c', to: 'a', ccy: 'EUR', amount: 150 },
    { id: 't4', from: 'd', to: 'e', ccy: 'USD', amount: 50 },
  ]);
  return e;
}

test('rate correction recomputes only the affected component/cycle', () => {
  const e = twoComponentEngine();
  const r1 = e.settle();
  assert.deepEqual(r1.locks, { c: 50, d: 50 });
  assert.deepEqual(e.componentStats, { a: 1, d: 1 });
  assert.deepEqual(e.lastRun, { mode: 'full', ratesVersion: 1, recomputedComponents: ['a', 'd'] });

  const r2 = e.correctRates({ EUR: 2000000 });
  assert.equal(r2.proof.ratesVersion, 2);
  // EUR trades doubled: c's net debit goes 50 -> 100; USD component untouched.
  assert.deepEqual(r2.netPositions, { a: 100, b: 0, c: -100, d: -50, e: 50 });
  assert.deepEqual(r2.locks, { c: 100, d: 50 });
  // Only the EUR component was recomputed.
  assert.deepEqual(e.lastRun, { mode: 'incremental', ratesVersion: 2, recomputedComponents: ['a'] });
  assert.deepEqual(e.componentStats, { a: 2, d: 1 });
  // The unaffected component's cycle/flow results are identical.
  assert.deepEqual(
    r2.residualFlows.filter((f) => f.from === 'd' || f.to === 'd'),
    r1.residualFlows.filter((f) => f.from === 'd' || f.to === 'd'),
  );
});

test('a correction that touches no active trade recomputes nothing', () => {
  const e = twoComponentEngine();
  e.settle();
  const r = e.correctRates({ EUR: 2000000, USD: 1000000 }); // USD unchanged
  assert.equal(r.proof.ratesVersion, 2);
  assert.throws(() => e.correctRates({ EUR: 2000000 }), (err) => err.code === CODES.INVALID_INPUT);
});

test('stale rate versions are rejected with RATE_STALE', () => {
  const e = twoComponentEngine();
  e.settle();
  e.correctRates({ EUR: 2000000 }); // version 2 registered
  assert.throws(
    () => e.settle({ ratesVersion: 1 }),
    (err) => {
      assert.equal(err.code, CODES.RATE_STALE);
      assert.deepEqual(err.details, { requested: 1, latest: 2 });
      return true;
    },
  );
  assert.throws(() => e.addRateVersion(2, RATES_V1), (err) => err.code === CODES.RATE_STALE);
  assert.throws(() => e.addRateVersion(1, RATES_V1), (err) => err.code === CODES.RATE_STALE);
  assert.throws(() => e.settle({ ratesVersion: 99 }), (err) => err.code === CODES.INVALID_INPUT);
});

test('voiding a trade releases frozen limits and the release is replayable', () => {
  const e = new ClearingEngine({ base: 'USD' });
  e.addRateVersion(1, { USD: 1000000 });
  e.setTrades([
    { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 },
    { id: 't2', from: 'b', to: 'c', ccy: 'USD', amount: 60 },
  ]);
  const r1 = e.settle();
  assert.deepEqual(r1.locks, { a: 100 });

  const r2 = e.voidTrade('t1');
  assert.deepEqual(r2.locks, { b: 60 });
  assert.deepEqual(r2.netPositions, { b: -60, c: 60 });
  // after voiding t1 the remaining component is {b,c}, id 'b'
  assert.deepEqual(e.lastRun, { mode: 'incremental', ratesVersion: 1, recomputedComponents: ['b'] });

  // The event log replays from an empty ledger to the same frozen balances.
  assert.deepEqual(e.events, [
    { seq: 1, type: 'lock', participant: 'a', amount: 100, reason: 'settle' },
    { seq: 2, type: 'release', participant: 'a', amount: 100, reason: 'release' },
    { seq: 3, type: 'lock', participant: 'b', amount: 60, reason: 'increment' },
  ]);
  assert.deepEqual(replayEvents(e.events), r2.locks);

  // Proof records the void; input hash changes.
  assert.notEqual(r2.proof.inputHash, r1.proof.inputHash);

  assert.throws(() => e.voidTrade('t1'), (err) => err.code === CODES.INVALID_INPUT);
  assert.throws(() => e.voidTrade('nope'), (err) => err.code === CODES.INVALID_INPUT);
});

test('voiding inside a cycle re-netted only that component', () => {
  const e = twoComponentEngine();
  e.settle();
  const r = e.voidTrade('t3'); // breaks the EUR cycle
  assert.deepEqual(r.netPositions, { a: -100, b: 0, c: 100, d: -50, e: 50 });
  assert.deepEqual(r.locks, { a: 100, d: 50 });
  assert.deepEqual(e.lastRun.recomputedComponents, ['a']);
  assert.deepEqual(e.componentStats, { a: 2, d: 1 });
  assert.deepEqual(replayEvents(e.events), r.locks);
});

test('NEGATIVE_RELEASE guards the ledger against corrupt replays', () => {
  const ledger = new LockLedger();
  ledger.lock('a', 40);
  assert.throws(
    () => ledger.release('a', 41),
    (err) => {
      assert.equal(err.code, CODES.NEGATIVE_RELEASE);
      assert.deepEqual(err.details, { participant: 'a', locked: 40, release: 41 });
      return true;
    },
  );
  // A duplicated release event in a replayed log is detected.
  assert.throws(
    () =>
      replayEvents([
        { type: 'lock', participant: 'a', amount: 10 },
        { type: 'release', participant: 'a', amount: 10 },
        { type: 'release', participant: 'a', amount: 10 },
      ]),
    (err) => err.code === CODES.NEGATIVE_RELEASE,
  );
  // Releasing for a participant that never locked is also negative.
  assert.throws(
    () => replayEvents([{ type: 'release', participant: 'ghost', amount: 1 }]),
    (err) => err.code === CODES.NEGATIVE_RELEASE,
  );
});

test('incremental updates keep output deterministic and replay-consistent', () => {
  const e = twoComponentEngine();
  e.settle();
  e.correctRates({ EUR: 1500000 });
  e.voidTrade('t2');
  const viaIncrements = e.result;
  assert.deepEqual(replayEvents(e.events), viaIncrements.locks);

  // A fresh engine applying the same final inputs settles to the same result.
  const f = new ClearingEngine({ base: 'USD' });
  f.addRateVersion(1, RATES_V1);
  f.addRateVersion(2, { USD: 1000000, EUR: 1500000 });
  f.setTrades([
    { id: 't1', from: 'a', to: 'b', ccy: 'EUR', amount: 100 },
    { id: 't2', from: 'b', to: 'c', ccy: 'EUR', amount: 100 },
    { id: 't3', from: 'c', to: 'a', ccy: 'EUR', amount: 150 },
    { id: 't4', from: 'd', to: 'e', ccy: 'USD', amount: 50 },
  ]);
  f.voidTrade('t2');
  const viaFull = f.settle();
  assert.deepEqual(viaIncrements, viaFull);
});
