'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../src/cli');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-cli-'));
}

function run(args, opts = {}) {
  return runCli(args);
}

function runOk(args) {
  const res = run(args);
  assert.equal(res.status, 0, `expected success, got ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('CLI happy path: init -> submit -> schedule -> commit -> status', () => {
  const dir = tmpDir();
  runOk(['init', '{"cpu":4,"mem":4,"quotas":{"alice":100}}', '--state', dir]);
  runOk(['submit', '{"id":"raw","owner":"alice","bytes":5}', '--state', dir]);
  runOk(['submit', '{"id":"clean","owner":"alice","deps":["raw"],"bytes":3}', '--state', dir]);
  const sched = runOk(['schedule', '--state', dir]);
  assert.deepEqual(sched.completed, ['clean', 'raw']);
  assert.ok(sched.events.length > 0);
  const committed = runOk(['commit', '--state', dir]);
  assert.equal(committed.generation, 1);
  const status = runOk(['status', '--state', dir]);
  assert.equal(status.root, committed.root);
  assert.deepEqual(status.nodes, { raw: 'completed', clean: 'completed' });
});

test('CLI invalidate and correct report the invalidation set and state root', () => {
  const dir = tmpDir();
  runOk(['init', '{"cpu":4,"mem":4}', '--state', dir]);
  runOk(['submit', '{"id":"a","bytes":2}', '--state', dir]);
  runOk(['submit', '{"id":"b","deps":["a"],"bytes":2}', '--state', dir]);
  runOk(['submit', '{"id":"c","bytes":9}', '--state', dir]);
  runOk(['schedule', '--state', dir]);
  const inv = runOk(['invalidate', 'a', '--state', dir]);
  assert.deepEqual(inv.invalidated, ['a', 'b']);
  const cor = runOk(['correct', 'a', '{"bytes":4}', '--state', dir]);
  assert.deepEqual(cor.invalidated, ['a', 'b']);
  const sched = runOk(['schedule', '--state', dir]);
  assert.deepEqual(sched.completed, ['a', 'b', 'c']);
});

test('CLI preempt reports killed recomputable nodes', () => {
  const dir = tmpDir();
  runOk(['init', '{"cpu":1,"mem":1}', '--state', dir]);
  runOk(['submit', '{"id":"long","duration":100}', '--state', dir]);
  const out = runOk(['preempt', '--state', dir]);
  assert.deepEqual(out.preempted, [], 'nothing running yet');
});

test('CLI domain errors exit with code 7', () => {
  const cases = [];
  // duplicate submit
  {
    const dir = tmpDir();
    runOk(['init', '{}', '--state', dir]);
    runOk(['submit', '{"id":"x"}', '--state', dir]);
    cases.push({ res: run(['submit', '{"id":"x"}', '--state', dir]), code: 'DUPLICATE_SUBMIT' });
  }
  // cycle
  {
    const dir = tmpDir();
    runOk(['init', '{}', '--state', dir]);
    cases.push({ res: run(['submit', '{"id":"y","deps":["y"]}', '--state', dir]), code: 'CYCLE_DEPENDENCY' });
  }
  // resource exceeds machine
  {
    const dir = tmpDir();
    runOk(['init', '{"cpu":2,"mem":2}', '--state', dir]);
    cases.push({ res: run(['submit', '{"id":"z","cpu":8}', '--state', dir]), code: 'RESOURCE_EXCEEDS_MACHINE' });
  }
  for (const { res, code } of cases) {
    assert.equal(res.status, 7, `${code} should exit 7, got ${res.status}: ${res.stderr}`);
    assert.ok(res.stderr.includes(code), `stderr should name ${code}: ${res.stderr}`);
  }
});

test('CLI undo rolls back a committed generation', () => {
  const dir = tmpDir();
  runOk(['init', '{}', '--state', dir]);
  runOk(['submit', '{"id":"a"}', '--state', dir]);
  const g1 = runOk(['commit', '--state', dir]);
  runOk(['submit', '{"id":"b"}', '--state', dir]);
  runOk(['commit', '--state', dir]);
  const undone = runOk(['undo', '--state', dir]);
  assert.equal(undone.generation, 1);
  assert.equal(undone.root, g1.root);
  const status = runOk(['status', '--state', dir]);
  assert.deepEqual(Object.keys(status.nodes), ['a']);
});
