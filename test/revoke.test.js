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

// Acceptance A: two-level revoke restores the original discount allocation.
test('A: revoking a parent refund cascades and restores original discount/tax/points', () => {
  const ledger = makeLedger();
  const original = ledger.computeOrder('o1');
  ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 400 }], { date: '2026-10-01' });
  ledger.refund('r2', 'o1', [{ lineId: 'l2', amount: 900 }], { date: '2026-10-02' });
  assert.notDeepEqual(ledger.computeOrder('o1').totals, original.totals);

  const res = ledger.revoke('r1');
  assert.deepEqual(res.revoked, ['r1', 'r2']); // child r2 rolled back with parent
  const restored = ledger.computeOrder('o1');
  assert.deepEqual(restored.totals, original.totals);
  for (const [lineId, line] of original.lines) {
    assert.deepEqual(restored.lines.get(lineId), line); // original discount allocation restored
  }
  assert.equal(ledger.refunds.get('r1').status, 'revoked');
  assert.equal(ledger.refunds.get('r2').status, 'revoked');
});

test('E_ROLLBACK_PATH: settled child blocks revoke, whole subtree unchanged', () => {
  const ledger = makeLedger();
  ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 400 }], { date: '2026-10-01' });
  ledger.refund('r2', 'o1', [{ lineId: 'l2', amount: 900 }], { date: '2026-10-02' });
  ledger.settle('r2');
  const snapshot = ledger.computeOrder('o1');

  let err;
  try { ledger.revoke('r1'); } catch (e) { err = e; }
  assert.equal(err?.code, 'E_ROLLBACK_PATH');
  assert.deepEqual(err.path, ['r1', 'r2']);
  assert.equal(err.blockedBy, 'r2');

  // nothing changed: statuses, derived state, refunded amounts
  assert.equal(ledger.refunds.get('r1').status, 'pending');
  assert.equal(ledger.refunds.get('r2').status, 'settled');
  assert.deepEqual(ledger.computeOrder('o1'), snapshot);
});

// Acceptance D: settled revoke errors but can emit an optional reverse flow.
test('D: revoke of settled refund errors; reverse option generates reverse flow', () => {
  const ledger = makeLedger();
  const node = ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 400 }], { date: '2026-10-01' });
  ledger.settle('r1');

  assert.throws(() => ledger.revoke('r1'), (e) => e.code === 'E_ALREADY_SETTLED');
  assert.equal(ledger.reversals.length, 0);

  let err;
  try { ledger.revoke('r1', { reverse: true }); } catch (e) { err = e; }
  assert.equal(err?.code, 'E_ALREADY_SETTLED');
  assert.equal(ledger.reversals.length, 1);
  const rev = ledger.reversals[0];
  assert.equal(rev.of, 'r1');
  assert.equal(rev.gross, -node.gross);
  assert.deepEqual(rev.effects, node.effects.map((e) => ({ ...e, discount: -e.discount, tax: -e.tax, points: -e.points })));
  assert.equal(err.reversal.revId, 'r1:rev');
  // original refund untouched
  assert.equal(ledger.refunds.get('r1').status, 'settled');
});

test('revoke of unknown or already-revoked refund rejected', () => {
  const ledger = makeLedger();
  ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 100 }]);
  ledger.revoke('r1');
  assert.throws(() => ledger.revoke('r1'), (e) => e.code === 'E_ALREADY_REVOKED');
  assert.throws(() => ledger.revoke('nope'), (e) => e.code === 'E_NOT_FOUND');
});
