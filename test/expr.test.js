import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate, hashAst, GateError } from '../src/expr.js';

const ev = (src, env = {}) => evaluate(parse(src), env, null);

test('arithmetic respects precedence', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('-2 * 3'), -6);
  assert.equal(ev('10 % 3'), 1);
  assert.equal(ev('10 / 4'), 2.5);
});

test('comparisons and logic operators', () => {
  assert.equal(ev('a > 5 and b < 2', { a: 10, b: 1 }), true);
  assert.equal(ev('a > 5 or b < 2', { a: 0, b: 1 }), true);
  assert.equal(ev('not (a == 1)', { a: 2 }), true);
  assert.equal(ev("site == 'A'", { site: 'A' }), true);
  assert.equal(ev("site != 'A'", { site: 'A' }), false);
  assert.equal(ev('a >= 3 and a <= 3', { a: 3 }), true);
});

test('NULL three-valued logic', () => {
  assert.equal(ev('null and true'), null);
  assert.equal(ev('null and false'), false);
  assert.equal(ev('true and null'), null);
  assert.equal(ev('false and null'), false);
  assert.equal(ev('null or true'), true);
  assert.equal(ev('null or false'), null);
  assert.equal(ev('not null'), null);
});

test('comparisons involving NULL yield NULL', () => {
  assert.equal(ev('1 < null'), null);
  assert.equal(ev('null == null'), null);
  assert.equal(ev('null != 1'), null);
  assert.equal(ev('null >= 0'), null);
});

test('is null / is not null', () => {
  assert.equal(ev('x is null', {}), true);
  assert.equal(ev('x is not null', { x: 1 }), true);
  assert.equal(ev('x is null', { x: 0 }), false);
  assert.equal(ev('x is not null', {}), false);
});

test('unknown identifier is NULL, never false', () => {
  assert.equal(ev('missing > 5', {}), null);
  assert.equal(ev('not (missing > 5)', {}), null);
  assert.notEqual(ev('missing > 5', {}), false);
  assert.equal(ev('missing', {}), null);
});

test('NULL propagates through arithmetic; division by zero is NULL', () => {
  assert.equal(ev('a + 1', {}), null);
  assert.equal(ev('1 / 0'), null);
  assert.equal(ev('0 / 0'), null);
  assert.equal(ev('null * 5'), null);
});

test('type mismatch in comparison yields NULL', () => {
  assert.equal(ev("1 < 'a'"), null);
  assert.equal(ev('true < false'), null);
  assert.equal(ev("1 == '1'"), null);
});

test('AST hash is stable and sensitive to structure', () => {
  assert.equal(hashAst(parse('a + b')), hashAst(parse('a + b')));
  assert.notEqual(hashAst(parse('a + b')), hashAst(parse('a + c')));
  assert.notEqual(hashAst(parse('a + b')), hashAst(parse('b + a')));
  assert.match(hashAst(parse('a')), /^[0-9a-f]{64}$/);
});

test('parse errors raise E_RULE', () => {
  assert.throws(() => parse('a +'), (e) => e instanceof GateError && e.code === 'E_RULE');
  assert.throws(() => parse('(a'), (e) => e.code === 'E_RULE');
  assert.throws(() => parse(''), (e) => e.code === 'E_RULE');
  assert.throws(() => parse('a = 1'), (e) => e.code === 'E_RULE');
  assert.throws(() => parse('a b'), (e) => e.code === 'E_RULE');
});

test('aggregate syntax parses with over window', () => {
  const ast = parse('avg(temp) over w1m <= 50');
  assert.equal(ast.t, 'bin');
  assert.equal(ast.op, '<=');
  assert.equal(ast.l.t, 'agg');
  assert.equal(ast.l.fn, 'avg');
  assert.equal(ast.l.win, 'w1m');
});

test('aggregate without resolver raises E_RULE', () => {
  assert.throws(() => ev('avg(x) over w', { x: 1 }), (e) => e.code === 'E_RULE');
});
