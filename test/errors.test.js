import test from 'node:test';
import assert from 'node:assert/strict';
import { CertStore } from '../src/store.js';
import { T0, BEFORE, AFTER, makeChain } from './helpers.js';

test('self-signed non-root certificate is rejected at issue time', () => {
  const store = new CertStore();
  assert.throws(
    () => store.issueCert({
      issuer: 'mallory', subject: 'mallory', maxAmount: 100,
      notBefore: BEFORE, notAfter: AFTER,
    }),
    { code: 'SELF_SIGNED_NON_ROOT' },
  );
});

test('root flag on a non-self-signed certificate is rejected', () => {
  const store = new CertStore();
  assert.throws(
    () => store.issueCert({
      issuer: 'a', subject: 'b', maxAmount: 100,
      notBefore: BEFORE, notAfter: AFTER, root: true,
    }),
    { code: 'INVALID_CERT' },
  );
});

test('chain that does not reach a trusted root fails with UNKNOWN_ROOT', () => {
  const store = new CertStore();
  store.issueCert({
    issuer: 'root', subject: 'root', maxAmount: 1000,
    notBefore: BEFORE, notAfter: AFTER, root: true,
  });
  // mallory is not a root and holds no certificate from any root
  store.issueCert({
    issuer: 'mallory', subject: 'dave', maxAmount: 100,
    notBefore: BEFORE, notAfter: AFTER,
  });
  assert.throws(
    () => store.verifyPayment({ payer: 'dave', payee: 'shop', amount: 10, time: T0 }),
    { code: 'UNKNOWN_ROOT' },
  );
  assert.throws(
    () => store.verifyPayment({ payer: 'nobody', payee: 'shop', amount: 10, time: T0 }),
    { code: 'UNKNOWN_ROOT' },
  );
});

test('verifyAuthorization rejects an authorization anchored at an unknown root', () => {
  const { store } = makeChain();
  const auth = store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 100, time: T0 });
  const other = new CertStore(); // knows nothing about "root"
  assert.throws(() => other.verifyAuthorization(auth), { code: 'UNKNOWN_ROOT' });
});

test('invalid inputs are rejected', () => {
  const { store } = makeChain();
  assert.throws(
    () => store.issueCert({ issuer: 'root', subject: 'x', maxAmount: -5, notBefore: BEFORE, notAfter: AFTER }),
    { code: 'INVALID_AMOUNT' },
  );
  assert.throws(
    () => store.issueCert({ issuer: 'root', subject: 'x', maxAmount: 5, notBefore: AFTER, notAfter: BEFORE }),
    { code: 'INVALID_CERT' },
  );
  assert.throws(
    () => store.issueCert({ issuer: 'root', subject: 'x', maxAmount: 5, notBefore: 'junk', notAfter: AFTER }),
    { code: 'INVALID_TIME' },
  );
  assert.throws(
    () => store.verifyPayment({ payer: 'alice', payee: 'shop', amount: 0, time: T0 }),
    { code: 'INVALID_AMOUNT' },
  );
  assert.throws(
    () => store.verifyPayment({ payer: 'alice', payee: 'shop', amount: 10, time: 'junk' }),
    { code: 'INVALID_TIME' },
  );
});

test('duplicate certificate issuance is rejected', () => {
  const { store, certs } = makeChain();
  const c = certs[0];
  assert.throws(
    () => store.issueCert({
      issuer: c.issuer, subject: c.subject, maxAmount: c.maxAmount,
      notBefore: c.notBefore, notAfter: c.notAfter,
    }),
    { code: 'CERT_EXISTS' },
  );
});
