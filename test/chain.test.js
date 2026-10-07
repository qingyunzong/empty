import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, CertChainError, generateKeyPair, createCert, verifyCert, verifyData, hashId } from '../index.js';

function flipSignatureChar(signature) {
  const i = 10; // well away from base64 padding
  const flipped = signature[i] === 'A' ? 'B' : 'A';
  return signature.slice(0, i) + flipped + signature.slice(i + 1);
}

const T0 = 0;
const T1 = 1_000_000;

function makeKeys(n) {
  return Array.from({ length: n }, () => generateKeyPair());
}

// Builds root self-cert + chain keys[0] -> keys[1] -> ... -> keys[last].
function buildChain(store, keys, opts = {}) {
  const { maxAmount = 1000, notBefore = T0, notAfter = T1 } = opts;
  const certs = [];
  certs.push(store.issueCert({
    issuerPrivateKey: keys[0].privateKey,
    issuerPublicKey: keys[0].publicKey,
    subjectPublicKey: keys[0].publicKey,
    maxAmount, notBefore, notAfter,
  }));
  for (let i = 0; i < keys.length - 1; i++) {
    certs.push(store.issueCert({
      issuerPrivateKey: keys[i].privateKey,
      issuerPublicKey: keys[i].publicKey,
      subjectPublicKey: keys[i + 1].publicKey,
      maxAmount, notBefore, notAfter,
    }));
  }
  return certs;
}

function freshStoreWithChain(depth, opts) {
  const store = new Store();
  const keys = makeKeys(depth + 1); // keys[0] = root, payer = keys[depth]
  store.addRoot('root-1', keys[0].publicKey);
  const certs = buildChain(store, keys, opts);
  return { store, keys, certs };
}

function payArgs(keys, overrides = {}) {
  return {
    payerPublicKey: keys[keys.length - 1].publicKey,
    payerPrivateKey: keys[keys.length - 1].privateKey,
    payee: 'merchant-42',
    amount: 100,
    time: 500_000,
    ...overrides,
  };
}

test('multi-level chain (depth 4) verifies and returns chain, signature, rootId', () => {
  const { store, keys, certs } = freshStoreWithChain(4);
  const result = store.verifyPayment(payArgs(keys));
  assert.equal(result.rootId, 'root-1');
  assert.equal(result.chain.length, 5); // self-cert + 4 hops
  assert.deepEqual(result.chain.map((c) => c.id), certs.map((c) => c.id));
  for (const cert of result.chain) assert.ok(verifyCert(cert));
  const chainHash = hashId(certs.map((c) => c.id));
  assert.ok(verifyData(keys[4].publicKey, { payment: result.payment, chainHash, rootId: 'root-1' }, result.signature));
  assert.deepEqual(result.payment, { payer: keys[4].publicKey, payee: 'merchant-42', amount: 100, time: 500_000 });
});

test('revoke makes payment fail; restore paired with the revoke event makes it valid again', () => {
  const { store, keys, certs } = freshStoreWithChain(3);
  assert.ok(store.verifyPayment(payArgs(keys)));

  const { revokeId } = store.revoke(certs[2].id);
  assert.throws(
    () => store.verifyPayment(payArgs(keys)),
    (err) => err.code === 'ERR_REVOKED',
  );

  store.restore(revokeId);
  assert.ok(store.verifyPayment(payArgs(keys)));
});

test('restore must pair with an existing, unrestored revoke event', () => {
  const { store, certs } = freshStoreWithChain(2);
  assert.throws(() => store.restore('rev-999'), (err) => err.code === 'ERR_UNKNOWN_REVOCATION');
  const { revokeId } = store.revoke(certs[1].id);
  store.restore(revokeId);
  assert.throws(() => store.restore(revokeId), (err) => err.code === 'ERR_ALREADY_RESTORED');
  // re-revoke creates a new event that must be restored separately
  const second = store.revoke(certs[1].id);
  assert.notEqual(second.revokeId, revokeId);
  assert.equal(store.isRevoked(certs[1].id), true);
  store.restore(second.revokeId);
  assert.equal(store.isRevoked(certs[1].id), false);
});

test('revoke of unknown cert fails', () => {
  const { store } = freshStoreWithChain(1);
  assert.throws(() => store.revoke('no-such-cert'), (err) => err.code === 'ERR_UNKNOWN_CERT');
});

test('expired certificate (time outside [notBefore, notAfter]) fails', () => {
  const { store, keys } = freshStoreWithChain(2, { notBefore: 100, notAfter: 200 });
  assert.ok(store.verifyPayment(payArgs(keys, { time: 150 })));
  assert.throws(() => store.verifyPayment(payArgs(keys, { time: 201 })), (err) => err.code === 'ERR_EXPIRED');
  assert.throws(() => store.verifyPayment(payArgs(keys, { time: 99 })), (err) => err.code === 'ERR_EXPIRED');
});

