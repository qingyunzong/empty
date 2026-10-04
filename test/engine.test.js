'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sign } = require('../src/frames');
const engine = require('../src/engine');

const run = (frames) => engine.run(frames.map(sign));
const kinds = (r) => r.events.map((e) => e.kind);

test('acceptance 1: amend may not cross the filled portion', () => {
  const r = run([
    { type: 'limits', seq: 0, funds: 1000, securities: 100 },
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 10, price: 5, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'S', side: 'sell', qty: 6, price: 5, ts: 0 },
    { type: 'match', seq: 3, ts: 1 },
    { type: 'amend', seq: 4, clOrdId: 'A1', origId: 'B', qty: 3, ts: 2 },
    { type: 'amend', seq: 5, clOrdId: 'A2', origId: 'B', qty: 8, ts: 2 },
  ]);
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].qty, 6);
  const rejected = r.events.find((e) => e.kind === 'amend_rejected');
  assert.equal(rejected.reason, 'crosses_filled');
  assert.equal(rejected.filled, 6);
  const accepted = r.events.find((e) => e.kind === 'amend_accepted');
  assert.equal(accepted.qty, 8);
  const b = r.orders.find((o) => o.clOrdId === 'B');
  assert.equal(b.filled, 6); // filled portion untouched
  assert.equal(b.qty, 8);
  assert.equal(b.remaining, 2);
});

test('acceptance 2a: cancel before match at the same tick wins by log order', () => {
  const r = run([
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 10, price: 5, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'S', side: 'sell', qty: 10, price: 5, ts: 0 },
    { type: 'cancel', seq: 3, origId: 'S', ts: 5 },
    { type: 'match', seq: 4, ts: 5 },
  ]);
  assert.equal(r.fills.length, 0);
  assert.ok(kinds(r).includes('cancel_accepted'));
  assert.equal(r.orders.find((o) => o.clOrdId === 'S').status, 'cancelled');
});

test('acceptance 2b: match before cancel at the same tick fills first', () => {
  const r = run([
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 10, price: 5, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'S', side: 'sell', qty: 10, price: 5, ts: 0 },
    { type: 'match', seq: 3, ts: 5 },
    { type: 'cancel', seq: 4, origId: 'S', ts: 5 },
  ]);
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].qty, 10);
  const rej = r.events.find((e) => e.kind === 'cancel_rejected');
  assert.equal(rej.status, 'filled');
});

test('acceptance 3: funds sufficient but securities insufficient -> rejected, no unilateral deduction', () => {
  const r = run([
    { type: 'limits', seq: 0, funds: 1000, securities: 5 },
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 10, price: 10, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'S', side: 'sell', qty: 10, price: 10, ts: 0 },
    { type: 'match', seq: 3, ts: 1 },
  ]);
  assert.equal(r.fills.length, 0);
  const rej = r.events.find((e) => e.kind === 'order_rejected');
  assert.equal(rej.clOrdId, 'S');
  assert.equal(rej.reason, 'insufficient_securities');
  assert.equal(r.accounts.securities.frozen, 0); // nothing deducted on the short side
  assert.equal(r.accounts.securities.spent, 0);
  assert.equal(r.accounts.funds.frozen, 100); // buyer's own freeze only
  assert.equal(r.accounts.funds.spent, 0);
});

test('acceptance 4: unmatched order is released when the window times out', () => {
  const r = run([
    { type: 'limits', seq: 0, funds: 1000, window: 50 },
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 10, price: 5, ts: 0 },
    { type: 'match', seq: 2, ts: 30 },
    { type: 'match', seq: 3, ts: 60 },
  ]);
  assert.equal(r.fills.length, 0);
  const exp = r.events.find((e) => e.kind === 'expired');
  assert.equal(exp.clOrdId, 'B');
  assert.equal(exp.qty, 10);
  assert.equal(exp.releasedFunds, 50);
  assert.equal(r.accounts.funds.frozen, 0);
  assert.equal(r.accounts.funds.available, 1000);
  assert.equal(r.orders[0].status, 'expired');
});

test('partial fills leave a remaining quantity that keeps priority', () => {
  const r = run([
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 10, price: 5, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'S1', side: 'sell', qty: 4, price: 5, ts: 0 },
    { type: 'match', seq: 3, ts: 1 },
    { type: 'new', seq: 4, clOrdId: 'S2', side: 'sell', qty: 6, price: 5, ts: 2 },
    { type: 'match', seq: 5, ts: 3 },
  ]);
  assert.deepEqual(r.fills.map((f) => f.qty), [4, 6]);
  assert.equal(r.orders.find((o) => o.clOrdId === 'B').status, 'filled');
});

