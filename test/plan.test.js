'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePlan, loadPlan, hashPlan } = require('../src/plan');
const { PlanError } = require('../src/errors');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
}

const samplePlan = {
  version: 1,
  inputs: { old: 'aaa', new: 'bbb' },
  budget: 5,
  m: 16,
  equal: false,
  witness: ['open', 'ok'],
  diffStates: ['fix'],
  tasks: ['confirm-fix'],
  cost: 3,
};

test('save/load roundtrip preserves the plan and hash', () => {
  const dir = tmpdir();
  const planPath = path.join(dir, 'plan.json');
  const hash = savePlan(planPath, samplePlan);
  assert.equal(hash, hashPlan(samplePlan));
  assert.deepEqual(loadPlan(planPath), samplePlan);
});

test('saving over an existing plan atomically replaces it', () => {
  const dir = tmpdir();
  const planPath = path.join(dir, 'plan.json');
  savePlan(planPath, samplePlan);
  const updated = { ...samplePlan, budget: 9, cost: 1 };
  savePlan(planPath, updated);
  assert.deepEqual(loadPlan(planPath), updated);
  // No temp files left behind after the atomic rename.
  assert.deepEqual(fs.readdirSync(dir), ['plan.json']);
});

// Acceptance 5: a truncated plan must be rejected and the old plan kept.
test('truncated plan is rejected and the old plan is kept', () => {
  const dir = tmpdir();
  const planPath = path.join(dir, 'plan.json');
  savePlan(planPath, samplePlan);
  const before = fs.readFileSync(planPath, 'utf8');

  const truncatedPath = path.join(dir, 'truncated.json');
  fs.writeFileSync(truncatedPath, before.slice(0, Math.floor(before.length / 2)));
  assert.throws(() => loadPlan(truncatedPath), PlanError);
  assert.throws(() => loadPlan(truncatedPath), /corrupt|truncated/i);

  // The previously saved plan is untouched and still loads.
  assert.equal(fs.readFileSync(planPath, 'utf8'), before);
  assert.deepEqual(loadPlan(planPath), samplePlan);
});

test('tampered plan (valid JSON, wrong hash) is rejected', () => {
  const dir = tmpdir();
  const planPath = path.join(dir, 'plan.json');
  savePlan(planPath, samplePlan);
  const data = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  data.plan.cost = 0;
  fs.writeFileSync(planPath, JSON.stringify(data, null, 2));
  assert.throws(() => loadPlan(planPath), /hash mismatch/i);
});

test('missing plan file is rejected', () => {
  assert.throws(() => loadPlan(path.join(tmpdir(), 'nope.json')), PlanError);
});
