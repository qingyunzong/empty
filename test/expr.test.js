import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression, evalExpression } from '../src/expr.js';
import { PlannerError } from '../src/errors.js';

test('pratt parser respects precedence: & binds tighter than |', () => {
  const ast = parseExpression('a & b | c');
  assert.equal(ast.kind, 'or');
  assert.equal(ast.left.kind, 'and');
  assert.equal(ast.right.name, 'c');
});

test('pratt parser handles ! and parentheses', () => {
  const ast = parseExpression('!(a | b) & c');
  assert.equal(ast.kind, 'and');
  assert.equal(ast.left.kind, 'not');
  assert.equal(ast.left.operand.kind, 'or');
});

test('type-qualified reference parses', () => {
  const ast = parseExpression('file:model.bin & !metric:loss');
  assert.equal(ast.left.type, 'file');
  assert.equal(ast.left.name, 'model.bin');
  assert.equal(ast.right.operand.type, 'metric');
});

test('evaluation over an artifact set', () => {
  const ast = parseExpression('(a & b) | !c');
  assert.equal(evalExpression(ast, new Set(['a', 'b'])), true);
  assert.equal(evalExpression(ast, new Set(['a'])), true); // !c
  assert.equal(evalExpression(ast, new Set(['a', 'c'])), false);
});

test('syntax errors are reported, not swallowed', () => {
  assert.throws(() => parseExpression('a &'), (e) => e instanceof PlannerError && e.code === 'E_PARSE');
  assert.throws(() => parseExpression('(a | b'), (e) => e.code === 'E_PARSE');
  assert.throws(() => parseExpression('a b'), (e) => e.code === 'E_PARSE');
});
