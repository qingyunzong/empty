'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FactoringStore } = require('../src/store.js');

// Independent enumeration: walk invoices one by one, no library helpers.
function independentTotals(store) {
  let frozen = 0;
  for (const inv of store.listInvoices()) {
    if (inv.state === 'active') frozen += inv.faceValue * inv.advanceRate;
  }
  return { frozen, available: store.creditLine - frozen };
}

test('frozen and available match independent per-invoice enumeration', () => {
  const store = new FactoringStore({ creditLine: 1_000_000, slop: 1 });
  const fixtures = [
    { id: 'i1', creditor: 'a', faceValue: 10000, advanceRate: 0.8, memo: 'x y' },
    { id: 'i2', creditor: 'a', faceValue: 25000, advanceRate: 0.5, memo: 'y z' },
    { id: 'i3', creditor: 'b', faceValue: 7777, advanceRate: 0.25, memo: 'p q' },
    { id: 'i4', creditor: 'b', faceValue: 12345, advanceRate: 1, memo: 'p q' },
    { id: 'i5', creditor: 'c', faceValue: 999, advanceRate: 0.1, memo: 'solo' },
  ];
  for (const f of fixtures) store.addInvoice(f);

  let expected = independentTotals(store);
  assert.equal(store.totals().frozen, expected.frozen);
  assert.equal(store.totals().available, expected.available);

  // After revocations the enumeration must still agree exactly.
  store.revokeInvoice('i2');
  store.revokeInvoice('i5');
  expected = independentTotals(store);
  assert.equal(store.totals().frozen, expected.frozen);
  assert.equal(store.totals().available, expected.available);

  // Revoking everything drains the pool completely.
  store.revokeInvoice('i1');
  store.revokeInvoice('i3');
  store.revokeInvoice('i4');
  assert.equal(store.totals().frozen, 0);
  assert.equal(store.totals().available, store.creditLine);
});

test('freeze amount equals faceValue * advanceRate per invoice', () => {
  const store = new FactoringStore({ creditLine: 1000, slop: 0 });
  store.addInvoice({ id: 'a', creditor: 'c', faceValue: 400, advanceRate: 0.5 });
  store.addInvoice({ id: 'b', creditor: 'c', faceValue: 100, advanceRate: 1 });
  assert.equal(store.totals().frozen, 300);
  assert.equal(store.totals().available, 700);
});
