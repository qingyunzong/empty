'use strict';

// Acceptance B: revoking a grant must not change already-derived statistics,
// while detail queries are rebuilt at query time; the audit explains both.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeDir, writeJson, writeJsonl, readJsonl, runCliInProc, stdoutJsonl } = require('./helpers');

const T1 = '2026-01-10T00:00:00Z';
const T2 = '2026-02-01T00:00:00Z'; // revocation time
const T3 = '2026-03-01T00:00:00Z';

function setup() {
  const dir = makeDir();
  const policy = {
    tenants: [{ id: 't1', parents: [] }],
    groups: [],
    tags: ['line-a'],
    devices: [{ id: 'd1', tags: ['line-a'] }],
    rules: [{ id: 'r1', effect: 'allow', subject: 't1', tag: 'line-a', actions: ['read', 'modify'] }],
  };
  const events = [
    { seq: 1, ts: T1, eventId: 'e1', deviceId: 'd1', type: 'vibration', payload: {} },
    { seq: 2, ts: T1, eventId: 'e2', deviceId: 'd1', type: 'downtime', payload: {} },
  ];
  const policyPath = writeJson(dir, 'policy.json', policy);
  const eventsPath = writeJsonl(dir, 'events.jsonl', events);
  return { dir, policyPath, eventsPath };
}

test('B: derived stats snapshot survives revocation; detail query is rebuilt at query time', () => {
  const { dir, policyPath, eventsPath } = setup();
  const statsPath = `${dir}/stats.jsonl`;
  const audit = `${dir}/audit.jsonl`;

  // Derive statistics at T1 while the grant is active.
  const s1 = runCliInProc(['stats', '--policy', policyPath, '--events', eventsPath, '--tenant', 't1', '--at', T1, '--out', statsPath]);
  assert.equal(s1.code, 0);
  assert.deepEqual(JSON.parse(s1.stdout).counts, { read: 2, modify: 2, mark_false_positive: 0 });

  // Operator revokes the grant at T2.
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.rules[0].revokedAt = T2;
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));

  // Same query before vs after revocation yields different results.
  const qBefore = runCliInProc(['query', '--policy', policyPath, '--events', eventsPath, '--tenant', 't1', '--action', 'read', '--at', T1, '--audit', audit]);
  assert.equal(qBefore.code, 0);
  assert.equal(stdoutJsonl(qBefore.stdout).at(-1).bitmap, '11'); // as-of T1 the grant still applied

  const qAfter = runCliInProc(['query', '--policy', policyPath, '--events', eventsPath, '--tenant', 't1', '--action', 'read', '--at', T3, '--audit', audit]);
  assert.equal(qAfter.code, 0);
  const afterLines = stdoutJsonl(qAfter.stdout);
  assert.equal(afterLines.at(-1).bitmap, '00');
  assert.equal(afterLines[0].counterexample.kind, 'missing_grant');

  // The previously derived statistics are unchanged (append-only snapshot).
  const statsLines = readJsonl(statsPath);
  assert.equal(statsLines.length, 1);
  assert.deepEqual(statsLines[0].counts, { read: 2, modify: 2, mark_false_positive: 0 });

  // A fresh stats run reflects the revocation, proving the snapshot was not rewritten.
  const s2 = runCliInProc(['stats', '--policy', policyPath, '--events', eventsPath, '--tenant', 't1', '--at', T3, '--out', statsPath]);
  assert.equal(s2.code, 0);
  assert.deepEqual(JSON.parse(s2.stdout).counts, { read: 0, modify: 0, mark_false_positive: 0 });
  assert.equal(readJsonl(statsPath).length, 2);

  // Audit explains both decisions: before -> matched r1; after -> no rules, missing grant.
  const auditLines = readJsonl(audit);
  const before = auditLines.filter((a) => a.at === T1);
  const after = auditLines.filter((a) => a.at === T3);
  assert.ok(before.every((a) => a.decision === 'allow' && a.matchedRules.includes('r1')));
  assert.ok(after.every((a) => a.decision === 'deny' && a.matchedRules.length === 0 && a.counterexample.kind === 'missing_grant'));
});
