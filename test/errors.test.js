'use strict';

// Error contract: invalid JSON -> exit 2, unknown subject/device -> exit 3,
// inheritance cycle -> exit 4 with the cycle listed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpdir, writeJson, writeText, runCliIn } = require('./helpers');

const VALID_POLICIES = {
  roles: { worker: {} },
  zones: { hall: {} },
  subjects: { alice: { roles: ['worker'] } },
  devices: { press: { zone: 'hall' } },
  rules: [{ id: 'r1', action: 'open_mold', effect: 'allow', role: 'worker' }],
};

const VALID_REQUEST =
  JSON.stringify({ id: 'q1', subject: 'alice', device: 'press', action: 'open_mold', time: '2026-10-01T00:00:00Z' }) + '\n';

function setup({ policies = VALID_POLICIES, requests = VALID_REQUEST } = {}) {
  const dir = tmpdir();
  writeJson(dir, 'policies.json', policies);
  writeText(dir, 'requests.jsonl', requests);
  return dir;
}

test('exit 2 on invalid policies JSON', () => {
  const dir = setup();
  writeText(dir, 'policies.json', '{ not json !!!');
  const res = runCliIn(dir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /invalid JSON/);
});

test('exit 2 on invalid JSONL line in requests', () => {
  const dir = setup({ requests: VALID_REQUEST + '{"id":"q2", broken\n' });
  const res = runCliIn(dir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /line 2/);
});

test('exit 2 on malformed request shape', () => {
  const dir = setup({ requests: '{"id":"q1","subject":"alice"}\n' });
  const res = runCliIn(dir);
  assert.equal(res.status, 2);
});

test('exit 3 on unknown subject', () => {
  const dir = setup({
    requests: JSON.stringify({ id: 'q9', subject: 'mallory', device: 'press', action: 'open_mold', time: '2026-10-01T00:00:00Z' }) + '\n',
  });
  const res = runCliIn(dir);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /subject 'mallory'/);
});

test('exit 3 on unknown device', () => {
  const dir = setup({
    requests: JSON.stringify({ id: 'q9', subject: 'alice', device: 'press-99', action: 'open_mold', time: '2026-10-01T00:00:00Z' }) + '\n',
  });
  const res = runCliIn(dir);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /device 'press-99'/);
});

test('exit 4 on role inheritance cycle and lists the cycle', () => {
  const dir = setup({
    policies: {
      roles: { a: { inherits: ['b'] }, b: { inherits: ['c'] }, c: { inherits: ['a'] } },
      rules: [],
    },
  });
  const res = runCliIn(dir);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /cycle/);
  assert.match(res.stderr, /a -> b -> c -> a/);
});

test('exit 4 on zone inheritance cycle and lists the cycle', () => {
  const dir = setup({
    policies: {
      zones: { x: { inherits: ['y'] }, y: { inherits: ['x'] } },
      rules: [],
    },
  });
  const res = runCliIn(dir);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /x -> y -> x|y -> x -> y/);
});

test('exit 0 on the happy path and writes both outputs', () => {
  const dir = setup();
  const res = runCliIn(dir);
  assert.equal(res.status, 0, res.stderr);
  const fs = require('fs');
  const path = require('path');
  const decisions = fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(decisions.length, 1);
  assert.equal(JSON.parse(decisions[0]).decision, 'allow');
  assert.ok(fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').includes('INFO'));
});
