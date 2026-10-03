'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const ledger = require('../lib/ledger');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}
function paths(dir) {
  const log = path.join(dir, 'ledger.log');
  return { log, idx: log + '.idx', key: log + '.key' };
}
function runCli(argv) {
  return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
}

const T0 = 1_700_000_000_000;

test('append and verify a clean chain', () => {
  const dir = tmpdir();
  const { log, idx, key } = paths(dir);
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 100, bizKey: 'k1' }, { logTime: T0, businessTime: T0 });
  ledger.appendEntry(log, idx, key, { type: 'debit', account: 'a', amount: 30, bizKey: 'k2' }, { logTime: T0 + 1, businessTime: T0 + 1 });
  const res = ledger.verify(log, key);
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
});

test('correction must point to an existing entry with same bizKey', () => {
  const dir = tmpdir();
  const { log, idx, key } = paths(dir);
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 100, bizKey: 'k1' }, { logTime: T0, businessTime: T0 });
  assert.throws(() => ledger.appendEntry(log, idx, key,
    { type: 'credit', account: 'a', amount: 50, bizKey: 'k1' },
    { logTime: T0 + 1, businessTime: T0 + 1, supersedes: 9 }), /existing entry/);
  assert.throws(() => ledger.appendEntry(log, idx, key,
    { type: 'credit', account: 'a', amount: 50, bizKey: 'other' },
    { logTime: T0 + 1, businessTime: T0 + 1, supersedes: 0 }), /bizKey mismatch/);
});

test('latest businessTime wins among multiple corrections', () => {
  const dir = tmpdir();
  const { log, idx, key } = paths(dir);
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 100, bizKey: 'k1' }, { logTime: T0, businessTime: T0 });
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 200, bizKey: 'k1' }, { logTime: T0 + 1, businessTime: T0 + 5, supersedes: 0 });
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 150, bizKey: 'k1' }, { logTime: T0 + 2, businessTime: T0 + 3, supersedes: 0 });
  const view = ledger.buildView(log);
  assert.equal(view.accounts.a, 200); // businessTime T0+5 wins over T0+3
  assert.equal(view.conflicts.length, 0);
});

test('concurrent corrections on same business key keep conflict certificate', () => {
  const dir = tmpdir();
  const { log, idx, key } = paths(dir);
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 100, bizKey: 'k1' }, { logTime: T0, businessTime: T0 });
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 200, bizKey: 'k1' }, { logTime: T0 + 1, businessTime: T0 + 9, supersedes: 0 });
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 300, bizKey: 'k1' }, { logTime: T0 + 2, businessTime: T0 + 9, supersedes: 0 });
  const view = ledger.buildView(log);
  assert.equal(view.conflicts.length, 1);
  const cert = view.conflicts[0];
  assert.equal(cert.bizKey, 'k1');
  assert.equal(cert.candidates.length, 2);
  assert.deepEqual(cert.candidates.map((c) => c.seq).sort(), [1, 2]);
  assert.equal(view.accounts.a, undefined); // excluded pending resolution
});

test('tombstone deletes on-chain entry from view', () => {
  const dir = tmpdir();
  const { log, idx, key } = paths(dir);
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 100, bizKey: 'k1' }, { logTime: T0, businessTime: T0 });
  ledger.appendEntry(log, idx, key, { type: 'tombstone', account: 'a', bizKey: 'k1' }, { logTime: T0 + 1, businessTime: T0 + 1, supersedes: 0 });
  const view = ledger.buildView(log);
  assert.equal(view.accounts.a, undefined);
  assert.equal(view.keys.k1.status, 'void');
  // cannot supersede a tombstone
  assert.throws(() => ledger.appendEntry(log, idx, key,
    { type: 'credit', account: 'a', amount: 1, bizKey: 'k1' },
    { logTime: T0 + 2, businessTime: T0 + 2, supersedes: 1 }), /tombstone/);
});

