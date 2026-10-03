'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ERR, guard, applyEvent, createState, project, projectionOf } = require('../lib/model');

function stateWith(events) {
  const st = createState();
  for (const e of events) {
    const g = guard(st, e);
    assert.equal(g.ok, true, `setup event failed: ${JSON.stringify(e)} -> ${g.message}`);
    applyEvent(st, e);
  }
  return st;
}

test('sale freezes its own amount; project reports balance and frozen', () => {
  const st = stateWith([{ type: 'sale', id: 's1', account: 'A', amount: 10 }]);
  assert.deepEqual(projectionOf(st).accounts.A, { balance: 10, frozen: 10 });
});

test('refund reverses sale and releases the linked freeze atomically', () => {
  const st = stateWith([
    { type: 'sale', id: 's1', account: 'A', amount: 10 },
    { type: 'refund', id: 'r1', ref: 's1', amount: 4 },
  ]);
  assert.deepEqual(projectionOf(st).accounts.A, { balance: 6, frozen: 6 });
  assert.equal(st.sales.s1.refunded, 4);
});

test('refund with dangling sale reference -> code 30', () => {
  const st = stateWith([{ type: 'sale', id: 's1', account: 'A', amount: 10 }]);
  const g = guard(st, { type: 'refund', id: 'r1', ref: 'nope', amount: 1 });
  assert.equal(g.ok, false);
  assert.equal(g.code, ERR.DANGLING_REF);
  assert.equal(g.code, 30);
});

test('refund exceeding remaining sale amount -> code 31', () => {
  const st = stateWith([
    { type: 'sale', id: 's1', account: 'A', amount: 10 },
    { type: 'refund', id: 'r1', ref: 's1', amount: 10 },
  ]);
  const g = guard(st, { type: 'refund', id: 'r2', ref: 's1', amount: 1 });
  assert.equal(g.code, 31);
});

test('refund when freeze already consumed -> code 32, nothing applied', () => {
  const st = stateWith([
    { type: 'sale', id: 's1', account: 'A', amount: 10 },
    { type: 'unfreeze', account: 'A', amount: 8 },
  ]);
  const before = projectionOf(st);
  const g = guard(st, { type: 'refund', id: 'r1', ref: 's1', amount: 5 });
  assert.equal(g.code, 32);
  assert.deepEqual(projectionOf(st), before, 'failed refund must not change state');
});

test('unfreeze beyond frozen -> code 32', () => {
  const st = stateWith([{ type: 'sale', id: 's1', account: 'A', amount: 5 }]);
  assert.equal(guard(st, { type: 'unfreeze', account: 'A', amount: 6 }).code, 32);
});

test('refundVoid restores money and freeze; only latest unconsumed refund is voidable', () => {
  const st = stateWith([
    { type: 'sale', id: 's1', account: 'A', amount: 10 },
    { type: 'refund', id: 'r1', ref: 's1', amount: 3 },
    { type: 'refund', id: 'r2', ref: 's1', amount: 2 },
  ]);
  // r1 is not the most recent refund -> not voidable
  assert.equal(guard(st, { type: 'refundVoid', ref: 'r1' }).code, 33);
  // r2 is the most recent unconsumed refund -> voidable
  assert.equal(guard(st, { type: 'refundVoid', ref: 'r2' }).ok, true);
  applyEvent(st, { type: 'refundVoid', ref: 'r2' });
  assert.deepEqual(projectionOf(st).accounts.A, { balance: 7, frozen: 7 });
  assert.equal(st.sales.s1.refunded, 3);
  // already voided -> not voidable again
  assert.equal(guard(st, { type: 'refundVoid', ref: 'r2' }).code, 33);
  // dangling refund reference -> 30
  assert.equal(guard(st, { type: 'refundVoid', ref: 'ghost' }).code, 30);
});

test('project folds a log and rejects invalid logs', () => {
  const log = [
    { type: 'sale', id: 's1', account: 'A', amount: 10 },
    { type: 'freeze', account: 'A', amount: 2 },
    { type: 'refund', id: 'r1', ref: 's1', amount: 5 },
    { type: 'refundVoid', ref: 'r1' },
  ];
  const st = project(log);
  assert.deepEqual(projectionOf(st).accounts.A, { balance: 8, frozen: 12 });
  assert.throws(() => project([{ type: 'refund', id: 'x', ref: 'ghost', amount: 1 }]), /30|dangling/);
});
