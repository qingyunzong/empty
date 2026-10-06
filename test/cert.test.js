import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRule } from '../src/compiler.js';
import { issueCertificate, verifyCertificate } from '../src/cert.js';

const SRC = 'rule "T" version 2 { param n: quantity decide { when n >= 1 -> ACCEPT otherwise -> CONTINUE } }';

function makeCert(overrides = {}) {
  const program = compileRule(SRC);
  return issueCertificate({
    ruleSource: SRC,
    program,
    sampleVersion: 1,
    sampleHash: 'sha256:' + '0'.repeat(64),
    inputs: { batch_id: 'B-1', batch_size: 10, sampled: 10, defects: 0, worst: 'none' },
    decision: 'ACCEPT',
    now: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

test('certificate contains rule hash, sample hash and versions', () => {
  const cert = makeCert();
  assert.match(cert.rule_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(cert.sample_hash, /^sha256:/);
  assert.equal(cert.rule_version, 2);
  assert.equal(cert.sample_version, 1);
  assert.match(cert.cert_hash, /^sha256:/);
});

test('issued certificate verifies OK', () => {
  const cert = makeCert();
  const result = verifyCertificate(cert);
  assert.equal(result.ok, true);
  assert.equal(result.certHash, cert.cert_hash);
});

test('tampered certificate fails integrity check', () => {
  const cert = makeCert();
  cert.decision = 'REJECT';
  const result = verifyCertificate(cert);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /integrity check failed/);
});

test('structurally invalid certificate is rejected', () => {
  assert.equal(verifyCertificate(null).ok, false);
  assert.equal(verifyCertificate({ format: 'nope' }).ok, false);
});
