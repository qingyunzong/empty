import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRational, add, sub, cmp, fmt, rat, RationalError } from '../src/rational.js';

test('parses integers, decimals and fractions exactly', () => {
  assert.equal(fmt(parseRational(3)), '3');
  assert.equal(fmt(parseRational('-4')), '-4');
  assert.equal(fmt(parseRational('7')), '7');
  assert.equal(fmt(parseRational('1.5')), '3/2');
  assert.equal(fmt(parseRational('-0.25')), '-1/4');
  assert.equal(fmt(parseRational('3/4')), '3/4');
  assert.equal(fmt(parseRational('6/4')), '3/2');
  assert.equal(fmt(parseRational('-2/3')), '-2/3');
});

test('rejects invalid rationals with E_RATIONAL', () => {
  for (const bad of ['abc', '1/0', '1.2.3', '', '1/', '/2', 1.5, NaN, Infinity, null, undefined, {}, []]) {
    assert.throws(() => parseRational(bad), (e) => e instanceof RationalError && e.code === 'E_RATIONAL', `input ${String(bad)}`);
  }
});

test('arithmetic is exact', () => {
  const a = parseRational('1/3');
  const b = parseRational('1/6');
  assert.equal(fmt(add(a, b)), '1/2');
  assert.equal(fmt(sub(a, b)), '1/6');
  assert.equal(cmp(parseRational('0.1'), parseRational('1/10')), 0);
  assert.equal(cmp(rat(2n, 2n), rat(1n, 1n)), 0);
});
