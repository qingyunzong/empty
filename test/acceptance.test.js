'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpec } = require('../spec');
const { analyze, findCounterexample } = require('../search');
const { baseSpec, denySelfRule, denyBigRule } = require('../helpers/fixtures');

// Acceptance 1: self-approval over the threshold yields a minimal
// counterexample with amount 101.
test('finds the minimal self-approval counterexample with amount 101', () => {
  const result = analyze(parseSpec(baseSpec()));
  assert.equal(result.result, 'counterexample');
  assert.equal(result.length, 2);
  assert.deepEqual(result.sequence, [
    { subject: 'alice', action: 'submit', amount: 101 },
    { subject: 'alice', action: 'approve', amount: 101 },
  ]);
  assert.deepEqual(result.violation, {
    subject: 'alice',
    amount: 101,
    submitIndex: 0,
    approveIndex: 1,
  });
});

// Acceptance 2: adding a deny rule eliminates the counterexample and the
// proof certificate covers every subject-action-amount combination.
test('deny of self-approval yields a proof with full coverage', () => {
  const raw = baseSpec();
  raw.rules.push(denySelfRule());
  const result = analyze(parseSpec(raw));
  assert.equal(result.result, 'proof');
  const cert = result.certificate;
  assert.equal(cert.algorithm, 'sha256');
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
  assert.equal(cert.combinations, 4 * 2 * 5);
  assert.equal(cert.selfContexts, 2);
  assert.equal(cert.positions, 6);
  assert.equal(cert.evaluations, 4 * 2 * 5 * 2 * 6);
  assert.deepEqual(cert.subjects, ['alice', 'bob', 'carol', 'dave']);
  assert.deepEqual(cert.actions, ['approve', 'submit']);
  assert.deepEqual(cert.amounts, [0, 1, 50, 100, 101]);
});

test('deny of over-threshold approvals also yields a proof', () => {
  const raw = baseSpec();
  raw.rules.push(denyBigRule());
  const result = analyze(parseSpec(raw));
  assert.equal(result.result, 'proof');
  assert.equal(result.certificate.combinations, 40);
});

// Acceptance 3: revoking the old allow invalidates the old counterexample,
// and revocation is future-effective only.
test('revoking the allow rule removes the old counterexample', () => {
  const raw = baseSpec();
  raw.revocations = [{ rule: 'allow-approve', at: 1 }];
  const result = analyze(parseSpec(raw));
  assert.equal(result.result, 'proof');
});

test('revocation is not retroactive: earlier positions still permitted', () => {
  const raw = baseSpec();
  raw.revocations = [{ rule: 'allow-approve', at: 2 }];
  const result = analyze(parseSpec(raw));
  assert.equal(result.result, 'counterexample');
  assert.deepEqual(result.sequence, [
    { subject: 'alice', action: 'submit', amount: 101 },
    { subject: 'alice', action: 'approve', amount: 101 },
  ]);
});

test('amounts at or below the threshold never violate', () => {
  const raw = baseSpec();
  raw.amounts = [0, 1, 50, 100];
  const spec = parseSpec(raw);
  assert.equal(findCounterexample(spec), null);
});
