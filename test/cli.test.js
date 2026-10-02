import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve('cli.js');

function runCli(args, input) {
  const res = spawnSync('node', [CLI, ...args], { input, encoding: 'utf8' });
  if (res.error && res.status === null) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  return path.join(dir, 'events.log');
}

function tmpInput(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-in-'));
  const file = path.join(dir, 'events.jsonl');
  const text = typeof events === 'string' ? events : events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(file, text);
  return file;
}

test('run applies JSONL stream, prints snapshot and journal, persists log', () => {
  const log = tmpLog();
  const input = tmpInput([
    { seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 1000 },
    { seq: 2, requestId: 'auth1', type: 'authorize', authId: 'au1', account: 'a1', amount: 400 },
    { seq: 3, requestId: 'auth2', type: 'authorize', authId: 'au2', account: 'a1', amount: 700 },
    { seq: 4, requestId: 'cap1', type: 'capture', authId: 'au1', amount: 150, merchant: 'm1' },
    { seq: 5, requestId: 'void1', type: 'void', authId: 'au1' },
  ]);

  const res = runCli(['run', '--log', log, '--input', input]);
  assert.equal(res.status, 0);
  const result = JSON.parse(res.stdout);
  assert.equal(result.recovered.truncated, false);
  assert.equal(result.snapshot.accounts.a1.held, 0);
  assert.equal(result.snapshot.accounts.a1.captured, 150);
  assert.equal(result.snapshot.accounts.a1.available, 850);
  assert.equal(result.snapshot.merchants.m1.settled, 150);
  assert.equal(result.journal.length, 5);
  const rejected = result.journal.find((r) => r.requestId === 'auth2');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'INSUFFICIENT');

  const snap = runCli(['snapshot', '--log', log]);
  assert.equal(snap.status, 0);
  assert.deepEqual(JSON.parse(snap.stdout).snapshot, result.snapshot);
});

test('replay --prefix recomputes deterministic intermediate state', () => {
  const log = tmpLog();
  const input = tmpInput([
    { seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 100 },
    { seq: 2, requestId: 'auth1', type: 'authorize', authId: 'au1', account: 'a1', amount: 60 },
    { seq: 3, requestId: 'cap1', type: 'capture', authId: 'au1', amount: 60 },
  ]);
  assert.equal(runCli(['run', '--log', log, '--input', input]).status, 0);

  const res = runCli(['replay', '--log', log, '--prefix', '2']);
  assert.equal(res.status, 0);
  const result = JSON.parse(res.stdout);
  assert.equal(result.snapshot.accounts.a1.held, 60);
  assert.equal(result.snapshot.accounts.a1.captured, 0);
  assert.equal(result.journal.length, 2);
});

test('malformed input exits with code 4 and writes to stderr', () => {
  const log = tmpLog();
  const input = tmpInput('{bad json\n');
  const res = runCli(['run', '--log', log, '--input', input]);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /invalid JSON/);
  assert.equal(res.stdout, '');
});

test('malformed event exits with code 4', () => {
  const log = tmpLog();
  const input = tmpInput([{ seq: 1, requestId: 'x', type: 'explode' }]);
  const res = runCli(['run', '--log', log, '--input', input]);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /unknown event type/);
});

test('unknown command exits with code 4', () => {
  const res = runCli(['nope']);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /unknown command/);
});

test('run recovers from a torn log left by a crash before fsync', () => {
  const log = tmpLog();
  const input = tmpInput([{ seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 100 }]);
  assert.equal(runCli(['run', '--log', log, '--input', input]).status, 0);
  fs.appendFileSync(log, '{"seq":2,"requestId":"torn'); // crash mid-write, no newline
  const res = runCli(['snapshot', '--log', log]);
  assert.equal(res.status, 0);
  const result = JSON.parse(res.stdout);
  assert.equal(result.recovered.truncated, true);
  assert.equal(result.snapshot.accounts.a1.limit, 100);
});
