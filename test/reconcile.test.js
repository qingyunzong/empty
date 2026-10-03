'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchLayer, reconcile } = require('../lib/reconcile');

test('equal-amount tie: all candidates listed, lexicographically smallest chosen', () => {
  const left = [{ id: 'L1', amount: 100, currency: 'CNY', ts: 1000 }];
  const right = [
    { id: 'R2', amount: 100, currency: 'CNY', ts: 1001 },
    { id: 'R1', amount: 100, currency: 'CNY', ts: 1002 },
    { id: 'R3', amount: 100, currency: 'CNY', ts: 999999 },
  ];
  const res = matchLayer(left, right, 10);
  assert.equal(res.matched.length, 1);
  assert.deepEqual(res.matched[0].alternatives, ['R1', 'R2']);
  assert.deepEqual(res.matched[0].right, ['R1']);
  assert.deepEqual(res.unmatchedRight, ['R2', 'R3']);
});

test('one-to-many match with equal total', () => {
  const left = [{ id: 'L1', amount: 100, currency: 'CNY', ts: 0 }];
  const right = [
    { id: 'R1', amount: 60, currency: 'CNY', ts: 1 },
    { id: 'R2', amount: 40, currency: 'CNY', ts: 2 },
  ];
  const res = matchLayer(left, right, 10);
  assert.equal(res.matched.length, 1);
  assert.deepEqual(res.matched[0].left, ['L1']);
  assert.deepEqual(res.matched[0].right, ['R1', 'R2']);
  assert.equal(res.unmatchedLeft.length, 0);
  assert.equal(res.unmatchedRight.length, 0);
});

test('many-to-one match with equal total', () => {
  const left = [
    { id: 'L1', amount: 30, currency: 'CNY', ts: 0 },
    { id: 'L2', amount: 70, currency: 'CNY', ts: 1 },
  ];
  const right = [{ id: 'R1', amount: 100, currency: 'CNY', ts: 2 }];
  const res = matchLayer(left, right, 10);
  assert.equal(res.matched.length, 1);
  assert.deepEqual(res.matched[0].left, ['L1', 'L2']);
  assert.deepEqual(res.matched[0].right, ['R1']);
});

test('unmatched on currency, amount and time-window mismatch', () => {
  const left = [
    { id: 'L1', amount: 100, currency: 'CNY', ts: 0 },
    { id: 'L2', amount: 100, currency: 'USD', ts: 0 },
    { id: 'L3', amount: 100, currency: 'CNY', ts: 100000 },
  ];
  const right = [{ id: 'R1', amount: 100, currency: 'CNY', ts: 5 }];
  const res = matchLayer(left, right, 10);
  assert.equal(res.matched.length, 1);
  assert.deepEqual(res.unmatchedLeft, ['L2', 'L3']);
});

test('three-layer reconcile produces matched and unmatched', () => {
  const channels = [
    { txId: 'T1', batchId: 'B1', customerId: 'C1', amount: '100', currency: 'CNY', timestamp: '1000' },
    { txId: 'T2', batchId: 'B1', customerId: 'C1', amount: '50', currency: 'CNY', timestamp: '1010' },
    { txId: 'T9', batchId: 'B1', customerId: 'C1', amount: '7', currency: 'CNY', timestamp: '1020' },
  ];
  const clearing = [
    { recordId: 'CL1', batchId: 'B2', amount: '100', currency: 'CNY', timestamp: '1005' },
    { recordId: 'CL2', batchId: 'B2', amount: '50', currency: 'CNY', timestamp: '1012' },
  ];
  const bank = [
    { receiptId: 'R1', batchId: 'B3', amount: '150', currency: 'CNY', timestamp: '1008', confirmed: 'false' },
  ];
  const res = reconcile({ channels, clearing, bank, windowSec: 60 });
  assert.equal(res.channelClearing.matched.length, 2);
  assert.deepEqual(res.channelClearing.unmatchedLeft, ['T9']);
  assert.equal(res.clearingBank.matched.length, 1);
  assert.deepEqual(res.clearingBank.matched[0].left, ['CL1', 'CL2']);
  assert.deepEqual(res.clearingBank.matched[0].right, ['R1']);
});
