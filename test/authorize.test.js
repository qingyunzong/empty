'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeField, resolveChain } = require('../src/authorize');
const { fixturePolicy } = require('./helpers');

test('org grants inherit down to role and individual', () => {
  const policy = fixturePolicy();
  const roleAuth = authorizeField(policy, 'operator', 'root_cause');
  assert.equal(roleAuth.allowed, true);
  assert.deepEqual(roleAuth.grants, ['org:factory']);
  const indAuth = authorizeField(policy, 'op-8', 'root_cause');
  assert.equal(indAuth.allowed, true);
  assert.equal(indAuth.visible, true);
});

test('chain is organization -> role -> individual', () => {
  const policy = fixturePolicy();
  const chain = resolveChain(policy, 'op-8');
  assert.deepEqual(
    chain.map((c) => c.kind),
    ['org', 'role', 'individual']
  );
});

test('individual deny wins over org grant', () => {
  const policy = fixturePolicy();
  const auth = authorizeField(policy, 'op-8', 'operator_name');
  assert.equal(auth.allowed, false);
  assert.deepEqual(auth.denials, ['individual:op-8']);
  assert.equal(auth.visible, false);
});

test('individual grant is blocked by label-upgraded classification', () => {
  const policy = fixturePolicy();
  const auth = authorizeField(policy, 'op-7', 'recipe_ratio');
  assert.equal(auth.allowed, true); // granted at individual level
  assert.equal(auth.clearance, 2); // inherits confidential from org factory
  assert.equal(auth.classification, 3); // recipe label forces secret
  assert.equal(auth.visible, false);
});

test('individual clearance can satisfy the upgraded classification', () => {
  const policy = fixturePolicy();
  const auth = authorizeField(policy, 'op-9', 'recipe_ratio');
  assert.equal(auth.clearance, 3);
  assert.equal(auth.visible, true);
});

test('role deny overrides org allow', () => {
  const policy = fixturePolicy();
  policy.roles.operator.deny = ['root_cause'];
  const auth = authorizeField(policy, 'operator', 'root_cause');
  assert.equal(auth.allowed, false);
  assert.equal(auth.visible, false);
});
