'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmpDir, writeJson, runCli } = require('./helpers');

const OBLIGATIONS = {
  obligations: [
    { id: 'o1', from: 'A', to: 'B', amount: 500, days: 1, status: 'confirmed' },
    { id: 'o2', from: 'B', to: 'A', amount: 200, days: 1, status: 'confirmed' },
  ],
};

const CONSTRAINTS = {
  fee_bps: 100,
  fixed_fee: 10,
  freeze_bps: 500,
  max_total_fee: 1000,
  max_days: 5,
  max_total_freeze: 1000,
  max_daily_amount: 10000,
};

function setup(dir) {
  writeJson(path.join(dir, 'obligations.json'), OBLIGATIONS);
  writeJson(path.join(dir, 'constraints.json'), CONSTRAINTS);
  assert.equal(runCli(['optimize'], { cwd: dir }).status, 0);
  return JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
}

test('crash before execution marker allows safe re-selection and re-emit', () => {
  const dir = makeTmpDir();
  const plan = setup(dir);
  const stateDir = path.join(dir, 'state');

  const crashed = runCli(['emit', '--state', stateDir], {
    cwd: dir,
    env: { SETTLE_CRASH_BEFORE_MARKER: '1' },
  });
  assert.equal(crashed.status, 1);
  const markerPath = path.join(stateDir, plan.planId + '.marker');
  const executedPath = path.join(stateDir, plan.planId + '.executed.json');
  assert.equal(fs.existsSync(executedPath), true, 'output record written before crash');
  assert.equal(fs.existsSync(markerPath), false, 'marker not written before crash');

  // Recovery path 1: re-emit completes and writes the marker.
  const retried = runCli(['emit', '--state', stateDir], { cwd: dir });
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(fs.existsSync(markerPath), true);
});

test('after a crash without marker the plan is still cancellable', () => {
  const dir = makeTmpDir();
  const plan = setup(dir);
  const stateDir = path.join(dir, 'state');
  const crashed = runCli(['emit', '--state', stateDir], {
    cwd: dir,
    env: { SETTLE_CRASH_BEFORE_MARKER: '1' },
  });
  assert.equal(crashed.status, 1);
  const res = runCli(['rollback', '--state', stateDir], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /cancelled/);
  assert.equal(fs.existsSync(path.join(stateDir, plan.planId + '.cancelled.json')), true);
});

test('optimize is deterministic so recovery re-selects the same plan', () => {
  const dir = makeTmpDir();
  const first = setup(dir);
  const again = runCli(['optimize', '--out', 'plan2.json'], { cwd: dir });
  assert.equal(again.status, 0);
  const second = JSON.parse(fs.readFileSync(path.join(dir, 'plan2.json'), 'utf8'));
  assert.equal(second.planId, first.planId);
  assert.deepEqual(second.certificate, first.certificate);
});
