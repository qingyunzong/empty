import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditView, minimalCounterexample } from '../src/audit.js';
import { computeView } from '../src/views.js';

const policy = JSON.parse(readFileSync(new URL('../fixtures/field-policy.json', import.meta.url)));
const report = JSON.parse(
  readFileSync(new URL('../fixtures/reports.jsonl', import.meta.url), 'utf8').split('\n')[0],
);

test('audit verifies every output field has an authorization path', () => {
  const { fields } = computeView(policy, [], 'supplier', report.fields);
  const result = auditView(policy, ['supplier'], { reportId: report.id, audience: 'supplier', fields });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.counterexample, null);
  // authorization paths recorded for content fields
  assert.deepEqual(result.paths.line_id, ['org:supplier']);
  assert.deepEqual(result.paths.safety_interlock_status, ['classification:regulatory(forced)']);
  // personal boundary nulls are reported separately
  assert.deepEqual(result.boundaryNulls.sort(), ['operator_id', 'operator_name']);
});

test('joint view audit requires an authorization path for every member audience', () => {
  // root_cause is authorized for hq but not supplier: a joint view containing
  // it violates the intersection rule
  const tampered = {
    reportId: report.id,
    audience: 'joint',
    fields: { line_id: 'L3', root_cause: 'bearing wear' },
  };
  const result = auditView(policy, ['supplier', 'hq'], tampered);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, ['root_cause']);
});

test('counterexample: minimal field set that makes the supplier view leak the recipe', () => {
  const leaked = {
    reportId: report.id,
    audience: 'supplier',
    fields: {
      line_id: 'L3',
      downtime_minutes: 47,
      mix_ratio: { polymer: 0.62 },
      temperature_profile: [180],
    },
  };
  const result = auditView(policy, ['supplier'], leaked);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.sort(), ['mix_ratio', 'temperature_profile']);
  // a single recipe field suffices to demonstrate the leak: minimal set has size 1
  assert.equal(result.counterexample.length, 1);
  assert.equal(result.counterexample[0], 'mix_ratio');
  assert.equal(policy.fields[result.counterexample[0]].classification, 'recipe');
});

test('counterexample falls back to the full violation set when no recipe field leaks', () => {
  assert.deepEqual(minimalCounterexample(policy, ['root_cause', 'operator_id']), ['operator_id', 'root_cause']);
  assert.equal(minimalCounterexample(policy, []), null);
});
