import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, readFileSync, closeSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// Note: this sandbox swallows grandchild output written to pipes, so both
// stdout and stderr are redirected to temp files and read back after exit.
function runCli(args) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'lin-check-'));
    const outFile = join(dir, 'stdout.txt');
    const errFile = join(dir, 'stderr.txt');
    const outFd = openSync(outFile, 'w');
    const errFd = openSync(errFile, 'w');
    const child = spawn('node', [cli, ...args], { stdio: ['ignore', outFd, errFd] });
    child.on('error', reject);
    child.on('exit', (code) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({
        code,
        stdout: readFileSync(outFile, 'utf8'),
        stderr: readFileSync(errFile, 'utf8'),
      });
    });
  });
}

test('check: linearizable history exits 0 with a witness', async () => {
  const { code, stdout } = await runCli([
    'check',
    fixture('overlapping-read.json'),
    '--initial',
    'alice=1000',
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.linearizable, true);
  assert.deepEqual(result.witness, ['read-old', 'res1', 'read-new']);
  assert.equal(result.linearizationPoints.length, 3);
});

test('check: non-linearizable but well-formed history exits 0 with linearizable:false', async () => {
  const { code, stdout } = await runCli([
    'check',
    fixture('cancel-then-commit.json'),
    '--initial',
    'alice=1000',
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.linearizable, false);
  assert.match(result.conflict, /com1/);
});

test('check: negative amount exits 1 with INVALID_HISTORY', async () => {
  const { code, stderr } = await runCli(['check', fixture('invalid-negative-amount.json')]);
  assert.equal(code, 1);
  const error = JSON.parse(stderr);
  assert.equal(error.error, 'INVALID_HISTORY');
  assert.match(error.message, /negative amount/);
});

test('check: inverted times exit 1 with INVALID_HISTORY', async () => {
  const { code, stderr } = await runCli(['check', fixture('invalid-time-inversion.json')]);
  assert.equal(code, 1);
  assert.match(JSON.parse(stderr).message, /inverted interval/);
});

test('check: duplicate opIds exit 1 with INVALID_HISTORY', async () => {
  const { code, stderr } = await runCli(['check', fixture('duplicate-opid.json')]);
  assert.equal(code, 1);
  assert.match(JSON.parse(stderr).message, /duplicate opId/);
});

test('check: malformed JSON exits 1 with INVALID_HISTORY', async () => {
  const { code, stderr } = await runCli(['check', fileURLToPath(new URL('./cli.test.js', import.meta.url))]);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr).error, 'INVALID_HISTORY');
});

test('check: missing file exits 1 with INVALID_HISTORY', async () => {
  const { code, stderr } = await runCli(['check', 'does-not-exist.json']);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr).error, 'INVALID_HISTORY');
});

test('usage errors exit 2', async () => {
  assert.equal((await runCli([])).code, 2);
  assert.equal((await runCli(['check'])).code, 2);
  assert.equal((await runCli(['bogus', 'x.json'])).code, 2);
});
