import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';

const example = (name) => fileURLToPath(new URL(`../examples/${name}`, import.meta.url));

// Drives the CLI entry point in-process, capturing what it would print.
function runCli(args) {
  const out = [];
  const err = [];
  const status = run(args, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('explore of the safe plan exits 0 with a certificate', () => {
  const { status, stdout } = runCli(['explore', example('safe.json')]);
  assert.equal(status, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.violating, 0);
  assert.equal(result.counterexample, null);
  assert.equal(result.certificate.type, 'SAFE_CERTIFICATE');
  assert.match(result.certificate.finalStateHash, /^[0-9a-f]{64}$/);
});

test('explore of the racy plan exits 0 with the minimal counterexample', () => {
  const { status, stdout } = runCli(['explore', example('racy.json')]);
  assert.equal(status, 0);
  const result = JSON.parse(stdout);
  assert.ok(result.violating > 0);
  assert.equal(result.certificate, null);
  assert.deepEqual(result.counterexample.sequence, ['r1', 'r2']);
});

test('invalid plans exit 1 with {"error":"INVALID_PLAN"}', () => {
  const files = [
    'invalid/duplicate-id.json',
    'invalid/unknown-transfer.json',
    'invalid/negative-amount.json',
    'invalid/cancel-before-commit.json',
  ];
  for (const file of files) {
    const { status, stdout } = runCli(['explore', example(file)]);
    assert.equal(status, 1, file);
    assert.deepEqual(JSON.parse(stdout), { error: 'INVALID_PLAN' }, file);
  }
});

test('a missing plan file exits 1 with {"error":"INVALID_PLAN"}', () => {
  const { status, stdout } = runCli(['explore', example('does-not-exist.json')]);
  assert.equal(status, 1);
  assert.deepEqual(JSON.parse(stdout), { error: 'INVALID_PLAN' });
});

test('bad usage exits 2', () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['explore']).status, 2);
  assert.equal(runCli(['bogus', example('safe.json')]).status, 2);
});
