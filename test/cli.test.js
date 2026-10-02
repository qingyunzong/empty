'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'xborder');

// The sandbox drops piped stdio of spawned children, so capture via files.
function run(args, eventsText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xborder-'));
  const patchPath = path.join(dir, 'out.jsonl');
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  const argv = [BIN, ...args.map((a) => (a === '{patch}' ? patchPath : a))];
  if (eventsText !== undefined) {
    const eventsPath = path.join(dir, 'events.jsonl');
    fs.writeFileSync(eventsPath, eventsText);
    argv.splice(1, 0, 'run', eventsPath);
  }
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  const proc = spawnSync(process.execPath, argv, { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: proc.status,
    spawnError: proc.error,
    stdout: fs.readFileSync(stdoutPath, 'utf8'),
    stderr: fs.readFileSync(stderrPath, 'utf8'),
    patch: fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : null,
  };
}

const ACCOUNT = JSON.stringify({
  type: 'account', budget: 100, quoteTtl: 10, worstRate: { USD: 2 }, frozen: {},
});

test('CLI: happy path emits delta patches and exits 0', () => {
  const { status, stderr, patch } = run(['--patch', '{patch}'], [
    ACCOUNT,
    JSON.stringify({ type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: null, ts: 1 }),
    JSON.stringify({ type: 'quote', paymentId: 'p1', rate: 1.5, ts: 2 }),
    JSON.stringify({ type: 'freeze', paymentId: 'p1', ts: 3 }),
    '',
  ].join('\n'));
  assert.equal(status, 0, stderr);
  assert.equal(stderr, '');
  const lines = patch.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [
    { seq: 3, add: ['p1'], remove: [] },
    { seq: 4, add: [], remove: ['p1'] },
  ]);
});

test('CLI: E_BUDGET exits non-zero with JSON stderr', () => {
  const { status, stderr } = run(['--patch', '{patch}'], [
    ACCOUNT,
    JSON.stringify({ type: 'payment', id: 'p1', amount: 200, ccy: 'USD', rate: 1, ts: 1 }),
    JSON.stringify({ type: 'freeze', paymentId: 'p1', ts: 2 }),
    '',
  ].join('\n'));
  assert.notEqual(status, 0);
  const err = JSON.parse(stderr.trim());
  assert.equal(err.code, 'E_BUDGET');
  assert.equal(typeof err.message, 'string');
});

test('CLI: E_RATE_STALE exits non-zero with JSON stderr', () => {
  const { status, stderr } = run(['--patch', '{patch}'], [
    JSON.stringify({ type: 'account', budget: 100, quoteTtl: 5, worstRate: { USD: 2 }, frozen: {} }),
    JSON.stringify({ type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: 1, ts: 1 }),
    JSON.stringify({ type: 'freeze', paymentId: 'p1', ts: 100 }),
    '',
  ].join('\n'));
  assert.notEqual(status, 0);
  const err = JSON.parse(stderr.trim());
  assert.equal(err.code, 'E_RATE_STALE');
});

test('CLI: patches written before a later error are still flushed', () => {
  const { status, patch } = run(['--patch', '{patch}'], [
    ACCOUNT,
    JSON.stringify({ type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: 1, ts: 1 }),
    JSON.stringify({ type: 'freeze', paymentId: 'nope', ts: 2 }),
    '',
  ].join('\n'));
  assert.notEqual(status, 0);
  assert.deepEqual(patch.trim().split('\n').map(JSON.parse), [
    { seq: 2, add: ['p1'], remove: [] },
  ]);
});

test('CLI: usage error exits non-zero', () => {
  const { status, stderr } = run([]);
  assert.notEqual(status, 0);
  assert.match(stderr, /usage: xborder run/);
});
