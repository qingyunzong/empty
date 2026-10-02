'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeView, computeSharedView } = require('../src/views');
const { auditView, counterexample } = require('../src/audit');
const { fixturePolicy, fixtureReport } = require('./helpers');

test('every output field has an authorization path', () => {
  const policy = fixturePolicy();
  const report = fixtureReport();
  for (const principal of ['operator', 'supplier', 'hq']) {
    const audit = auditView(policy, computeView(policy, report, principal));
    assert.equal(audit.ok, true);
    for (const field of audit.fields) {
      if (field.redacted) continue;
      assert.ok(field.path.length > 0 || field.regulatory, `field ${field.name} lacks path`);
    }
  }
});

test('shared view audit passes with regulatory override path', () => {
  const policy = fixturePolicy();
  const report = fixtureReport();
  const supplier = computeView(policy, report, 'supplier');
  const hq = computeView(policy, report, 'hq');
  const shared = computeSharedView(policy, report, supplier, hq, 'supplier', 'hq');
  const audit = auditView(policy, shared);
  assert.equal(audit.ok, true);
  const safety = audit.fields.find((f) => f.name === 'safety_code');
  assert.equal(safety.regulatory, true);
});

test('counterexample gives minimal field set for supplier recipe leak', () => {
  const policy = fixturePolicy();
  const report = fixtureReport();
  const supplier = computeView(policy, report, 'supplier');
  const ce = counterexample(policy, report, 'supplier', supplier, 'recipe', new Map());
  assert.equal(ce.leaking, false);
  assert.deepEqual(ce.minimalFieldSet, ['recipe_ratio']);
  // 1 missing grant + 2 clearance levels (internal -> secret)
  assert.equal(ce.distance, 3);
});

test('counterexample flags an active recipe leak at distance 0', () => {
  const policy = fixturePolicy();
  policy.orgs.external.clearance = 'secret';
  policy.orgs.external.allow.push('recipe_ratio');
  const report = fixtureReport();
  const supplier = computeView(policy, report, 'supplier');
  assert.ok('recipe_ratio' in supplier.fields);
  const ce = counterexample(policy, report, 'supplier', supplier, 'recipe', new Map());
  assert.equal(ce.leaking, true);
  assert.equal(ce.distance, 0);
  assert.deepEqual(ce.minimalFieldSet, ['recipe_ratio']);
});
