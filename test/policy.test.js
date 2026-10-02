'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpec } = require('../spec');
const { isPermitted } = require('../policy');

test('permissions are inherited through the role hierarchy', () => {
  const spec = parseSpec({
    threshold: 100,
    subjects: ['alice'],
    roles: { employee: [], clerk: ['employee'] },
    assignments: { alice: ['clerk'] },
    rules: [{ id: 'r1', effect: 'allow', role: 'employee', action: 'submit' }],
    invariant: { role: 'clerk' },
  });
  const submit = { subject: 'alice', action: 'submit', amount: 1, self: false };
  const approve = { subject: 'alice', action: 'approve', amount: 1, self: false };
  assert.equal(isPermitted(spec, 0, submit), true);
  assert.equal(isPermitted(spec, 0, approve), false);
});

test('deny wins over allow, including inherited denies', () => {
  const spec = parseSpec({
    threshold: 100,
    subjects: ['alice'],
    roles: { employee: [], clerk: ['employee'] },
    assignments: { alice: ['clerk'] },
    rules: [
      { id: 'r1', effect: 'allow', role: 'clerk', action: 'approve' },
      { id: 'r2', effect: 'deny', role: 'employee', action: 'approve' },
    ],
    invariant: { role: 'clerk' },
  });
  const approve = { subject: 'alice', action: 'approve', amount: 1, self: false };
  assert.equal(isPermitted(spec, 0, approve), false);
});

test('revocation is future-effective only', () => {
  const spec = parseSpec({
    threshold: 100,
    subjects: ['alice'],
    roles: { clerk: [] },
    assignments: { alice: ['clerk'] },
    rules: [{ id: 'r1', effect: 'allow', role: 'clerk', action: 'approve' }],
    revocations: [{ rule: 'r1', at: 2 }],
    invariant: { role: 'clerk' },
  });
  const token = { subject: 'alice', action: 'approve', amount: 1, self: false };
  assert.equal(isPermitted(spec, 0, token), true);
  assert.equal(isPermitted(spec, 1, token), true);
  assert.equal(isPermitted(spec, 2, token), false);
  assert.equal(isPermitted(spec, 5, token), false);
});

test('self and amountGt conditions gate rule matching', () => {
  const spec = parseSpec({
    threshold: 100,
    subjects: ['alice'],
    roles: { clerk: [] },
    assignments: { alice: ['clerk'] },
    rules: [
      { id: 'r1', effect: 'allow', role: 'clerk', action: 'approve' },
      { id: 'r2', effect: 'deny', role: 'clerk', action: 'approve', self: true },
      { id: 'r3', effect: 'deny', role: 'clerk', action: 'approve', amountGt: 100 },
    ],
    invariant: { role: 'clerk' },
  });
  const base = { subject: 'alice', action: 'approve' };
  assert.equal(isPermitted(spec, 0, { ...base, amount: 50, self: false }), true);
  assert.equal(isPermitted(spec, 0, { ...base, amount: 50, self: true }), false);
  assert.equal(isPermitted(spec, 0, { ...base, amount: 101, self: false }), false);
  assert.equal(isPermitted(spec, 0, { ...base, amount: 100, self: false }), true);
});
