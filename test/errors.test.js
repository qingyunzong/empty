'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmpDir, writeJson, runCli } = require('./helpers');

const CONSTRAINTS = {
  fee_bps: 100,
  fixed_fee: 10,
  freeze_bps: 500,
  max_total_fee: 1000,
  max_days: 5,
  max_total_freeze: 1000,
  max_daily_amount: 10000,
};

test('code 70: infeasible constraints', () => {
  const dir = makeTmpDir();
  writeJson(path.join(dir, 'obligations.json'), {
    obligations: [{ id: 'o1', from: 'A', to: 'B', amount: 100, days: 1, status: 'confirmed' }],
  });
  writeJson(path.join(dir, 'constraints.json'), { ...CONSTRAINTS, max_daily_amount: 50 });
  const res = runCli(['optimize'], { cwd: dir });
  assert.equal(res.status, 70);
  assert.match(res.stderr, /error\(70\)/);
});

test('code 71: pending obligations must not be treated as unsatisfiable', () => {
  const dir = makeTmpDir();
  writeJson(path.join(dir, 'obligations.json'), {
    obligations: [
      { id: 'o1', from: 'A', to: 'B', amount: 100, days: 1, status: 'confirmed' },
      { id: 'o2', from: 'C', to: 'D', amount: 100, days: 1, status: 'pending' },
    ],
  });
  writeJson(path.join(dir, 'constraints.json'), CONSTRAINTS);
  const res = runCli(['optimize'], { cwd: dir });
  assert.equal(res.status, 71);
  assert.match(res.stderr, /pending obligations: o2/);
  // Explicit opt-in excludes them instead of failing.
  const ok = runCli(['optimize', '--exclude-pending'], { cwd: dir });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /pending excluded: o2/);
});

test('code 72: rollback after execution is refused', () => {
  const dir = makeTmpDir();
  writeJson(path.join(dir, 'obligations.json'), {
    obligations: [{ id: 'o1', from: 'A', to: 'B', amount: 100, days: 1, status: 'confirmed' }],
  });
  writeJson(path.join(dir, 'constraints.json'), CONSTRAINTS);
  assert.equal(runCli(['optimize'], { cwd: dir }).status, 0);
  assert.equal(runCli(['emit'], { cwd: dir }).status, 0);
  const res = runCli(['rollback'], { cwd: dir });
  assert.equal(res.status, 72);
  assert.match(res.stderr, /error\(72\)/);
});
