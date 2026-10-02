import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

test('equal lamport timestamps are ordered lexicographically regardless of arrival order', () => {
  const build = (first, second) => {
    const ledger = new Ledger();
    const amountFor = (id) => (id === 'va' ? '1' : '2');
    ledger.addVoucher({ id: first, lamport: 5, postings: [{ account: 'a', amount: amountFor(first), currency: 'BASE' }] });
    ledger.addVoucher({ id: second, lamport: 5, postings: [{ account: 'a', amount: amountFor(second), currency: 'BASE' }] });
    return ledger;
  };
  const l1 = build('vb', 'va');
  const l2 = build('va', 'vb');
  assert.deepEqual(l1.order, ['va', 'vb']);
  assert.deepEqual(l2.order, ['va', 'vb']);
  assert.equal(l1.root(), l2.root());
});

test('auto lamport follows the Lamport clock: max(seen) + 1', () => {
  const ledger = new Ledger();
  ledger.addVoucher({ id: 'a', postings: [{ account: 'x', amount: '1', currency: 'BASE' }] });
  ledger.addVoucher({ id: 'b', lamport: 10, postings: [{ account: 'x', amount: '1', currency: 'BASE' }] });
  ledger.addVoucher({ id: 'c', postings: [{ account: 'x', amount: '1', currency: 'BASE' }] });
  assert.equal(ledger.vouchers.get('a').lamport, 1);
  assert.equal(ledger.vouchers.get('c').lamport, 11);
  assert.deepEqual(ledger.order, ['a', 'b', 'c']);
});

test('pending voucher is not unsatisfiable: a late snapshot resolves it', () => {
  const ledger = new Ledger({ base: 'CNY' });
  ledger.addVoucher({ id: 'v1', lamport: 1, postings: [{ account: 'cash', amount: '1', currency: 'CNY' }] });
  const res = ledger.addVoucher({
    id: 'v2', lamport: 2, snapshot: 'fx-late',
    postings: [{ account: 'cash', amount: '10', currency: 'USD' }],
  });
  assert.equal(res.pending, true);
  assert.equal(ledger.vouchers.has('v2'), false);

  const snap = ledger.addSnapshot('fx-late', { USD: '7' });
  assert.deepEqual(snap.applied, ['v2']);
  assert.equal(ledger.balances().cash, '71');
  assert.doesNotThrow(() => ledger.finalize());
});

test('still-missing snapshot at finalize reports MISSING_SNAPSHOT', () => {
  const ledger = new Ledger({ base: 'CNY' });
  ledger.addVoucher({
    id: 'v9', lamport: 1, snapshot: 'ghost',
    postings: [{ account: 'cash', amount: '1', currency: 'USD' }],
  });
  assert.throws(() => ledger.finalize(), (err) => err.code === 'MISSING_SNAPSHOT');
});

test('non-base currency without any snapshot id is an immediate MISSING_SNAPSHOT', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.addVoucher({ id: 'x', postings: [{ account: 'a', amount: '1', currency: 'USD' }] }),
    (err) => err.code === 'MISSING_SNAPSHOT',
  );
});
