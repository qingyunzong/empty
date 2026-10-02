import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

const makeLedger = () => {
  const ledger = new Ledger();
  ledger.addOrder({
    orderId: 'o1', merchantId: 'm1', discount: 100, pointsRate: 0.01,
    lines: [
      { lineId: 'l1', amount: 1000, taxRate: 0.1 },
      { lineId: 'l2', amount: 3000, taxRate: 0.1 },
    ],
  });
  return ledger;
};

test('refund recomputes discount allocation, tax and points', () => {
  const ledger = makeLedger();
  const before = ledger.computeOrder('o1');
  assert.deepEqual(before.totals, { effective: 4000, discount: 100, net: 3900, tax: 391, points: 38, gross: 4291 });

  const node = ledger.refund('r1', 'o1', [{ lineId: 'l2', amount: 1000 }], { date: '2026-10-01' });
  const after = ledger.computeOrder('o1');

  // effective: l1=1000, l2=2000 -> discount 100 splits 33/67 (remainders tie? 100*1000/3000=33.33, 100*2000/3000=66.67)
  assert.equal(after.lines.get('l1').discount, 33);
  assert.equal(after.lines.get('l2').discount, 67);
  assert.equal(after.totals.discount, 100);
  // gross delta equals what the refund node recorded
  assert.equal(node.gross, before.totals.gross - after.totals.gross);
  // effects are the per-line deltas of the refunded line
  const eff = node.effects.find((e) => e.lineId === 'l2');
  assert.equal(eff.amount, 1000);
  assert.equal(eff.discount, after.lines.get('l2').discount - before.lines.get('l2').discount);
  assert.equal(eff.tax, after.lines.get('l2').tax - before.lines.get('l2').tax);
  assert.equal(eff.points, after.lines.get('l2').points - before.lines.get('l2').points);
});

test('refund exceeding remaining line amount is rejected', () => {
  const ledger = makeLedger();
  ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 800 }]);
  assert.throws(() => ledger.refund('r2', 'o1', [{ lineId: 'l1', amount: 201 }]), (e) => e.code === 'E_INVALID_REFUND');
  assert.doesNotThrow(() => ledger.refund('r2', 'o1', [{ lineId: 'l1', amount: 200 }])); // exactly remaining is fine
});

test('duplicate refId and unknown order/line rejected', () => {
  const ledger = makeLedger();
  ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 1 }]);
  assert.throws(() => ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 1 }]), (e) => e.code === 'E_DUPLICATE_REF');
  assert.throws(() => ledger.refund('r3', 'nope', [{ lineId: 'l1', amount: 1 }]), (e) => e.code === 'E_NOT_FOUND');
  assert.throws(() => ledger.refund('r4', 'o1', [{ lineId: 'nope', amount: 1 }]), (e) => e.code === 'E_VALIDATION');
});
