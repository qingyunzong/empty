'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../cli');

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through its exported main() with captured stdio.
function runCli(args) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
  let status;
  try {
    status = main(['node', 'cli.js', ...args]);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { status, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
}

function writeJson(dir, name, value) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}

const baseOld = {
  states: ['A', 'B'],
  alphabet: ['x'],
  start: 'A',
  transitions: { A: { x: 'B' }, B: { x: 'A' } },
  risk: { A: 'low', B: 'high' },
};

const renamedNew = {
  states: ['S1', 'S2'],
  alphabet: ['x'],
  start: 'S1',
  transitions: { S1: { x: 'S2' }, S2: { x: 'S1' } },
  risk: { S1: 'low', S2: 'high' },
};

const divergingNew = {
  states: ['S1', 'S2'],
  alphabet: ['x'],
  start: 'S1',
  transitions: { S1: { x: 'S2' }, S2: { x: 'S1' } },
  risk: { S1: 'low', S2: 'low' },
  tasks: [{ id: 'check-B', cost: 2, covers: ['B'] }],
};

test('CLI reports equal=true for a renamed machine and saves a plan', () => {
  const dir = tmpdir();
  const oldP = writeJson(dir, 'old.json', baseOld);
  const newP = writeJson(dir, 'new.json', renamedNew);
  const planP = path.join(dir, 'plan.json');
  const res = runCli([oldP, newP, '3', '--plan', planP]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.equal, true);
  assert.equal(out.witness, null);
  assert.deepEqual(out.tasks, []);
  assert.equal(out.cost, 0);
  assert.match(out.planHash, /^[0-9a-f]{64}$/);
  // The saved plan loads back.
  const load = runCli(['load', planP]);
  assert.equal(load.status, 0, load.stderr);
  assert.equal(JSON.parse(load.stdout).ok, true);
});

test('CLI outputs witness, tasks, cost, planHash for a diverging machine', () => {
  const dir = tmpdir();
  const oldP = writeJson(dir, 'old.json', baseOld);
  const newP = writeJson(dir, 'new.json', divergingNew);
  const planP = path.join(dir, 'plan.json');
  const res = runCli([oldP, newP, '5', '--plan', planP]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.equal, false);
  assert.deepEqual(out.witness, ['x']);
  assert.deepEqual(out.tasks, ['check-B']);
  assert.equal(out.cost, 2);
  assert.match(out.planHash, /^[0-9a-f]{64}$/);
});

test('CLI is deterministic across runs (tied optima)', () => {
  const dir = tmpdir();
  const tied = {
    ...divergingNew,
    tasks: [
      { id: 't2', cost: 2, covers: ['B'] },
      { id: 't1', cost: 2, covers: ['B'] },
    ],
  };
  const oldP = writeJson(dir, 'old.json', baseOld);
  const newP = writeJson(dir, 'new.json', tied);
  const runs = [0, 1].map((i) => {
    const res = runCli([oldP, newP, '5', '--plan', path.join(dir, `p${i}.json`)]);
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  });
  assert.equal(runs[0], runs[1]);
  assert.deepEqual(JSON.parse(runs[0]).tasks, ['t1']);
});

test('negative budget exits 7', () => {
  const dir = tmpdir();
  const oldP = writeJson(dir, 'old.json', baseOld);
  const newP = writeJson(dir, 'new.json', renamedNew);
  const res = runCli([oldP, newP, '-1', '--plan', path.join(dir, 'plan.json')]);
  assert.equal(res.status, 7);
  assert.match(res.stderr, /budget/);
});

test('missing state (unknown transition target) exits 7', () => {
  const dir = tmpdir();
  const broken = {
    states: ['A'],
    alphabet: ['x'],
    start: 'A',
    transitions: { A: { x: 'ghost' } },
    risk: { A: 'low' },
  };
  const oldP = writeJson(dir, 'old.json', broken);
  const newP = writeJson(dir, 'new.json', renamedNew);
  const res = runCli([oldP, newP, '1', '--plan', path.join(dir, 'plan.json')]);
  assert.equal(res.status, 7);
  assert.match(res.stderr, /missing state/);
});

test('non-integer task cost exits 7', () => {
  const dir = tmpdir();
  const badCost = {
    ...divergingNew,
    tasks: [{ id: 'check-B', cost: 1.5, covers: ['B'] }],
  };
  const oldP = writeJson(dir, 'old.json', baseOld);
  const newP = writeJson(dir, 'new.json', badCost);
  const res = runCli([oldP, newP, '5', '--plan', path.join(dir, 'plan.json')]);
  assert.equal(res.status, 7);
  assert.match(res.stderr, /cost must be a non-negative integer/);
});

test('insufficient budget prints INFEASIBLE and exits 8 without saving a plan', () => {
  const dir = tmpdir();
  const oldP = writeJson(dir, 'old.json', baseOld);
  const newP = writeJson(dir, 'new.json', divergingNew);
  const planP = path.join(dir, 'plan.json');
  const res = runCli([oldP, newP, '1', '--plan', planP]);
  assert.equal(res.status, 8);
  assert.equal(res.stdout, 'INFEASIBLE\n');
  assert.equal(fs.existsSync(planP), false);
});

test('uncoverable difference is INFEASIBLE regardless of budget', () => {
  const dir = tmpdir();
  const noTasks = { ...divergingNew };
  delete noTasks.tasks;
  const oldP = writeJson(dir, 'old.json', baseOld);
  const newP = writeJson(dir, 'new.json', noTasks);
  const res = runCli([oldP, newP, '99', '--plan', path.join(dir, 'plan.json')]);
  assert.equal(res.status, 8);
  assert.equal(res.stdout, 'INFEASIBLE\n');
});

// Acceptance 5 via the CLI: loading a truncated plan fails and the old plan
// remains intact and loadable.
test('CLI load rejects a truncated plan and keeps the old plan', () => {
  const dir = tmpdir();
  const oldP = writeJson(dir, 'old.json', baseOld);
  const newP = writeJson(dir, 'new.json', renamedNew);
  const planP = path.join(dir, 'plan.json');
  const res = runCli([oldP, newP, '3', '--plan', planP]);
  assert.equal(res.status, 0, res.stderr);
  const before = fs.readFileSync(planP, 'utf8');

  const truncatedP = path.join(dir, 'truncated.json');
  fs.writeFileSync(truncatedP, before.slice(0, Math.floor(before.length / 2)));
  const bad = runCli(['load', truncatedP]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /INVALID PLAN/);

  // Old plan untouched and still loadable.
  assert.equal(fs.readFileSync(planP, 'utf8'), before);
  const good = runCli(['load', planP]);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).ok, true);
});
