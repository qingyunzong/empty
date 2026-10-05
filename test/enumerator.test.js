import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

const KEYS = ['merchant', 'commission', 'tax'];

// Independent re-implementation of the proportional split with
// largest-remainder rounding, written separately from src/split.js:
// iteratively picks the component with the largest leftover fraction.
function independentSplit(amount, comps) {
  const total = KEYS.reduce((s, k) => s + comps[k], 0);
  const numerators = KEYS.map((k) => amount * comps[k]);
  const base = numerators.map((n) => Math.floor(n / total));
  const remainders = numerators.map((n, i) => n - base[i] * total);
  const out = [...base];
  let leftover = amount - base.reduce((a, b) => a + b, 0);
  while (leftover > 0) {
    let best = 0;
    for (let i = 1; i < remainders.length; i += 1) {
      if (remainders[i] > remainders[best]) best = i;
    }
    out[best] += 1;
    remainders[best] = -1;
    leftover -= 1;
  }
  return { merchant: out[0], commission: out[1], tax: out[2] };
}

function componentsFor(total) {
  const merchant = Math.floor(total / 2);
  const commission = Math.floor((total - merchant) / 2);
  const tax = total - merchant - commission;
  return { merchant, commission, tax };
}

function candidatesFor(total) {
  return [Math.ceil(total / 2), Math.ceil(total / 3), Math.ceil(total / 4)];
}

test('enumerator: totals <= 20, 3 candidate refunds, all subsets', () => {
  for (let total = 1; total <= 20; total += 1) {
    const comps = componentsFor(total);
    const candidates = candidatesFor(total);
    for (let mask = 0; mask < 8; mask += 1) {
      const ledger = new Ledger();
      ledger.addPayment({ paymentId: 'p', ...comps });
      const expected = { merchant: 0, commission: 0, tax: 0 };
      let cumulative = 0;
      const refundIds = [];
      for (let i = 0; i < 3; i += 1) {
        if (!(mask & (1 << i))) continue;
        const amount = candidates[i];
        const refundId = `r${i}`;
        if (cumulative + amount > total) {
          const eventsBefore = ledger.events.length;
          assert.throws(
            () => ledger.requestRefund({ refundId, paymentId: 'p', amount }),
            (err) => err.code === 'REFUND_EXCEEDED',
          );
          assert.equal(ledger.events.length, eventsBefore, 'overflow leaves history untouched');
          continue;
        }
        const { result } = ledger.requestRefund({ refundId, paymentId: 'p', amount });
        const expectedSplit = independentSplit(amount, comps);
        assert.deepEqual(
          result.split,
          expectedSplit,
          `total=${total} mask=${mask} refund=${amount}`,
        );
        cumulative += amount;
        for (const key of KEYS) expected[key] += expectedSplit[key];
        refundIds.push(refundId);
      }
      assert.ok(cumulative <= total, 'cumulative refunds never exceed the payment');

      for (const refundId of refundIds) {
        ledger.registerRefund({ refundId });
      }
      const snap = ledger.snapshot();
      assert.deepEqual(snap.payments[0].posted, expected, `total=${total} mask=${mask}`);
      assert.equal(snap.payments[0].postedTotal, cumulative);
      assert.equal(snap.payments[0].remaining, total - cumulative);
      assert.ok(snap.payments[0].postedTotal <= snap.payments[0].total);
    }
  }
});

test('boundary: exact total succeeds, one unit more is rejected', () => {
  for (let total = 1; total <= 20; total += 1) {
    const comps = componentsFor(total);

    const exact = new Ledger();
    exact.addPayment({ paymentId: 'p', ...comps });
    const { result } = exact.requestRefund({ refundId: 'r', paymentId: 'p', amount: total });
    assert.deepEqual(result.split, comps, 'full refund returns the original components');
    assert.throws(
      () => exact.requestRefund({ refundId: 'r2', paymentId: 'p', amount: 1 }),
      (err) => err.code === 'REFUND_EXCEEDED',
    );

    const over = new Ledger();
    over.addPayment({ paymentId: 'p', ...comps });
    assert.throws(
      () => over.requestRefund({ refundId: 'r', paymentId: 'p', amount: total + 1 }),
      (err) => err.code === 'REFUND_EXCEEDED',
    );
    assert.equal(over.events.length, 1, 'only the payment event remains');
  }
});
