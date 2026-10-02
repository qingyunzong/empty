'use strict';

// Acceptance C: a constructed "should-deny-but-allowed" case is detectable.
// A specific guard deny rule is retroactively revoked (e-stop related), so a
// historical request that was denied at the time now evaluates to allow via a
// weaker legacy allow. The interpreter must flag it three ways:
//   1. the decision record carries an alert + the revoked rule id,
//   2. the audit log emits an ALERT line,
//   3. the counterexample pinpoints the one change that restores the deny,
//      and a tampered decision log is caught by verifyDecision.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadPolicies, evaluateRequest, verifyCounterexample, verifyDecision } = require('../src/index');
const { tmpdir, writeJson, writeText, runCliIn, readJsonl } = require('./helpers');

const RAW = {
  roles: { operator: {} },
  zones: { cell: {} },
  subjects: { alice: { roles: ['operator'] } },
  devices: { press: { zone: 'cell' } },
  rules: [
    {
      id: 'guard-deny',
      action: 'open_mold',
      effect: 'deny',
      role: 'operator',
      zone: 'cell',
      retroactive: true,
      revokeAt: '2026-09-15T00:00:00Z',
    },
    { id: 'legacy-allow', action: 'open_mold', effect: 'allow', role: 'operator' },
  ],
};

const REQUEST = { id: 'c1', subject: 'alice', device: 'press', action: 'open_mold', time: '2026-09-10T10:00:00Z' };

test('C: fragile allow is flagged in the decision record', () => {
  const policies = loadPolicies(RAW);
  const record = evaluateRequest(policies, REQUEST);
  assert.equal(record.decision, 'allow');
  assert.deepEqual(record.retroactivelyRevoked, ['guard-deny']);
  assert.deepEqual(record.alerts, ['allow_depends_on_retroactively_revoked_deny:guard-deny']);
});

test('C: counterexample restores the deny with a single change and verifies', () => {
  const policies = loadPolicies(RAW);
  const record = evaluateRequest(policies, REQUEST);
  const cx = record.counterexample;
  assert.equal(cx.flips, true);
  assert.equal(cx.changes, 1);
  assert.deepEqual(cx.mutation, { type: 'unrevoke_rule', ruleId: 'guard-deny' });
  assert.equal(cx.resultingDecision, 'deny');
  assert.equal(verifyCounterexample(policies, REQUEST, cx).valid, true);
});

test('C: tampered decision logs are caught by verifyDecision', () => {
  const policies = loadPolicies(RAW);
  // Honest record says allow; a forged record claiming deny would also be a
  // mismatch - verification works both directions.
  assert.equal(verifyDecision(policies, REQUEST, 'allow').match, true);
  const forged = verifyDecision(policies, REQUEST, 'deny');
  assert.equal(forged.match, false);
  assert.equal(forged.actual, 'allow');
  // And once the counterexample mutation is applied, the deny claim becomes
  // honest: the constructed "should-deny" case is fully reproducible.
  const { applyMutation } = require('../src/index');
  const { rawPolicies, request } = applyMutation(RAW, REQUEST, {
    type: 'unrevoke_rule',
    ruleId: 'guard-deny',
  });
  const mutated = loadPolicies(rawPolicies);
  assert.equal(verifyDecision(mutated, request, 'deny').match, true);
});

test('C: CLI audit log emits an ALERT for the fragile allow', () => {
  const dir = tmpdir();
  writeJson(dir, 'policies.json', RAW);
  writeText(dir, 'requests.jsonl', JSON.stringify(REQUEST) + '\n');
  const res = runCliIn(dir);
  assert.equal(res.status, 0, res.stderr);
  const audit = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
  assert.match(audit, /ALERT .*allow_depends_on_retroactively_revoked_deny:guard-deny/);
  const [record] = readJsonl(path.join(dir, 'decisions.jsonl'));
  assert.equal(record.decision, 'allow');
  assert.deepEqual(record.alerts, ['allow_depends_on_retroactively_revoked_deny:guard-deny']);
});
