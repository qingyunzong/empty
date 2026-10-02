'use strict';

// Acceptance 3: a crash before the execution marker is written leaves the
// system recoverable — re-selection is deterministic and emit can be retried.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeCase, runCli, statePath } = require('./helpers');

const obligations = [
  { id: 'o1', from: 'A', to: 'B', amount: 120, day: 1, status: 'confirmed' },
  { id: 'o2', from: 'B', to: 'A', amount: 80, day: 2, status: 'confirmed' },
  { id: 'o3', from: 'B', to: 'C', amount: 60, day: 0, status: 'confirmed' },
];
const constraints = {
  feeBps: 20,
  freezeBps: 5,
  freezeMarginBps: 100,
  timeBps: 2,
  maxFreeze: 10000,
  dailyLimit: 10000,
};

test('crash before execution marker: recovery allows safe deterministic re-selection', () => {
  const dir = makeCase(obligations, constraints);
  assert.equal(runCli(dir, 'optimize').status, 0);
  const before = JSON.parse(fs.readFileSync(statePath(dir, 'plan.json'), 'utf8'));

  const crashed = runCli(dir, 'emit', [], { SETTLE_CRASH_BEFORE_MARKER: '1' });
  assert.equal(crashed.status, 99, 'simulated crash before marker write');
  assert.equal(fs.existsSync(statePath(dir, 'executed.json')), false, 'no marker after crash');

  const reopt = runCli(dir, 'optimize');
  assert.equal(reopt.status, 0, 're-optimize after crash is allowed');
  const after = JSON.parse(fs.readFileSync(statePath(dir, 'plan.json'), 'utf8'));
  assert.deepEqual(after.selected, before.selected, 're-selection is deterministic');
  assert.equal(
    after.certificate.candidateSetHash,
    before.certificate.candidateSetHash,
    'certificate stable across crash recovery',
  );

  const rollback = runCli(dir, 'rollback');
  assert.equal(rollback.status, 0, 'unexecuted plan can still be rolled back after crash');
  assert.equal(fs.existsSync(statePath(dir, 'plan.json')), false);

  assert.equal(runCli(dir, 'optimize').status, 0, 'can plan again after rollback');
  const emit = runCli(dir, 'emit');
  assert.equal(emit.status, 0, emit.stderr);
  const marker = JSON.parse(fs.readFileSync(statePath(dir, 'executed.json'), 'utf8'));
  assert.equal(marker.status, 'executed');
  assert.equal(typeof marker.planHash, 'string');
  const replay = runCli(dir, 'emit');
  assert.equal(replay.status, 0, 'emit is idempotent once executed');
  assert.match(JSON.parse(replay.stdout).status, /idempotent replay/);
});

test('execution marker is written atomically as complete valid JSON', () => {
  const dir = makeCase(obligations, constraints);
  assert.equal(runCli(dir, 'optimize').status, 0);
  assert.equal(runCli(dir, 'emit').status, 0);
  const raw = fs.readFileSync(statePath(dir, 'executed.json'), 'utf8');
  const marker = JSON.parse(raw);
  assert.equal(marker.status, 'executed');
  const leftovers = fs.readdirSync(statePath(dir, '')).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'no temporary files left behind');
});
