'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicy } = require('../lib/policy');
const { decide } = require('../lib/evaluate');

// Chain: auditor -> senior -> base. The allow rule lives on the farthest role.
const POLICY = `
{"type":"role","role":"auditor","inherits":["senior"]}
{"type":"role","role":"senior","inherits":["base"]}
{"type":"role","role":"base"}
{"type":"rule","id":"r-base-allow","role":"base","resource":"merchant:*","effect":"allow"}
{"type":"revoke","role":"auditor","at":"2026-02-01T00:00:00Z"}
`;

const policy = loadPolicy(POLICY);

function event(at) {
  return { id: 'e', role: 'auditor', resource: 'merchant:42', at };
}

test('inherited rule applies through the full chain with inheritance path', () => {
  const d = decide(policy, event('2026-01-15T00:00:00Z'));
  assert.equal(d.decision, 'allow');
  assert.equal(d.rule, 'r-base-allow');
  assert.deepEqual(d.path, ['auditor', 'senior', 'base']);
});

test('revocation: authorization before revoke time still allowed (history immutable)', () => {
  const d = decide(policy, event('2026-01-31T23:59:59Z'));
  assert.equal(d.decision, 'allow');
  assert.equal(d.rule, 'r-base-allow');
});

test('revocation: authorization at/after revoke time denied', () => {
  for (const at of ['2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z']) {
    const d = decide(policy, event(at));
    assert.equal(d.decision, 'deny');
    assert.equal(d.reason, 'role_revoked');
    assert.equal(d.rule, null);
  }
});

test('revoking an ancestor removes only its inherited rules after the revoke time', () => {
  const p = loadPolicy(`
{"type":"role","role":"auditor","inherits":["base"]}
{"type":"role","role":"base"}
{"type":"rule","id":"r1","role":"base","resource":"merchant:*","effect":"allow"}
{"type":"revoke","role":"base","at":"2026-02-01T00:00:00Z"}
`);
  const before = decide(p, { id: 'a', role: 'auditor', resource: 'merchant:1', at: '2026-01-15T00:00:00Z' });
  assert.equal(before.decision, 'allow');
  const after = decide(p, { id: 'b', role: 'auditor', resource: 'merchant:1', at: '2026-02-02T00:00:00Z' });
  assert.equal(after.decision, 'deny');
  assert.equal(after.reason, 'no_matching_rule');
});
