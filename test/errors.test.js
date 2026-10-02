'use strict';

// Error exit codes: 8 = events out of order beyond window, 4 = tenant cycle,
// 9 = unknown tag. Exit codes are asserted on spawned processes; messages are
// asserted in-process (spawned stderr pipes can be swallowed by sandboxes).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDir, writeJson, writeJsonl, runCli, runCliInProc } = require('./helpers');

const T = '2026-01-10T00:00:00Z';

function basePolicy(overrides = {}) {
  return {
    tenants: [{ id: 't1', parents: [] }],
    groups: [],
    tags: ['line-a'],
    devices: [{ id: 'd1', tags: ['line-a'] }],
    rules: [{ id: 'r1', effect: 'allow', subject: 't1', tag: 'line-a', actions: ['read'] }],
    ...overrides,
  };
}

function queryArgs(dir, policy, events) {
  const policyPath = writeJson(dir, 'policy.json', policy);
  const eventsPath = writeJsonl(dir, 'events.jsonl', events);
  return ['query', '--policy', policyPath, '--events', eventsPath, '--tenant', 't1', '--action', 'read', '--at', T];
}

test('exit 8: event out of order beyond the reorder window', () => {
  const dir = makeDir();
  const events = [
    { seq: 500, ts: T, eventId: 'e1', deviceId: 'd1', type: 'vibration' },
    { seq: 100, ts: T, eventId: 'e2', deviceId: 'd1', type: 'vibration' }, // 400 behind, window is 100
  ];
  const args = queryArgs(dir, basePolicy(), events);
  assert.equal(runCli(args).code, 8);
  const inProc = runCliInProc(args);
  assert.equal(inProc.code, 8);
  assert.match(inProc.stderr, /beyond window 100/);
});

test('reordering within the window is tolerated', () => {
  const dir = makeDir();
  const events = [
    { seq: 500, ts: T, eventId: 'e1', deviceId: 'd1', type: 'vibration' },
    { seq: 450, ts: T, eventId: 'e2', deviceId: 'd1', type: 'vibration' },
  ];
  const args = queryArgs(dir, basePolicy(), events);
  assert.equal(runCli(args).code, 0);
});

test('exit 4: tenant/group inheritance cycle', () => {
  const dir = makeDir();
  const policy = basePolicy({
    tenants: [{ id: 't1', parents: ['g1'] }],
    groups: [{ id: 'g1', parents: ['g2'] }, { id: 'g2', parents: ['g1'] }],
  });
  const events = [{ seq: 1, ts: T, eventId: 'e1', deviceId: 'd1', type: 'vibration' }];
  const args = queryArgs(dir, policy, events);
  assert.equal(runCli(args).code, 4);
  const inProc = runCliInProc(args);
  assert.equal(inProc.code, 4);
  assert.match(inProc.stderr, /cycle/);
});

test('exit 9: unknown tag on device or in rule', () => {
  const events = [{ seq: 1, ts: T, eventId: 'e1', deviceId: 'd1', type: 'vibration' }];

  const dir1 = makeDir();
  const args1 = queryArgs(dir1, basePolicy({ devices: [{ id: 'd1', tags: ['nope'] }] }), events);
  assert.equal(runCli(args1).code, 9);
  assert.match(runCliInProc(args1).stderr, /unknown tag 'nope'/);

  const dir2 = makeDir();
  const p2 = basePolicy({ rules: [{ id: 'r1', effect: 'allow', subject: 't1', tag: 'ghost', actions: ['read'] }] });
  const args2 = queryArgs(dir2, p2, events);
  assert.equal(runCli(args2).code, 9);
  assert.match(runCliInProc(args2).stderr, /unknown tag 'ghost'/);
});
