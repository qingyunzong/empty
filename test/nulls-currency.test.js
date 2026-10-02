import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

function capture(ledger, id, overrides = {}) {
  ledger.apply({
    type: 'auth',
    id,
    merchant: 'm',
    day: '2024-02-01',
    amount: 100,
    currency: 'USD',
    ...overrides,
  });
  ledger.apply({ type: 'capture', id, day: '2024-02-01' });
}

test('B: NULL tip is ignored in fee aggregation', () => {
  const ledger = new Ledger();
  capture(ledger, 't1', { tip: null }); // effective 100
  capture(ledger, 't2', { tip: 30 }); // effective 130
  capture(ledger, 't3', {}); // tip absent -> null -> effective 100
  const stats = ledger.merchantStats('m', '2024-02-01');
  assert.deepEqual(stats.currencies.USD, { count: 3, min: 100, max: 130, sum: 330 });
  assert.equal(stats.totalUsd, 330);
});

test('B: NULL amount contributes nothing to min/max/sum', () => {
  const ledger = new Ledger();
  capture(ledger, 't1', { amount: null, tip: 50 }); // skipped entirely
  capture(ledger, 't2', { amount: 200, tip: null });
  const stats = ledger.merchantStats('m', '2024-02-01');
  assert.deepEqual(stats.currencies.USD, { count: 1, min: 200, max: 200, sum: 200 });
});

test('B: unknown currency is not converted and gets its own bucket', () => {
  const ledger = new Ledger();
  capture(ledger, 't1', { amount: 100, currency: 'USD' });
  capture(ledger, 't2', { amount: 500, currency: 'XAU' }); // unknown
  capture(ledger, 't3', { amount: 700, currency: 'XAU', tip: 50 });
  capture(ledger, 't4', { amount: 200, currency: null }); // NULL currency bucket
  const stats = ledger.merchantStats('m', '2024-02-01');
  assert.deepEqual(stats.currencies.XAU, { count: 2, min: 500, max: 750, sum: 1250 });
  assert.deepEqual(stats.currencies.UNKNOWN, { count: 1, min: 200, max: 200, sum: 200 });
  // only the known USD bucket is converted into the base total
  assert.equal(stats.totalUsd, 100);
});

test('B: known foreign currency is converted into totalUsd, bucket stays native', () => {
  const ledger = new Ledger();
  capture(ledger, 't1', { amount: 1000, currency: 'EUR' }); // rate 1.1
  const stats = ledger.merchantStats('m', '2024-02-01');
  assert.deepEqual(stats.currencies.EUR, { count: 1, min: 1000, max: 1000, sum: 1000 });
  assert.equal(stats.totalUsd, 1100);
});

test('B: empty merchant/day yields empty stats', () => {
  const ledger = new Ledger();
  assert.deepEqual(ledger.merchantStats('nobody', '2024-02-01'), {
    merchant: 'nobody',
    day: '2024-02-01',
    currencies: {},
    totalUsd: 0,
  });
});
