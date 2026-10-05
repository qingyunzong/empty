import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'refund-cli-'));
}

function tmpHistory() {
  return path.join(tmpDir(), 'history.jsonl');
}

// The sandbox blocks child-process pipes, so commands are passed as argv and
// stdout is captured through a redirected file descriptor instead of stdio pipes.
function runCli(historyFile, input) {
  const outFile = path.join(tmpDir(), 'out.json');
  const outFd = fs.openSync(outFile, 'w');
  const args = [cliPath];
  if (historyFile !== undefined) args.push(historyFile);
  if (input !== undefined) args.push(typeof input === 'string' ? input : JSON.stringify(input));
  const res = spawnSync(process.execPath, args, { stdio: ['ignore', outFd, outFd], timeout: 15000 });
  fs.closeSync(outFd);
  assert.equal(res.error, undefined, 'child process should not fail to spawn');
  const stdout = fs.readFileSync(outFile, 'utf8');
  return { status: res.status, stdout, json: JSON.parse(stdout) };
}

function readEvents(historyFile) {
  if (!fs.existsSync(historyFile)) return [];
  return fs
    .readFileSync(historyFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const PAYMENT = { op: 'payment', paymentId: 'p1', merchant: 70, commission: 20, tax: 10 };

test('cli processes a batch and persists JSONL history', () => {
  const history = tmpHistory();
  const batch = [
    PAYMENT,
    { op: 'refund', refundId: 'r1', paymentId: 'p1', amount: 40 },
    { op: 'register', refundId: 'r1' },
    { op: 'snapshot' },
  ];
  const { status, json } = runCli(history, batch);
  assert.equal(status, 0);
  assert.equal(json.results.length, 4);
  assert.equal(json.results[0].total, 100);
  assert.deepEqual(json.results[1].split, { merchant: 28, commission: 8, tax: 4 });
  assert.equal(json.results[2].status, 'POSTED');
  assert.equal(json.results[2].entries.length, 3);
  assert.equal(json.results[3].payments[0].postedTotal, 40);
  assert.equal(json.results[3].payments[0].remaining, 60);

  const events = readEvents(history);
  assert.deepEqual(events.map((e) => e.type), ['payment', 'freeze', 'post']);
});

test('cli replay of the same batch is idempotent and appends nothing', () => {
  const history = tmpHistory();
  const batch = [
    PAYMENT,
    { op: 'refund', refundId: 'r1', paymentId: 'p1', amount: 40 },
    { op: 'register', refundId: 'r1' },
  ];
  const first = runCli(history, batch);
  assert.equal(first.status, 0);
  const bytesAfterFirst = fs.readFileSync(history, 'utf8');

  const second = runCli(history, batch);
  assert.equal(second.status, 0);
  assert.deepEqual(second.json, first.json, 'replay returns identical results');
  assert.equal(fs.readFileSync(history, 'utf8'), bytesAfterFirst, 'no duplicate events appended');

  const postEvents = readEvents(history).filter((e) => e.type === 'post');
  assert.equal(postEvents.length, 1, 'no double posting after replay');
});

test('cli duplicate refundId within one batch returns the first result once', () => {
  const history = tmpHistory();
  const batch = [
    PAYMENT,
    { op: 'refund', refundId: 'r1', paymentId: 'p1', amount: 30 },
    { op: 'refund', refundId: 'r1', paymentId: 'p1', amount: 55 },
  ];
  const { status, json } = runCli(history, batch);
  assert.equal(status, 0);
  assert.deepEqual(json.results[2], json.results[1]);
  assert.equal(json.results[1].amount, 30);
  assert.equal(readEvents(history).filter((e) => e.type === 'freeze').length, 1);
});

test('cli over-limit refund exits 1 with REFUND_EXCEEDED and does not change the ledger', () => {
  const history = tmpHistory();
  assert.equal(runCli(history, [PAYMENT, { op: 'refund', refundId: 'r1', paymentId: 'p1', amount: 90 }]).status, 0);
  const bytesBefore = fs.readFileSync(history, 'utf8');

  const single = runCli(history, { op: 'refund', refundId: 'r2', paymentId: 'p1', amount: 11 });
  assert.equal(single.status, 1);
  assert.equal(single.json.error.code, 'REFUND_EXCEEDED');
  assert.ok(single.json.error.message.length > 0);
  assert.equal(fs.readFileSync(history, 'utf8'), bytesBefore, 'history untouched on error');

  const batch = runCli(history, [
    { op: 'refund', refundId: 'r3', paymentId: 'p1', amount: 5 },
    { op: 'refund', refundId: 'r4', paymentId: 'p1', amount: 6 },
  ]);
  assert.equal(batch.status, 1);
  assert.equal(batch.json.results.length, 1, 'partial results reported before the error');
  assert.equal(batch.json.error.code, 'REFUND_EXCEEDED');
});

test('cli cancel before registration appends a release event only', () => {
  const history = tmpHistory();
  const { status, json } = runCli(history, [
    PAYMENT,
    { op: 'refund', refundId: 'r1', paymentId: 'p1', amount: 30 },
    { op: 'cancel', refundId: 'r1' },
  ]);
  assert.equal(status, 0);
  assert.equal(json.results[2].status, 'RELEASED');
  const events = readEvents(history);
  assert.deepEqual(events.map((e) => e.type), ['payment', 'freeze', 'release']);
  assert.deepEqual(events[2].released, { merchant: 21, commission: 6, tax: 3 });
});

test('cli cancel after registration appends compensating entries', () => {
  const history = tmpHistory();
  const { status, json } = runCli(history, [
    PAYMENT,
    { op: 'refund', refundId: 'r1', paymentId: 'p1', amount: 30 },
    { op: 'register', refundId: 'r1' },
    { op: 'cancel', refundId: 'r1' },
  ]);
  assert.equal(status, 0);
  assert.equal(json.results[3].status, 'COMPENSATED');
  const events = readEvents(history);
  assert.deepEqual(events.map((e) => e.type), ['payment', 'freeze', 'post', 'compensate']);
  const post = events[2];
  const comp = events[3];
  for (let i = 0; i < post.entries.length; i += 1) {
    assert.equal(comp.entries[i].account, post.entries[i].account);
    assert.equal(comp.entries[i].amount, post.entries[i].amount);
    assert.notEqual(comp.entries[i].direction, post.entries[i].direction);
  }
});

test('cli reports coded errors for bad input with exit code 1', () => {
  const history = tmpHistory();
  const badJson = runCli(history, '{not json');
  assert.equal(badJson.status, 1);
  assert.equal(badJson.json.error.code, 'INVALID_JSON');

  const unknownOp = runCli(history, { op: 'explode' });
  assert.equal(unknownOp.status, 1);
  assert.equal(unknownOp.json.error.code, 'UNKNOWN_OP');

  const noPayment = runCli(history, { op: 'refund', refundId: 'r1', paymentId: 'ghost', amount: 1 });
  assert.equal(noPayment.status, 1);
  assert.equal(noPayment.json.error.code, 'PAYMENT_NOT_FOUND');

  const noHistory = runCli(undefined, undefined);
  assert.equal(noHistory.status, 1);
  assert.equal(noHistory.json.error.code, 'USAGE');
});
