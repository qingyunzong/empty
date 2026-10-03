import test from 'node:test';
import assert from 'node:assert/strict';
import { T0, makeChain } from './helpers.js';

function tampered(auth, mutate) {
  const copy = structuredClone(auth);
  mutate(copy);
  return copy;
}

test('modifying any signed field of an authorization fails verification', () => {
  const { store } = makeChain();
  const auth = store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 150, time: T0 });
  assert.equal(store.verifyAuthorization(auth), true);

  const variants = {
    payer: (a) => { a.payer = 'bob'; },
    payee: (a) => { a.payee = 'attacker'; },
    amount: (a) => { a.amount = 151; },
    time: (a) => { a.time = '2026-01-02T00:00:00.000Z'; },
    rootId: (a) => { a.rootId = 'fake-root'; },
    'chain cert subject': (a) => { a.chain[2].subject = 'mallory'; },
    'chain cert maxAmount': (a) => { a.chain[2].maxAmount = 999999; },
    'chain cert notAfter': (a) => { a.chain[0].notAfter = '2030-01-01T00:00:00.000Z'; },
    'chain cert id': (a) => { a.chain[0].id = '0'.repeat(64); },
    'chain cert signature': (a) => {
      a.chain[1].signature = Buffer.from('forged').toString('base64');
    },
    'payment signature': (a) => {
      a.signature = Buffer.from('forged').toString('base64');
    },
  };
  for (const [field, mutate] of Object.entries(variants)) {
    assert.throws(
      () => store.verifyAuthorization(tampered(auth, mutate)),
      (err) => err.code === 'BAD_SIGNATURE' || err.code === 'BROKEN_CHAIN',
      `tampering ${field} must fail`,
    );
  }
});

test('a valid authorization with a correctly re-signed payment still fails if a cert signature is invalid', () => {
  const { store, certs } = makeChain();
  // attacker alters the ledger copy of a certificate without the issuer key
  certs[2].maxAmount = 999999;
  assert.throws(
    () => store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 500, time: T0 }),
    { code: 'BAD_SIGNATURE' },
  );
});

test('validateChain rejects a certificate with a forged signature', () => {
  const { store, certs } = makeChain();
  const forged = { ...certs[1], signature: Buffer.from('forged').toString('base64') };
  assert.throws(
    () => store.validateChain([certs[0], forged, certs[2]], 'root', 100, T0),
    { code: 'BAD_SIGNATURE' },
  );
});
