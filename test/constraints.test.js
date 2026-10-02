'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmpDir, writeJson, runCli } = require('./helpers');

const OBLIGATIONS = {
  obligations: [
    { id: 'o1', from: 'A', to: 'B', amount: 600, days: 1, status: 'confirmed' },
    { id: 'o2', from: 'C', to: 'D', amount: 600, days: 1, status: 'confirmed' },
  ],
};

const BASE_CONSTRAINTS = {
  fee_bps: 100,
  fixed_fee: 10,
  freeze_bps: 500,
  max_total_fee: 1000,
  max_days: 5,
  max_total_freeze: 1000,
  max_daily_amount: 1000,
};

function setup(dir, constraints) {
  writeJson(path.join(dir, 'obligations.json'), OBLIGATIONS);
  writeJson(path.join(dir, 'constraints.json'), constraints);
}

test('daily cap overflow selects a feasible subset, never a partial payment', () => {
  const dir = makeTmpDir();
  setup(dir, BASE_CONSTRAINTS); // both together: amount 1200 > 1000
  const res = runCli(['optimize'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  assert.equal(plan.obligations.length, 1);
  assert.ok(plan.metrics.amount <= BASE_CONSTRAINTS.max_daily_amount);
  // The rejected full-book candidate must be recorded as infeasible, not trimmed.
  assert.equal(plan.infeasible.byConstraint.daily_amount > 0, true);
});

test('freeze cap violation fails the whole plan at emit, no partial deduction', () => {
  const dir = makeTmpDir();
  setup(dir, BASE_CONSTRAINTS);
  assert.equal(runCli(['optimize'], { cwd: dir }).status, 0);
  // Tighten the freeze cap after the plan was proposed.
  writeJson(path.join(dir, 'constraints.json'), { ...BASE_CONSTRAINTS, max_total_freeze: 1 });
  const stateDir = path.join(dir, 'state');
  const res = runCli(['emit', '--state', stateDir], { cwd: dir });
  assert.equal(res.status, 70, res.stderr);
  assert.match(res.stderr, /whole plan rejected/);
  // Nothing may be written: no executed record, no marker.
  assert.equal(fs.existsSync(stateDir), false);
});

test('daily cap violation at emit fails the whole plan, no partial deduction', () => {
  const dir = makeTmpDir();
  setup(dir, BASE_CONSTRAINTS);
  assert.equal(runCli(['optimize'], { cwd: dir }).status, 0);
  writeJson(path.join(dir, 'constraints.json'), { ...BASE_CONSTRAINTS, max_daily_amount: 1 });
  const stateDir = path.join(dir, 'state');
  const res = runCli(['emit', '--state', stateDir], { cwd: dir });
  assert.equal(res.status, 70, res.stderr);
  assert.equal(fs.existsSync(stateDir), false);
});

test('infeasible book exits 70 and writes no plan', () => {
  const dir = makeTmpDir();
  setup(dir, { ...BASE_CONSTRAINTS, max_daily_amount: 100 });
  const res = runCli(['optimize'], { cwd: dir });
  assert.equal(res.status, 70);
  assert.equal(fs.existsSync(path.join(dir, 'plan.json')), false);
});
