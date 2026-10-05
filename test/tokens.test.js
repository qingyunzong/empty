'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ALPHABET, ALPHABET_SIZE, TOKEN_INDEX, tokenizeTx, amountBucket, periodBucket } = require('../src/tokens');

test('amount bucket boundaries', () => {
  assert.equal(amountBucket(0), 'L');
  assert.equal(amountBucket(99.99), 'L');
  assert.equal(amountBucket(100), 'M');
  assert.equal(amountBucket(999.99), 'M');
  assert.equal(amountBucket(1000), 'H');
  assert.equal(amountBucket(9999.99), 'H');
  assert.equal(amountBucket(10000), 'X');
});

test('period bucket boundaries', () => {
  assert.equal(periodBucket(0), 'N');
  assert.equal(periodBucket(5), 'N');
  assert.equal(periodBucket(6), 'M');
  assert.equal(periodBucket(11), 'M');
  assert.equal(periodBucket(12), 'A');
  assert.equal(periodBucket(17), 'A');
  assert.equal(periodBucket(18), 'E');
  assert.equal(periodBucket(23), 'E');
});

test('tokenizeTx maps a full transaction', () => {
  const tok = tokenizeTx({ amount: 5000, hour: 2, region: 'foreign', channel: 'ecom', history: true });
  assert.equal(tok, 'HNFE1');
});

test('TOKEN_UNKNOWN for out-of-domain fields', () => {
  for (const tx of [
    { amount: -5, hour: 10, region: 'domestic', channel: 'pos' },
    { amount: 10, hour: 24, region: 'domestic', channel: 'pos' },
    { amount: 10, hour: 10, region: 'mars', channel: 'pos' },
    { amount: 10, hour: 10, region: 'domestic', channel: 'smoke-signal' },
    { amount: 10, hour: 10, region: 'domestic', channel: 'pos', history: 'maybe' },
  ]) {
    assert.throws(() => tokenizeTx(tx), (e) => e.code === 'TOKEN_UNKNOWN');
  }
});

test('alphabet is 192 tokens in five-tuple lexicographic order', () => {
  assert.equal(ALPHABET_SIZE, 192);
  assert.equal(ALPHABET[0], 'LNDP0');
  assert.equal(ALPHABET[ALPHABET_SIZE - 1], 'XEFA1');
  for (let i = 0; i < ALPHABET_SIZE; i++) assert.equal(TOKEN_INDEX.get(ALPHABET[i]), i);
});
