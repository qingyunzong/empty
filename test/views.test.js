import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeView, computeJointView } from '../src/views.js';

const policy = JSON.parse(readFileSync(new URL('../fixtures/field-policy.json', import.meta.url)));
const reports = readFileSync(new URL('../fixtures/reports.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const r1 = reports[0];
const r2 = reports[1];

test('A: joint view is the intersection of supplier and hq visibility', () => {
  const joint = computeJointView(policy, [], ['supplier', 'hq'], r1.fields).fields;
  // visible to both supplier and hq
  assert.equal(joint.line_id, 'L3');
  assert.equal(joint.downtime_minutes, 47);
  // root_cause is visible to hq but not to supplier -> dropped by intersection
  assert.ok(!('root_cause' in joint));
  // recipe fields visible to neither -> dropped
  assert.ok(!('mix_ratio' in joint));
  assert.ok(!('temperature_profile' in joint));
});

test('A: regulatory fields stay visible in the joint view (exception)', () => {
  const joint = computeJointView(policy, [], ['supplier', 'hq'], r1.fields).fields;
  // no org grant for safety_interlock_status, yet forced visible
  assert.equal(joint.safety_interlock_status, 'OK');
});

test('C: personal fields are nulled at the boundary for unauthorized audiences', () => {
  const supplier = computeView(policy, [], 'supplier', r1.fields).fields;
  assert.equal(supplier.operator_name, null);
  assert.equal(supplier.operator_id, null);
  assert.ok(!('root_cause' in supplier));
  assert.ok(!('mix_ratio' in supplier));
  // hq sees personal data nulled too (minLevel role, only org grants exist)
  const hq = computeView(policy, [], 'hq', r1.fields).fields;
  assert.equal(hq.operator_name, null);
  // operator role is authorized for operator_name but not operator_id
  const operator = computeView(policy, [], 'operator', r1.fields).fields;
  assert.equal(operator.operator_name, 'Wei Zhang');
  assert.equal(operator.operator_id, null);
});

test('C: genuine null personal values stay null and do not crash the gate', () => {
  const supplier = computeView(policy, [], 'supplier', r2.fields).fields;
  assert.equal(supplier.operator_name, null);
  assert.equal(supplier.operator_id, null);
  const operator = computeView(policy, [], 'operator', r2.fields).fields;
  assert.equal(operator.operator_name, null);
  const joint = computeJointView(policy, [], ['supplier', 'hq'], r2.fields).fields;
  assert.equal(joint.operator_name, null);
});
