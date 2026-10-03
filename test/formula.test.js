'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, evaluate, extractDeps } = require('../src/formula');

test('arithmetic precedence, parentheses, unary, decimals', () => {
  const ev = (s, vars = {}) => evaluate(parse(s), (n) => vars[n]);
  assert.equal(ev('1+2*3'), 7);
  assert.equal(ev('(1+2)*3'), 9);
  assert.equal(ev('10/4'), 2.5);
  assert.equal(ev('-(3+1)'), -4);
  assert.equal(ev('-3 + -2'), -5);
  assert.equal(ev('0.5 * 4'), 2);
  assert.equal(ev('2 * (3 + 4) - 10 / 5'), 12);
  assert.equal(ev('a + b * 2', { a: 1, b: 3 }), 7);
  assert.equal(ev('7 - 2 - 1'), 4);
  assert.equal(ev('16 / 4 / 2'), 2);
});

test('extractDeps collects unique tag references', () => {
  assert.deepEqual([...extractDeps(parse('a + b * (a - c)'))].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...extractDeps(parse('1 + 2'))], []);
});

test('syntax errors are rejected', () => {
  for (const bad of ['', '1+', '(1', '1 2', 'a b', '1..2', '@', '2(3)', 'a..b..c(']) {
    assert.throws(() => parse(bad), undefined, bad);
  }
});

test('division by zero throws DIVISION_BY_ZERO', () => {
  assert.throws(() => evaluate(parse('1/0'), () => 0), (e) => e.code === 'DIVISION_BY_ZERO');
  assert.throws(() => evaluate(parse('1/(2-2)'), () => 0), (e) => e.code === 'DIVISION_BY_ZERO');
});

test('unknown reference throws UNKNOWN_REFERENCE', () => {
  assert.throws(() => evaluate(parse('missing + 1'), () => undefined), (e) => e.code === 'UNKNOWN_REFERENCE');
});