test('amount exceeding any link limit fails', () => {
  const store = new Store();
  const keys = makeKeys(4);
  store.addRoot('root-1', keys[0].publicKey);
  buildChain(store, keys, { maxAmount: 1000 });
  // replace the keys1->keys2 link with a tight one
  for (const cert of [...store.certs.values()]) {
    if (cert.issuer === keys[1].publicKey && cert.subject === keys[2].publicKey) store.certs.delete(cert.id);
  }
  store.issueCert({
    issuerPrivateKey: keys[1].privateKey,
    issuerPublicKey: keys[1].publicKey,
    subjectPublicKey: keys[2].publicKey,
    maxAmount: 50, notBefore: T0, notAfter: T1,
  });
  assert.ok(store.verifyPayment(payArgs(keys, { amount: 50 })));
  assert.throws(
    () => store.verifyPayment(payArgs(keys, { amount: 51 })),
    (err) => err.code === 'ERR_AMOUNT_EXCEEDED',
  );
});

test('self-signed non-root certificate is rejected at issue time', () => {
  const store = new Store();
  const [root, other] = makeKeys(2);
  store.addRoot('root-1', root.publicKey);
  assert.throws(
    () => store.issueCert({
      issuerPrivateKey: other.privateKey,
      issuerPublicKey: other.publicKey,
      subjectPublicKey: other.publicKey,
      maxAmount: 10, notBefore: 0, notAfter: 10,
    }),
    (err) => err.code === 'ERR_SELF_SIGNED_NON_ROOT',
  );
});

test('chain rooted at an unknown (untrusted) root fails with ERR_UNKNOWN_ROOT', () => {
  const store = new Store();
  const keys = makeKeys(3);
  // foreign chain admitted externally; its root was never added via addRoot
  store.admitCert(createCert({
    issuerPrivateKey: keys[0].privateKey,
    issuerPublicKey: keys[0].publicKey,
    subjectPublicKey: keys[0].publicKey,
    maxAmount: 100, notBefore: 0, notAfter: 1000,
  }));
  store.admitCert(createCert({
    issuerPrivateKey: keys[0].privateKey,
    issuerPublicKey: keys[0].publicKey,
    subjectPublicKey: keys[1].publicKey,
    maxAmount: 100, notBefore: 0, notAfter: 1000,
  }));
  assert.throws(
    () => store.verifyPayment({
      payerPublicKey: keys[1].publicKey,
      payerPrivateKey: keys[1].privateKey,
      payee: 'm', amount: 10, time: 10,
    }),
    (err) => err.code === 'ERR_UNKNOWN_ROOT',
  );
});

test('tampering with any signed field breaks cryptographic verification', () => {
  const { keys, certs } = freshStoreWithChain(3);
  const target = certs[2]; // a middle cert
  const tampers = {
    signature: { ...target, signature: flipSignatureChar(target.signature) },
    id: { ...target, id: '0'.repeat(64) },
    maxAmount: { ...target, maxAmount: target.maxAmount + 1 },
    notBefore: { ...target, notBefore: target.notBefore + 1 },
    notAfter: { ...target, notAfter: target.notAfter - 1 },
    subject: { ...target, subject: keys[0].publicKey },
    issuer: { ...target, issuer: keys[3].publicKey },
  };
  for (const [field, tampered] of Object.entries(tampers)) {
    assert.equal(verifyCert(tampered), false, `verifyCert must reject tampered field: ${field}`);

    // end-to-end: a store where the only possible chain uses the tampered cert
    const store = new Store();
    store.addRoot('root-1', keys[0].publicKey);
    for (const cert of certs) store.admitCert(cert);
    store.certs.delete(target.id);
    store.admitCert(tampered);
    assert.throws(
      () => store.verifyPayment(payArgs(keys)),
      (err) => err instanceof CertChainError,
      `verifyPayment must fail with tampered field: ${field}`,
    );
  }
});

test('tampered signature/id/amount/time fields specifically yield ERR_TAMPERED_SIGNATURE', () => {
  const { keys, certs } = freshStoreWithChain(3);
  const target = certs[2];
  const tampers = [
    { ...target, signature: flipSignatureChar(target.signature) },
    { ...target, id: 'f'.repeat(64) },
    { ...target, maxAmount: target.maxAmount + 1 },
    { ...target, notBefore: target.notBefore + 1 },
    { ...target, notAfter: target.notAfter - 1 },
  ];
  for (const tampered of tampers) {
    const store = new Store();
    store.addRoot('root-1', keys[0].publicKey);
    for (const cert of certs) store.admitCert(cert);
    store.certs.delete(target.id);
    store.admitCert(tampered);
    assert.throws(
      () => store.verifyPayment(payArgs(keys)),
      (err) => err.code === 'ERR_TAMPERED_SIGNATURE',
    );
  }
});

test('verifyCert accepts untampered certs and rejects forged signatures', () => {
  const { certs } = freshStoreWithChain(1);
  assert.ok(verifyCert(certs[0]));
  assert.equal(verifyCert({ ...certs[0], signature: Buffer.from('forged').toString('base64') }), false);
});
