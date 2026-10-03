'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli');

const EXAMPLES = path.join(__dirname, '..', 'examples');
const KEY = 'cli-key';

// Invoke the CLI in-process, capturing output and the exit code.
function runCli(args, stdin) {
  const out = { stdout: '', stderr: '' };
  const exitCode = run(args, {
    stdout: (text) => { out.stdout += text; },
    stderr: (text) => { out.stderr += text; },
    stdin,
  });
  return { exitCode, ...out };
}

test('cli run: chain example prints JSON verdict and exits 0', () => {
  const res = runCli(['run', path.join(EXAMPLES, 'chain.txt'), '--key', KEY]);
  assert.equal(res.exitCode, 0, res.stderr);
  const verdict = JSON.parse(res.stdout);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.claims.C3.dependencies, ['E1', 'E2', 'E3']);
  assert.equal(verdict.commits.length, 8);
  for (const commit of verdict.commits) {
    assert.match(commit.cert, /^[0-9a-f]{64}$/);
    assert.match(commit.scopeHash, /^[0-9a-f]{64}$/);
  }
});

test('cli run: revoke example reports invalid downstream claims', () => {
  const res = runCli(['run', path.join(EXAMPLES, 'revoke.txt'), '--key', KEY]);
  assert.equal(res.exitCode, 0, res.stderr);
  const verdict = JSON.parse(res.stdout);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.claims.C2.valid, false);
  assert.equal(verdict.claims.C3.valid, false);
  assert.equal(verdict.claims.IND.valid, true);
});

test('cli run -> verify roundtrip accepts the ledger', () => {
  const built = runCli(['run', path.join(EXAMPLES, 'chain.txt'), '--key', KEY]);
  assert.equal(built.exitCode, 0, built.stderr);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(tmp, 'ledger.json');
  fs.writeFileSync(file, built.stdout);
  const res = runCli(['verify', file, '--key', KEY]);
  assert.equal(res.exitCode, 0, res.stderr);
  const verdict = JSON.parse(res.stdout);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.claims.C3.dependencies, ['E1', 'E2', 'E3']);
});

test('acceptance 3a: alias escaping its scope is rejected with exit code 1', () => {
  const res = runCli(['run', path.join(EXAMPLES, 'alias-scope.txt'), '--key', KEY]);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /unknown identifier "X"/);
  assert.equal(res.stdout, '');
});

test('acceptance 3b: tampered signature is rejected with exit code 1', () => {
  const built = runCli(['run', path.join(EXAMPLES, 'chain.txt'), '--key', KEY]);
  assert.equal(built.exitCode, 0, built.stderr);
  const ledger = JSON.parse(built.stdout);
  const c = ledger.commits[2];
  c.cert = (c.cert[0] === 'a' ? 'b' : 'a') + c.cert.slice(1);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(tmp, 'tampered.json');
  fs.writeFileSync(file, JSON.stringify(ledger));
  const res = runCli(['verify', file, '--key', KEY]);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /signature mismatch/);
});

test('cli rejects wrong key, bad usage and type errors with exit code 1', () => {
  const built = runCli(['run', path.join(EXAMPLES, 'chain.txt'), '--key', KEY]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(tmp, 'ledger.json');
  fs.writeFileSync(file, built.stdout);

  const wrongKey = runCli(['verify', file, '--key', 'nope']);
  assert.equal(wrongKey.exitCode, 1);
  assert.match(wrongKey.stderr, /signature mismatch/);

  const noArgs = runCli([]);
  assert.equal(noArgs.exitCode, 1);
  assert.match(noArgs.stderr, /usage:/);

  const badType = runCli(['run', '-', '--key', KEY], 'evidence E1\nrule R1\nclaim C = E1 & R1\n');
  assert.equal(badType.exitCode, 1);
  assert.match(badType.stderr, /cannot combine rules/);
});
