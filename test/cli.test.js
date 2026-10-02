import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../cli.js', import.meta.url).pathname;

// NOTE: this sandbox blocks pipe creation for child processes (spawnSync
// with piped stdio fails with EPERM), so stdout/stderr are captured via
// file descriptors instead.
function runCli(args, dir) {
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  const outFd = openSync(stdoutPath, 'w');
  const errFd = openSync(stderrPath, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', outFd, errFd],
  });
  return {
    status: res.status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

function setup(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'visionline-'));
  const stream = join(dir, 'stream.jsonl');
  writeFileSync(stream, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const out = join(dir, 'out');
  return { dir, stream, out };
}

test('cli run writes state.json, moves.jsonl, errors.jsonl; exit 0 on clean stream', () => {
  const { dir, stream, out } = setup([
    { type: 'inspect', id: 'a' },
    { type: 'reject', id: 'a' },
    { type: 'rework_start', id: 'a' },
    { type: 'rework_done', id: 'a' },
  ]);
  const res = runCli(['run', '--stream', stream, '--out', out], dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /good=1 defective=0 rework=0 pending=0/);
  const state = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8'));
  assert.deepEqual(state, { good: 1, defective: 0, rework: 0, pending: 0 });
  const moves = readFileSync(join(out, 'moves.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(moves.map((m) => m.kind), ['reject', 'rework_start', 'rework_done']);
  assert.equal(readFileSync(join(out, 'errors.jsonl'), 'utf8'), '');
});

test('cli exits 2 on stream errors but still writes all outputs', () => {
  const { dir, stream, out } = setup([
    { type: 'reject', id: 'ghost' },
    { type: 'inspect', id: 'a' },
    { type: 'accept', id: 'a' },
  ]);
  const res = runCli(['run', '--stream', stream, '--out', out], dir);
  assert.equal(res.status, 2);
  const errors = readFileSync(join(out, 'errors.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'orphan_reject');
  const state = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8'));
  assert.deepEqual(state, { good: 1, defective: 0, rework: 0, pending: 0 });
});

test('cli exits 1 on bad usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visionline-'));
  const res = runCli([], dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage:/);
});
