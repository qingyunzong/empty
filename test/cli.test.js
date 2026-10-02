import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

const mkDir = () => mkdtempSync(join(tmpdir(), 'satsched-cli-'));

// Runs the CLI in-process (the sandbox forbids spawning), capturing output.
function run(args) {
  const out = [];
  const err = [];
  const status = runCli(args, {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  return { status, stdout: out.join('\n') + (out.length ? '\n' : ''), stderr: err.join('\n') };
}

const passArgs = (dir, id, task, s, e, extra = []) => [
  '--dir', dir, 'pass', '--id', id, '--task', task, '--start', String(s), '--end', String(e),
  '--elevation', '10', '--rate', '10', '--onboard', '5000', ...extra,
];

test('end-to-end: pass -> schedule -> drop -> verify', () => {
  const dir = mkDir();
  let r = run(passArgs(dir, 'P1', 'T1', 0, 100, ['--quota', '100000']));
  assert.equal(r.status, 0, r.stderr);
  r = run(passArgs(dir, 'P2', 'T2', 200, 260, ['--min-guarantee', '500']));
  assert.equal(r.status, 0, r.stderr);

  r = run(['--dir', dir, 'schedule']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0\t100\tDOWNLINK\tP1\tT1\t1000/);
  assert.match(r.stdout, /CERTIFICATE\tseq=3\thead=[0-9a-f]{64}/);

  r = run(['--dir', dir, 'schedule', '--seconds']);
  assert.match(r.stdout, /^0\tDOWNLINK P1 T1$/m);
  assert.match(r.stdout, /^150\tIDLE$/m);

  r = run(['--dir', dir, 'drop']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /TOTALS\tserved=1600/);

  r = run(['--dir', dir, 'verify']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK\tseq=3\thead=[0-9a-f]{64}\tstate=[0-9a-f]{64}/);
});

test('correct + confirm flow via CLI', () => {
  const dir = mkDir();
  run(passArgs(dir, 'P1', 'T1', 0, 100));
  let r = run(['--dir', dir, 'correct', '--pass', 'P1', '--start', '0', '--end', '40', '--pending']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--dir', dir, 'drop']);
  assert.match(r.stdout, /pending=600/);
  assert.match(r.stdout, /failed=0/);
  r = run(['--dir', dir, 'correct', '--pass', 'P1', '--confirm']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--dir', dir, 'drop']);
  assert.match(r.stdout, /weather=600/);
  assert.match(r.stdout, /failed=600/);
});

test('exit 9: negative elevation, overspeed rate, undo of confirmed bytes', () => {
  const dir = mkDir();
  let r = run(['--dir', dir, 'pass', '--id', 'PB', '--task', 'T', '--start', '0', '--end', '100',
    '--elevation', '-5', '--rate', '10', '--onboard', '100']);
  assert.equal(r.status, 9, `expected 9, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /elevation/);

  r = run(['--dir', dir, 'pass', '--id', 'PB', '--task', 'T', '--start', '0', '--end', '100',
    '--elevation', '5', '--rate', '2000000', '--onboard', '100']);
  assert.equal(r.status, 9, `expected 9, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /link max/);

  run(passArgs(dir, 'P1', 'T1', 0, 50));
  run(passArgs(dir, 'P2', 'T2', 50, 100));
  r = run(['--dir', dir, 'correct', '--pass', 'P2', '--start', '50', '--end', '100', '--at', '60']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--dir', dir, 'undo', '--steps', '1']);
  assert.equal(r.status, 9, `expected 9, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /confirmed bytes/);
});

test('undo via CLI: multi-level and to-pass boundary', () => {
  const dir = mkDir();
  for (const [id, s, e] of [['P1', 0, 100], ['P2', 200, 300], ['P3', 400, 500]]) {
    run(passArgs(dir, id, `T${id}`, s, e));
  }
  let r = run(['--dir', dir, 'undo', '--steps', '2']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed=3,4/);
  r = run(['--dir', dir, 'undo', '--to-pass', 'P1']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--dir', dir, 'verify']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--dir', dir, 'schedule']);
  assert.match(r.stdout, /CERTIFICATE/);
});

test('acceptance 4 via CLI: verify rejects half-written journal, recovers', () => {
  const dir = mkDir();
  run(passArgs(dir, 'P1', 'T1', 0, 100));
  appendFileSync(join(dir, 'journal.log'), '{"seq":3,"op":"pass","payload":{"pass":{"id":"P2"');
  let r = run(['--dir', dir, 'verify']);
  assert.equal(r.status, 8, `expected 8, got ${r.status}`);
  assert.match(r.stderr, /INVALID/);
  r = run(['--dir', dir, 'verify', '--recover']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RECOVERED\tremoved=1/);
  r = run(['--dir', dir, 'verify']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK\tseq=2/);
});

test('usage errors exit 2', () => {
  const dir = mkDir();
  assert.equal(run(['--dir', dir]).status, 2);
  assert.equal(run(['--dir', dir, 'bogus']).status, 2);
  assert.equal(run(['--dir', dir, 'pass', '--id', 'P1']).status, 2);
});
