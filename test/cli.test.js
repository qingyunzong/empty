import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir, writeJson } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'replan.js');

function cli(args, cwd) {
  // note: piped stdio is unreliable in this sandbox, so capture via files
  const outFile = path.join(cwd, `cli-${process.pid}-${cli.seq++}.out`);
  const errFile = `${outFile}.err`;
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return { status: r.status, stdout, stderr };
}
cli.seq = 0;

const DAG = { tasks: [
  { id: 'fetch', deps: [], cpu: 1, mem: 1, wall: 2, failRate: 0 },
  { id: 'build', deps: ['fetch'], cpu: 2, mem: 1, wall: 3, failRate: 0 },
  { id: 'build-docs', deps: ['fetch'], cpu: 2, mem: 1, wall: 3, failRate: 0 },
] };
const BUDGET = { cpu: 10, mem: 10, wall: 10 };

function setup() {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', DAG);
  const budget = writeJson(dir, 'budget.json', BUDGET);
  return { dir, dag, budget };
}

test('plan exits 0 and lists plans deterministically', () => {
  const { dir, dag, budget } = setup();
  const r1 = cli(['plan', dag, budget], dir);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /plan #0 \[build,build-docs,fetch\]/);
  const r2 = cli(['plan', dag, budget], dir);
  assert.equal(r1.stdout, r2.stdout);
});

test('E_CYCLE exits with code 2', () => {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', { tasks: [
    { id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] },
  ] });
  const budget = writeJson(dir, 'budget.json', BUDGET);
  const r = cli(['plan', dag, budget], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_CYCLE/);
});

test('E_AMBIG exits with code 5 on ambiguous task prefix (explain)', () => {
  const { dir, dag, budget } = setup();
  const r = cli(['explain', dag, budget, 'build'], dir); // exact match wins
  assert.equal(r.status, 0, r.stderr);
  const r2 = cli(['explain', dag, budget, 'bui'], dir); // matches build + build-docs
  assert.equal(r2.status, 5);
  assert.match(r2.stderr, /E_AMBIG/);
  assert.match(r2.stderr, /build-docs/);
});

test('E_AMBIG on --require-unique with tied optima', () => {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', { tasks: [
    { id: 'a', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0 },
    { id: 'b', deps: [], cpu: 1, mem: 1, wall: 1, failRate: 0 },
  ] });
  const budget = writeJson(dir, 'budget.json', { cpu: 1, mem: 1, wall: 1 });
  const r = cli(['run', '--simulate', dag, budget, '--require-unique'], dir);
  assert.equal(r.status, 5);
  assert.match(r.stderr, /E_AMBIG/);
  const r2 = cli(['run', '--simulate', dag, budget, '--plan-index', '1', '--state', path.join(dir, 's.json')], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /plan: \[b\]/);
});

test('run --simulate, crash, checkpoint, resume end-to-end', () => {
  const { dir, dag, budget } = setup();
  const state = path.join(dir, 'state.json');
  const crash = cli(['run', '--simulate', dag, budget, '--state', state, '--crash-after-checkpoint', 'build'], dir);
  assert.equal(crash.status, 75, crash.stderr);
  assert.match(crash.stderr, /SIM_CRASH/);
  const resumed = cli(['resume', state], dir);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /status: completed/);
  const ck = cli(['checkpoint', state, 'fetch'], dir);
  assert.equal(ck.status, 0, ck.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'state.json.checkpoints', 'fetch.manual.json')));
  const bad = cli(['checkpoint', state, 'bu'], dir); // ambiguous: build, build-docs
  assert.equal(bad.status, 5);
  assert.match(bad.stderr, /E_AMBIG/);
});

test('E_LOST_CKPT exits with code 4', () => {
  const { dir, dag, budget } = setup();
  const state = path.join(dir, 'state.json');
  cli(['run', '--simulate', dag, budget, '--state', state, '--crash-after-checkpoint', 'build'], dir);
  fs.rmSync(path.join(dir, 'state.json.checkpoints', 'build.1.json'));
  const r = cli(['resume', state], dir);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /E_LOST_CKPT/);
});

test('plan --drop releases budget and re-plans (acceptance 4 via CLI)', () => {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', { tasks: [
    { id: 'big', deps: [], cpu: 5, mem: 1, wall: 1, failRate: 0, value: 3 },
    { id: 'small1', deps: [], cpu: 3, mem: 1, wall: 1, failRate: 0, value: 2 },
    { id: 'small2', deps: [], cpu: 3, mem: 1, wall: 1, failRate: 0, value: 2 },
  ] });
  const budget = writeJson(dir, 'budget.json', { cpu: 6, mem: 10, wall: 10 });
  const before = cli(['plan', dag, budget], dir);
  assert.match(before.stdout, /plan #0 \[small1,small2\]/);
  const after = cli(['plan', dag, budget, '--drop', 'small1'], dir);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /plan #0 \[big\]/);
});

test('explain without a task prints plans, per-task reasons and recovery points', () => {
  const { dir, dag, budget } = setup();
  const r = cli(['explain', dag, budget], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /optimal value: 3/);
  assert.match(r.stdout, /fetch: selected/);
  assert.match(r.stdout, /recovery points \(plan #0\)/);
  assert.match(r.stdout, /build: on failure resume after \[fetch\]/);
});

test('E_BUDGET exits with code 3 when required tasks exceed the budget', () => {
  const dir = tmpdir();
  const dag = writeJson(dir, 'dag.json', { tasks: [
    { id: 'a', deps: [], cpu: 4, mem: 1, wall: 1, failRate: 0 },
    { id: 'b', deps: [], cpu: 4, mem: 1, wall: 1, failRate: 0 },
  ] });
  const budget = writeJson(dir, 'budget.json', { cpu: 5, mem: 5, wall: 5 });
  const r = cli(['plan', dag, budget, '--require', 'a,b'], dir);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /E_BUDGET/);
});
