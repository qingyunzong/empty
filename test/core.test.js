'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Core } = require('../src/core');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function makeCore(overrides = {}) {
  const core = new Core({
    budgetLimit: 50,
    slaMs: 100,
    highRiskTags: ['high'],
    ...overrides,
  });
  core.setHasher(sha256);
  return core;
}

const refundK1 = { op: 'refund', key: 'k1', order: 'o1', amount: 40, riskTag: 'high', paid: 100 };

test('duplicate refund with same payload returns the original result', () => {
  const core = makeCore();
  const first = core.apply(refundK1, 0);
  const second = core.apply(refundK1, 10);
  assert.deepEqual(second, first);
  assert.equal(core.refunds.size, 1);
  assert.equal(core.budgetUsed, 40, 'budget reserved exactly once');
  const third = core.apply({ op: 'approve', key: 'k1' }, 20);
  assert.equal(third.state, 'APPROVED');
  const dup = core.apply(refundK1, 30);
  assert.equal(dup.state, 'APPROVED', 'duplicate after approval replays the decision');
  assert.equal(core.orders.get('o1').refunded, 40, 'no double deduction');
});

test('same key with different amount is a conflict and keeps history', () => {
  const core = makeCore();
  core.apply(refundK1, 0);
  const res = core.apply({ ...refundK1, amount: 55 }, 5);
  assert.equal(res.status, 'conflict');
  assert.equal(res.code, 'CONFLICT');
  assert.equal(res.originalAmount, 40);
  assert.equal(core.refunds.get('k1').amount, 40, 'original record unchanged');
});

test('refund can never exceed the refundable balance', () => {
  const core = makeCore();
  const res = core.apply({ op: 'refund', key: 'k1', order: 'o1', amount: 120, riskTag: 'low', paid: 100 }, 0);
  assert.equal(res.state, 'REJECTED');
  assert.equal(res.code, 'LIMIT_EXCEEDED');
  core.apply({ op: 'refund', key: 'k2', order: 'o1', amount: 60, riskTag: 'low', paid: 100 }, 1);
  core.apply({ op: 'approve', key: 'k2' }, 2);
  const res2 = core.apply({ op: 'refund', key: 'k3', order: 'o1', amount: 50, riskTag: 'low', paid: 100 }, 3);
  assert.equal(res2.code, 'LIMIT_EXCEEDED', 'remaining balance is 40 after first approval');
});

test('high-risk budget: approve holds, reject/expire release, queue auto-rejects at SLA', () => {
  const core = makeCore();
  core.apply({ op: 'refund', key: 'a', order: 'o1', amount: 40, riskTag: 'high', paid: 100 }, 0);
  const queued = core.apply({ op: 'refund', key: 'b', order: 'o1', amount: 40, riskTag: 'high', paid: 100 }, 10);
  assert.equal(queued.state, 'PENDING');
  assert.deepEqual(core.queue.map((r) => r.key), ['b'], 'b waits for budget');

  // SLA deadline for b is t=110: virtual clock auto-rejects it.
  core.apply({ op: 'tick', to: 110 }, 110);
  assert.equal(core.refunds.get('b').state, 'REJECTED');
  assert.equal(core.refunds.get('b').rejectCode, 'BUDGET_EXHAUSTED');

  // Rejecting a releases its budget.
  core.apply({ op: 'reject', key: 'a' }, 120);
  assert.equal(core.budgetUsed, 0);

  // Now c can reserve budget, and expiring it releases again.
  core.apply({ op: 'refund', key: 'c', order: 'o1', amount: 40, riskTag: 'high', paid: 100 }, 130);
  assert.equal(core.budgetUsed, 40);
  core.apply({ op: 'expire', key: 'c' }, 140);
  assert.equal(core.budgetUsed, 0);
  assert.equal(core.refunds.get('c').state, 'EXPIRED');
});

