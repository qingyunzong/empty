import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression, ParseError } from '../src/index.js';

test('pratt parser respects precedence and parentheses', () => {
  const expr = parseExpression('1 + 2 * 3');
  assert.equal(expr.kind, 'bin');
  assert.equal(expr.op, '+');
  assert.equal(expr.right.op, '*');

  const grouped = parseExpression('(1 + 2) * 3');
  assert.equal(grouped.op, '*');
  assert.equal(grouped.left.op, '+');
});

test('left associativity and unary minus', () => {
  const expr = parseExpression('10 - 4 - 3');
  assert.equal(expr.op, '-');
  assert.equal(expr.left.op, '-');

  const neg = parseExpression('-x * 2');
  assert.equal(neg.op, '*');
  assert.equal(neg.left.kind, 'neg');
});

test('trailing tokens are a parse error', () => {
  assert.throws(() => parseExpression('1 2'), ParseError);
});
