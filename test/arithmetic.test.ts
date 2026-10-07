import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EvalError, evaluate } from '../src/index.ts';

test('integer arithmetic respects precedence and parentheses', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7n);
  assert.equal(evaluate('(1 + 2) * 3'), 9n);
  assert.equal(evaluate('10 - 4 - 3'), 3n);
  assert.equal(evaluate('2 * 3 % 4'), 2n);
});

test('unary minus', () => {
  assert.equal(evaluate('-3 + 1'), -2n);
  assert.equal(evaluate('- -5'), 5n);
  assert.equal(evaluate('-(1 + 2)'), -3n);
});

test('division and modulo truncate toward zero', () => {
  assert.equal(evaluate('7 / 2'), 3n);
  assert.equal(evaluate('-7 / 2'), -3n);
  assert.equal(evaluate('7 / -2'), -3n);
  assert.equal(evaluate('-7 / -2'), 3n);
  assert.equal(evaluate('-7 % 2'), -1n);
  assert.equal(evaluate('7 % -2'), 1n);
});

test('division by zero reports an error with source range when evaluated', () => {
  let caught: unknown;
  try {
    evaluate('1 + 2 / 0');
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof EvalError);
  assert.match(caught.message, /Division by zero/);
  assert.deepEqual(caught.span, { start: 4, end: 9 });
  assert.equal(caught.range.startLine, 1);
  assert.equal(caught.range.startCol, 5);
});

test('arbitrary precision integers', () => {
  const a = 123456789012345678901234567890n;
  const b = 987654321098765432109876543210n;
  assert.equal(evaluate('123456789012345678901234567890 * 987654321098765432109876543210'), a * b);
  assert.equal(evaluate(`${a} + ${b}`), a + b);
  assert.equal(evaluate('def fact(n) = n == 0 ? 1 : n * fact(n - 1); fact(40)'), 815915283247897734345611269596115894272000000000n);
});
