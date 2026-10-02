'use strict';

// Acceptance C: false-positive marking stays consistent with the original event
// (append-only marker, original line untouched, device copied from the event),
// and marking requires the mark_false_positive permission.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeDir, writeJson, writeJsonl, readJsonl, runCliInProc, stdoutJsonl } = require('./helpers');

const T = '2026-01-10T00:00:00Z';

function setup() {
  const dir = makeDir();
  const policy = {
    tenants: [{ id: 't1', parents: [] }, { id: 't2', parents: [] }],
    groups: [],
    tags: ['line-a'],
    devices: [{ id: 'd1', tags: ['line-a'] }],
    rules: [{ id: 'r1', effect: 'allow', subject: 't1', tag: 'line-a', actions: ['read', 'mark_false_positive'] }],
  };
  const events = [
    { seq: 1, ts: T, eventId: 'e1', deviceId: 'd1', type: 'vibration', payload: { mm: 3 } },
    { seq: 2, ts: T, eventId: 'e2', deviceId: 'd1', type: 'vibration', payload: { mm: 5 } },
  ];
  const policyPath = writeJson(dir, 'policy.json', policy);
  const eventsPath = writeJsonl(dir, 'events.jsonl', events);
  return { dir, policyPath, eventsPath };
}

test('C: authorized mark-fp appends a consistent marker without touching the original event', () => {
  const { dir, policyPath, eventsPath } = setup();
  const audit = `${dir}/audit.jsonl`;
  const before = fs.readFileSync(eventsPath, 'utf8');

  const m = runCliInProc(['mark-fp', '--policy', policyPath, '--events', eventsPath, '--tenant', 't1', '--event', 'e1', '--at', T, '--audit', audit]);
  assert.equal(m.code, 0);
  assert.deepEqual(JSON.parse(m.stdout), { marked: 'e1', device: 'd1', by: 't1' });

  const after = fs.readFileSync(eventsPath, 'utf8');
  assert.ok(after.startsWith(before), 'original event lines must be untouched (append-only)');
  const records = readJsonl(eventsPath);
  const mark = records.find((r) => r.type === 'fp_mark');
  const original = records.find((r) => r.eventId === 'e1' && r.type !== 'fp_mark');
  assert.equal(mark.eventId, original.eventId);
  assert.equal(mark.deviceId, original.deviceId, 'marker device must match the original event device');
  assert.deepEqual(original, { seq: 1, ts: T, eventId: 'e1', deviceId: 'd1', type: 'vibration', payload: { mm: 3 } });

  const q = runCliInProc(['query', '--policy', policyPath, '--events', eventsPath, '--tenant', 't1', '--action', 'read', '--at', T]);
  assert.equal(q.code, 0);
  const lines = stdoutJsonl(q.stdout);
  assert.equal(lines.find((l) => l.event === 'e1').falsePositive, 1);
  assert.equal(lines.find((l) => l.event === 'e2').falsePositive, 0);

  const auditLines = readJsonl(audit);
  assert.equal(auditLines[0].cmd, 'mark-fp');
  assert.equal(auditLines[0].decision, 'allow');
  assert.ok(auditLines[0].matchedRules.includes('r1'));
});

test('C: unauthorized tenant cannot mark; file unchanged and denial is audited', () => {
  const { dir, policyPath, eventsPath } = setup();
  const audit = `${dir}/audit.jsonl`;
  const before = fs.readFileSync(eventsPath, 'utf8');

  const m = runCliInProc(['mark-fp', '--policy', policyPath, '--events', eventsPath, '--tenant', 't2', '--event', 'e1', '--at', T, '--audit', audit]);
  assert.equal(m.code, 3);
  assert.match(m.stderr, /may not mark/);
  assert.equal(fs.readFileSync(eventsPath, 'utf8'), before);

  const auditLines = readJsonl(audit);
  assert.equal(auditLines[0].decision, 'deny');
  assert.equal(auditLines[0].counterexample.kind, 'missing_grant');
});
