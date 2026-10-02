import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { issueCert, verifyCert } from '../src/cert.js';
import { E } from '../src/errors.js';

function setup() {
  const store = new Store();
  store.addEvidence({ key: 'a', status: 'asserted', fields: { amount: 60 } });
  store.addEvidence({ key: 'b', status: 'asserted', fields: { amount: 50 } });
  store.addEvidence({ key: 'c', status: 'unknown', fields: { amount: 5 } });
  store.addRule({ id: 'r1', priority: 3, when: { op: 'lt', field: 'amount', value: 0 } });
  const engine = new Engine(store);
  const claim = {
    select: { op: 'notnull', field: 'amount' },
    aggregate: { op: 'sum', field: 'amount' },
    cmp: { op: 'gte', value: 112 }, // 60+50=110 fails, +5 from unknown c passes
  };
  return { store, engine, claim };
}

test('certificate contains input hash, rule version, hit keys, undecided items', () => {
  const { engine, claim } = setup();
  const cert = issueCert(engine, claim);
  assert.equal(cert.format, 'evpack-cert/1');
  assert.equal(cert.conclusion, 'undecided'); // unknown row c is pending
  assert.deepEqual(cert.hitEvidenceKeys, ['a', 'b']);
  assert.deepEqual(cert.undecided, ['c']);
  assert.equal(cert.inputHash, engine.store.inputHash());
  assert.equal(cert.rulesVersion, engine.store.rulesVersion());
  assert.match(cert.certHash, /^[0-9a-f]{64}$/);
  assert.equal(verifyCert(engine, cert), true);
});

test('pass certificate verifies and stays stable', () => {
  const { engine } = setup();
  const claim = {
    select: { op: 'gt', field: 'amount', value: 40 },
    aggregate: { op: 'count', field: '*' },
    cmp: { op: 'eq', value: 2 },
  };
  const cert = issueCert(engine, claim);
  assert.equal(cert.conclusion, 'pass');
  assert.equal(verifyCert(engine, cert), true);
});

test('acceptance: tampered certificate is rejected with E_CERT_MISMATCH', () => {
  const { engine, claim } = setup();
  const cert = issueCert(engine, claim);
  const fields = ['conclusion', 'hitEvidenceKeys', 'undecided', 'inputHash', 'rulesVersion'];
  for (const field of fields) {
    const tampered = { ...cert };
    tampered[field] = field === 'conclusion' ? 'pass'
      : field === 'inputHash' || field === 'rulesVersion' ? '0'.repeat(64)
        : [];
    assert.throws(() => verifyCert(engine, tampered), (e) => e.code === E.CERT_MISMATCH, field);
  }
});

test('evidence change after issuance invalidates the certificate', () => {
  const { store, engine, claim } = setup();
  const cert = issueCert(engine, claim);
  engine.retract('b');
  assert.equal(store.get('b').status, 'retracted');
  assert.throws(() => verifyCert(engine, cert), (e) => e.code === E.CERT_MISMATCH);
});

test('rule change after issuance invalidates the certificate', () => {
  const { engine, claim } = setup();
  const cert = issueCert(engine, claim);
  engine.store.addRule({ id: 'r2', priority: 1, when: { op: 'false' } });
  assert.throws(() => verifyCert(engine, cert), (e) => e.code === E.CERT_MISMATCH);
});
