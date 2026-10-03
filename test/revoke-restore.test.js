import test from 'node:test';
import assert from 'node:assert/strict';
import { T0, makeChain } from './helpers.js';

test('revoke breaks the chain, paired restore heals it', () => {
  const { store, certs } = makeChain();
  const pay = () => store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 100, time: T0 });
  assert.doesNotThrow(pay);

  const revocation = store.revoke({ certId: certs[1].id, time: T0 });
  assert.throws(pay, { code: 'CERT_REVOKED' });

  const restore = store.restore({ revocationId: revocation.id, time: T0 });
  assert.equal(restore.pairs, revocation.id);
  assert.doesNotThrow(pay);
  assert.equal(store.verifyAuthorization(pay()), true);
});

test('restore without a matching revocation fails', () => {
  const { store, certs } = makeChain();
  assert.throws(() => store.restore({ certId: certs[0].id }), {
    code: 'RESTORE_WITHOUT_REVOKE',
  });
  const revocation = store.revoke({ certId: certs[0].id, time: T0 });
  store.restore({ revocationId: revocation.id, time: T0 });
  // the revocation is already paired; a second restore must fail
  assert.throws(() => store.restore({ revocationId: revocation.id }), {
    code: 'RESTORE_WITHOUT_REVOKE',
  });
  assert.throws(() => store.restore({ certId: certs[0].id }), {
    code: 'RESTORE_WITHOUT_REVOKE',
  });
});

test('double revoke fails', () => {
  const { store, certs } = makeChain();
  store.revoke({ certId: certs[0].id, time: T0 });
  assert.throws(() => store.revoke({ certId: certs[0].id, time: T0 }), {
    code: 'ALREADY_REVOKED',
  });
});

test('revocation is time-scoped: payments before the revoke still verify', () => {
  const { store, certs } = makeChain();
  const auth = store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 100, time: T0 });
  store.revoke({ certId: certs[2].id, time: '2026-06-01T00:00:00.000Z' });
  // authorization at T0 predates the revocation
  assert.equal(store.verifyAuthorization(auth), true);
  // a new payment after the revocation fails
  assert.throws(
    () => store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 100, time: '2026-07-01T00:00:00.000Z' }),
    { code: 'CERT_REVOKED' },
  );
});

test('expired certificate breaks the chain', () => {
  const { store } = makeChain();
  assert.throws(
    () => store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 100, time: '2027-06-01T00:00:00.000Z' }),
    { code: 'CERT_EXPIRED' },
  );
});

test('certificate not yet valid breaks the chain', () => {
  const { store } = makeChain();
  assert.throws(
    () => store.verifyPayment({ payer: 'carol', payee: 'shop', amount: 100, time: '2024-06-01T00:00:00.000Z' }),
    { code: 'CERT_NOT_YET_VALID' },
  );
});

test('revoke of unknown certificate fails', () => {
  const { store } = makeChain();
  assert.throws(() => store.revoke({ certId: 'nope' }), { code: 'UNKNOWN_CERT' });
});
