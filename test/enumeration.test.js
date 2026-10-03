// Acceptance D: cross-check the incremental engine against an independent
// reference implementation over ALL subsets (order preserved) of an 8-event
// pool: 2^8 = 256 runs, comparing final eligible sets, patch streams, and
// error codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, EngineError } from '../src/engine.js';
import { runReference } from '../src/reference.js';

const POOL = [
  { type: 'account', budget: 300, worstRates: { USD: 2, EUR: 1.5 } },
  { type: 'payment', id: 'p1', amount: 100, ccy: 'USD', rate: null },
  { type: 'payment', id: 'p2', amount: 80, ccy: 'EUR', rate: 1.2 },
  { type: 'freeze', paymentId: 'p1' },
  { type: 'freeze', paymentId: 'p2' },
  { type: 'quote', paymentId: 'p1', rate: 1.4, ts: 1 },
  { type: 'reverse', paymentId: 'p2' },
  { type: 'reverse', paymentId: 'p1' },
];

function runEngine(events) {
  const engine = createEngine();
  const patches = [];
  events.forEach((e, i) => patches.push(...engine.apply(e, i + 1)));
  return { eligible: engine.eligibleSet(), patches };
}

function subsets(pool) {
  const out = [];
  for (let mask = 0; mask < (1 << pool.length); mask += 1) {
    out.push(pool.filter((_, i) => mask & (1 << i)));
  }
  return out;
}

test('D: incremental engine matches reference over all 2^8 event subsets', () => {
  const all = subsets(POOL);
  assert.equal(all.length, 256);
  let errorRuns = 0;
  let okRuns = 0;
  for (const events of all) {
    let engineResult;
    let engineError = null;
    try {
      engineResult = runEngine(events);
    } catch (err) {
      assert.ok(err instanceof EngineError, `unexpected error type: ${err}`);
      engineError = err;
    }
    let refResult;
    let refError = null;
    try {
      refResult = runReference(events);
    } catch (err) {
      assert.ok(err instanceof EngineError, `unexpected reference error type: ${err}`);
      refError = err;
    }
    const label = JSON.stringify(events.map((e) => e.type + (e.id ?? e.paymentId ?? '')));
    assert.equal(engineError === null, refError === null, `error mismatch for ${label}`);
    if (engineError) {
      assert.equal(engineError.code, refError.code, `error code mismatch for ${label}`);
      errorRuns += 1;
    } else {
      assert.deepEqual(engineResult.eligible, refResult.eligible, `eligible mismatch for ${label}`);
      assert.deepEqual(engineResult.patches, refResult.patches, `patch mismatch for ${label}`);
      okRuns += 1;
    }
  }
  // Sanity: the pool must exercise both success and error paths.
  assert.ok(okRuns > 0, 'expected some successful subsets');
  assert.ok(errorRuns > 0, 'expected some error subsets');
});
