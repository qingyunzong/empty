import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openSync, closeSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

// NOTE: this sandboxed environment drops pipe data for spawned node children,
// so the tests feed stdin/stdout through temp files instead of pipes.
function runCli(input) {
  const dir = mkdtempSync(join(tmpdir(), 'mvcc-cli-'));
  const inPath = join(dir, 'in.jsonl');
  const outPath = join(dir, 'out.jsonl');
  writeFileSync(inPath, input);
  const inFd = openSync(inPath, 'r');
  const outFd = openSync(outPath, 'w');
  try {
    const r = spawnSync(process.execPath, [CLI], { stdio: [inFd, outFd, 'pipe'] });
    const stdout = readFileSync(outPath, 'utf8');
    return { status: r.status, stdout, stderr: String(r.stderr) };
  } finally {
    closeSync(inFd);
    closeSync(outFd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseLines(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('cli: full session exits 0 and keeps snapshot isolation', () => {
  const input = [
    JSON.stringify({ op: 'insert', eventId: 'A', deviceId: 'd1', validAt: 100, data: { state: 'alarm' } }),
    JSON.stringify({ op: 'snapshot' }),
    JSON.stringify({ op: 'correct', eventId: 'A', data: { state: 'reset' } }),
    JSON.stringify({ op: 'get', eventId: 'A', snapshot: 1 }),
    JSON.stringify({ op: 'get', eventId: 'A' }),
    JSON.stringify({ op: 'range', deviceId: 'd1', from: 0, to: 200 }),
    JSON.stringify({ op: 'range', deviceId: 'd1', from: 200, to: 100 }),
  ].join('\n') + '\n';
  const r = runCli(input);
  assert.equal(r.status, 0, r.stderr);
  const out = parseLines(r.stdout);
  assert.equal(out.length, 7);
  assert.ok(out.every((l) => l.ok));
  assert.equal(out[1].result.snapshot, 1);
  assert.equal(out[3].result.data.state, 'alarm');
  assert.equal(out[4].result.data.state, 'reset');
  assert.equal(out[5].result.length, 1);
  assert.deepEqual(out[6].result, []);
});

test('cli: domain errors (E_DUP / E_NOENT) exit 1', () => {
  const input = [
    JSON.stringify({ op: 'insert', eventId: 'A', deviceId: 'd1', validAt: 1 }),
    JSON.stringify({ op: 'insert', eventId: 'A', deviceId: 'd1', validAt: 2 }),
    JSON.stringify({ op: 'delete', eventId: 'ghost' }),
    JSON.stringify({ op: 'get', eventId: 'A' }),
  ].join('\n') + '\n';
  const r = runCli(input);
  assert.equal(r.status, 1, r.stderr);
  const out = parseLines(r.stdout);
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.equal(out[1].error.code, 'E_DUP');
  assert.equal(out[2].error.code, 'E_NOENT');
  assert.equal(out[3].ok, true);
});

test('cli: malformed JSON and unknown op exit 2', () => {
  const r1 = runCli('this is not json\n');
  assert.equal(r1.status, 2);
  assert.equal(parseLines(r1.stdout)[0].error.code, 'E_PARSE');

  const r2 = runCli(JSON.stringify({ op: 'bogus' }) + '\n');
  assert.equal(r2.status, 2);
  assert.equal(parseLines(r2.stdout)[0].error.code, 'E_USAGE');

  const r3 = runCli(JSON.stringify(['not', 'an', 'object']) + '\n');
  assert.equal(r3.status, 2);
});

test('cli: usage error dominates domain error in exit code', () => {
  const input = [
    JSON.stringify({ op: 'delete', eventId: 'ghost' }),
    'garbage',
  ].join('\n') + '\n';
  assert.equal(runCli(input).status, 2);
});
