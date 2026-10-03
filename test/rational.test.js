import test from 'node:test';
import assert from 'node:assert/strict';
import { add, cmp, parseRat, rat, ratToString } from '../src/rational.js';

test('parses and normalizes p/q forms', () => {
  assert.equal(ratToString(parseRat('3/6')), '1/2');
  assert.equal(ratToString(parseRat('4')), '4');
  assert.equal(ratToString(parseRat('-2/4')), '-1/2');
  assert.equal(ratToString(parseRat('2/-4')), '-1/2');
  assert.equal(ratToString(parseRat({ p: 6, q: 8 })), '3/4');
  assert.equal(ratToString(parseRat(7)), '7');
});

test('rejects non-rational input with E_RATIONAL', () => {
  for (const bad of ['1/0', { p: 1, q: 0 }, 0.5, 'abc', '1/2/3', NaN]) {
    assert.throws(() => parseRat(bad), (e) => e.code === 'E_RATIONAL');
  }
});

test('exact arithmetic without floats', () => {
  const third = rat(1n, 3n);
  const sixth = rat(1n, 6n);
  assert.equal(ratToString(add(third, sixth)), '1/2');
  assert.equal(cmp(rat(1n, 3n), rat(2n, 7n)), 1);
  assert.equal(cmp(rat(2n, 4n), rat(1n, 2n)), 0);
});
