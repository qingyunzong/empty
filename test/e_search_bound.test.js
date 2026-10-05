// Acceptance E: exceeding the search bound K=5 must raise SEARCH_BOUND,
// must never be reported as "no difference", and the certificate must still
// state the proven lower bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLedgers, verifyCertificate } from '../src/index.js';
import { pair } from './helpers.js';

function ledgers() {
  const right = [
    ...pair('r1', 'r2', { relId: 't1' }),
    ...pair('r3', 'r4', { relId: 't2', amount: 20 }),
    ...pair('r5', 'r6', { relId: 't3', amount: 7 }),
  ];
  // Left carries 6 extra events (3 extra balanced pairs) -> every repair
  // needs at least 6 operations, one per surplus event.
  const left = [
    ...pair('l1', 'l2', { relId: 't1' }),
    ...pair('l3', 'l4', { relId: 't2', amount: 20 }),
    ...pair('l5', 'l6', { relId: 't3', amount: 7 }),
    ...pair('x1', 'x2', { relId: 'e1', amount: 1 }),
    ...pair('x3', 'x4', { relId: 'e2', amount: 2 }),
    ...pair('x5', 'x6', { relId: 'e3', amount: 3 }),
  ];
  return { left, right };
}

test('E1: minimal cost 6 with k=5 -> SEARCH_BOUND with proven lower bound 6', () => {
  const { left, right } = ledgers();
  const res = diffLedgers(left, right, { k: 5 });
  assert.equal(res.balanced, false, 'a bounded search must never be reported as balanced');
  assert.equal(res.error.code, 'SEARCH_BOUND');
  assert.deepEqual(res.scripts, []);
  assert.equal(res.certificate.reason, 'SEARCH_BOUND');
  assert.ok(res.certificate.provenLowerBound >= 6, `lower bound too weak: ${res.certificate.provenLowerBound}`);
  assert.equal(res.certificate.k, 5);
});

test('E2: the SEARCH_BOUND certificate still verifies', () => {
  const { left, right } = ledgers();
  const res = diffLedgers(left, right, { k: 5 });
  assert.deepEqual(verifyCertificate(left, right, res.certificate), { valid: true });
});

test('E3: same ledgers with k=6 resolve to 6 removeExtra ops', () => {
  const { left, right } = ledgers();
  const res = diffLedgers(left, right, { k: 6 });
  assert.equal(res.error, null);
  assert.equal(res.minCost, 6);
  assert.ok(
    res.scripts.some((s) => s.every((op) => op.op === 'removeExtra' && op.side === 'left')),
  );
});

test('E4: tiny node budget forces a bounded search, never a false "balanced"', () => {
  // Pure internal imbalance (identical unbalanced ledgers) requires the
  // bounded BFS; a budget of 1 state must surface SEARCH_BOUND, and the
  // certificate must still carry the proven lower bound (>= 2 here).
  const left = [{ id: 'a', account: 'cash', amount: 100, direction: 'debit', currency: 'USD', relId: 'r1' }];
  const right = [{ id: 'b', account: 'cash', amount: 100, direction: 'debit', currency: 'USD', relId: 'r1' }];
  const res = diffLedgers(left, right, { k: 5, budget: 1 });
  assert.equal(res.balanced, false);
  assert.equal(res.error.code, 'SEARCH_BOUND');
  assert.ok(res.certificate.provenLowerBound >= 2);
  assert.deepEqual(verifyCertificate(left, right, res.certificate), { valid: true });
});
