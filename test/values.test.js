'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/values');

test('three-valued AND/OR/NOT truth tables', () => {
  const T = true, F = false, U = null;
  assert.equal(V.tvAnd(T, T), true);
  assert.equal(V.tvAnd(T, F), false);
  assert.equal(V.tvAnd(T, U), null);
  assert.equal(V.tvAnd(F, U), false);
  assert.equal(V.tvAnd(U, U), null);
  assert.equal(V.tvOr(T, U), true);
  assert.equal(V.tvOr(F, U), null);
  assert.equal(V.tvOr(F, F), false);
  assert.equal(V.tvNot(U), null);
  assert.equal(V.tvNot(T), false);
});

test('comparisons with NULL are unknown', () => {
  assert.equal(V.compare('=', null, 1), null);
  assert.equal(V.compare('<', 1, null), null);
  assert.equal(V.compare('=', 2, 2), true);
  assert.equal(V.compare('<>', 'a', 'b'), true);
});

test('E_TYPE on mismatched or invalid operands', () => {
  assert.throws(() => V.compare('=', 1, '1'), (e) => e.code === 'E_TYPE');
  assert.throws(() => V.compare('<', 'a', 1), (e) => e.code === 'E_TYPE');
  assert.throws(() => V.arith('+', 1, 'x'), (e) => e.code === 'E_TYPE');
  assert.throws(() => V.tvAnd(1, true), (e) => e.code === 'E_TYPE');
  assert.throws(() => V.tvNot('x'), (e) => e.code === 'E_TYPE');
});

test('arithmetic NULL propagation and division by zero', () => {
  assert.equal(V.arith('+', null, 1), null);
  assert.equal(V.arith('/', 1, 0), null);
  assert.equal(V.arith('*', 3, 4), 12);
});
