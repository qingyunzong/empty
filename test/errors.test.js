'use strict';

// Error contract: 70 infeasible, 71 pending treated as unsatisfiable,
// 72 rollback after execution (only a reverse plan may be generated).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeCase, runCli, statePath } = require('./helpers');

const constraints = {
  feeBps: 10,
  freezeBps: 5,
  freezeMarginBps: 0,
  timeBps: 0,
  maxFreeze: 10000,
  dailyLimit: 10000,
};

const obligations = [
  { id: 'o1', from: 'A', to: 'B', amount: 100, day: 0, status: 'confirmed' },
  { id: 'o2', from: 'B', to: 'A', amount: 60, day: 1, status: 'confirmed' },
];

test('pending obligations are treated as unsatisfiable: exit 71', () => {
  const dir = makeCase(
    [...obligations, { id: 'o3', from: 'C', to: 'A', amount: 10, day: 0, status: 'pending' }],
    constraints,
  );
  const res = runCli(dir, 'optimize');
  assert.equal(res.status, 71, res.stderr);
  assert.match(res.stderr, /pending obligation\(s\) treated as unsatisfiable: o3/);
  assert.equal(fs.existsSync(statePath(dir, 'plan.json')), false);
});

test('infeasible budgets: exit 70', () => {
  const dir = makeCase(obligations, { ...constraints, dailyLimit: 10 });
  const res = runCli(dir, 'optimize');
  assert.equal(res.status, 70, res.stderr);
});

test('rollback of an unexecuted plan succeeds and revokes it', () => {
  const dir = makeCase(obligations, constraints);
  assert.equal(runCli(dir, 'optimize').status, 0);
  const res = runCli(dir, 'rollback');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(statePath(dir, 'plan.json')), false);
  assert.equal(fs.existsSync(statePath(dir, 'plan.rolledback.json')), true);
  const emit = runCli(dir, 'emit');
  assert.equal(emit.status, 1, 'emit refuses after rollback');
});

test('rollback after execution fails with 72 and only a reverse plan is generated', () => {
  const dir = makeCase(obligations, constraints);
  assert.equal(runCli(dir, 'optimize').status, 0);
  assert.equal(runCli(dir, 'emit').status, 0);
  const res = runCli(dir, 'rollback');
  assert.equal(res.status, 72, res.stderr);
  assert.match(res.stderr, /already executed; rollback refused/);
  const reverse = JSON.parse(fs.readFileSync(statePath(dir, 'reverse-plan.json'), 'utf8'));
  assert.equal(reverse.kind, 'reverse-plan');
  const selected = JSON.parse(fs.readFileSync(statePath(dir, 'plan.json'), 'utf8')).selected;
  for (let i = 0; i < selected.netted.length; i++) {
    assert.equal(reverse.netted[i].party, selected.netted[i].party);
    assert.equal(reverse.netted[i].amount, -selected.netted[i].amount);
  }
  for (let i = 0; i < selected.gross.length; i++) {
    assert.equal(reverse.gross[i].from, selected.gross[i].to);
    assert.equal(reverse.gross[i].to, selected.gross[i].from);
    assert.equal(reverse.gross[i].amount, selected.gross[i].amount);
  }
  assert.equal(fs.existsSync(statePath(dir, 'executed.json')), true, 'marker untouched');
});

test('re-optimize after execution is refused', () => {
  const dir = makeCase(obligations, constraints);
  assert.equal(runCli(dir, 'optimize').status, 0);
  assert.equal(runCli(dir, 'emit').status, 0);
  const res = runCli(dir, 'optimize');
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /already executed/);
});

test('rollback with no plan exits 1', () => {
  const dir = makeCase(obligations, constraints);
  const res = runCli(dir, 'rollback');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /nothing to rollback/);
});
