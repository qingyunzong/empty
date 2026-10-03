'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger, BRANCHES } = require('../src/ledger');
const { split } = require('../src/split');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'splitpay-'));
}

function readEvents(dir) {
  const logPath = path.join(dir, 'events.log');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Independent enumerator: every success/failure mask for the three branches.
const MASKS = [];
for (let mask = 0; mask < 8; mask += 1) {
  MASKS.push({ bank: mask & 1, coupon: mask & 2, points: mask & 4 });
}

test('enumerate all branch success/failure masks', () => {
  for (const mask of MASKS) {
    const dir = tmpdir();
    const ledger = new Ledger(dir);
    const expected = { bank: 100, coupon: 50, points: 25 };
    ledger.register('p1', expected);
    for (const branchId of BRANCHES) {
      if (mask[branchId]) {
        ledger.branchSuccess('p1', branchId, expected[branchId]);
      } else {
        ledger.branchFailed('p1', branchId, 'simulated failure');
      }
    }
    const cert = ledger.certificate('p1');
    const allSucceeded = BRANCHES.every((branchId) => mask[branchId]);
    if (allSucceeded) {
      assert.equal(cert.status, 'SETTLED', `mask ${JSON.stringify(mask)}`);
      const total = expected.bank + expected.coupon + expected.points;
      assert.equal(
        cert.split.merchant + cert.split.fee + cert.split.tax,
        total,
        'split must sum to the payment total'
      );
      assert.deepEqual(cert.split, split(total), 'split must be recomputable');
      assert.equal(cert.compensations.length, 0);
    } else {
      assert.equal(cert.status, 'FAILED', `mask ${JSON.stringify(mask)}`);
      assert.equal(cert.split, null);
      for (const branchId of BRANCHES) {
        if (mask[branchId]) {
          assert.equal(cert.branches[branchId].status, 'COMPENSATED');
          assert.ok(
            cert.compensations.some(
              (entry) => entry.branchId === branchId && entry.amount === expected[branchId]
            ),
            `branch ${branchId} must have a reverse record`
          );
        } else {
          assert.equal(cert.branches[branchId].status, 'FAILED');
        }
      }
    }
  }
});

test('duplicate notifications are idempotent', () => {
  const dir = tmpdir();
  const ledger = new Ledger(dir);
  ledger.register('p1', { bank: 100, coupon: 50, points: 0 });
  ledger.branchSuccess('p1', 'bank', 100);
  ledger.branchSuccess('p1', 'bank', 100);
  ledger.branchSuccess('p1', 'coupon', 50);
  ledger.branchSuccess('p1', 'points', 0);
  ledger.branchSuccess('p1', 'points', 0);
  ledger.branchFailed('p1', 'points', 'late duplicate failure');
  const cert = ledger.certificate('p1');
  assert.equal(cert.status, 'SETTLED');
  const events = readEvents(dir);
  assert.equal(events.filter((event) => event.type === 'split').length, 1);
  assert.equal(
    events.filter((event) => event.type === 'branch_success' && event.branchId === 'bank').length,
    1
  );
  assert.equal(
    events.filter((event) => event.type === 'branch_success' && event.branchId === 'points').length,
    1
  );
  assert.equal(events.filter((event) => event.type === 'branch_failed').length, 0);
});

test('duplicate register with same amounts is idempotent, conflict is rejected', () => {
  const dir = tmpdir();
  const ledger = new Ledger(dir);
  ledger.register('p1', { bank: 100, coupon: 50, points: 25 });
  ledger.register('p1', { bank: 100, coupon: 50, points: 25 });
  assert.equal(readEvents(dir).filter((event) => event.type === 'register').length, 1);
  assert.throws(
    () => ledger.register('p1', { bank: 100, coupon: 50, points: 26 }),
    (error) => error.code === 'CONFLICT'
  );
});

test('amount mismatch marks the payment failed and compensates succeeded branches', () => {
  const dir = tmpdir();
  const ledger = new Ledger(dir);
  ledger.register('p1', { bank: 100, coupon: 50, points: 25 });
  ledger.branchSuccess('p1', 'bank', 100);
  ledger.branchSuccess('p1', 'coupon', 51);
  const cert = ledger.certificate('p1');
  assert.equal(cert.status, 'FAILED');
  assert.equal(cert.branches.bank.status, 'COMPENSATED');
  assert.equal(cert.branches.coupon.status, 'FAILED');
  assert.equal(cert.branches.coupon.received, 51);
  assert.deepEqual(cert.compensations, [{ branchId: 'bank', amount: 100 }]);
});

test('late success after failure is compensated immediately', () => {
  const dir = tmpdir();
  const ledger = new Ledger(dir);
  ledger.register('p1', { bank: 100, coupon: 50, points: 25 });
  ledger.branchFailed('p1', 'coupon', 'declined');
  ledger.branchSuccess('p1', 'bank', 100);
  const cert = ledger.certificate('p1');
  assert.equal(cert.status, 'FAILED');
  assert.equal(cert.branches.bank.status, 'COMPENSATED');
  assert.deepEqual(cert.compensations, [{ branchId: 'bank', amount: 100 }]);
});

test('recovery after restart continues the merge and never splits twice', () => {
  const dir = tmpdir();
  let ledger = new Ledger(dir);
  ledger.register('p1', { bank: 100, coupon: 50, points: 25 });
  ledger.branchSuccess('p1', 'bank', 100);
  ledger.branchSuccess('p1', 'coupon', 50);
  // crash and restart from the log
  ledger = new Ledger(dir);
  assert.equal(ledger.certificate('p1').status, 'PENDING');
  ledger.branchSuccess('p1', 'points', 25);
  assert.equal(ledger.certificate('p1').status, 'SETTLED');
  // another restart: replaying the log must not split again
  ledger = new Ledger(dir);
  const cert = ledger.certificate('p1');
  assert.equal(cert.status, 'SETTLED');
  assert.deepEqual(cert.split, split(175));
  const events = readEvents(dir);
  assert.equal(events.filter((event) => event.type === 'split').length, 1);
});

test('recovery after crash completes pending compensation', () => {
  const dir = tmpdir();
  const ledger = new Ledger(dir);
  ledger.register('p1', { bank: 100, coupon: 50, points: 25 });
  ledger.branchSuccess('p1', 'bank', 100);
  // simulate a crash: failure recorded, compensation not yet written
  fs.appendFileSync(
    path.join(dir, 'events.log'),
    `${JSON.stringify({ type: 'branch_failed', paymentId: 'p1', branchId: 'coupon', reason: 'crash' })}\n`
  );
  const recovered = new Ledger(dir);
  const cert = recovered.certificate('p1');
  assert.equal(cert.status, 'FAILED');
  assert.equal(cert.branches.bank.status, 'COMPENSATED');
  assert.deepEqual(cert.compensations, [{ branchId: 'bank', amount: 100 }]);
  // recovering again must not compensate twice
  const again = new Ledger(dir);
  assert.deepEqual(again.certificate('p1').compensations, [{ branchId: 'bank', amount: 100 }]);
});

test('zero-amount branches are accepted and settle to a zero split', () => {
  const dir = tmpdir();
  const ledger = new Ledger(dir);
  ledger.register('p1', { bank: 0, coupon: 0, points: 0 });
  ledger.branchSuccess('p1', 'bank', 0);
  ledger.branchSuccess('p1', 'coupon', 0);
  ledger.branchSuccess('p1', 'points', 0);
  const cert = ledger.certificate('p1');
  assert.equal(cert.status, 'SETTLED');
  assert.deepEqual(cert.split, { merchant: 0, fee: 0, tax: 0 });
});

test('negative and non-integer amounts are rejected', () => {
  const dir = tmpdir();
  const ledger = new Ledger(dir);
  assert.throws(
    () => ledger.register('p1', { bank: -1, coupon: 0, points: 0 }),
    (error) => error.code === 'INVALID_AMOUNT'
  );
  assert.throws(
    () => ledger.register('p1', { bank: 1.5, coupon: 0, points: 0 }),
    (error) => error.code === 'INVALID_AMOUNT'
  );
  ledger.register('p1', { bank: 100, coupon: 50, points: 25 });
  assert.throws(
    () => ledger.branchSuccess('p1', 'bank', -5),
    (error) => error.code === 'INVALID_AMOUNT'
  );
  assert.throws(
    () => ledger.branchSuccess('p1', 'bank', 10.5),
    (error) => error.code === 'INVALID_AMOUNT'
  );
  assert.throws(
    () => ledger.branchSuccess('p1', 'paypal', 10),
    (error) => error.code === 'INVALID_BRANCH'
  );
  assert.throws(
    () => ledger.branchSuccess('unknown', 'bank', 10),
    (error) => error.code === 'UNKNOWN_PAYMENT'
  );
});
