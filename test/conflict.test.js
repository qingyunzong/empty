'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicy, decide } = require('../lib/index');

function policyOf(records) {
  return loadPolicy(records.map((r) => JSON.stringify(r)).join('\n'));
}

test('explicit deny beats allow even when the allow is nearer', () => {
  const policy = policyOf([
    { type: 'inherit', role: 'analyst', inherits: 'viewer' },
    { type: 'rule', id: 'r-allow', role: 'analyst', resource: 'res', effect: 'allow' },
    { type: 'rule', id: 'r-deny', role: 'viewer', resource: 'res', effect: 'deny' },
  ]);
  const d = decide(policy, { id: 'e1', role: 'analyst', resource: 'res', ts: 1 });
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'r-deny');
  assert.equal(d.reason, 'DENY_OVERRIDES_ALLOW');
  assert.deepEqual(d.path, ['analyst', 'viewer']);
});

test('among same effect, nearer ancestor beats farther ancestor', () => {
  const policy = policyOf([
    { type: 'inherit', role: 'lead', inherits: 'analyst' },
    { type: 'inherit', role: 'analyst', inherits: 'viewer' },
    { type: 'rule', id: 'r-far', role: 'viewer', resource: 'res', effect: 'allow' },
    { type: 'rule', id: 'r-near', role: 'analyst', resource: 'res', effect: 'allow' },
  ]);
  const d = decide(policy, { id: 'e2', role: 'lead', resource: 'res', ts: 1 });
  assert.equal(d.rule, 'r-near');
  assert.deepEqual(d.path, ['lead', 'analyst']);
});

test('equal effect and distance tie-breaks by lexicographic rule id', () => {
  const policy = policyOf([
    { type: 'rule', id: 'r2', role: 'analyst', resource: 'res', effect: 'allow' },
    { type: 'rule', id: 'r10', role: 'analyst', resource: 'res', effect: 'allow' },
    { type: 'rule', id: 'r1', role: 'analyst', resource: 'res', effect: 'allow' },
  ]);
  const d = decide(policy, { id: 'e3', role: 'analyst', resource: 'res', ts: 1 });
  // lexicographic, not numeric: "r1" < "r10" < "r2"
  assert.equal(d.rule, 'r1');
  assert.equal(d.candidates, 3);
});

test('tie-break applies across roles at the same distance', () => {
  const policy = policyOf([
    { type: 'inherit', role: 'lead', inherits: 'analyst' },
    { type: 'inherit', role: 'lead', inherits: 'viewer' },
    { type: 'rule', id: 'z-rule', role: 'analyst', resource: 'res', effect: 'allow' },
    { type: 'rule', id: 'a-rule', role: 'viewer', resource: 'res', effect: 'allow' },
  ]);
  const d = decide(policy, { id: 'e4', role: 'lead', resource: 'res', ts: 1 });
  assert.equal(d.rule, 'a-rule');
});

test('deny among denies uses distance then id ordering', () => {
  const policy = policyOf([
    { type: 'inherit', role: 'lead', inherits: 'analyst' },
    { type: 'inherit', role: 'analyst', inherits: 'viewer' },
    { type: 'rule', id: 'r-far-deny', role: 'viewer', resource: 'res', effect: 'deny' },
    { type: 'rule', id: 'r-near-deny', role: 'analyst', resource: 'res', effect: 'deny' },
    { type: 'rule', id: 'r-allow', role: 'lead', resource: 'res', effect: 'allow' },
  ]);
  const d = decide(policy, { id: 'e5', role: 'lead', resource: 'res', ts: 1 });
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'r-near-deny');
  assert.equal(d.reason, 'DENY_OVERRIDES_ALLOW');
});

test('rules on other resources do not interfere', () => {
  const policy = policyOf([
    { type: 'rule', id: 'r-other', role: 'analyst', resource: 'other', effect: 'deny' },
    { type: 'rule', id: 'r-here', role: 'analyst', resource: 'res', effect: 'allow' },
  ]);
  const d = decide(policy, { id: 'e6', role: 'analyst', resource: 'res', ts: 1 });
  assert.equal(d.decision, 'allow');
  assert.equal(d.rule, 'r-here');
});
