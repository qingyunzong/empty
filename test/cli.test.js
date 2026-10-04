'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { tmpdir } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'mold-plan.js');

// The sandbox does not deliver piped stdio from spawned processes, so the
// child's stdout/stderr are redirected to temp files and read after exit.
function run(args) {
  return new Promise((resolve, reject) => {
    const dir = tmpdir();
    const outFile = path.join(dir, 'out.txt');
    const errFile = path.join(dir, 'err.txt');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['ignore', outFd, errFd]
    });
    child.on('error', reject);
    child.on('close', (status) => {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve({
        status,
        stdout: fs.readFileSync(outFile, 'utf8'),
        stderr: fs.readFileSync(errFile, 'utf8')
      });
    });
  });
}

function stderrJson(res) {
  assert.ok(res.stderr.trim().length > 0, 'stderr non-empty');
  const parsed = JSON.parse(res.stderr);
  assert.ok(parsed.error && parsed.error.code && parsed.error.message);
  return parsed;
}

test('no arguments: usage error, exit 2, stderr JSON', async () => {
  const res = await run([]);
  assert.equal(res.status, 2);
  assert.equal(stderrJson(res).error.code, 'USAGE');
});

test('happy path: apply ops, plan feasible, verify ok', async () => {
  const dir = tmpdir();
  const steps = [
    ['apply', '--state', dir, '--op', 'shift', '--shift', 'S1', '--capacity', '210'],
    ['apply', '--state', dir, '--op', 'mold', '--mold', 'M1', '--life', '1000'],
    ['apply', '--state', dir, '--op', 'setup', '--mold', 'M1', '--minutes', '10'],
    ['apply', '--state', dir, '--op', 'insert', '--job', 'J1', '--mold', 'M1', '--shots', '10', '--duration', '100'],
    ['apply', '--state', dir, '--op', 'insert', '--job', 'J2', '--mold', 'M1', '--shots', '10', '--duration', '100']
  ];
  for (const args of steps) {
    const res = await run(args);
    assert.equal(res.status, 0, `${args.join(' ')}: ${res.stderr}`);
  }
  const plan = await run(['plan', '--state', dir]);
  assert.equal(plan.status, 0);
  const out = JSON.parse(plan.stdout);
  assert.equal(out.feasible, true);
  assert.equal(out.cost, 210);

  const verify = await run(['verify', '--state', dir]);
  assert.equal(verify.status, 0);
  assert.equal(JSON.parse(verify.stdout).ok, true);
});

test('budget shortfall: exit 3, stderr JSON, certificate preserved in stdout', async () => {
  const dir = tmpdir();
  for (const args of [
    ['apply', '--state', dir, '--op', 'shift', '--shift', 'S1', '--capacity', '210'],
    ['apply', '--state', dir, '--op', 'mold', '--mold', 'M1', '--life', '1000'],
    ['apply', '--state', dir, '--op', 'setup', '--mold', 'M1', '--minutes', '10'],
    ['apply', '--state', dir, '--op', 'insert', '--job', 'J1', '--mold', 'M1', '--shots', '10', '--duration', '100'],
    ['apply', '--state', dir, '--op', 'insert', '--job', 'J2', '--mold', 'M1', '--shots', '10', '--duration', '100']
  ]) assert.equal((await run(args)).status, 0);

  const res = await run(['apply', '--state', dir, '--op', 'shift', '--shift', 'S1', '--capacity', '209']);
  assert.equal(res.status, 3);
  assert.equal(stderrJson(res).error.code, 'INFEASIBLE');
  const out = JSON.parse(res.stdout);
  assert.equal(out.feasible, false);
  assert.ok(out.certificate && out.certificate.planStr, 'last feasible certificate retained');
  assert.equal(out.certificate.cost, 210);
});

test('rollback out of bounds: exit 6, stderr JSON ROLLBACK', async () => {
  const dir = tmpdir();
  assert.equal((await run(['apply', '--state', dir, '--op', 'shift', '--shift', 'S1', '--capacity', '100'])).status, 0);
  const res = await run(['rollback', '--state', dir, '--n', '5']);
  assert.equal(res.status, 6);
  assert.equal(stderrJson(res).error.code, 'ROLLBACK');
});

test('rollback removes last batch and stays verifiable', async () => {
  const dir = tmpdir();
  assert.equal((await run(['apply', '--state', dir, '--op', 'shift', '--shift', 'S1', '--capacity', '100'])).status, 0);
  assert.equal((await run(['apply', '--state', dir, '--op', 'mold', '--mold', 'M1', '--life', '100'])).status, 0);
  const res = await run(['rollback', '--state', dir, '--n', '1']);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.rolledBack, 1);
  assert.equal((await run(['verify', '--state', dir])).status, 0);
});

test('verify detects tampered plan: exit 2 CORRUPT', async () => {
  const dir = tmpdir();
  assert.equal((await run(['apply', '--state', dir, '--op', 'shift', '--shift', 'S1', '--capacity', '100'])).status, 0);
  const planFile = path.join(dir, 'plan.json');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  plan.planStr = 'FORGED';
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const res = await run(['verify', '--state', dir]);
  assert.equal(res.status, 2);
  assert.equal(stderrJson(res).error.code, 'CORRUPT');
});

test('sync command: two terminals converge, pending reported', async () => {
  const dirA = tmpdir();
  const dirB = tmpdir();
  const setup = (dir, job) => [
    ['apply', '--state', dir, '--op', 'shift', '--shift', 'S1', '--capacity', '100'],
    ['apply', '--state', dir, '--op', 'mold', '--mold', 'M1', '--life', '1000'],
    ['apply', '--state', dir, '--op', 'insert', '--job', job, '--mold', 'M1', '--shots', '10', '--duration', '80'],
    ['apply', '--state', dir, '--op', 'assign', '--job', job, '--shift', 'S1']
  ];
  for (const a of setup(dirA, 'J1')) assert.equal((await run(a)).status, 0);
  for (const a of setup(dirB, 'J2')) assert.equal((await run(a)).status, 0);
  const res = await run(['sync', '--state', dirA, '--peer', dirB]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.a.result.feasible, true);
  assert.equal(out.b.result.feasible, true);
  assert.deepEqual(out.a.result.pending, out.b.result.pending);
  assert.equal(out.a.result.pending.length, 1, 'over-allocated job pending');
});
