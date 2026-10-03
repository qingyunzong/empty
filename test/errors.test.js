'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FactoringStore, FactoringError } = require('../src/store.js');

function makeStore() {
  return new FactoringStore({ creditLine: 10_000, slop: 1 });
}

test('illegal advance rates are rejected', () => {
  const bad = [0, -0.1, 1.5, NaN, Infinity, '0.8', undefined];
  for (const rate of bad) {
    const store = makeStore();
    assert.throws(
      () => store.addInvoice({ id: 'x', creditor: 'c', faceValue: 100, advanceRate: rate }),
      (err) => err instanceof FactoringError && err.code === 'INVALID_ADVANCE_RATE',
      `rate ${rate} must throw INVALID_ADVANCE_RATE`
    );
  }
  // Boundary: rate of exactly 1 is legal.
  const store = makeStore();
  store.addInvoice({ id: 'ok', creditor: 'c', faceValue: 100, advanceRate: 1 });
  assert.equal(store.totals().frozen, 100);
});

test('freezing beyond the credit line is rejected and leaves state untouched', () => {
  const store = makeStore();
  store.addInvoice({ id: 'a', creditor: 'c', faceValue: 8000, advanceRate: 1 });
  assert.throws(
    () => store.addInvoice({ id: 'b', creditor: 'c', faceValue: 2001, advanceRate: 1 }),
    (err) => err.code === 'CREDIT_LINE_EXCEEDED'
  );
  assert.equal(store.getInvoice('b'), null);
  assert.equal(store.totals().frozen, 8000);
  // Exactly the remaining line is still allowed.
  store.addInvoice({ id: 'b', creditor: 'c', faceValue: 2000, advanceRate: 1 });
  assert.equal(store.totals().available, 0);
});

test('duplicate revocation is rejected', () => {
  const store = makeStore();
  store.addInvoice({ id: 'a', creditor: 'c', faceValue: 100, advanceRate: 0.5 });
  store.revokeInvoice('a');
  assert.throws(
    () => store.revokeInvoice('a'),
    (err) => err.code === 'INVOICE_ALREADY_REVOKED'
  );
  assert.throws(
    () => store.revokeInvoice('ghost'),
    (err) => err.code === 'INVOICE_NOT_FOUND'
  );
});

test('invalid constructor and invoice fields are rejected', () => {
  assert.throws(() => new FactoringStore({ creditLine: -1 }), /creditLine/);
  assert.throws(() => new FactoringStore({ creditLine: 100, slop: -1 }), /slop/);
  assert.throws(() => new FactoringStore({ creditLine: 100, slop: 1.5 }), /slop/);
  const store = makeStore();
  assert.throws(
    () => store.addInvoice({ id: 'a', creditor: 'c', faceValue: -5, advanceRate: 0.5 }),
    (err) => err.code === 'INVALID_FACE_VALUE'
  );
  assert.throws(
    () => store.addInvoice({ id: '', creditor: 'c', faceValue: 5, advanceRate: 0.5 }),
    (err) => err.code === 'INVALID_INVOICE_ID'
  );
  store.addInvoice({ id: 'dup', creditor: 'c', faceValue: 5, advanceRate: 0.5 });
  assert.throws(
    () => store.addInvoice({ id: 'dup', creditor: 'c', faceValue: 5, advanceRate: 0.5 }),
    (err) => err.code === 'DUPLICATE_INVOICE_ID'
  );
});
