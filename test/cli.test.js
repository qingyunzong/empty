import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

// The offline sandbox forbids spawning child processes, so the CLI is
// exercised through its in-process entry point runCli(argv), which returns
// { code, stdout, stderr } exactly as the real process would emit them.
function run(args) {
  const r = runCli(args);
  return { status: r.code, stdout: r.stdout, stderr: r.stderr };
}

test('cli eval prints exact interval, quantized value and error bound', () => {
  const res = run(['eval', '--coeffs', '1/4,0,-2,0,1', '--lo', '9/10', '--hi', '11/10', '-k', '1']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.interval, { min: '-3/4', max: '-7059/10000' });
  assert.equal(out.quantized, '-7/10');
  assert.equal(out.errorBound, '1/20');
  assert.equal(out.k, 1);
});

test('cli eval reports E_AMBIGUOUS with exit code 4', () => {
  const res = run(['eval', '--coeffs', '0,1', '--lo', '0', '--hi', '1/10', '-k', '1']);
  assert.equal(res.status, 4);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error, 'E_AMBIGUOUS');
});

test('cli eval rejects k < 0 with E_CONFIG (exit 2)', () => {
  const res = run(['eval', '--coeffs', '1', '--lo', '0', '--hi', '1', '-k', '-1']);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).error, 'E_CONFIG');
});

test('cli eval rejects zero denominator with E_RATIONAL (exit 3)', () => {
  const res = run(['eval', '--coeffs', '1/0', '--lo', '0', '--hi', '1', '-k', '1']);
  assert.equal(res.status, 3);
  assert.equal(JSON.parse(res.stderr).error, 'E_RATIONAL');
});

test('cli revision workflow: commit, undo restores original instruction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oven-'));
  const state = join(dir, 'state.json');
  try {
    const evalArgs = ['eval', '--lo', '9/10', '--hi', '11/10', '-k', '1', '--state', state];

    assert.equal(run(['init', '--coeffs', '1/4,0,-2,0,1', '--state', state]).status, 0);
    const original = JSON.parse(run(evalArgs).stdout);
    assert.equal(original.quantized, '-7/10');

    // Illegal commit (degree 5) must not change the active version.
    assert.equal(run(['stage', '--coeffs', '1,2,3,4,5,6', '--state', state]).status, 0);
    const badCommit = run(['commit', '--state', state]);
    assert.equal(badCommit.status, 2);
    assert.equal(JSON.parse(badCommit.stderr).error, 'E_CONFIG');
    assert.deepEqual(JSON.parse(run(evalArgs).stdout), original);

    // Legal revision changes the instruction; undo restores the original.
    assert.equal(run(['stage', '--coeffs', '3,0,-2,0,1', '--state', state]).status, 0);
    assert.equal(run(['commit', '--state', state]).status, 0);
    const revised = JSON.parse(run(evalArgs).stdout);
    assert.notDeepEqual(revised, original);

    assert.equal(run(['undo', '--state', state]).status, 0);
    assert.deepEqual(JSON.parse(run(evalArgs).stdout), original);

    assert.equal(run(['redo', '--state', state]).status, 0);
    assert.deepEqual(JSON.parse(run(evalArgs).stdout), revised);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
