'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicy, decide } = require('../lib/index');

const POLICY = [
  { type: 'inherit', role: 'auditor', inherits: 'analyst' },
  { type: 'inherit', role: 'analyst', inherits: 'viewer' },
  { type: 'rule', id: 'r-read', role: 'viewer', resource: 'settlement:read', effect: 'allow' },
  { type: 'rule', id: 'r-export', role: 'analyst', resource: 'settlement:export', effect: 'allow' },
].map((r) => JSON.stringify(r)).join('\n');

test('inherited allow resolves with full inheritance path', () => {
  const policy = loadPolicy(POLICY);
  const d = decide(policy, { id: 'e1', role: 'auditor', resource: 'settlement:read', ts: 10 });
  assert.equal(d.decision, 'allow');
  assert.equal(d.rule, 'r-read');
  assert.deepEqual(d.path, ['auditor', 'analyst', 'viewer']);
  assert.equal(d.reason, 'EXPLICIT_ALLOW');
});

test('direct rule wins over inherited rule at shorter distance', () => {
  const policy = loadPolicy(POLICY);
  const d = decide(policy, { id: 'e2', role: 'auditor', resource: 'settlement:export', ts: 10 });
  assert.equal(d.decision, 'allow');
  assert.equal(d.rule, 'r-export');
  assert.deepEqual(d.path, ['auditor', 'analyst']);
});

test('unknown resource falls back to default deny', () => {
  const policy = loadPolicy(POLICY);
  const d = decide(policy, { id: 'e3', role: 'auditor', resource: 'settlement:delete', ts: 10 });
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, null);
  assert.equal(d.reason, 'DEFAULT_DENY');
});

test('revocation only affects authorizations at/after its timestamp', () => {
  const text = `${POLICY}\n${JSON.stringify({ type: 'revoke', role: 'viewer', at: 100 })}`;
  const policy = loadPolicy(text);

  const before = decide(policy, { id: 'e4', role: 'auditor', resource: 'settlement:read', ts: 50 });
  assert.equal(before.decision, 'allow');
  assert.equal(before.rule, 'r-read');

  const at = decide(policy, { id: 'e5', role: 'auditor', resource: 'settlement:read', ts: 100 });
  assert.equal(at.decision, 'deny');
  assert.equal(at.reason, 'DEFAULT_DENY');

  const after = decide(policy, { id: 'e6', role: 'auditor', resource: 'settlement:read', ts: 150 });
  assert.equal(after.decision, 'deny');
});

test('revoking a middle role keeps inherited ancestor rules reachable', () => {
  const text = `${POLICY}\n${JSON.stringify({ type: 'revoke', role: 'analyst', at: 100 })}`;
  const policy = loadPolicy(text);

  // analyst's own rule is gone after revocation
  const own = decide(policy, { id: 'e7', role: 'auditor', resource: 'settlement:export', ts: 150 });
  assert.equal(own.decision, 'deny');

  // viewer's rule still applies through the (edge-preserving) chain
  const inherited = decide(policy, { id: 'e8', role: 'auditor', resource: 'settlement:read', ts: 150 });
  assert.equal(inherited.decision, 'allow');
  assert.equal(inherited.rule, 'r-read');
});

test('string (ISO) timestamps compare lexicographically for revocation', () => {
  const text = `${POLICY}\n${JSON.stringify({ type: 'revoke', role: 'viewer', at: '2026-06-01T00:00:00Z' })}`;
  const policy = loadPolicy(text);
  const before = decide(policy, { id: 'e9', role: 'viewer', resource: 'settlement:read', ts: '2026-05-31T23:59:59Z' });
  const after = decide(policy, { id: 'e10', role: 'viewer', resource: 'settlement:read', ts: '2026-06-01T00:00:01Z' });
  assert.equal(before.decision, 'allow');
  assert.equal(after.decision, 'deny');
});
