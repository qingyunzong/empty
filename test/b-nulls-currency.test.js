'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, NULL_CURRENCY_BUCKET } = require('../src/ledger');

const DAY = '2026-10-02';

function capture(l, id, over = {}) {
  l.apply({ type: 'auth', id, merchant: 'm', day: DAY, amount: 100, currency: 'USD', tip: null, ...over });
  l.apply({ type: 'capture', id });
}

test('B: NULL tip is ignored in fee aggregation', () => {
  const l = new Ledger();
  capture(l, 't1', { tip: 10 });
  capture(l, 't2', { tip: null });
  capture(l, 't3', {}); // tip omitted entirely
  const bucket = l.merchantStats('m', DAY).buckets.USD;
  assert.equal(bucket.count, 3);
  assert.equal(bucket.tipSum, 10);   // only the non-null tip contributes
  assert.equal(bucket.tipCount, 1);
  assert.equal(bucket.sum, 300);
});

test('B: NULL amount ignored by min/max/sum but capture counted', () => {
  const l = new Ledger();
  capture(l, 'a1', { amount: 50 });
  capture(l, 'a2', { amount: null });
  capture(l, 'a3', { amount: 150 });
  const bucket = l.merchantStats('m', DAY).buckets.USD;
  assert.equal(bucket.count, 3);
  assert.equal(bucket.sum, 200);
  assert.equal(bucket.min, 50);
  assert.equal(bucket.max, 150);
});

test('B: unknown currency is not converted and gets its own bucket', () => {
  const l = new Ledger();
  capture(l, 'u1', { amount: 100, currency: 'USD' });
  capture(l, 'u2', { amount: 100, currency: 'EUR' });   // known: converted at 1.08
  capture(l, 'u3', { amount: 700, currency: 'XTS' });   // unknown: separate bucket, no conversion
  capture(l, 'u4', { amount: 40, currency: null });     // null currency: UNKNOWN bucket, no conversion
  const stats = l.merchantStats('m', DAY);
  assert.deepEqual(Object.keys(stats.buckets).sort(), ['EUR', 'USD', 'XTS', NULL_CURRENCY_BUCKET].sort());
  assert.equal(stats.buckets.XTS.sum, 700);
  assert.equal(stats.buckets.UNKNOWN.sum, 40);
  // converted bucket contains only USD (100) + EUR (108); XTS and null excluded
  assert.equal(stats.converted.currency, 'USD');
  assert.equal(stats.converted.count, 2);
  assert.ok(Math.abs(stats.converted.sum - 208) < 1e-9);
});