test('tampered middle byte: verify exits 4 and reports offset', () => {
  const dir = tmpdir();
  const { log, idx, key } = paths(dir);
  for (let i = 0; i < 10; i++) {
    ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: i + 1, bizKey: 'k' + i }, { logTime: T0 + i, businessTime: T0 + i });
  }
  const offsets = ledger.readLog(log).map((e) => e.offset);
  const target = 5;
  const buf = fs.readFileSync(log);
  const pos = offsets[target] + 20; // middle of entry 5
  buf[pos] = buf[pos] === 0x30 ? 0x31 : 0x30;
  fs.writeFileSync(log, buf);
  const res = runCli(['verify', '--log', log]);
  assert.equal(res.status, 4, res.stdout + res.stderr);
  assert.match(res.stdout, new RegExp(`FAIL entry ${target} offset ${offsets[target]}`));
  // log is not truncated
  assert.equal(ledger.readLog(log).length, 10);
});

test('time window violation is rejected', () => {
  const dir = tmpdir();
  const { log, idx, key } = paths(dir);
  assert.throws(() => ledger.appendEntry(log, idx, key,
    { type: 'credit', account: 'a', amount: 1, bizKey: 'k1' },
    { logTime: T0, businessTime: T0 - ledger.TIME_WINDOW_MS - 1 }), /window/);
});

test('crash after index write but before log write: dangling index discarded', () => {
  const dir = tmpdir();
  const { log, idx, key } = paths(dir);
  for (let i = 0; i < 5; i++) {
    ledger.appendEntry(log, idx, key, { type: 'credit', account: 'a', amount: 1, bizKey: 'k' + i }, { logTime: T0 + i, businessTime: T0 + i });
  }
  // simulate crash: index line written for entry 5, log line never written
  fs.appendFileSync(idx, JSON.stringify({ seq: 5, offset: 99999, length: 50, hash: 'deadbeef' }) + '\n');
  const res = runCli(['verify', '--log', log]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /OK 5 entries/);
  const idxLines = fs.readFileSync(idx, 'utf8').trim().split('\n');
  assert.equal(idxLines.length, 5); // dangling index entry discarded
  assert.equal(ledger.readLog(log).length, 5); // log untouched
});

test('proof verifies independently via verify-proof subcommand', () => {
  const dir = tmpdir();
  const { log, idx, key } = paths(dir);
  const proofFile = path.join(dir, 'proof.json');
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'bob', amount: 100, bizKey: 'k1' }, { logTime: T0, businessTime: T0 });
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'bob', amount: 5, bizKey: 'k2' }, { logTime: T0 + 1, businessTime: T0 + 1 });
  ledger.appendEntry(log, idx, key, { type: 'credit', account: 'alice', amount: 120, bizKey: 'k1' }, { logTime: T0 + 2, businessTime: T0 + 2, supersedes: 0 });
  ledger.appendEntry(log, idx, key, { type: 'debit', account: 'alice', amount: 20, bizKey: 'k3' }, { logTime: T0 + 3, businessTime: T0 + 3 });
  let res = runCli(['proof', '--log', log, '--account', 'alice', '--out', proofFile]);
  assert.equal(res.status, 0, res.stderr);
  const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  assert.equal(proof.entries.length, 2);
  assert.equal(proof.ancestors.length, 1); // superseded entry 0 (bob's) is a correction ancestor
  res = runCli(['verify-proof', '--log', log, '--proof', proofFile]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /OK proof for alice/);
  // tamper the proof
  proof.entries[0].hash = proof.entries[0].hash.replace(/.$/, '0');
  fs.writeFileSync(proofFile, JSON.stringify(proof));
  res = runCli(['verify-proof', '--log', log, '--proof', proofFile]);
  assert.equal(res.status, 5);
  assert.match(res.stdout, /FAIL/);
});

test('cli log/view end to end', () => {
  const dir = tmpdir();
  const { log } = paths(dir);
  let r = runCli(['log', '--log', log, '--op', '{"type":"credit","account":"a","amount":100,"bizKey":"k1"}', '--log-time', String(T0), '--business-time', String(T0)]);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['log', '--log', log, '--op', '{"type":"credit","account":"a","amount":130,"bizKey":"k1"}', '--log-time', String(T0 + 1), '--business-time', String(T0 + 1), '--supersedes', '0']);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['view', '--log', log, '--account', 'a']);
  assert.equal(JSON.parse(r.stdout).balance, 130);
});