test('budget tie at the same timestamp is decided by ascending key', () => {
  const core = makeCore({ budgetLimit: 40 });
  // Both queued (budget 0 left after the first reservation is released later).
  core.apply({ op: 'refund', key: 'z', order: 'o1', amount: 40, riskTag: 'high', paid: 300 }, 0);
  core.apply({ op: 'refund', key: 'a', order: 'o1', amount: 40, riskTag: 'high', paid: 300 }, 0);
  core.apply({ op: 'refund', key: 'm', order: 'o1', amount: 40, riskTag: 'high', paid: 300 }, 0);
  assert.deepEqual(core.queue.map((r) => r.key), ['a', 'm']);
  // At t=100 both queued refunds hit their SLA at the same instant; 'a' wins
  // the tie-break ordering and is rejected first, but both die: the check is
  // that ordering is deterministic and key-decided. Free budget instead:
  core.apply({ op: 'expire', key: 'z' }, 50);
  assert.equal(core.budgetUsed, 40, 'FIFO head (a) admitted after z released');
  assert.equal(core.refunds.get('a').budgetHeld, true);
  // m times out at t=100.
  core.apply({ op: 'tick', to: 100 }, 100);
  assert.equal(core.refunds.get('m').rejectCode, 'BUDGET_EXHAUSTED');
});

test('simultaneous SLA expiry of two queued refunds rejects in key order', () => {
  const core = makeCore({ budgetLimit: 0 });
  core.apply({ op: 'refund', key: 'b', order: 'o1', amount: 10, riskTag: 'high', paid: 100 }, 0);
  core.apply({ op: 'refund', key: 'a', order: 'o1', amount: 10, riskTag: 'high', paid: 100 }, 0);
  core.apply({ op: 'tick', to: 100 }, 100);
  const events = core.audit.filter((e) => e.event === 'refundRejected').map((e) => e.data.key);
  assert.deepEqual(events, ['a', 'b'], 'same-deadline ties resolve by ascending key');
});

test('expire then late approve: approve is a no-op on a terminal refund', () => {
  const core = makeCore();
  core.apply(refundK1, 0);
  const expired = core.apply({ op: 'expire', key: 'k1' }, 10);
  assert.equal(expired.state, 'EXPIRED');
  const lateApprove = core.apply({ op: 'approve', key: 'k1' }, 20);
  assert.equal(lateApprove.state, 'EXPIRED', 'late approve cannot resurrect');
  assert.equal(core.orders.get('o1').refunded, 0);
  assert.equal(core.budgetUsed, 0, 'budget released by expire stays released');
});

test('approve then late expire: expire is a no-op on an approved refund', () => {
  const core = makeCore();
  core.apply(refundK1, 0);
  core.apply({ op: 'approve', key: 'k1' }, 10);
  const lateExpire = core.apply({ op: 'expire', key: 'k1' }, 20);
  assert.equal(lateExpire.state, 'APPROVED');
  assert.equal(core.budgetUsed, 40, 'budget still held by the approval');
});

test('reverse of an approved refund restores budget and balance, history immutable', () => {
  const core = makeCore();
  core.apply(refundK1, 0);
  core.apply({ op: 'approve', key: 'k1' }, 10);
  assert.equal(core.orders.get('o1').refunded, 40);
  const res = core.apply({ op: 'reverse', key: 'k1' }, 20);
  assert.equal(res.state, 'REVERSED');
  assert.equal(core.orders.get('o1').refunded, 0, 'refundable balance restored');
  assert.equal(core.budgetUsed, 0, 'budget returned');
  const events = core.audit.map((e) => e.event);
  assert.ok(events.includes('refundApproved'), 'approval stays in history');
  assert.ok(events.includes('reverseRefund'), 'reversal appended, not rewritten');
  // A reversed refund cannot be approved again.
  const again = core.apply({ op: 'approve', key: 'k1' }, 30);
  assert.equal(again.state, 'REVERSED');
});

test('audit hash chain is deterministic and tamper-evident', () => {
  const run = () => {
    const core = makeCore();
    core.apply(refundK1, 0);
    core.apply({ op: 'approve', key: 'k1' }, 10);
    core.apply({ op: 'reverse', key: 'k1' }, 20);
    return core.auditHash();
  };
  assert.equal(run(), run(), 'same inputs produce the same audit hash');
  const core = makeCore();
  core.apply(refundK1, 0);
  core.apply({ op: 'approve', key: 'k1' }, 10);
  assert.equal(core.verifyAudit(), true, 'untampered chain verifies');
  core.audit[0].data.amount = 999; // tamper with history
  assert.equal(core.verifyAudit(), false, 'tampered chain is detected');
});
