import test from 'node:test';
import assert from 'node:assert/strict';
import { T0, makeChain } from './helpers.js';

test('multi-level chain authorizes a payment', () => {
  const { store } = makeChain();
  const auth = store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 150, time: T0 });
  assert.equal(auth.rootId, 'root');
  assert.equal(auth.chain.length, 3);
  assert.deepEqual(
    auth.chain.map((c) => c.subject),
    ['alice', 'bob', 'carol'],
  );
  // compressed: no issuer field, derivable from rootId + previous subject
  for (const cert of auth.chain) {
    assert.equal('issuer' in cert, false);
  }
  assert.equal(typeof auth.signature, 'string');
  assert.equal(store.verifyAuthorization(auth), true);
});

test('payment by the root itself uses an empty chain', () => {
  const { store } = makeChain();
  const auth = store.verifyPayment({ payer: 'root', payee: 'shop', amount: 10, time: T0 });
  assert.equal(auth.rootId, 'root');
  assert.equal(auth.chain.length, 0);
  assert.equal(store.verifyAuthorization(auth), true);
});

test('amount above the weakest link is rejected', () => {
  const { store } = makeChain([1000, 500, 200]);
  assert.throws(
    () => store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 201, time: T0 }),
    { code: 'AMOUNT_EXCEEDED' },
  );
  // bob can still pay up to 500 via the shorter chain
  const auth = store.verifyPayment({ payer: 'bob', payee: 'shop', amount: 500, time: T0 });
  assert.equal(auth.chain.length, 2);
});

test('amount exactly at the limit is accepted', () => {
  const { store } = makeChain([1000, 500, 200]);
  const auth = store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 200, time: T0 });
  assert.equal(store.verifyAuthorization(auth), true);
});
