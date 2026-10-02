'use strict';

// Acceptance 2: breaching either the freeze cap or the daily limit fails the
// whole plan (exit 70) with no partial settlement artifacts left behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const model = require('../lib/model');
const { makeCase, runCli, statePath } = require('./helpers');

const baseConstraints = {
  feeBps: 10,
  freezeBps: 5,
  freezeMarginBps: 0,
  timeBps: 0,
  maxFreeze: 100000,
  dailyLimit: 100000,
};

function assertNoSettlementArtifacts(dir) {
  assert.equal(fs.existsSync(statePath(dir, 'plan.json')), false, 'no plan file');
  assert.equal(fs.existsSync(statePath(dir, 'executed.json')), false, 'no execution marker');
  assert.equal(fs.existsSync(statePath(dir, 'reverse-plan.json')), false, 'no reverse plan');
}

test('daily limit breach fails the whole plan with exit 70 and no partial effects', () => {
  const obligations = [
    { id: 'o1', from: 'A', to: 'B', amount: 1000, day: 0, status: 'confirmed' },
  ];
  const dir = makeCase(obligations, { ...baseConstraints, dailyLimit: 500 });
  const res = runCli(dir, 'optimize');
  assert.equal(res.status, 70, res.stderr);
  assert.match(res.stderr, /no feasible netting plan/);
  assertNoSettlementArtifacts(dir);
  const emit = runCli(dir, 'emit');
  assert.equal(emit.status, 1, 'emit refuses without a plan');
  assertNoSettlementArtifacts(dir);
});

test('freeze cap breach fails the whole plan even when daily limit is fine', () => {
  const obligations = [
    { id: 'o1', from: 'A', to: 'B', amount: 400, day: 0, status: 'confirmed' },
  ];
  const dir = makeCase(obligations, { ...baseConstraints, maxFreeze: 300, dailyLimit: 1000 });
  const res = runCli(dir, 'optimize');
  assert.equal(res.status, 70, res.stderr);
  assertNoSettlementArtifacts(dir);
});

test('freeze margin can breach freeze cap while volume stays under daily limit', () => {
  const obligations = [
    { id: 'o1', from: 'A', to: 'B', amount: 400, day: 0, status: 'confirmed' },
  ];
  const constraints = { ...baseConstraints, freezeMarginBps: 5000, maxFreeze: 500, dailyLimit: 1000 };
  const evaluation = model.evaluateMask(
    obligations,
    model.normalizeConstraints(constraints),
    model.partyTotals(obligations),
    0,
  );
  assert.equal(evaluation.feasible, false);
  assert.match(evaluation.reason, /^freeze:600>500$/);
  const dir = makeCase(obligations, constraints);
  const res = runCli(dir, 'optimize');
  assert.equal(res.status, 70, res.stderr);
  assertNoSettlementArtifacts(dir);
});

test('plans violating either budget are excluded entirely; surviving plan respects both', () => {
  const obligations = [
    { id: 'o1', from: 'A', to: 'B', amount: 100, day: 0, status: 'confirmed' },
    { id: 'o2', from: 'B', to: 'A', amount: 100, day: 0, status: 'confirmed' },
  ];
  const constraints = { ...baseConstraints, maxFreeze: 1000, dailyLimit: 150 };
  const dir = makeCase(obligations, constraints);
  const res = runCli(dir, 'optimize');
  assert.equal(res.status, 0, res.stderr);
  const record = JSON.parse(fs.readFileSync(statePath(dir, 'plan.json'), 'utf8'));
  assert.deepEqual(record.selected.ids, ['o1', 'o2']);
  assert.equal(record.selected.volume, 0);
  assert.equal(record.selected.freeze, 0);
  const explain = runCli(dir, 'explain');
  assert.equal(explain.status, 0);
  assert.match(explain.stdout, /- \[\] eliminated: infeasible \(daily:200>150\)/);
  assert.match(explain.stdout, /- \[o1\] eliminated: infeasible \(sign:A\)/);
  assert.match(explain.stdout, /- \[o2\] eliminated: infeasible \(sign:B\)/);
});
