'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmpDir, writeJson, runCli } = require('./helpers');

const OBLIGATIONS = {
  obligations: [
    { id: 'o1', from: 'A', to: 'B', amount: 1000, days: 1, status: 'confirmed' },
    { id: 'o2', from: 'B', to: 'A', amount: 400, days: 2, status: 'confirmed' },
    { id: 'o3', from: 'C', to: 'D', amount: 300, days: 1, status: 'confirmed' },
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
}

test('full lifecycle: optimize, emit, reverse plan instead of rollback', () => {
  const dir = makeTmpDir();
  setup(dir);
  const opt = runCli(['optimize'], { cwd: dir });
  assert.equal(opt.status, 0, opt.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  // o1/o2 net to A->B 600; o3 settles gross.
  assert.deepEqual(
    plan.payments.map((p) => [p.from, p.to, p.amount]),
    [
      ['A', 'B', 600],
      ['C', 'D', 300],
    ]
  );

  const emit = runCli(['emit'], { cwd: dir });
  assert.equal(emit.status, 0, emit.stderr);
  assert.match(emit.stdout, /certificate candidateSetHash=/);

  const refused = runCli(['rollback'], { cwd: dir });
  assert.equal(refused.status, 72);

  const reverse = runCli(['rollback', '--reverse'], { cwd: dir });
  assert.equal(reverse.status, 0, reverse.stderr);
  const reversePath = path.join(dir, '.settle-state', plan.planId + '.reverse.json');
  const reversed = JSON.parse(fs.readFileSync(reversePath, 'utf8'));
  assert.equal(reversed.reverses, plan.planId);
  assert.deepEqual(
    reversed.payments.map((p) => [p.from, p.to, p.amount]),
    [
      ['B', 'A', 600],
      ['D', 'C', 300],
    ]
  );
});

test('rollback of an unexecuted plan cancels it', () => {
  const dir = makeTmpDir();
  setup(dir);
  assert.equal(runCli(['optimize'], { cwd: dir }).status, 0);
  const res = runCli(['rollback'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /cancelled \(was not executed\)/);
});

test('explain reports elimination reasons for candidates and subsets', () => {
  const dir = makeTmpDir();
  setup(dir);
  assert.equal(runCli(['optimize'], { cwd: dir }).status, 0);

  const all = runCli(['explain'], { cwd: dir });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /eliminated feasible candidates:/);
  assert.match(all.stdout, /settled principal \d+ < optimal \d+/);

  // Subset {o1,o2,o3} is the chosen plan; {o1,o2} alone nets to A->B 600 too,
  // so it ties on payments but loses on principal.
  const subset = runCli(['explain', '--subset', 'o1,o2'], { cwd: dir });
  assert.equal(subset.status, 0, subset.stderr);
  assert.match(subset.stdout, /eliminated: settled principal 1400 < optimal 1700/);

  // An infeasible subset reports the violated constraint.
  writeJson(path.join(dir, 'constraints.json'), { ...CONSTRAINTS, max_daily_amount: 500 });
  assert.equal(runCli(['optimize', '--out', 'tight.json'], { cwd: dir }).status, 0);
  const infeasible = runCli(['explain', '--plan', 'tight.json', '--subset', 'o1,o3'], { cwd: dir });
  assert.equal(infeasible.status, 0, infeasible.stderr);
  assert.match(infeasible.stdout, /eliminated: infeasible, violates daily_amount/);
});
