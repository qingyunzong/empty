'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guard, applyEvent, createState, project } = require('../lib/model');
const { applyConcurrent } = require('../lib/conflict');
const { cert } = require('../lib/cert');

function saleState() {
  return project([{ type: 'sale', id: 's1', account: 'A', amount: 10 }]);
}

test('two concurrent refunds on one sale: exactly one wins, loser gets conflict certificate', () => {
  const st = saleState();
  const r1 = { type: 'refund', id: 'r1', ref: 's1', amount: 7, baseSeq: 1 };
  const r2 = { type: 'refund', id: 'r2', ref: 's1', amount: 7, baseSeq: 1 };

  // both validated against the same base state (seq 1): both pass guard
  assert.equal(guard(st, r1).ok, true);
  assert.equal(guard(st, r2).ok, true);

  // first apply wins
  const w1 = applyConcurrent(st, r1);
  assert.equal(w1.ok, true);

  // second apply: baseSeq is stale -> conflict, certificate issued, no state change
  const w2 = applyConcurrent(st, r2);
  assert.equal(w2.ok, false);
  assert.equal(w2.code, 40);
  assert.ok(w2.certificate, 'conflict certificate required');
  assert.equal(w2.certificate.type, 'conflict-certificate');
  assert.equal(w2.certificate.event.id, 'r2');
  assert.equal(w2.certificate.baseSeq, 1);
  assert.equal(w2.certificate.stateSeq, 2);
  assert.equal(w2.certificate.stateHash, cert(st).overall);

  // exactly one refund applied; totals never exceed the original sale
  assert.equal(st.sales.s1.refunded, 7);
  assert.deepEqual(st.accounts.A, { balance: 3, frozen: 3 });
});

test('concurrent over-refund without baseSeq: re-guard rejects with code 31 and certificate', () => {
  const st = saleState();
  assert.equal(applyConcurrent(st, { type: 'refund', id: 'r1', ref: 's1', amount: 6 }).ok, true);
  // a second refund validated concurrently against the pre-r1 state now loses
  const res = applyConcurrent(st, { type: 'refund', id: 'r2', ref: 's1', amount: 6 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 31);
  assert.ok(res.certificate);
  assert.equal(res.certificate.sale.refunded, 6);
  assert.equal(res.certificate.sale.amount, 10);
  // no auto-split: losing amount is not partially applied
  assert.equal(st.sales.s1.refunded, 6);
  assert.deepEqual(st.accounts.A, { balance: 4, frozen: 4 });
});

test('conflict certificate is verifiable offline against the winning state', () => {
  const st = saleState();
  applyConcurrent(st, { type: 'refund', id: 'r1', ref: 's1', amount: 10, baseSeq: 1 });
  const loser = { type: 'refund', id: 'r2', ref: 's1', amount: 10, baseSeq: 1 };
  const res = applyConcurrent(st, loser);
  // offline audit: certificate hash must match the terminal state hash
  assert.equal(res.certificate.stateHash, cert(st).overall);
  // and the losing event indeed overflows the sale recorded in the certificate
  const { sale, event } = res.certificate;
  assert.ok(sale.refunded + event.amount > sale.amount);
});
