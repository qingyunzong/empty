import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine } from '../src/engine.js';
import { canon } from '../src/canon.js';
import { toBase } from '../src/rates.js';

const RATES = { USD: 1000000, EUR: 1100000, JPY: 9000 };

function engineWith(trades, { limits = null, capacity = null } = {}) {
  const e = new ClearingEngine({ base: 'USD', limits, capacity });
  e.addRateVersion(1, RATES);
  e.setTrades(trades);
  return e;
}

test('bilateral offset nets opposite flows', () => {
  const e = engineWith([
    { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 },
    { id: 't2', from: 'b', to: 'a', ccy: 'USD', amount: 40 },
  ]);
  const r = e.settle();
  assert.deepEqual(r.netPositions, { a: -60, b: 60 });
  assert.deepEqual(r.locks, { a: 60 });
  assert.deepEqual(r.residualFlows, [{ from: 'a', to: 'b', amount: 60 }]);
  assert.deepEqual(r.cycles, []);
});

test('multi-currency trades are converted through the rate table', () => {
  const e = engineWith([{ id: 't1', from: 'a', to: 'b', ccy: 'EUR', amount: 100 }]);
  const r = e.settle();
  assert.equal(r.netPositions.a, -110);
  assert.equal(r.netPositions.b, 110);
});

test('conversion rounds half-up deterministically', () => {
  assert.equal(toBase(1, 1500000), 2); // 1.5 -> 2
  assert.equal(toBase(3, 1500000), 5); // 4.5 -> 5
  assert.equal(toBase(100, 1100000), 110);
});

test('a balanced cycle nets to zero and needs no locks (cycles are not unsatisfiable)', () => {
  const e = engineWith(
    [
      { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 },
      { id: 't2', from: 'b', to: 'c', ccy: 'USD', amount: 100 },
      { id: 't3', from: 'c', to: 'a', ccy: 'USD', amount: 100 },
    ],
    { limits: { a: 0, b: 0, c: 0 } },
  );
  const r = e.settle();
  assert.deepEqual(r.netPositions, { a: 0, b: 0, c: 0 });
  assert.deepEqual(r.locks, {});
  assert.deepEqual(r.residualFlows, []);
  assert.deepEqual(r.cycles, [{ component: 'a', nodes: ['a', 'b', 'c'], amount: 100, tradeIds: ['t1', 't2', 't3'] }]);
});

test('an imbalanced cycle is cancelled by its minimum edge', () => {
  const e = engineWith([
    { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 },
    { id: 't2', from: 'b', to: 'c', ccy: 'USD', amount: 100 },
    { id: 't3', from: 'c', to: 'a', ccy: 'USD', amount: 150 },
  ]);
  const r = e.settle();
  assert.deepEqual(r.netPositions, { a: 50, b: 0, c: -50 });
  assert.deepEqual(r.locks, { c: 50 });
  assert.deepEqual(r.residualFlows, [{ from: 'c', to: 'a', amount: 50 }]);
});

test('overlapping cycles reduce deterministically', () => {
  const trades = [
    { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 10 },
    { id: 't2', from: 'b', to: 'c', ccy: 'USD', amount: 10 },
    { id: 't3', from: 'c', to: 'a', ccy: 'USD', amount: 10 },
    { id: 't4', from: 'b', to: 'd', ccy: 'USD', amount: 7 },
    { id: 't5', from: 'd', to: 'a', ccy: 'USD', amount: 7 },
  ];
  const r1 = engineWith(trades).settle();
  const r2 = engineWith([...trades].reverse()).settle();
  assert.equal(canon(r1), canon(r2));
  assert.deepEqual(r1.netPositions, { a: 7, b: -7, c: 0, d: 0 });
});

test('same trades and rate version give identical output regardless of input order', () => {
  const trades = [
    { id: 't1', from: 'a', to: 'b', ccy: 'EUR', amount: 100 },
    { id: 't2', from: 'b', to: 'c', ccy: 'JPY', amount: 5000 },
    { id: 't3', from: 'c', to: 'a', ccy: 'USD', amount: 90 },
    { id: 't4', from: 'a', to: 'c', ccy: 'USD', amount: 10 },
  ];
  const e1 = engineWith(trades, { limits: { a: 1000, b: 1000, c: 1000 }, capacity: 5000 });
  const e2 = engineWith([...trades].reverse(), { limits: { c: 1000, b: 1000, a: 1000 }, capacity: 5000 });
  const r1 = e1.settle();
  const r2 = e2.settle();
  assert.equal(canon(r1), canon(r2));
  assert.equal(r1.proof.inputHash, r2.proof.inputHash);
  assert.equal(r1.proof.rulesVersion, 'netting-rules/1.0.0');
  assert.equal(r1.proof.ratesVersion, 1);
});

test('proof input hash changes when a rate version changes', () => {
  const trades = [{ id: 't1', from: 'a', to: 'b', ccy: 'EUR', amount: 100 }];
  const e = engineWith(trades);
  const h1 = e.settle().proof.inputHash;
  e.correctRates({ EUR: 1200000 });
  const h2 = e.result.proof.inputHash;
  assert.notEqual(h1, h2);
  assert.equal(e.result.proof.ratesVersion, 2);
});
