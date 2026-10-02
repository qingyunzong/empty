import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { E } from '../src/errors.js';

function chargebackedTx(ledger, id, captureDay) {
  ledger.apply({ type: 'auth', id, merchant: 'm', day: '2024-03-01', amount: 500, currency: 'USD' });
  ledger.apply({ type: 'capture', id, day: captureDay });
  ledger.apply({ type: 'chargeback', id });
}

test('D: chargeback reversal fails with E_LOCKED after settlement, no side effects', () => {
  const ledger = new Ledger();
  chargebackedTx(ledger, 't1', '2024-03-10');
  ledger.apply({ type: 'settle', merchant: 'm', day: '2024-03-31' });

  const statsBefore = ledger.merchantStats('m', '2024-03-10');
  const capturesBefore = structuredClone(ledger.captures);

  assert.throws(
    () => ledger.apply({ type: 'reverse_chargeback', id: 't1' }),
    (err) => err.code === E.LOCKED,
  );

  // no side effects: state, stats and capture log are untouched
  assert.equal(ledger.transactions.get('t1').state, 'chargeback');
  assert.deepEqual(ledger.merchantStats('m', '2024-03-10'), statsBefore);
  assert.deepEqual(ledger.captures, capturesBefore);

  // repeated attempts keep failing the same way
  assert.throws(
    () => ledger.apply({ type: 'reverse_chargeback', id: 't1' }),
    (err) => err.code === E.LOCKED,
  );
});

test('D: lock boundary is inclusive of the capture day', () => {
  // settle day == capture day -> locked
  const locked = new Ledger();
  chargebackedTx(locked, 't1', '2024-03-10');
  locked.apply({ type: 'settle', merchant: 'm', day: '2024-03-10' });
  assert.throws(
    () => locked.apply({ type: 'reverse_chargeback', id: 't1' }),
    (err) => err.code === E.LOCKED,
  );

  // settle day < capture day -> not locked, reversal succeeds
  const open = new Ledger();
  chargebackedTx(open, 't1', '2024-03-10');
  open.apply({ type: 'settle', merchant: 'm', day: '2024-03-09' });
  open.apply({ type: 'reverse_chargeback', id: 't1' });
  assert.equal(open.transactions.get('t1').state, 'capture');
});

test('D: settlement is per-merchant and reversal works before any settlement', () => {
  const ledger = new Ledger();
  chargebackedTx(ledger, 't1', '2024-03-10');
  chargebackedTx(ledger, 't2', '2024-03-10');
  ledger.apply({ type: 'settle', merchant: 'other', day: '2024-03-31' });
  ledger.apply({ type: 'reverse_chargeback', id: 't1' });
  assert.equal(ledger.transactions.get('t1').state, 'capture');

  // a later settlement then locks the remaining chargeback
  ledger.apply({ type: 'settle', merchant: 'm', day: '2024-03-10' });
  assert.throws(
    () => ledger.apply({ type: 'reverse_chargeback', id: 't2' }),
    (err) => err.code === E.LOCKED,
  );
});
