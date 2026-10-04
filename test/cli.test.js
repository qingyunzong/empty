'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chainFrames, encodeFrame } = require('./helpers');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'at-cli-'));
}

let outCounter = 0;
// This sandbox does not deliver grandchild stdout over pipes, so the child's
// stdout is redirected to a file and read back.
function run(args, dir, extraEnv = {}) {
  const outPath = path.join(dir, '.stdout-' + ++outCounter);
  const errPath = path.join(dir, '.stderr-' + outCounter);
  const fd = fs.openSync(outPath, 'w');
  const efd = fs.openSync(errPath, 'w');
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, AT_DIR: dir, ...extraEnv },
    stdio: ['ignore', fd, efd],
    encoding: 'utf8',
  });
  fs.closeSync(fd);
  fs.closeSync(efd);
  proc.stdout = fs.readFileSync(outPath, 'utf8');
  proc.stderr = fs.readFileSync(errPath, 'utf8');
  return proc;
}

function writeFrames(dir, frames) {
  const p = path.join(dir, 'frames.bin');
  fs.writeFileSync(p, Buffer.concat(frames.map(encodeFrame)));
  return p;
}

test('end-to-end: run then verify checkpoint', () => {
  const dir = tmpdir();
  const frames = chainFrames([
    { args: { key: 'a', value: 1 } },
    { args: { key: 'b', value: 2 } },
    { args: { key: 'c', value: 3 } },
  ]);
  const bin = writeFrames(dir, frames);
  const proc = run([bin], dir);
  assert.equal(proc.status, 0, proc.stderr);
  const events = proc.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.slice(0, 3).map((e) => e.status), ['applied', 'applied', 'applied']);
  const summary = events[events.length - 1];
  assert.equal(summary.count, 3);
  assert.match(summary.root, /^[0-9a-f]{64}$/);
  const verify = run(['verify', summary.checkpoint], dir);
  assert.equal(verify.status, 0, verify.stdout);
  const res = JSON.parse(verify.stdout);
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  assert.equal(res.root, summary.root);
});

test('duplicate frame in the stream is reported once as applied, once as duplicate', () => {
  const dir = tmpdir();
  const [f] = chainFrames([{ args: { key: 'a', value: 1 } }]);
  const bin = writeFrames(dir, [f, f]);
  const proc = run([bin], dir);
  assert.equal(proc.status, 0, proc.stderr);
  const events = proc.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events[0].status, 'applied');
  assert.equal(events[1].status, 'duplicate');
  assert.equal(events[2].count, 1);
});

test('exit 3 on expired lease, evidence preserved', () => {
  const dir = tmpdir();
  const frames = chainFrames([
    { args: { key: 'a', value: 1 } },
    { args: { key: 'b', value: 2 } },
    { args: { key: 'c', value: 3 }, leaseUntil: 0 },
  ]);
  const bin = writeFrames(dir, frames);
  const proc = run([bin], dir);
  assert.equal(proc.status, 3, proc.stderr);
  const events = proc.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events[2].status, 'rejected');
  assert.equal(events[2].reason, 'lease_expired');
  const evidence = fs.readFileSync(path.join(dir, 'evidence.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].reason, 'lease_expired');
});

test('exit 2 on corrupted frame', () => {
  const dir = tmpdir();
  const frames = chainFrames([{ args: { key: 'a', value: 1 } }]);
  const bin = writeFrames(dir, frames);
  const buf = fs.readFileSync(bin);
  buf[buf.length - 3] ^= 0xff;
  fs.writeFileSync(bin, buf);
  const proc = run([bin], dir);
  assert.equal(proc.status, 2, proc.stderr);
  assert.match(proc.stderr, /bad_crc/);
});

test('exit 5 on chain break, for both run and verify', () => {
  const dir = tmpdir();
  const frames = chainFrames([{ args: { key: 'a', value: 1 } }, { args: { key: 'b', value: 2 } }]);
  const bin = writeFrames(dir, frames);
  assert.equal(run([bin], dir).status, 0);
  // Tamper with the first log entry without fixing up its hash.
  const logPath = path.join(dir, 'audit.log');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[0]);
  entry.args.value = 999;
  lines[0] = JSON.stringify(entry);
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  const rerun = run([bin], dir);
  assert.equal(rerun.status, 5, rerun.stderr);
  assert.match(rerun.stderr, /hash_mismatch|chain_break/);
  const verify = run(['verify', path.join(dir, 'checkpoint.json')], dir);
  assert.equal(verify.status, 5, verify.stdout);
  assert.equal(JSON.parse(verify.stdout).ok, false);
});

test('verify rejects a tampered checkpoint with exit 1', () => {
  const dir = tmpdir();
  const frames = chainFrames([{ args: { key: 'a', value: 1 } }]);
  const bin = writeFrames(dir, frames);
  assert.equal(run([bin], dir).status, 0);
  const cpPath = path.join(dir, 'checkpoint.json');
  const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
  cp.root = '0'.repeat(64);
  fs.writeFileSync(cpPath, JSON.stringify(cp));
  const verify = run(['verify', cpPath], dir);
  assert.equal(verify.status, 1, verify.stdout);
  const res = JSON.parse(verify.stdout);
  assert.equal(res.ok, false);
  assert.ok(res.problems.includes('root_mismatch'));
});

test('checkpoint is signed periodically during the run', () => {
  const dir = tmpdir();
  const frames = chainFrames(Array.from({ length: 9 }, (_, i) => ({ args: { key: 'k' + i, value: i } })));
  const bin = writeFrames(dir, frames);
  const proc = run([bin], dir, { AT_CHECKPOINT_EVERY: '4' });
  assert.equal(proc.status, 0, proc.stderr);
  const cp = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
  assert.equal(cp.count, 9); // final checkpoint always written
  assert.match(cp.sig, /^[0-9a-f]{64}$/);
});
