'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GateError,
  parsePolicy,
  effectiveClassificationLevel,
  isRegulatory,
} = require('../src/policy');
const { fixturePolicy } = require('./helpers');

test('unknown field classification exits 28', () => {
  const policy = fixturePolicy();
  policy.fields.bogus = { classification: 'mystery' };
  assert.throws(
    () => parsePolicy(JSON.stringify(policy)),
    (err) => err instanceof GateError && err.exitCode === 28
  );
});

test('label upgrading to unknown classification exits 28', () => {
  const policy = fixturePolicy();
  policy.labels.recipe.upgradeTo = 'cosmic';
  assert.throws(
    () => parsePolicy(JSON.stringify(policy)),
    (err) => err.exitCode === 28
  );
});

test('unknown clearance classification exits 28', () => {
  const policy = fixturePolicy();
  policy.orgs.external.clearance = 'nowhere';
  assert.throws(
    () => parsePolicy(JSON.stringify(policy)),
    (err) => err.exitCode === 28
  );
});

test('classification labels force-upgrade effective level', () => {
  const policy = fixturePolicy();
  assert.equal(effectiveClassificationLevel(policy, 'recipe_ratio'), 3); // internal -> secret via recipe
  assert.equal(effectiveClassificationLevel(policy, 'operator_name'), 2); // internal -> confidential via pii
  assert.equal(effectiveClassificationLevel(policy, 'downtime_minutes'), 0);
});

test('regulatory label marks field as regulatory', () => {
  const policy = fixturePolicy();
  assert.equal(isRegulatory(policy, 'safety_code'), true);
  assert.equal(isRegulatory(policy, 'root_cause'), false);
});
