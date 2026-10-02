'use strict';

// Acceptance A: inheritance + conflict mixed, 50 requests through the CLI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, runCli, readJsonl } = require('./helpers');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function run() {
  const dir = tmpdir();
  const decisions = path.join(dir, 'decisions.jsonl');
  const audit = path.join(dir, 'audit.log');
  const res = runCli([
    '--policies', path.join(FIXTURES, 'policies.json'),
    '--requests', path.join(FIXTURES, 'requests.jsonl'),
    '--decisions', decisions,
    '--audit', audit,
  ]);
  assert.equal(res.status, 0, res.stderr);
  return { records: readJsonl(decisions), audit: fs.readFileSync(audit, 'utf8') };
}

let cached;
function getRun() {
  if (!cached) cached = run();
  return cached;
}

function find(records, subject, device, action, time) {
  const r = records.find(
    (d) => d.subject === subject && d.device === device && d.action === action && d.time === time
  );
  assert.ok(r, `expected a request for ${subject}/${device}/${action}/${time}`);
  return r;
}

test('A: all 50 requests produce a decision with full evidence', () => {
  const { records } = getRun();
  assert.equal(records.length, 50);
  for (const r of records) {
    assert.ok(['allow', 'deny'].includes(r.decision));
    assert.ok(Array.isArray(r.rulePath), 'rulePath present');
    assert.ok(Array.isArray(r.overridden), 'overridden present');
    assert.ok(r.counterexample && typeof r.counterexample === 'object', 'counterexample present');
  }
});

test('A: inherited allow applies before revocation point', () => {
  const { records } = getRun();
  const r = find(records, 'alice', 'press-1', 'open_mold', '2026-09-10T10:00:00Z');
  assert.equal(r.decision, 'allow');
  assert.equal(r.rulePath[0].ruleId, 'old-open-allow');
  assert.deepEqual(r.rulePath[0].rolePath, ['operator']);
  assert.deepEqual(r.rulePath[0].zonePath, ['cell-a']);
  assert.deepEqual(
    r.overridden.map((o) => o.ruleId).sort(),
    ['base-open-allow', 'cella-open-deny']
  );
});

test('A: after revokeAt the inherited allow lapses and zone deny wins', () => {
  const { records } = getRun();
  const r = find(records, 'alice', 'press-1', 'open_mold', '2026-10-02T12:00:00Z');
  assert.equal(r.decision, 'deny');
  assert.equal(r.rulePath[0].ruleId, 'cella-open-deny');
  assert.deepEqual(r.overridden.map((o) => o.ruleId), ['base-open-allow']);
});

test('A: role inheritance reaches grandparent role (temp -> worker)', () => {
  const { records } = getRun();
  const r = find(records, 'bob', 'mixer-1', 'open_mold', '2026-09-25T10:00:00Z');
  assert.equal(r.decision, 'allow');
  assert.equal(r.rulePath[0].ruleId, 'base-open-allow');
  assert.deepEqual(r.rulePath[0].rolePath, ['temp', 'worker']);
});

test('A: same-level allow/deny conflict denies and issues a certificate', () => {
  const { records, audit } = getRun();
  const r = find(records, 'carol', 'oven-1', 'heat_up', '2026-10-02T12:00:00Z');
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'conflict_default_deny');
  assert.deepEqual(r.conflict.rules.map((x) => x.ruleId).sort(), ['conflict-allow', 'conflict-deny']);
  assert.equal(r.conflict.resolution, 'deny');
  assert.match(audit, /WARN .*CONFLICT certificate: conflict-allow\(allow\) vs conflict-deny\(deny\)/);
});

test('A: time-windowed rule wins inside its window only', () => {
  const { records } = getRun();
  const night = find(records, 'alice', 'press-1', 'heat_up', '2026-10-01T03:00:00Z');
  assert.equal(night.decision, 'allow');
  assert.equal(night.rulePath[0].ruleId, 'night-heat-allow');
  const day = find(records, 'dave', 'press-1', 'heat_up', '2026-10-02T12:00:00Z');
  assert.equal(day.decision, 'allow');
  assert.equal(day.rulePath[0].ruleId, 'heat-allow-operator');
  assert.deepEqual(day.overridden.map((o) => o.ruleId), ['hall-heat-deny']);
});

test('A: retroactively revoked e-stop permit is excluded but evidenced', () => {
  const { records, audit } = getRun();
  for (const time of ['2026-09-10T10:00:00Z', '2026-09-25T10:00:00Z']) {
    const r = find(records, 'carol', 'press-1', 'reset_estop', time);
    assert.equal(r.decision, 'allow');
    assert.equal(r.rulePath[0].ruleId, 'estop-allow-lead');
    assert.deepEqual(r.retroactivelyRevoked, ['estop-retro-permit']);
  }
  assert.match(audit, /NOTICE .*retroactively revoked rule\(s\) excluded.*estop-retro-permit/);
});

test('A: every allow decision carries a verified counterexample', () => {
  const { records } = getRun();
  for (const r of records.filter((x) => x.decision === 'allow')) {
    assert.equal(r.counterexample.flips, true, `counterexample for ${r.requestId}`);
    assert.equal(r.counterexample.resultingDecision, 'deny');
    assert.equal(r.counterexample.verified, true);
  }
});
