import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/cli-core.js';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'refund-cli-'));
  try {
    fn(join(dir, 'history.jsonl'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(store, command, payload) {
  const args = ['--store', store, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  const { code, output } = await runCli(args);
  return { code, json: JSON.parse(output) };
}

function readEvents(store) {
  return readFileSync(store, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('CLI: full lifecycle with JSONL history and JSON output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refund-cli-'));
  const store = join(dir, 'history.jsonl');
  try {
    let r = await run(store, 'settle', { paymentId: 'p1', merchant: 70, commission: 20, tax: 10 });
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.result.total, 100);

    r = await run(store, 'refund', { refundId: 'r1', paymentId: 'p1', amount: 50 });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.result.split, { merchant: 35, commission: 10, tax: 5 });
    assert.equal(r.json.result.status, 'frozen');

    // duplicate refundId returns the first result and appends nothing
    const before = readEvents(store).length;
    r = await run(store, 'refund', { refundId: 'r1', paymentId: 'p1', amount: 50 });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.result.split, { merchant: 35, commission: 10, tax: 5 });
    assert.equal(readEvents(store).length, before);

    r = await run(store, 'register', { refundId: 'r1' });
    assert.equal(r.code, 0);
    assert.equal(r.json.result.status, 'posted');

    r = await run(store, 'balance', { paymentId: 'p1' });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.result.posted, { merchant: 35, commission: 10, tax: 5 });
    assert.deepEqual(r.json.result.available, { merchant: 35, commission: 10, tax: 5 });

    // cancel after registration -> compensating reversal recorded
    r = await run(store, 'cancel', { refundId: 'r1' });
    assert.equal(r.code, 0);
    assert.equal(r.json.result.status, 'compensated');
    r = await run(store, 'balance', { paymentId: 'p1' });
    assert.deepEqual(r.json.result.available, { merchant: 70, commission: 20, tax: 10 });
    assert.deepEqual(r.json.result.compensated, { merchant: 35, commission: 10, tax: 5 });

    // cancel before registration -> release only
    r = await run(store, 'refund', { refundId: 'r2', paymentId: 'p1', amount: 10 });
    assert.equal(r.code, 0);
    r = await run(store, 'cancel', { refundId: 'r2' });
    assert.equal(r.json.result.status, 'released');

    const types = readEvents(store).map((e) => e.type);
    assert.deepEqual(types, [
      'payment_settled',
      'refund_frozen',
      'refund_posted',
      'refund_compensated',
      'refund_frozen',
      'refund_released',
    ]);

    r = await run(store, 'history');
    assert.equal(r.code, 0);
    assert.equal(r.json.result.length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: over-amount refund exits 1 with REFUND_EXCEEDED and no state change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refund-cli-'));
  const store = join(dir, 'history.jsonl');
  try {
    await run(store, 'settle', { paymentId: 'p1', merchant: 10, commission: 5, tax: 5 });
    const before = readEvents(store).length;
    const r = await run(store, 'refund', { refundId: 'r1', paymentId: 'p1', amount: 21 });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'REFUND_EXCEEDED');
    assert.match(r.json.error.message, /exceeds/);
    assert.equal(readEvents(store).length, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: invalid JSON, unknown command and missing payment exit 1 with error code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refund-cli-'));
  const store = join(dir, 'history.jsonl');
  try {
    let r = await runCli(['--store', store, 'refund', '{bad']);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.output).error.code, 'INVALID_JSON');

    r = await runCli(['--store', store, 'frobnicate', '{}']);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.output).error.code, 'UNKNOWN_COMMAND');

    r = await runCli(['--store', store, 'balance', '{"paymentId":"ghost"}']);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.output).error.code, 'PAYMENT_NOT_FOUND');

    r = await runCli(['--store', store]);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.output).error.code, 'INVALID_INPUT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: reads payload from stdin when omitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refund-cli-'));
  const store = join(dir, 'history.jsonl');
  try {
    const { code, output } = await runCli(['--store', store, 'settle'], {
      stdinText: JSON.stringify({ paymentId: 'p1', merchant: 1, commission: 1, tax: 1 }),
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(output).result.total, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
