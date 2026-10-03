import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const parseSrc = (src) => parse(tokenize(src));
const firstGlobalExpr = (src) => parseSrc(src).decls[0].expr;

test('multiplication binds tighter than addition', () => {
  const expr = firstGlobalExpr('let x: money = 1.00 + 2.00 * 3.00');
  assert.equal(expr.op, '+');
  assert.equal(expr.left.type, 'moneyLit');
  assert.equal(expr.right.op, '*');
});

test('parentheses override precedence', () => {
  const expr = firstGlobalExpr('let x: money = (1.00 + 2.00) * 3.00');
  assert.equal(expr.op, '*');
  assert.equal(expr.left.op, '+');
});

test('comparison binds tighter than logic, unary not binds tightest', () => {
  const expr = firstGlobalExpr('let b: bool = x < y and not z');
  assert.equal(expr.op, 'and');
  assert.equal(expr.left.op, '<');
  assert.equal(expr.right.op, 'not');
});

test('equality is below comparison, or is below and', () => {
  const expr = firstGlobalExpr('let b: bool = a == b or c and d');
  assert.equal(expr.op, 'or');
  assert.equal(expr.left.op, '==');
  assert.equal(expr.right.op, 'and');
});

test('rule declarations parse params, return type and body lets', () => {
  const program = parseSrc('rule fee(amount: money, day: date) -> money { let x: money = amount * 2.00 x }');
  const rule = program.decls[0];
  assert.equal(rule.type, 'ruleDecl');
  assert.deepEqual(rule.params.map((p) => [p.name, p.type]), [['amount', 'money'], ['day', 'date']]);
  assert.equal(rule.returnType, 'money');
  assert.equal(rule.body.lets.length, 1);
  assert.equal(rule.body.expr.type, 'var');
});

test('if is an expression with block branches', () => {
  const program = parseSrc('rule f(a: money) -> money { if a > 1.00 { a } else { 1.00 } }');
  const expr = program.decls[0].body.expr;
  assert.equal(expr.type, 'if');
  assert.equal(expr.thenBlock.type, 'block');
  assert.equal(expr.elseBlock.type, 'block');
});

test('rule calls parse with argument lists', () => {
  const expr = firstGlobalExpr('let x: money = fee(1.00, 2024-01-15)');
  assert.equal(expr.type, 'call');
  assert.equal(expr.name, 'fee');
  assert.equal(expr.args.length, 2);
  assert.equal(expr.args[1].type, 'dateLit');
});

test('syntax errors raise E_PARSE with position', () => {
  assert.throws(() => parseSrc('let x: money = '), (err) => err.code === 'E_PARSE' && err.line === 1);
  assert.throws(() => parseSrc('rule f( { 1.00 }'), (err) => err.code === 'E_PARSE');
  assert.throws(() => parseSrc('let x: money = 1.00 +'), (err) => err.code === 'E_PARSE');
});
