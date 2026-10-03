// CLI-level tests: JSON output, exit codes, crash simulation and recovery.
// The sandbox forbids spawning child processes, so the CLI is driven
// in-process through its exported run(argv, io) entry point — the same code
// path the process entry point uses, with captured stdout/stderr.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as cliRun } from '../src/cli.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cli-'));
}

function run(dir, args) {
  const out = [];
  const err = [];
  const status = cliRun(['--data', dir, ...args], {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return {
    status,
    stdout: out.length ? JSON.parse(out.join('')) : null,
    stderr: err.length ? JSON.parse(err.join('')) : null,
  };
}

function buildTree(dir) {
  assert.equal(run(dir, ['create', '--id', 'root', '--budget', '1000']).status, 0);
  assert.equal(run(dir, ['create', '--id', 'a', '--parent', 'root', '--budget', '400']).status, 0);
  assert.equal(run(dir, ['create', '--id', 'a1', '--parent', 'a', '--budget', '150']).status, 0);
  assert.equal(run(dir, ['create', '--id', 'b', '--parent', 'root', '--budget', '300']).status, 0);
}

test('cli: happy path create/prepare/commit/get', () => {
  const dir = tmpDir();
  buildTree(dir);
  assert.equal(run(dir, ['prepare', 'a1']).stdout.group.state, 'PREPARED');
  const committed = run(dir, ['commit', 'a1']);
  assert.equal(committed.status, 0);
  assert.equal(committed.stdout.group.state, 'SETTLED');
  const parent = run(dir, ['get', 'a']).stdout.group;
  assert.equal(parent.reserved, 0);
  assert.equal(parent.spent, 150);
});

test('cli: cancel of mixed tree exits 0 with PARTIAL status and blocked reasons', () => {
  const dir = tmpDir();
  buildTree(dir);
  run(dir, ['prepare', 'a1']);
  run(dir, ['commit', 'a1']);
  const res = run(dir, ['cancel', 'root']);
  assert.equal(res.status, 0, 'PARTIAL cancel must not be reported as overall failure');
  assert.equal(res.stdout.ok, true);
  assert.equal(res.stdout.result.status, 'PARTIAL');
  assert.deepEqual(res.stdout.result.blocked.map((b) => b.id), ['a1']);
  assert.deepEqual([...res.stdout.result.cancelled].sort(), ['b']);
  assert.equal(run(dir, ['get', 'a1']).stdout.group.state, 'SETTLED');
  assert.equal(run(dir, ['get', 'root']).stdout.group.state, 'PARTIAL');
});

test('cli: crash --after-prepare exits non-zero; next run recovers and recommit succeeds', () => {
  const dir = tmpDir();
  buildTree(dir);
  run(dir, ['prepare', 'b']);

  const crash = run(dir, ['crash', '--after-prepare', 'b']);
  assert.notEqual(crash.status, 0, 'simulated crash must exit non-zero');
  assert.equal(crash.stderr.crashed, true);
  assert.equal(crash.stderr.point, 'after-prepare');

  // Recovery happens on the next invocation: rolled back to PREPARED,
  // no partial budget deduction at the parent.
  const after = run(dir, ['get', 'b']);
  assert.equal(after.status, 0);
  assert.equal(after.stdout.group.state, 'PREPARED');
  const root = run(dir, ['get', 'root']).stdout.group;
  assert.equal(root.reserved, 400 + 300);
  assert.equal(root.spent, 0);

  const recommit = run(dir, ['commit', 'b']);
  assert.equal(recommit.status, 0);
  assert.equal(recommit.stdout.group.state, 'SETTLED');
  assert.equal(run(dir, ['get', 'root']).stdout.group.spent, 300);
});

test('cli: errors are JSON on stderr with non-zero exit', () => {
  const dir = tmpDir();
  buildTree(dir);
  const cases = [
    { args: ['get', 'missing'], code: 'NOT_FOUND' },
    { args: ['commit', 'a'], code: 'INVALID_TRANSITION' }, // not prepared
    { args: ['prepare', 'missing'], code: 'NOT_FOUND' },
    { args: ['create', '--id', 'a', '--parent', 'root', '--budget', '10'], code: 'DUPLICATE_ID' },
    { args: ['create', '--id', 'x', '--parent', 'root', '--budget', '99999'], code: 'INSUFFICIENT_BUDGET' },
    { args: ['create', '--id', 'x', '--parent', 'ghost', '--budget', '10'], code: 'PARENT_NOT_FOUND' },
    { args: ['cancel', 'missing'], code: 'NOT_FOUND' },
    { args: ['frobnicate'], code: 'USAGE' },
  ];
  for (const { args, code } of cases) {
    const res = run(dir, args);
    assert.notEqual(res.status, 0, `${args.join(' ')} must exit non-zero`);
    assert.equal(res.stdout, null, `${args.join(' ')} must not print to stdout`);
    assert.equal(res.stderr.error.code, code, `${args.join(' ')}`);
    assert.equal(typeof res.stderr.error.message, 'string');
  }
});

test('cli: cancel of SETTLED group is rejected; cancel of CANCELLED is rejected', () => {
  const dir = tmpDir();
  buildTree(dir);
  run(dir, ['prepare', 'b']);
  run(dir, ['commit', 'b']);
  const settled = run(dir, ['cancel', 'b']);
  assert.notEqual(settled.status, 0);
  assert.equal(settled.stderr.error.code, 'INVALID_TRANSITION');
  run(dir, ['cancel', 'a']);
  const again = run(dir, ['cancel', 'a']);
  assert.notEqual(again.status, 0);
  assert.equal(again.stderr.error.code, 'INVALID_TRANSITION');
});
