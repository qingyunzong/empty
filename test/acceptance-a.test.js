'use strict';

// Acceptance A: cross-tenant visibility on the same device, group inheritance,
// event-level exceptions coexisting with tag rules, deny > allow, and the
// safety-public downtime deny-break with a recorded reason.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDir, writeJson, writeJsonl, readJsonl, runCliInProc, stdoutJsonl } = require('./helpers');

const T = '2026-01-10T00:00:00Z';

function setup() {
  const dir = makeDir();
  const policy = {
    tenants: [
      { id: 't1', parents: ['g1'] },
      { id: 't2', parents: [] },
      { id: 't3', parents: [] },
    ],
    groups: [{ id: 'g1', parents: [] }],
    tags: ['line-a', 'safety-public'],
    devices: [
      { id: 'd1', tags: ['line-a'] },
      { id: 'd2', tags: ['line-a', 'safety-public'] },
    ],
    rules: [
      { id: 'r1', effect: 'allow', subject: 'g1', tag: 'line-a', actions: ['read', 'modify'] },
      { id: 'r2', effect: 'allow', subject: 't2', event: 'e2', actions: ['read'] },
      { id: 'r3', effect: 'deny', subject: 't3', tag: 'line-a', actions: ['read'] },
      { id: 'r4', effect: 'allow', subject: 't3', tag: 'line-a', actions: ['read'] },
    ],
  };
  const events = [
    { seq: 1, ts: T, eventId: 'e1', deviceId: 'd1', type: 'vibration', payload: { mm: 3 } },
    { seq: 2, ts: T, eventId: 'e2', deviceId: 'd1', type: 'vibration', payload: { mm: 4 } },
    { seq: 3, ts: T, eventId: 'e3', deviceId: 'd2', type: 'downtime', payload: { min: 12 } },
    { seq: 4, ts: T, eventId: 'e4', deviceId: 'd2', type: 'vibration', payload: { mm: 9 } },
  ];
  const policyPath = writeJson(dir, 'policy.json', policy);
  const eventsPath = writeJsonl(dir, 'events.jsonl', events);
  return { dir, policyPath, eventsPath };
}

function query(policyPath, eventsPath, tenant, audit) {
  const args = ['query', '--policy', policyPath, '--events', eventsPath, '--tenant', tenant, '--action', 'read', '--at', T];
  if (audit) args.push('--audit', audit);
  return runCliInProc(args);
}

test('A: group inheritance grants read to member tenant, other tenant denied with minimal counterexample', () => {
  const { policyPath, eventsPath } = setup();
  const r1 = query(policyPath, eventsPath, 't1');
  assert.equal(r1.code, 0);
  const lines1 = stdoutJsonl(r1.stdout);
  assert.equal(lines1.at(-1).bitmap, '1111'); // t1 inherits g1 allow on line-a

  const r2 = query(policyPath, eventsPath, 't2');
  assert.equal(r2.code, 0);
  const lines2 = stdoutJsonl(r2.stdout);
  // t2 has no tag grant but has an event-level exception for e2: exceptions coexist with tag rules.
  assert.equal(lines2.at(-1).bitmap, '0100');
  const e1 = lines2.find((l) => l.event === 'e1');
  assert.equal(e1.visible, 0);
  assert.equal(e1.counterexample.kind, 'missing_grant');
  assert.deepEqual(e1.counterexample.grant, { effect: 'allow', subject: 't2', tag: 'line-a', actions: ['read'] });
});

test('A: deny beats allow, but safety-public downtime read breaks deny and audit records the reason', () => {
  const { dir, policyPath, eventsPath } = setup();
  const audit = `${dir}/audit.jsonl`;
  const r = query(policyPath, eventsPath, 't3', audit);
  assert.equal(r.code, 0);
  const lines = stdoutJsonl(r.stdout);
  // e3: downtime on safety-public device -> deny broken. e4: plain event -> deny wins.
  assert.equal(lines.at(-1).bitmap, '0010');
  const e3 = lines.find((l) => l.event === 'e3');
  assert.equal(e3.visible, 1);
  assert.equal(e3.brokenDeny.denyRule, 'r3');
  assert.equal(e3.brokenDeny.allowRule, 'r4');
  const e4 = lines.find((l) => l.event === 'e4');
  assert.equal(e4.visible, 0);
  assert.equal(e4.counterexample.kind, 'extra_revocation');
  assert.equal(e4.counterexample.ruleId, 'r3');

  const auditLines = readJsonl(audit);
  const a3 = auditLines.find((a) => a.event === 'e3');
  assert.equal(a3.decision, 'allow');
  assert.match(a3.brokenDeny.reason, /safety-public/);
  assert.match(a3.brokenDeny.reason, /breaks deny rule 'r3'/);
  const a4 = auditLines.find((a) => a.event === 'e4');
  assert.equal(a4.decision, 'deny');
  assert.equal(a4.counterexample.kind, 'extra_revocation');
});