test('price-time priority, same price and same tick broken by clOrdId', () => {
  const r = run([
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 15, price: 10, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'Z1', side: 'sell', qty: 5, price: 4, ts: 0 },
    { type: 'new', seq: 3, clOrdId: 'A1', side: 'sell', qty: 5, price: 4, ts: 0 },
    { type: 'new', seq: 4, clOrdId: 'P1', side: 'sell', qty: 5, price: 3, ts: 9 },
    { type: 'match', seq: 5, ts: 10 },
  ]);
  // best price first (P1 @3), then same price same tick by clOrdId (A1 before Z1)
  assert.deepEqual(r.fills.map((f) => f.sellId), ['P1', 'A1', 'Z1']);
});

test('execution uses the maker price and refunds the improvement', () => {
  const r = run([
    { type: 'limits', seq: 0, funds: 1000 },
    { type: 'new', seq: 1, clOrdId: 'S', side: 'sell', qty: 5, price: 4, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'B', side: 'buy', qty: 5, price: 7, ts: 1 },
    { type: 'match', seq: 3, ts: 2 },
  ]);
  assert.equal(r.fills[0].price, 4); // seller rested first
  assert.equal(r.accounts.funds.frozen, 20); // 5*4, not 5*7
});

test('retransmission is deduplicated by seq and by clOrdId payload', () => {
  const frames = [
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 10, price: 5, ts: 0 },
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 10, price: 5, ts: 0 }, // same seq resend
    { type: 'new', seq: 2, clOrdId: 'B', side: 'buy', qty: 10, price: 5, ts: 0 }, // new seq, same payload
  ];
  const r = engine.run(frames.map(sign));
  assert.equal(r.orders.length, 1);
  assert.equal(r.events.filter((e) => e.kind === 'order_accepted').length, 1);
  assert.equal(r.events.filter((e) => e.kind === 'duplicate_ignored').length, 1);
});

test('out-of-order arrival is replayed in seq order', () => {
  const frames = [
    { type: 'match', seq: 3, ts: 1 },
    { type: 'new', seq: 2, clOrdId: 'S', side: 'sell', qty: 5, price: 5, ts: 0 },
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 5, ts: 0 },
  ];
  const r = engine.run(frames.map(sign));
  assert.equal(r.fills.length, 1);
});

test('settle finalizes, fail appends compensation without erasing the ledger', () => {
  const r = run([
    { type: 'limits', seq: 0, funds: 100, securities: 10 },
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'S', side: 'sell', qty: 5, price: 10, ts: 0 },
    { type: 'match', seq: 3, ts: 1 },
    { type: 'settle', seq: 4, ts: 2 },
    { type: 'fail', seq: 5, origId: 'B', ts: 3 },
    { type: 'amend', seq: 6, clOrdId: 'A1', origId: 'B', qty: 9, ts: 4 },
  ]);
  assert.equal(r.fills[0].settled, true);
  assert.equal(r.fills[0].compensated, true);
  assert.deepEqual(r.compensations, [
    { fillId: 'F1', triggeredBy: 'B', fundsCredited: 50, securitiesCredited: 5 },
  ]);
  // settled event stays in the audit log; compensation is appended, not erased
  assert.ok(kinds(r).includes('settled'));
  assert.ok(kinds(r).includes('fail_compensation'));
  assert.equal(r.accounts.funds.spent, 0);
  assert.equal(r.accounts.securities.spent, 0);
  // after fill+settle the order is no longer open to amend
  assert.ok(kinds(r).includes('amend_rejected'));
});

test('fail before settle is rejected', () => {
  const r = run([
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10, ts: 0 },
    { type: 'fail', seq: 2, origId: 'B', ts: 1 },
  ]);
  assert.ok(kinds(r).includes('fail_rejected'));
});

test('audit root is deterministic and replay-independent of arrival order', () => {
  const frames = [
    { type: 'limits', seq: 0, funds: 100, securities: 10 },
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'S', side: 'sell', qty: 5, price: 9, ts: 0 },
    { type: 'match', seq: 3, ts: 1 },
    { type: 'settle', seq: 4, ts: 2 },
  ].map(sign);
  const a = engine.run(frames);
  const b = engine.run([...frames].reverse());
  assert.equal(a.auditRoot, b.auditRoot);
  assert.match(a.auditRoot, /^[0-9a-f]{64}$/);
});
