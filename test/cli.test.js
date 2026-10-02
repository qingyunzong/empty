'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function node(pathName, cost, children = [], status = 'active') {
  return { path: pathName, children, cost, status, hash: `hash-${pathName}` };
}

function sampleState() {
  return {
    root: 'proj',
    nodes: {
      proj: node('proj', 100, ['exp1', 'exp2']),
      exp1: node('proj/exp1', 12, ['step1', 'step2']),
      exp2: node('proj/exp2', 7, ['step3']),
      step1: node('proj/exp1/step1', 4),
      step2: node('proj/exp1/step2', 6),
      step3: node('proj/exp2/step3', 2),
    },
  };
}

function makeWorkspace(state = sampleState()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return { dir, stateFile };
}

function run(args, cwd) {
  // The sandbox cannot pipe child stdio, so capture via files instead.
  const outFile = path.join(cwd, `.stdout-${process.pid}-${run.counter++}`);
  const errFile = path.join(cwd, `.stderr-${process.pid}-${run.counter++}`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: result.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}
run.counter = 0;

test('CLI: exact budget plan, commit, verify end to end', () => {
  const { dir, stateFile } = makeWorkspace();

  const plan = run(['plan', stateFile, '--node', 'exp1', '--budget', '10'], dir);
  assert.equal(plan.status, 0, plan.stderr);
  const planJson = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  assert.equal(planJson.feasible, true);
  assert.equal(planJson.totalCost, 10);
  assert.deepEqual(planJson.selected, ['step1', 'step2']);
  assert.deepEqual(planJson.affected, ['step1', 'step2', 'exp1']);

  const commit = run(['commit', stateFile, '--node', 'exp1', '--budget', '10'], dir);
  assert.equal(commit.status, 0, commit.stderr);
  const cert = JSON.parse(fs.readFileSync(path.join(dir, 'certificate.json'), 'utf8'));
  assert.equal(cert.target, 'exp1');
  assert.equal(cert.entries.length, 3);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.nodes.exp1.status, 'rolled_back');
  assert.equal(state.nodes.step1.status, 'rolled_back');
  assert.equal(state.nodes.step2.status, 'rolled_back');
  assert.equal(state.nodes.proj.status, 'active');
  for (const entry of cert.entries) {
    assert.equal(state.nodes[entry.id].hash, entry.newHash);
    assert.notEqual(entry.newHash, entry.oldHash);
  }

  const verify = run(['verify', stateFile, '--cert', path.join(dir, 'certificate.json')], dir);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /certificate OK/);
});

test('CLI: insufficient budget exits 2, writes infeasible.json, touches nothing', () => {
  const { dir, stateFile } = makeWorkspace();
  const before = fs.readFileSync(stateFile, 'utf8');

  const commit = run(['commit', stateFile, '--node', 'exp1', '--budget', '9'], dir);
  assert.equal(commit.status, 2, commit.stderr);
  assert.match(commit.stderr, /infeasible/);

  const infeasible = JSON.parse(fs.readFileSync(path.join(dir, 'infeasible.json'), 'utf8'));
  assert.equal(infeasible.feasible, false);
  assert.equal(infeasible.reason, 'budget_exceeded');
  assert.equal(infeasible.requiredCost, 10);
  assert.equal(infeasible.budget, 9);

  assert.equal(fs.readFileSync(stateFile, 'utf8'), before); // no node changed
  assert.equal(fs.existsSync(path.join(dir, 'certificate.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'plan.json')), false);

  const plan = run(['plan', stateFile, '--node', 'exp1', '--budget', '9'], dir);
  assert.equal(plan.status, 2, plan.stderr);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

test('CLI: verify rejects a tampered state', () => {
  const { dir, stateFile } = makeWorkspace();
  const commit = run(['commit', stateFile, '--node', 'exp1', '--budget', '10'], dir);
  assert.equal(commit.status, 0, commit.stderr);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.nodes.step1.hash = 'tampered';
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const verify = run(['verify', stateFile, '--cert', path.join(dir, 'certificate.json')], dir);
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /hash mismatch/);
});

test('CLI: rolling back an already rolled-back node fails with exit 1', () => {
  const { dir, stateFile } = makeWorkspace();
  const commit = run(['commit', stateFile, '--node', 'exp1', '--budget', '10'], dir);
  assert.equal(commit.status, 0, commit.stderr);

  const again = run(['commit', stateFile, '--node', 'exp1', '--budget', '10'], dir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already rolled back/);
});

test('CLI: unknown node and bad budget fail with exit 1', () => {
  const { dir, stateFile } = makeWorkspace();
  const unknown = run(['plan', stateFile, '--node', 'nope', '--budget', '10'], dir);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown node/);

  const badBudget = run(['plan', stateFile, '--node', 'exp1', '--budget', '-3'], dir);
  assert.equal(badBudget.status, 1);
  assert.match(badBudget.stderr, /--budget/);
});
