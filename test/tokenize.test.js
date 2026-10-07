'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenizeTx, ALPHABET, TOKEN_INDEX } = require('../src/tokenize');
const { RiskError } = require('../src/errors');

test('tokenize maps transaction to canonical 5-tuple token', () => {
  const tok = tokenizeTx({
    id: 't1',
    account: 'a',
    amount: 5000,
    hour: 20,
    region: 'crossborder',
    channel: 'online',
    history: 'flagged',
  });
  assert.equal(tok, 'a2t3r1c1h1');
});

test('amount tier boundaries', () => {
  const base = { id: 'x', account: 'a', hour: 0, region: 'domestic', channel: 'pos', history: 'clean' };
  assert.equal(tokenizeTx({ ...base, amount: 99.99 }).slice(0, 2), 'a0');
  assert.equal(tokenizeTx({ ...base, amount: 100 }).slice(0, 2), 'a1');
  assert.equal(tokenizeTx({ ...base, amount: 1000 }).slice(0, 2), 'a2');
  assert.equal(tokenizeTx({ ...base, amount: 10000 }).slice(0, 2), 'a3');
});

test('alphabet is sorted so string order equals tuple lexicographic order', () => {
  const sorted = [...ALPHABET].sort();
  assert.deepEqual(ALPHABET, sorted);
  assert.equal(ALPHABET.length, 4 * 4 * 3 * 3 * 2);
  assert.equal(TOKEN_INDEX.get('a0t0r0c0h0'), 0);
});

test('unknown dimension value raises TOKEN_UNKNOWN', () => {
  assert.throws(
    () => tokenizeTx({ id: 'bad', account: 'a', amount: 10, hour: 3, region: 'moon', channel: 'pos', history: 'clean' }),
    (err) => err instanceof RiskError && err.code === 'TOKEN_UNKNOWN'
  );
  assert.throws(
    () => tokenizeTx({ id: 'bad2', account: 'a', amount: -5, hour: 3, region: 'domestic', channel: 'pos', history: 'clean' }),
    (err) => err.code === 'TOKEN_UNKNOWN'
  );
});
