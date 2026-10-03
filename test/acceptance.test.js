'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-accept-'));
}

let spawnCount = 0;

function run(args) {
  // The sandbox drops pipe writes from grandchildren, so capture via files.
  spawnCount += 1;
  const outFile = path.join(os.tmpdir(), `cli-out-${process.pid}-${spawnCount}.txt`);
  const errFile = path.join(os.tmpdir(), `cli-err-${process.pid}-${spawnCount}.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.unlinkSync(outFile);
  fs.unlinkSync(errFile);
  if (res.error) throw res.error;
  return { status: res.status, stdout, stderr };
}

function stateOf(file, limit) {
  const args = ['state', file];
  if (limit !== undefined) args.push('--limit', String(limit));
  const res = run(args);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('acceptance 1: crash afterAppend keeps hold; commit works after restart', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'log.jsonl');

  const crash = run(['reserve', file, 'alice', '40', '--event-id', 'e1', '--limit', '100', '--crash', 'afterAppend']);
  assert.equal(crash.status, 42, `expected exit 42, got ${crash.status}: ${crash.stdout}`);
  const crashReport = JSON.parse(crash.stdout);
  assert.equal(crashReport.crashed, 'afterAppend');

  const after = stateOf(file, 100);
  assert.equal(after.recovery.truncated, false);
  assert.equal(after.recovery.validEvents, 1);
  assert.equal(after.state.accounts.alice.held, 40);
  assert.equal(after.state.accounts.alice.available, 60);

  const commit = run(['commit', file, 'alice', '15', '--event-id', 'e2', '--limit', '100']);
  assert.equal(commit.status, 0, commit.stderr);
  const final = stateOf(file, 100);
  assert.equal(final.state.accounts.alice.held, 25);
  assert.equal(final.state.accounts.alice.committed, 15);
  assert.equal(final.state.accounts.alice.available, 60);

  console.log('[acceptance-1] recovery:', JSON.stringify(after.recovery));
  console.log('[acceptance-1] headHash:', final.state.headHash);
});

test('acceptance 2: crash beforeAppend leaves no partial write; duplicate eventId is idempotent', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'log.jsonl');

  const crash = run(['reserve', file, 'bob', '30', '--event-id', 'dup-1', '--limit', '100', '--crash', 'beforeAppend']);
  assert.equal(crash.status, 1, `expected exit 1, got ${crash.status}`);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', '', 'no partial write allowed');

  const first = run(['reserve', file, 'bob', '30', '--event-id', 'dup-1', '--limit', '100']);
  assert.equal(first.status, 0, first.stderr);
  const second = run(['reserve', file, 'bob', '30', '--event-id', 'dup-1', '--limit', '100']);
  assert.equal(second.status, 2, 'duplicate must be rejected as no-op');
  assert.match(second.stdout, /duplicate eventId/);

  const final = stateOf(file, 100);
  assert.equal(final.recovery.validEvents, 1);
  assert.equal(final.state.accounts.bob.held, 30, 'single deduction despite retries');
  assert.equal(final.state.accounts.bob.available, 70);

  console.log('[acceptance-2] recovery:', JSON.stringify(final.recovery));
  console.log('[acceptance-2] headHash:', final.state.headHash);
});

test('acceptance 3: tampered last line is truncated and offset reported', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'log.jsonl');

  assert.equal(run(['reserve', file, 'carol', '10', '--event-id', 't1', '--limit', '100']).status, 0);
  assert.equal(run(['reserve', file, 'carol', '20', '--event-id', 't2', '--limit', '100']).status, 0);

  const before = fs.readFileSync(file);
  const firstNl = before.indexOf(0x0a);
  const lines = before.toString('utf8').split('\n');
  const firstHash = JSON.parse(lines[0]).hash;

  const tampered = Buffer.from(before);
  tampered[tampered.length - 2] = tampered[tampered.length - 2] === 48 ? 49 : 48;
  fs.writeFileSync(file, tampered);

  const res = run(['state', file, '--limit', '100']);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.recovery.truncated, true);
  assert.equal(report.recovery.offset, firstNl + 1, 'truncation at start of corrupted record');
  assert.equal(report.recovery.line, 2);
  assert.equal(report.recovery.validEvents, 1);
  assert.equal(report.recovery.headHash, firstHash);
  assert.equal(report.state.accounts.carol.held, 10);
  assert.equal(fs.readFileSync(file).length, firstNl + 1, 'file physically truncated');

  console.log('[acceptance-3] recovery:', JSON.stringify(report.recovery));
  console.log('[acceptance-3] headHash:', report.state.headHash);
});

test('frozen account rejects new reserve but allows commit/release', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'log.jsonl');
  assert.equal(run(['reserve', file, 'dave', '50', '--event-id', 'f1', '--limit', '100']).status, 0);
  assert.equal(run(['freeze', file, 'dave', '--event-id', 'f2', '--limit', '100']).status, 0);
  const rejected = run(['reserve', file, 'dave', '10', '--event-id', 'f3', '--limit', '100']);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stdout, /account frozen/);
  assert.equal(run(['commit', file, 'dave', '20', '--event-id', 'f4', '--limit', '100']).status, 0);
  assert.equal(run(['release', file, 'dave', '30', '--event-id', 'f5', '--limit', '100']).status, 0);
  const final = stateOf(file, 100);
  assert.equal(final.state.accounts.dave.held, 0);
  assert.equal(final.state.accounts.dave.committed, 20);
  assert.equal(final.state.accounts.dave.available, 80);
  assert.equal(final.state.accounts.dave.frozen, true);
});
