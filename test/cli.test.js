import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = new URL('../bin/cli.js', import.meta.url).pathname;

// Sandboxed environments may not support child-process pipes reliably, so
// stdin/stdout/stderr are wired through temp files instead.
function runCli(input, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cli-'));
  const inPath = path.join(dir, 'in.jsonl');
  const outPath = path.join(dir, 'out.txt');
  const errPath = path.join(dir, 'err.txt');
  fs.writeFileSync(inPath, input);
  const inFd = fs.openSync(inPath, 'r');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: [inFd, outFd, errFd] });
  fs.closeSync(inFd);
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: res.status,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

test('CLI applies JSONL commands and prints snapshot + trace', () => {
  const cmds = [
    { op: 'open_account', accountId: 'acct', creditLimit: 1000 },
    { op: 'authorize', accountId: 'acct', authId: 'A1', amount: 600, requestId: 'r1' },
    { op: 'capture', accountId: 'acct', authId: 'A1', amount: 200, merchantId: 'm1', requestId: 'r2' },
    { op: 'reverse', accountId: 'acct', authId: 'A1', requestId: 'r3' },
  ];
  const res = runCli(cmds.map((c) => JSON.stringify(c)).join('\n'), ['--trace']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  const trace = lines.slice(0, 4).map((l) => JSON.parse(l));
  assert.equal(trace[1].reason, 'authorize A1: freeze 600 (available 1000 -> 400)');
  assert.deepEqual(trace.map((t) => t.seq), [0, 1, 2, 3]);
  const snap = JSON.parse(lines.slice(4).join('\n'));
  assert.equal(snap.accounts[0].available, 800);
  assert.equal(snap.accounts[0].posted, 200);
  assert.equal(snap.merchants[0].settled, 200);
});

test('CLI exits 4 with error on stderr for INSUFFICIENT funds', () => {
  const cmds = [
    { op: 'open_account', accountId: 'acct', creditLimit: 100 },
    { op: 'authorize', accountId: 'acct', authId: 'A1', amount: 101 },
  ];
  const res = runCli(cmds.map((c) => JSON.stringify(c)).join('\n'));
  assert.equal(res.status, 4);
  assert.match(res.stderr, /ERROR INSUFFICIENT/);
});

test('CLI exits 4 on malformed JSON input', () => {
  const res = runCli('{"op":"open_account",}\n');
  assert.equal(res.status, 4);
  assert.match(res.stderr, /ERROR BAD_JSON/);
});

test('CLI persists to --log and restores state on the next run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cli-'));
  const logPath = path.join(dir, 'events.jsonl');
  const run1 = runCli(
    [
      { op: 'open_account', accountId: 'acct', creditLimit: 500 },
      { op: 'authorize', accountId: 'acct', authId: 'A1', amount: 200 },
    ].map((c) => JSON.stringify(c)).join('\n'),
    ['--log', logPath],
  );
  assert.equal(run1.status, 0, run1.stderr);
  const run2 = runCli(
    JSON.stringify({ op: 'capture', accountId: 'acct', authId: 'A1', amount: 50, merchantId: 'm1' }),
    ['--log', logPath],
  );
  assert.equal(run2.status, 0, run2.stderr);
  const snap = JSON.parse(run2.stdout);
  assert.equal(snap.accounts[0].available, 300);
  assert.equal(snap.accounts[0].held, 150);
  assert.equal(snap.accounts[0].posted, 50);
  assert.equal(snap.eventsApplied, 3);
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
});
