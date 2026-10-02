'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'obs.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
}

function writeJsonl(dir, events) {
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

// NOTE: this sandbox cannot capture child-process pipes, so the CLI's
// stdout/stderr are redirected to files and read back.
function runCli(args, dir) {
  const outFile = path.join(dir, `stdout-${runCli.n}.txt`);
  const errFile = path.join(dir, `stderr-${runCli.n}.txt`);
  runCli.n += 1;
  const out = fs.openSync(outFile, 'w');
  const err = fs.openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [BIN, ...args], { stdio: ['ignore', out, err] });
  fs.closeSync(out);
  fs.closeSync(err);
  return {
    status: r.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}
runCli.n = 0;

const STREAM = [
  { type: 'plan', target: 'T1', pi: 'alice', duration: 30, value: 10, switch: 5, windows: [[0, 100]], quota: 60, clock: 1, node: 'n1' },
  { type: 'plan', target: 'T2', pi: 'bob', duration: 30, value: 8, switch: 5, windows: [[20, 100]], quota: 40, clock: 1, node: 'n2' },
  { type: 'observe', id: 'o1', target: 'T1', start: 0, end: 30, clock: 2, node: 'n1' },
  { type: 'checkpoint', id: 'cp1', clock: 3, node: 'n1' },
  { type: 'correct', target: 'T2', windows: [[40, 90]], clock: 4, node: 'n2' },
  { type: 'plan', target: 'T3', pi: 'bob', duration: 20, value: 5, switch: 5, windows: [[0, 200]], clock: 5, node: 'n1' },
];

test('acceptance 4: crash after checkpoint recovers an identical certificate', () => {
  const dir = tmpdir();
  const state = path.join(dir, 'state');
  const file = writeJsonl(dir, STREAM);

  const full = runCli(['run', file, '--state', state], dir);
  assert.equal(full.status, 0, full.stderr);
  const fullOut = JSON.parse(full.stdout);
  assert.ok(fullOut.certificate.startsWith('sha256:'));
  assert.ok(fs.existsSync(path.join(state, 'checkpoint-cp1.json')));
  assert.ok(fs.existsSync(path.join(state, 'latest.json')));

  // Simulate crash after the checkpoint: recover from disk, continue the stream.
  const rec = runCli(['recover', '--state', state, '--events', file], dir);
  assert.equal(rec.status, 0, rec.stderr);
  const recOut = JSON.parse(rec.stdout);
  assert.equal(recOut.verified, true);
  assert.equal(recOut.continuedEvents, 2);
  assert.equal(recOut.certificate, fullOut.certificate);

  // Determinism: a fresh full re-run produces the same certificate too.
  const again = runCli(['run', file, '--state', path.join(dir, 'state2')], dir);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).certificate, fullOut.certificate);
});

test('recover without continuation verifies the checkpoint certificate', () => {
  const dir = tmpdir();
  const state = path.join(dir, 'state');
  const file = writeJsonl(dir, STREAM);
  assert.equal(runCli(['run', file, '--state', state], dir).status, 0);
  const rec = runCli(['recover', '--state', state], dir);
  assert.equal(rec.status, 0, rec.stderr);
  const recOut = JSON.parse(rec.stdout);
  assert.equal(recOut.verified, true);
  const cp = JSON.parse(fs.readFileSync(path.join(state, 'checkpoint-cp1.json'), 'utf8'));
  assert.equal(recOut.certificate, cp.certificate);
});

test('exit code 3: overlapping windows', () => {
  const dir = tmpdir();
  const file = writeJsonl(dir, [
    { type: 'plan', target: 'T', duration: 5, windows: [[0, 10], [5, 15]] },
  ]);
  const r = runCli(['run', file, '--state', path.join(dir, 's')], dir);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /overlapping windows/);
});

test('exit code 3: negative duration', () => {
  const dir = tmpdir();
  const file = writeJsonl(dir, [{ type: 'plan', target: 'T', duration: -5, windows: [[0, 10]] }]);
  const r = runCli(['run', file, '--state', path.join(dir, 's')], dir);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /negative duration/);
});

test('exit code 3: revoking an unknown observation', () => {
  const dir = tmpdir();
  const file = writeJsonl(dir, [{ type: 'revoke', id: 'ghost' }]);
  const r = runCli(['run', file, '--state', path.join(dir, 's')], dir);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /unknown observation/);
});

test('cli output contains executable sequence, skip reasons and certificate', () => {
  const dir = tmpdir();
  const file = writeJsonl(dir, [
    { type: 'plan', target: 'T1', pi: 'alice', duration: 30, value: 10, switch: 5, windows: [[0, 40]], quota: 30, clock: 1 },
    { type: 'plan', target: 'T2', pi: 'bob', duration: 30, value: 9, switch: 5, windows: [[0, 40]], quota: 40, clock: 2 },
    { type: 'correct', target: 'T2', cloud: 'unknown', clock: 3 },
  ]);
  const r = runCli(['run', file, '--state', path.join(dir, 's')], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.schedule.map(p => [p.target, p.start, p.end]), [['T1', 0, 30]]);
  assert.deepEqual(out.pending, [{ target: 'T2', reason: 'cloud-unknown' }]);
  assert.deepEqual(out.deficits, { alice: 0, bob: 40 });
  assert.equal(out.value, 10);
  assert.ok(out.certificate.startsWith('sha256:'));
});
