import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateHistory,
  InvalidHistory,
  createInitialState,
  applyOp,
} from '../src/model.js';

const base = { client: 'c1', opId: 'op1', invocationTime: 0, responseTime: 1, account: 'a' };

test('rejects non-array history', () => {
  assert.throws(() => validateHistory({}), (e) => e instanceof InvalidHistory && e.code === 'INVALID_HISTORY');
});

test('rejects negative amount as INVALID_HISTORY', () => {
  const h = [{ ...base, type: 'reserve', amount: -1, reserveId: 'r1' }];
  assert.throws(() => validateHistory(h), /amount/);
});

test('rejects time inversion as INVALID_HISTORY', () => {
  const h = [{ ...base, invocationTime: 5, responseTime: 2, type: 'reserve', amount: 1, reserveId: 'r1' }];
  assert.throws(() => validateHistory(h), /time inversion/);
});

test('rejects duplicate opId (duplicate response) as INVALID_HISTORY', () => {
  const h = [
    { ...base, type: 'reserve', amount: 1, reserveId: 'r1' },
    { ...base, invocationTime: 2, responseTime: 3, type: 'cancel', reserveId: 'r1' },
  ];
  assert.throws(() => validateHistory(h), /duplicate opId/);
});

test('rejects read without observed balance/frozen', () => {
  const h = [{ ...base, type: 'read' }];
  assert.throws(() => validateHistory(h), /balance/);
});

test('zero amount reserve succeeds and holds nothing', () => {
  const state = createInitialState(100);
  const r = applyOp(state, { ...base, type: 'reserve', amount: 0, reserveId: 'rz' });
  assert.equal(r.ok, true);
  const read = applyOp(state, { ...base, type: 'read' });
  assert.deepEqual({ balance: read.balance, frozen: read.frozen }, { balance: 100, frozen: 0 });
});

test('zero amount reservation can be committed and cancelled exactly once', () => {
  const state = createInitialState(0);
  applyOp(state, { ...base, type: 'reserve', amount: 0, reserveId: 'rz' });
  assert.equal(applyOp(state, { ...base, type: 'commit', reserveId: 'rz' }).ok, true);
  assert.equal(applyOp(state, { ...base, type: 'commit', reserveId: 'rz' }).ok, false);
  assert.equal(applyOp(state, { ...base, type: 'cancel', reserveId: 'rz' }).ok, false);
});

test('commit/cancel of unknown reserveId is a failed op, not an error', () => {
  const state = createInitialState(50);
  assert.equal(applyOp(state, { ...base, type: 'commit', reserveId: 'nope' }).ok, false);
  assert.equal(applyOp(state, { ...base, type: 'cancel', reserveId: 'nope' }).ok, false);
});

test('reserve fails when funds are insufficient', () => {
  const state = createInitialState(10);
  assert.equal(applyOp(state, { ...base, type: 'reserve', amount: 11, reserveId: 'r1' }).ok, false);
  assert.equal(applyOp(state, { ...base, type: 'reserve', amount: 10, reserveId: 'r1' }).ok, true);
});

test('cancel returns funds to balance; commit releases the hold', () => {
  const s1 = createInitialState(100);
  applyOp(s1, { ...base, type: 'reserve', amount: 40, reserveId: 'r1' });
  applyOp(s1, { ...base, type: 'cancel', reserveId: 'r1' });
  let read = applyOp(s1, { ...base, type: 'read' });
  assert.deepEqual({ balance: read.balance, frozen: read.frozen }, { balance: 100, frozen: 0 });

  const s2 = createInitialState(100);
  applyOp(s2, { ...base, type: 'reserve', amount: 40, reserveId: 'r1' });
  applyOp(s2, { ...base, type: 'commit', reserveId: 'r1' });
  read = applyOp(s2, { ...base, type: 'read' });
  assert.deepEqual({ balance: read.balance, frozen: read.frozen }, { balance: 60, frozen: 0 });
});
