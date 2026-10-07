import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, openSync, closeSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// The sandboxed environment blocks piped stdio for spawned processes, so the
// child's stdin/stdout are wired through temporary files instead.
function runCli({ input, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'clearing-cli-'));
  const stdinFile = join(dir, 'stdin.json');
  const stdoutFile = join(dir, 'stdout.txt');
  const stderrFile = join(dir, 'stderr.txt');
  writeFileSync(stdinFile, typeof input === 'string' ? input : JSON.stringify(input));
  const inFd = openSync(stdinFile, 'r');
  const outFd = openSync(stdoutFile, 'w');
  const errFd = openSync(stderrFile, 'w');
  const result = spawnSync(process.execPath, [CLI, ...args], {
    stdio: [inFd, outFd, errFd],
  });
  closeSync(inFd);
  closeSync(outFd);
  closeSync(errFd);
  return {
    code: result.status,
    stdout: readFileSync(stdoutFile, 'utf8'),
    stderr: readFileSync(stderrFile, 'utf8'),
  };
}

test('reads a job from stdin and prints schedule/certificates/errors', () => {
  const { code, stdout } = runCli({
    input: {
      config: { slots: 2, capacity: 1 },
      instructions: [
        { id: 'a', institution: 'A', amount: 5, priority: 2, deadline: 2 },
        { id: 'b', institution: 'B', amount: 7, priority: 1, deadline: 2 },
      ],
    },
  });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.deepEqual(
    report.schedule.map((s) => [s.id, s.slot]),
    [['a', 1], ['b', 2]],
  );
  assert.ok(Array.isArray(report.certificates));
  assert.deepEqual(report.errors, []);
});

test('capacity conflict exits with code 2 and CAPACITY error', () => {
  const { code, stdout } = runCli({
    input: {
      config: { slots: 1, capacity: 1 },
      instructions: [
        { id: 'a', institution: 'A', amount: 5, priority: 2, deadline: 1 },
        { id: 'b', institution: 'B', amount: 7, priority: 1, deadline: 1 },
      ],
    },
  });
  assert.equal(code, 2);
  const report = JSON.parse(stdout);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].code, 'CAPACITY');
  assert.equal(report.errors[0].id, 'b');
});

test('reads a job from a JSON file argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clearing-'));
  const file = join(dir, 'job.json');
  writeFileSync(file, JSON.stringify({
    config: { slots: 1, capacity: 1 },
    instructions: [{ id: 'only', institution: 'A', amount: 1, priority: 1, deadline: 1 }],
  }));
  const { code, stdout } = runCli({ input: '', args: [file] });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.deepEqual(report.schedule.map((s) => s.id), ['only']);
});

test('invalid JSON exits with code 2 and INVALID_INPUT', () => {
  const { code, stdout } = runCli({ input: '{not json' });
  assert.equal(code, 2);
  const report = JSON.parse(stdout);
  assert.equal(report.errors[0].code, 'INVALID_INPUT');
});

test('stale undo via CLI payload exits with code 2 and STALE_UNDO', () => {
  const { code, stdout } = runCli({
    input: {
      config: { slots: 1, capacity: 1 },
      instructions: [{ id: 'x', institution: 'A', amount: 1, priority: 1, deadline: 1 }],
      undo: [{ id: 'x', expectedVersion: 999 }],
    },
  });
  assert.equal(code, 2);
  const report = JSON.parse(stdout);
  assert.equal(report.errors[0].code, 'STALE_UNDO');
});

test('undo via CLI payload applies incremental repair', () => {
  const { code, stdout } = runCli({
    input: {
      config: { slots: 1, capacity: 1 },
      instructions: [{ id: 'x', institution: 'A', amount: 1, priority: 1, deadline: 1 }],
      undo: [{ id: 'x', expectedVersion: 1 }],
    },
  });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.schedule.length, 0);
  assert.equal(report.certificates.at(-1).type, 'UNDO');
});

test('CLI output is deterministic for identical input', () => {
  const job = {
    config: { slots: 2, capacity: 1, quotas: { A: 1 } },
    instructions: [
      { id: 'a1', institution: 'A', amount: 5, priority: 3, deadline: 2 },
      { id: 'a2', institution: 'A', amount: 9, priority: 3, deadline: 2 },
      { id: 'b1', institution: 'B', amount: 4, priority: 2, deadline: 2 },
    ],
  };
  const first = runCli({ input: job });
  const second = runCli({ input: job });
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.code, second.code);
});
