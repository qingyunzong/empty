'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashObject } = require('../src/hash.js');
const { AT, baseLab } = require('../testkit/fixtures.js');

function issueCert(lab) {
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'CERT');
  return r.cert;
}

test('audit replays a genuine certificate -> VALID', () => {
  const lab = baseLab();
  const cert = issueCert(lab);
  const r = lab.audit(cert.id);
  assert.equal(r.status, 'VALID');
  assert.equal(r.certId, cert.id);
});

test('audit detects field tampering -> TAMPERED', () => {
  const lab = baseLab();
  const cert = issueCert(lab);
  const forged = { ...cert, combinedUncertainty: 0.0001 };
  const r = lab.audit(forged);
  assert.equal(r.status, 'TAMPERED');
  assert.equal(r.reason, 'HASH_MISMATCH');
});

test('audit replays derivation: consistent hash but wrong result -> REPLAY_MISMATCH', () => {
  const lab = baseLab();
  const cert = issueCert(lab);
  // Attacker changes the outcome and recomputes id/hash, but cannot make the
  // embedded inputs derive the forged uncertainty.
  const forged = { ...cert, combinedUncertainty: 0.0001 };
  const { id, hash, ...body } = forged;
  const newHash = hashObject(body);
  const rehashed = { id: `CERT-${newHash.slice(0, 16)}`, ...body, hash: newHash };
  const r = lab.audit(rehashed);
  assert.equal(r.status, 'REPLAY_MISMATCH');
  assert.equal(r.reason, 'UNCERTAINTY_MISMATCH');
});

test('audit detects post-issuance lab record edits -> STATE_DIVERGED', () => {
  const lab = baseLab();
  const cert = issueCert(lab);
  lab.state.artifacts.S1.uncertainty = 0.009; // lab record altered afterwards
  const r = lab.audit(cert.id);
  assert.equal(r.status, 'STATE_DIVERGED');
  assert.ok(r.diverged.includes('S1'));
});

test('audit rejects unknown certificate ids', () => {
  const lab = baseLab();
  assert.throws(() => lab.audit('CERT-nope'), (e) => e.code === 'CERT_NOT_FOUND');
});
