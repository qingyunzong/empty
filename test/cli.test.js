import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../cli.js', import.meta.url).pathname;

function runCli(args) {
  const dir = mkdtempSync(join(tmpdir(), 'payfuzz-io-'));
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  const outFd = openSync(stdoutPath, 'w');
  const errFd = openSync(stderrPath, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: res.status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'payfuzz-'));
}

test('fuzz then replay succeeds with identical hashes and byte-identical rerun', () => {
  const dir = tmp();
  const outA = join(dir, 'run-a.json');
  const outB = join(dir, 'run-b.json');

  const fuzzA = runCli(['fuzz', '--seed', '42', '--steps', '80', '--accounts', '3', '--out', outA]);
  assert.equal(fuzzA.status, 0, fuzzA.stderr);
  const hashA = /finalStateHash=([0-9a-f]{64})/.exec(fuzzA.stdout)[1];
  const sampleHashA = /sampleHash=([0-9a-f]{64})/.exec(fuzzA.stdout)[1];

  const fuzzB = runCli(['fuzz', '--seed', '42', '--steps', '80', '--accounts', '3', '--out', outB]);
  assert.equal(fuzzB.status, 0, fuzzB.stderr);
  const bytesA = readFileSync(outA);
  const bytesB = readFileSync(outB);
  assert.ok(bytesA.equals(bytesB), 'same seed must produce byte-identical run files');

  const replay = runCli(['replay', outA]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /REPLAY_OK/);
  const hashReplay = /finalStateHash=([0-9a-f]{64})/.exec(replay.stdout)[1];
  const sampleHashReplay = /sampleHash=([0-9a-f]{64})/.exec(replay.stdout)[1];
  assert.equal(hashReplay, hashA);
  assert.equal(sampleHashReplay, sampleHashA);

  console.log(`cliFuzzExit=${fuzzA.status} cliReplayExit=${replay.status}`);
  console.log(`cliFinalStateHash=${hashA}`);
  console.log(`cliSampleHash=${sampleHashA}`);
  console.log(`replayDiff=0 (byte-identical rerun, replay hash match)`);
});

test('invalid seed is rejected with exit 1 and INVALID_INPUT', () => {
  const dir = tmp();
  for (const bad of ['abc', '-1', '1.5', '4294967296']) {
    const res = runCli(['fuzz', '--seed', bad, '--steps', '5', '--accounts', '2', '--out', join(dir, 'x.json')]);
    assert.equal(res.status, 1, `seed=${bad}`);
    assert.match(res.stderr, /INVALID_INPUT/, `seed=${bad}`);
  }
  console.log('invalidSeedExit=1 code=INVALID_INPUT');
});

test('negative steps rejected with exit 1 and INVALID_INPUT', () => {
  const dir = tmp();
  const res = runCli(['fuzz', '--seed', '42', '--steps', '-5', '--accounts', '2', '--out', join(dir, 'x.json')]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /INVALID_INPUT/);
  console.log('negativeStepsExit=1 code=INVALID_INPUT');
});

test('unknown op in replay file rejected with exit 1 and INVALID_INPUT', () => {
  const dir = tmp();
  const out = join(dir, 'run.json');
  const fuzz = runCli(['fuzz', '--seed', '42', '--steps', '10', '--accounts', '2', '--out', out]);
  assert.equal(fuzz.status, 0, fuzz.stderr);
  const run = JSON.parse(readFileSync(out, 'utf8'));
  run.ops[0].type = 'explode';
  const tampered = join(dir, 'tampered.json');
  writeFileSync(tampered, JSON.stringify(run));
  const res = runCli(['replay', tampered]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /INVALID_INPUT/);
  assert.match(res.stderr, /unknown op type/);
  console.log('unknownOpExit=1 code=INVALID_INPUT');
});

test('unknown command rejected with exit 1 and INVALID_INPUT', () => {
  const res = runCli(['frobnicate']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /INVALID_INPUT/);
});

test('replay of tampered run file exits 1 with REPLAY_MISMATCH', () => {
  const dir = tmp();
  const out = join(dir, 'run.json');
  runCli(['fuzz', '--seed', '42', '--steps', '10', '--accounts', '2', '--out', out]);
  const run = JSON.parse(readFileSync(out, 'utf8'));
  run.finalStateHash = '0'.repeat(64);
  const tampered = join(dir, 'tampered.json');
  writeFileSync(tampered, JSON.stringify(run));
  const res = runCli(['replay', tampered]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /REPLAY_MISMATCH/);
});
