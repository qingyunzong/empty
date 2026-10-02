import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, BRANCHES } from '../src/ledger.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'splitpay-'));
}

// Independent enumerator of branch success/failure masks (bit=1 -> success).
function* branchMasks() {
  for (let mask = 0; mask < 1 << BRANCHES.length; mask += 1) {
    yield BRANCHES.map((_, i) => Boolean(mask & (1 << i)));
  }
}

const AMOUNTS = { card: 100, coupon: 0, points: 55 };

function feed(ledger, paymentId, mask) {
  let cert;
  BRANCHES.forEach((branchId, i) => {
    cert = ledger.handleEvent({
      type: 'branch_result',
      paymentId,
      branchId,
      status: mask[i] ? 'success' : 'failed',
      amount: mask[i] ? AMOUNTS[branchId] : undefined,
    });
  });
  return cert;
}

test('mask enumerator: all-success joins and splits with conserved total; any failure compensates every succeeded branch', () => {
  for (const mask of branchMasks()) {
    const ledger = new Ledger(tmpdir());
    const cert = feed(ledger, `p-${mask.map(Number).join('')}`, mask);
    const total = BRANCHES.reduce((sum, b, i) => sum + (mask[i] ? AMOUNTS[b] : 0), 0);
    if (mask.every(Boolean)) {
      assert.equal(cert.status, 'COMPLETED', `mask=${mask}`);
      assert.equal(cert.split.total, total);
      assert.equal(cert.split.merchant + cert.split.fee + cert.split.tax, total);
      assert.equal(cert.compensations.length, 0);
    } else {
      assert.equal(cert.status, 'FAILED', `mask=${mask}`);
      assert.equal(cert.split, null);
      const compensated = cert.compensations.map((c) => c.branchId).sort();
      const expected = BRANCHES.filter((_, i) => mask[i]).sort();
      assert.deepEqual(compensated, expected, `mask=${mask} every succeeded branch needs a reversal`);
      for (const c of cert.compensations) assert.equal(c.amount, AMOUNTS[c.branchId]);
    }
  }
});

test('duplicate notification for the same paymentId+branchId is idempotent', () => {
  const workdir = tmpdir();
  const ledger = new Ledger(workdir);
  const event = { type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: 100 };
  ledger.handleEvent(event);
  ledger.handleEvent(event); // duplicate
  ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'coupon', status: 'success', amount: 0 });
  ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'points', status: 'success', amount: 55 });
  const cert = ledger.handleEvent(event); // duplicate after completion
  assert.equal(cert.status, 'COMPLETED');
  const log = fs.readFileSync(path.join(workdir, 'events.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.filter((e) => e.type === 'branch_success' && e.branchId === 'card').length, 1);
  assert.equal(log.filter((e) => e.type === 'split').length, 1);
});

test('conflicting duplicate is rejected', () => {
  const ledger = new Ledger(tmpdir());
  ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: 100 });
  assert.throws(
    () => ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: 101 }),
    (err) => err.code === 'DUPLICATE_CONFLICT',
  );
});

test('restart from log resumes join without duplicating the split', () => {
  const workdir = tmpdir();
  let ledger = new Ledger(workdir);
  ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: 100 });
  // crash + recovery
  ledger = new Ledger(workdir);
  ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'coupon', status: 'success', amount: 0 });
  // crash + recovery again
  ledger = new Ledger(workdir);
  const cert = ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'points', status: 'success', amount: 55 });
  assert.equal(cert.status, 'COMPLETED');
  assert.equal(cert.split.total, 155);
  // replay once more: state survives, no extra split
  ledger = new Ledger(workdir);
  const again = ledger.certificate('p1');
  assert.equal(again.status, 'COMPLETED');
  const log = fs.readFileSync(path.join(workdir, 'events.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.filter((e) => e.type === 'split').length, 1);
});

test('restart from log resumes compensation after a failure', () => {
  const workdir = tmpdir();
  let ledger = new Ledger(workdir);
  ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: 100 });
  ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'coupon', status: 'failed' });
  // crash before the late points branch reports
  ledger = new Ledger(workdir);
  const cert = ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'points', status: 'success', amount: 55 });
  assert.equal(cert.status, 'FAILED');
  const compensated = cert.compensations.map((c) => c.branchId).sort();
  assert.deepEqual(compensated, ['card', 'points']);
  const log = fs.readFileSync(path.join(workdir, 'events.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.filter((e) => e.type === 'compensation' && e.branchId === 'card').length, 1);
});

test('zero-amount branches are accepted and join into a zero split', () => {
  const ledger = new Ledger(tmpdir());
  let cert;
  for (const branchId of BRANCHES) {
    cert = ledger.handleEvent({ type: 'branch_result', paymentId: 'p0', branchId, status: 'success', amount: 0 });
  }
  assert.equal(cert.status, 'COMPLETED');
  assert.deepEqual(cert.split, { total: 0, merchant: 0, fee: 0, tax: 0 });
});

test('negative or non-integer amounts are rejected', () => {
  const ledger = new Ledger(tmpdir());
  assert.throws(
    () => ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: -1 }),
    (err) => err.code === 'INVALID_AMOUNT',
  );
  assert.throws(
    () => ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: 1.5 }),
    (err) => err.code === 'INVALID_AMOUNT',
  );
  assert.throws(
    () => ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'nope', status: 'success', amount: 1 }),
    (err) => err.code === 'INVALID_BRANCH',
  );
});

test('amount mismatch against declared expectation fails the order and compensates succeeded branches', () => {
  const ledger = new Ledger(tmpdir());
  ledger.handleEvent({ type: 'order_created', paymentId: 'p1', expected: { card: 100, coupon: 10, points: 5 } });
  ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'card', status: 'success', amount: 100 });
  const cert = ledger.handleEvent({ type: 'branch_result', paymentId: 'p1', branchId: 'coupon', status: 'success', amount: 11 });
  assert.equal(cert.status, 'FAILED');
  assert.deepEqual(cert.compensations.map((c) => c.branchId), ['card']);
  assert.equal(cert.branches.coupon.status, 'failed');
});

test('small-amount enumeration: every branch combo with total <= 30 cents joins with conserved split', () => {
  for (let card = 0; card <= 10; card += 1) {
    for (let coupon = 0; coupon <= 10; coupon += 1) {
      for (let points = 0; points <= 10; points += 1) {
        const ledger = new Ledger(tmpdir());
        const amounts = { card, coupon, points };
        let cert;
        for (const branchId of BRANCHES) {
          cert = ledger.handleEvent({
            type: 'branch_result',
            paymentId: 'p',
            branchId,
            status: 'success',
            amount: amounts[branchId],
          });
        }
        const total = card + coupon + points;
        assert.equal(cert.status, 'COMPLETED');
        assert.equal(cert.split.merchant + cert.split.fee + cert.split.tax, total, `combo=${card}/${coupon}/${points}`);
      }
    }
  }
});
