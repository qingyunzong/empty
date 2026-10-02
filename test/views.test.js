'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeView, computeSharedView } = require('../src/views');
const { fixturePolicy, fixtureReport } = require('./helpers');

// Acceptance A: supplier/HQ conflict -> intersection, regulatory exception.
test('shared view is the intersection plus forced regulatory fields', () => {
  const policy = fixturePolicy();
  const report = fixtureReport();
  const supplier = computeView(policy, report, 'supplier');
  const hq = computeView(policy, report, 'hq');
  const shared = computeSharedView(policy, report, supplier, hq, 'supplier', 'hq');

  // hq can see recipe_ratio, supplier cannot -> intersected out
  assert.ok('recipe_ratio' in hq.fields);
  assert.ok(!('recipe_ratio' in supplier.fields));
  assert.ok(!('recipe_ratio' in shared.fields));

  // supplier is not authorized for safety_code, but it is regulatory
  assert.ok(!('safety_code' in supplier.fields));
  assert.equal(shared.fields.safety_code, report.fields.safety_code);

  assert.deepEqual(Object.keys(shared.fields).sort(), [
    'downtime_minutes',
    'machine_id',
    'root_cause',
    'safety_code',
  ]);
});

// Acceptance C: personal info boundary -> null values.
test('pii fields at the permission boundary become null', () => {
  const policy = fixturePolicy();
  const report = fixtureReport();
  const supplier = computeView(policy, report, 'supplier');
  const hq = computeView(policy, report, 'hq');
  const operator = computeView(policy, report, 'operator');

  assert.ok('operator_name' in supplier.fields);
  assert.equal(supplier.fields.operator_name, null);
  assert.deepEqual(supplier.nulled, ['operator_name']);

  assert.equal(hq.fields.operator_name, null);

  // operator is authorized (confidential clearance >= upgraded confidential)
  assert.equal(operator.fields.operator_name, 'Zhang Wei');

  // null never leaks into the shared view
  const shared = computeSharedView(policy, report, supplier, hq, 'supplier', 'hq');
  assert.ok(!('operator_name' in shared.fields));
});

test('unknown report fields are omitted, not leaked', () => {
  const policy = fixturePolicy();
  const report = { id: 'rpt-x', fields: { mystery_field: 'data', downtime_minutes: 1 } };
  const view = computeView(policy, report, 'hq');
  assert.ok(!('mystery_field' in view.fields));
  assert.deepEqual(view.omitted, ['mystery_field']);
});
