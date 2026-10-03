'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve('cli.js');

// NB: this sandbox cannot capture child stdout via pipes, so redirect to files.
function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g17-run-'));
  const outFile = path.join(dir, 'out.txt');
  const errFile = path.join(dir, 'err.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: res.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function tmpLog(events) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g17-cli-')), 'events.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const LOG = [
  { type: 'sale', id: 's1', account: 'A', amount: 10 },
  { type: 'refund', id: 'r1', ref: 's1', amount: 4 },
];

test('cli project prints balance and frozen per account', () => {
  const res = run(['project', '--log', tmpLog(LOG)]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.accounts.A, { balance: 6, frozen: 6 });
  assert.equal(out.seq, 2);
});

test('cli guard validates without applying; exit code reflects result', () => {
  const log = tmpLog(LOG);
  const good = run(['guard', '--log', log, '--event', JSON.stringify({ type: 'refund', id: 'r2', ref: 's1', amount: 2 })]);
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).ok, true);

  const dangling = run(['guard', '--log', log, '--event', JSON.stringify({ type: 'refund', id: 'r3', ref: 'ghost', amount: 1 })]);
  assert.equal(dangling.status, 1);
  assert.equal(JSON.parse(dangling.stdout).code, 30);

  const dup = run(['guard', '--log', log, '--event', JSON.stringify({ type: 'refund', id: 'r4', ref: 's1', amount: 9 })]);
  assert.equal(JSON.parse(dup.stdout).code, 31);

  // guard without --apply must not modify the log
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
});

test('cli guard --apply appends valid events and rejects invalid ones', () => {
  const log = tmpLog(LOG);
  const ok = run(['guard', '--log', log, '--event', JSON.stringify({ type: 'refund', id: 'r2', ref: 's1', amount: 2 }), '--apply']);
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).ok, true);

  const bad = run(['guard', '--log', log, '--event', JSON.stringify({ type: 'unfreeze', account: 'A', amount: 99 }), '--apply']);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).code, 32);

  const after = run(['project', '--log', log]);
  assert.deepEqual(JSON.parse(after.stdout).accounts.A, { balance: 4, frozen: 4 });
});

test('cli cert prints per-account hashes and overall hash; --out writes a file', () => {
  const log = tmpLog(LOG);
  const outFile = path.join(path.dirname(log), 'cert.json');
  const res = run(['cert', '--log', log, '--out', outFile]);
  assert.equal(res.status, 0, res.stderr);
  const c = JSON.parse(res.stdout);
  assert.equal(c.seq, 2);
  assert.match(c.accounts.A.hash, /^[0-9a-f]{64}$/);
  assert.match(c.overall, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(outFile, 'utf8')), c);

  // deterministic across runs
  const again = run(['cert', '--log', log]);
  assert.equal(JSON.parse(again.stdout).overall, c.overall);
});
