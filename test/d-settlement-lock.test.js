'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');

function capturedOn(l, id, day, merchant = 'm1') {
  l.apply({ type: 'auth', id, merchant, day, amount: 100, currency: 'USD', tip: null });
  l.apply({ type: 'capture', id, day });
}

test('D: reversing a chargeback on a settled capture fails with E_LOCKED and no side effects', () => {
  const l = new Ledger();
  capturedOn(l, 't1', '2026-10-01');
  l.apply({ type: 'settle', merchant: 'm1', day: '2026-10-01' });
  l.apply({ type: 'chargeback', id: 't1' });
  const statsBefore = l.merchantStats('m1', '2026-10-01');
  const logLen = l.log.length;
  assert.throws(
    () => l.apply({ type: 'reverse_chargeback', id: 't1' }),
    (err) => err.code === 'E_LOCKED',
  );
  // No side effects: state, stats, log and lock table all unchanged.
  assert.equal(l.txns.get('t1').state, 'charged_back');
  assert.deepEqual(l.merchantStats('m1', '2026-10-01'), statsBefore);
  assert.equal(l.log.length, logLen);
  assert.equal(l.lockedThrough.get('m1'), '2026-10-01');
});

test('D: lock boundary is inclusive and explicit', () => {
  const l = new Ledger();
  capturedOn(l, 'before', '2026-10-01');  // on the boundary: locked
  capturedOn(l, 'after', '2026-10-02');   // past the boundary: not locked
  l.apply({ type: 'settle', merchant: 'm1', day: '2026-10-01' });
  l.apply({ type: 'chargeback', id: 'before' });
  l.apply({ type: 'chargeback', id: 'after' });
  assert.throws(() => l.apply({ type: 'reverse_chargeback', id: 'before' }), /locked/);
  l.apply({ type: 'reverse_chargeback', id: 'after' }); // succeeds
  assert.equal(l.txns.get('after').state, 'captured');
  // Extending the settlement to 2026-10-02 now locks the second capture too.
  l.apply({ type: 'chargeback', id: 'after' });
  l.apply({ type: 'settle', merchant: 'm1', day: '2026-10-02' });
  assert.throws(() => l.apply({ type: 'reverse_chargeback', id: 'after' }),
    (err) => err.code === 'E_LOCKED');
});

test('D: settlement lock is per-merchant', () => {
  const l = new Ledger();
  capturedOn(l, 'x1', '2026-10-01', 'mA');
  capturedOn(l, 'x2', '2026-10-01', 'mB');
  l.apply({ type: 'settle', merchant: 'mA', day: '2026-10-01' });
  l.apply({ type: 'chargeback', id: 'x1' });
  l.apply({ type: 'chargeback', id: 'x2' });
  assert.throws(() => l.apply({ type: 'reverse_chargeback', id: 'x1' }),
    (err) => err.code === 'E_LOCKED');
  l.apply({ type: 'reverse_chargeback', id: 'x2' }); // other merchant unaffected
  assert.equal(l.txns.get('x2').state, 'captured');
});
