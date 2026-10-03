'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  search,
  runSequence,
  verifyCertificate,
  buildCombinations,
  certificatePayload,
  stableStringify,
} = require('../lib');
const { loadSpec } = require('../testlib/helpers');

test('acceptance 1: self-approval counterexample with amount 101', () => {
  const spec = loadSpec('self-approval.json');
  const result = search(spec);
  assert.equal(result.result, 'counterexample');
  assert.equal(result.length, 2);
  assert.deepEqual(result.canonical, ['submit(alice,101)', 'approve(alice,0)']);
  assert.deepEqual(result.sequence, [
    { op: 'submit', subject: 'alice', amount: 101 },
    { op: 'approve', subject: 'alice', tx: 0 },
  ]);
  assert.equal(result.violation.amount, 101);
  assert.equal(result.violation.approver, result.violation.submitter);
  assert.equal(result.violation.approver, 'alice');
  assert.ok(result.violation.amount > result.violation.threshold);
});

test('acceptance 2: deny rule yields proof with full coverage certificate', () => {
  const spec = loadSpec('self-approval-deny.json');
  const result = search(spec);
  assert.equal(result.result, 'proof');
  const expected = [];
  for (const subject of spec.subjects) {
    for (const action of ['approve', 'submit']) {
      for (const amount of spec.amounts) {
        expected.push(`${subject}|${action}|${amount}`);
      }
    }
  }
  assert.equal(result.coverage.combinations, spec.subjects.length * 2 * spec.amounts.length);
  assert.equal(result.coverage.combinations, 20);
  assert.deepEqual([...result.combinations].sort(), expected.sort());
  assert.match(result.certificate, /^sha256:[0-9a-f]{64}$/);
  assert.ok(verifyCertificate(spec, result));
  const payload = certificatePayload(spec, buildCombinations(spec));
  const digest = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  assert.equal(result.certificate, `sha256:${digest}`);
});

test('acceptance 3: revocation only affects the future', () => {
  const spec = loadSpec('self-approval-revoke.json');
  const result = search(spec);
  assert.equal(result.result, 'counterexample');
  assert.deepEqual(result.canonical, ['submit(alice,101)', 'approve(alice,0)']);

  const revokedFirst = runSequence(spec, [
    { op: 'revoke', rule: 'r2' },
    { op: 'submit', subject: 'alice', amount: 101 },
    { op: 'approve', subject: 'alice', tx: 0 },
  ]);
  assert.equal(revokedFirst.valid, false);
  assert.equal(revokedFirst.failedAt, 2);

  const revokedMiddle = runSequence(spec, [
    { op: 'submit', subject: 'alice', amount: 101 },
    { op: 'revoke', rule: 'r2' },
    { op: 'approve', subject: 'alice', tx: 0 },
  ]);
  assert.equal(revokedMiddle.valid, false);
  assert.equal(revokedMiddle.failedAt, 2);

  const revokedAfter = runSequence(spec, [
    { op: 'submit', subject: 'alice', amount: 101 },
    { op: 'approve', subject: 'alice', tx: 0 },
    { op: 'revoke', rule: 'r2' },
  ]);
  assert.equal(revokedAfter.valid, true);
  assert.ok(revokedAfter.trace[1].violation);
  assert.equal(revokedAfter.trace[1].violation.amount, 101);
});

test('acceptance 3b: with the old allow removed there is no counterexample', () => {
  const spec = loadSpec('self-approval-revoked.json');
  const result = search(spec);
  assert.equal(result.result, 'proof');
  assert.ok(verifyCertificate(spec, result));
});
