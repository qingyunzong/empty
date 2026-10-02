import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RefundService } from '../src/refund.js';

// Deterministic PRNG so the enumeration is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent re-implementation of the cumulative split used only by this
// test: proportional shares with the rounding remainder handed out by the
// largest remainder method (fixed tie-break order merchant > commission > tax).
function independentSplit(amount, comps) {
  const keys = ['merchant', 'commission', 'tax'];
  const total = comps.merchant + comps.commission + comps.tax;
  const out = { merchant: 0, commission: 0, tax: 0 };
  if (amount === 0) return out;
  const rows = keys.map((k) => {
    const num = amount * comps[k];
    const base = Math.floor(num / total);
    out[k] = base;
    return { k, rem: num % total };
  });
  rows.sort((a, b) => b.rem - a.rem || keys.indexOf(a.k) - keys.indexOf(b.k));
  let left = amount - (out.merchant + out.commission + out.tax);
  for (const row of rows) {
    if (left === 0) break;
    out[row.k] += 1;
    left -= 1;
  }
  return out;
}

test('enumerator: totals <= 20, 3 candidate refunds, all subsets', () => {
  const rand = mulberry32(20261003);
  const TRIALS = 400;
  let subsetRuns = 0;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const total = 1 + Math.floor(rand() * 20); // original total, 1..20
    const merchant = Math.floor(rand() * (total + 1));
    const commission = Math.floor(rand() * (total - merchant + 1));
    const tax = total - merchant - commission;
    const comps = { merchant, commission, tax };
    // 3 candidate refund amounts, deliberately allowed to exceed the total
    const candidates = [0, 1, 2].map(() => Math.floor(rand() * (total + 3)));

    for (let mask = 0; mask < 8; mask += 1) {
      const chosen = candidates
        .filter((_, i) => (mask & (1 << i)) !== 0)
        .filter((a) => a > 0);
      subsetRuns += 1;

      const service = new RefundService();
      service.settlePayment({ paymentId: 'p', ...comps });

      // Independent expectation: a refund succeeds iff the running cumulative
      // amount stays within the original total.
      let cumulative = 0;
      const succeeded = [];
      chosen.forEach((amount, i) => {
        const refundId = `r${i}`;
        if (cumulative + amount <= total) {
          service.requestRefund({ refundId, paymentId: 'p', amount });
          cumulative += amount;
          succeeded.push(refundId);
        } else {
          assert.throws(
            () => service.requestRefund({ refundId, paymentId: 'p', amount }),
            (err) => err.code === 'REFUND_EXCEEDED',
          );
        }
      });
      for (const refundId of succeeded) service.registerRefund(refundId);

      const balance = service.getBalance('p');
      const expected = independentSplit(cumulative, comps);
      assert.deepEqual(
        balance.posted,
        expected,
        `trial=${trial} mask=${mask} comps=${JSON.stringify(comps)} chosen=${chosen}`,
      );
      for (const k of ['merchant', 'commission', 'tax']) {
        assert.ok(balance.posted[k] <= comps[k], `posted ${k} exceeds original`);
        assert.ok(balance.posted[k] >= 0);
      }
      assert.equal(balance.posted.merchant + balance.posted.commission + balance.posted.tax, cumulative);
      assert.ok(cumulative <= total);
      assert.equal(balance.refundedTotal, cumulative);
    }
  }
  assert.equal(subsetRuns, TRIALS * 8);
});

test('enumerator boundary: exact total succeeds, total + 1 fails', () => {
  for (let total = 1; total <= 20; total += 1) {
    const comps = { merchant: total - (total >> 1), commission: total >> 1, tax: 0 };
    const service = new RefundService();
    service.settlePayment({ paymentId: 'p', ...comps });
    service.requestRefund({ refundId: 'full', paymentId: 'p', amount: total });
    service.registerRefund('full');
    const balance = service.getBalance('p');
    assert.deepEqual(balance.posted, comps);
    assert.throws(
      () => service.requestRefund({ refundId: 'over', paymentId: 'p', amount: 1 }),
      (err) => err.code === 'REFUND_EXCEEDED',
    );
    assert.deepEqual(service.getBalance('p').posted, comps);
  }
});
