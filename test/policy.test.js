import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  authorizationPath,
  inheritanceChain,
  validatePolicy,
  validateReportFields,
  GateError,
} from '../src/policy.js';

const policy = JSON.parse(readFileSync(new URL('../fixtures/field-policy.json', import.meta.url)));

test('inheritance: individual inherits role and org grants', () => {
  // alice (individual) -> operator (role) -> factory (org)
  assert.deepEqual(inheritanceChain(policy, 'alice'), [
    { level: 'individual', id: 'alice' },
    { level: 'role', id: 'operator' },
    { level: 'org', id: 'factory' },
  ]);
  // line_id granted at role level, inherited down to alice
  assert.deepEqual(authorizationPath(policy, 'alice', 'line_id'), [
    'individual:alice',
    'role:operator',
  ]);
  // operator_id granted only at org level, but personal forces minLevel role:
  // the org-level grant is not sufficient even for alice
  assert.equal(authorizationPath(policy, 'alice', 'operator_id'), null);
  // operator_name granted at role level
  assert.deepEqual(authorizationPath(policy, 'alice', 'operator_name'), [
    'individual:alice',
    'role:operator',
  ]);
  // role inherits org grants
  assert.deepEqual(authorizationPath(policy, 'operator', 'root_cause'), ['role:operator']);
  // supplier has no grant for root_cause
  assert.equal(authorizationPath(policy, 'supplier', 'root_cause'), null);
});

test('classification label forces escalation of the required grant level', () => {
  // mix_ratio is recipe (minLevel individual): hq's org-level grant is not enough
  assert.equal(authorizationPath(policy, 'hq', 'mix_ratio'), null);
  // alice holds an individual-level grant: sufficient
  assert.deepEqual(authorizationPath(policy, 'alice', 'mix_ratio'), ['individual:alice']);
  // operator_id is personal (minLevel role): factory's org-level grant is not enough
  assert.equal(authorizationPath(policy, 'operator', 'operator_id'), null);
  // operator_name granted at role level: exactly sufficient for personal
  assert.deepEqual(authorizationPath(policy, 'operator', 'operator_name'), ['role:operator']);
});

test('regulatory fields are authorized for everyone (forced)', () => {
  for (const audience of ['supplier', 'hq', 'operator', 'alice']) {
    const path = authorizationPath(policy, audience, 'safety_interlock_status');
    assert.ok(path, `expected forced path for ${audience}`);
  }
});

test('unknown classification in policy exits 28', () => {
  const bad = structuredClone(policy);
  bad.fields.mystery = { classification: 'top-secret' };
  assert.throws(() => validatePolicy(bad), (error) => error instanceof GateError && error.exitCode === 28);
});

test('unknown classification for report field exits 28', () => {
  assert.throws(
    () => validateReportFields(policy, 'r-x', { not_in_policy: 1 }),
    (error) => error instanceof GateError && error.exitCode === 28,
  );
});
