import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine } from '../src/engine.js';
import { CODES } from '../src/errors.js';

const RATES = { USD: 1000000 };

function engineWith(trades, opts = {}) {
  const e = new ClearingEngine({ base: 'USD', ...opts });
  e.addRateVersion(1, RATES);
  e.setTrades(trades);
  return e;
}

test('frozen limit boundary: lock exactly equal to limit is accepted', () => {
  const trades = [{ id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 }];
  const ok = engineWith(trades, { limits: { a: 100 } }).settle();
  assert.deepEqual(ok.locks, { a: 100 });
  assert.throws(
    () => engineWith(trades, { limits: { a: 99 } }).settle(),
    (err) => {
      assert.equal(err.code, CODES.LIMIT);
      assert.deepEqual(err.details, { participant: 'a', required: 100, limit: 99 });
      return true;
    },
  );
});

test('window capacity boundary: total locks exactly equal to capacity is accepted', () => {
  const trades = [
    { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 60 },
    { id: 't2', from: 'c', to: 'd', ccy: 'USD', amount: 40 },
  ];
  const ok = engineWith(trades, { capacity: 100 }).settle();
  assert.equal(ok.window.locked, 100);
  assert.throws(
    () => engineWith(trades, { capacity: 99 }).settle(),
    (err) => {
      assert.equal(err.code, CODES.LIMIT);
      assert.deepEqual(err.details, { scope: 'window', required: 100, capacity: 99 });
      return true;
    },
  );
});

test('unnettable cycle reports CYCLE_LOCKED with the minimal conflict set', () => {
  const trades = [
    { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 },
    { id: 't2', from: 'b', to: 'c', ccy: 'USD', amount: 100 },
    { id: 't3', from: 'c', to: 'a', ccy: 'USD', amount: 150 },
  ];
  assert.throws(
    () => engineWith(trades, { limits: { a: 1000, b: 1000, c: 10 } }).settle(),
    (err) => {
      assert.equal(err.code, CODES.CYCLE_LOCKED);
      assert.equal(err.details.participant, 'c');
      assert.equal(err.details.required, 50);
      assert.equal(err.details.limit, 10);
      assert.deepEqual(err.details.cycle, ['a', 'b', 'c']);
      // minimal conflict set: every trade of the shortest cycle through the
      // deficient participant; removing any one of them breaks the cycle.
      assert.deepEqual(err.details.conflictSet, ['t1', 't2', 't3']);
      return true;
    },
  );
});

test('deficiency outside any cycle is LIMIT, not CYCLE_LOCKED', () => {
  const trades = [{ id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 }];
  assert.throws(
    () => engineWith(trades, { limits: { a: 50 } }).settle(),
    (err) => err.code === CODES.LIMIT,
  );
});

test('a cycle that fits within limits settles instead of locking', () => {
  const trades = [
    { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 },
    { id: 't2', from: 'b', to: 'c', ccy: 'USD', amount: 100 },
    { id: 't3', from: 'c', to: 'a', ccy: 'USD', amount: 150 },
  ];
  const r = engineWith(trades, { limits: { c: 50 } }).settle();
  assert.deepEqual(r.locks, { c: 50 });
});

test('participants missing from the limits map are treated as zero', () => {
  const trades = [{ id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 1 }];
  assert.throws(
    () => engineWith(trades, { limits: {} }).settle(),
    (err) => err.code === CODES.LIMIT && err.details.limit === 0,
  );
});

test('validation errors use INVALID_INPUT', () => {
  assert.throws(
    () => engineWith([{ id: 't1', from: 'a', to: 'a', ccy: 'USD', amount: 1 }]),
    (err) => err.code === CODES.INVALID_INPUT,
  );
  assert.throws(
    () => engineWith([{ id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 0 }]),
    (err) => err.code === CODES.INVALID_INPUT,
  );
  assert.throws(
    () =>
      engineWith([
        { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 1 },
        { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 2 },
      ]),
    (err) => err.code === CODES.INVALID_INPUT,
  );
  assert.throws(
    () => engineWith([{ id: 't1', from: 'a', to: 'b', ccy: 'XXX', amount: 1 }]).settle(),
    (err) => err.code === CODES.INVALID_INPUT,
  );
});
