import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EvalError, evaluate } from '../src/index.ts';

test('comparisons', () => {
  assert.equal(evaluate('1 < 2'), true);
  assert.equal(evaluate('2 <= 2'), true);
  assert.equal(evaluate('3 > 4'), false);
  assert.equal(evaluate('3 >= 4'), false);
  assert.equal(evaluate('1 == 1'), true);
  assert.equal(evaluate('1 != 2'), true);
  assert.equal(evaluate('true == false'), false);
  assert.equal(evaluate('true != false'), true);
});

test('ternary selects a branch', () => {
  assert.equal(evaluate('true ? 10 : 20'), 10n);
  assert.equal(evaluate('1 < 2 ? 3 : 4'), 3n);
  assert.equal(evaluate('false ? 1 : 2'), 2n);
});

test('ternary requires a boolean condition', () => {
  assert.throws(() => evaluate('1 ? 2 : 3'), (error) => error instanceof EvalError);
});

test('boolean operators short-circuit', () => {
  assert.equal(evaluate('false && (1 / 0 == 0)'), false);
  assert.equal(evaluate('true || (1 / 0 == 0)'), true);
  assert.throws(() => evaluate('true && (1 / 0 == 0)'), /Division by zero/);
  assert.throws(() => evaluate('false || (1 / 0 == 0)'), /Division by zero/);
});

test('logical not', () => {
  assert.equal(evaluate('!false'), true);
  assert.equal(evaluate('!(1 < 2)'), false);
});

test('unselected branches are never evaluated', () => {
  assert.equal(evaluate('true ? 1 : 1 / 0'), 1n);
  assert.equal(evaluate('false ? 1 / 0 : 2'), 2n);
  assert.equal(evaluate('true ? 1 : missing_variable'), 1n);
  assert.equal(evaluate('false && missing_variable'), false);
  assert.equal(evaluate('true || missing_variable'), true);
});
