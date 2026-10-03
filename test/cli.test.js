'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'splitpay-cli-'));
}

// Invoke the CLI exactly as `node cli.js ...` would, capturing streams and exit code.
function runCli(args) {
  const out = [];
  const err = [];
  const status = run(args, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('CLI processes events across invocations and prints a JSON certificate', () => {
  const dir = tmpdir();
  const events = [
    { type: 'register', paymentId: 'p1', branches: { bank: 100, coupon: 50, points: 25 } },
    { type: 'branch_success', paymentId: 'p1', branchId: 'bank', amount: 100 },
    { type: 'branch_success', paymentId: 'p1', branchId: 'coupon', amount: 50 },
    { type: 'branch_success', paymentId: 'p1', branchId: 'points', amount: 25 },
  ];
  let cert;
  for (const event of events) {
    const result = runCli([JSON.stringify(event), dir]);
    assert.equal(result.status, 0, result.stderr);
    cert = JSON.parse(result.stdout);
  }
  assert.equal(cert.status, 'SETTLED');
  assert.equal(cert.total, 175);
  assert.equal(cert.split.merchant + cert.split.fee + cert.split.tax, 175);
  assert.deepEqual(cert.split, { merchant: 165, fee: 9, tax: 1 });
});

test('CLI accepts an event JSON file path', () => {
  const dir = tmpdir();
  const eventFile = path.join(dir, 'event.json');
  fs.writeFileSync(
    eventFile,
    JSON.stringify({ type: 'register', paymentId: 'p1', branches: { bank: 0, coupon: 0, points: 0 } })
  );
  const result = runCli([eventFile, dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'PENDING');
});

test('CLI reports errors with exit code 1 and a JSON error body', () => {
  const dir = tmpdir();
  const cases = [
    { event: 'not-json', code: 'INVALID_JSON' },
    { event: '{"type":"bogus"}', code: 'INVALID_EVENT' },
    {
      event: JSON.stringify({ type: 'branch_success', paymentId: 'nope', branchId: 'bank', amount: 1 }),
      code: 'UNKNOWN_PAYMENT',
    },
    {
      event: JSON.stringify({ type: 'register', paymentId: 'p1', branches: { bank: -1, coupon: 0, points: 0 } }),
      code: 'INVALID_AMOUNT',
    },
    {
      event: JSON.stringify({ type: 'branch_success', paymentId: 'p1', branchId: 'bank', amount: -5 }),
      code: 'INVALID_AMOUNT',
    },
  ];
  for (const { event, code } of cases) {
    const result = runCli([event, dir]);
    assert.equal(result.status, 1, `expected exit 1 for ${code}`);
    const body = JSON.parse(result.stderr);
    assert.equal(body.error, code);
    assert.equal(typeof body.message, 'string');
  }
  const missingArgs = runCli([]);
  assert.equal(missingArgs.status, 1);
  assert.equal(JSON.parse(missingArgs.stderr).error, 'INVALID_ARGS');
});
