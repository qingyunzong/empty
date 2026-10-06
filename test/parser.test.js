import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { ParseError } from '../src/errors.js';

const RULE = `rule "T" version 1 {
  param a: quantity
  param b: quantity
  param c: quantity
  decide {
    when not a >= 1 and b >= 2 or c >= 3 -> REJECT
    otherwise -> ACCEPT
  }
}`;

test('parses rule header, params and decide block', () => {
  const ast = parse(RULE);
  assert.equal(ast.name, 'T');
  assert.equal(ast.version, 1);
  assert.equal(ast.params.length, 3);
  assert.equal(ast.decide.whens.length, 1);
  assert.equal(ast.decide.otherwise.decision, 'ACCEPT');
});

test('pratt precedence: not > and > or', () => {
  const ast = parse(RULE);
  const guard = ast.decide.whens[0].guard;
  assert.equal(guard.kind, 'bin');
  assert.equal(guard.op, 'or');
  assert.equal(guard.left.kind, 'bin');
  assert.equal(guard.left.op, 'and');
  assert.equal(guard.left.left.kind, 'not');
  assert.equal(guard.right.kind, 'bin');
  assert.equal(guard.right.op, '>=');
});

test('arithmetic precedence: * binds tighter than +', () => {
  const ast = parse(`rule "T" version 1 {
    param a: quantity
    decide { when a + 1 * 2 >= 3 -> ACCEPT otherwise -> CONTINUE }
  }`);
  const cmp = ast.decide.whens[0].guard;
  assert.equal(cmp.left.kind, 'bin');
  assert.equal(cmp.left.op, '+');
  assert.equal(cmp.left.right.op, '*');
});

test('parse errors carry line numbers', () => {
  assert.throws(() => parse('rule "T" version 1 {\n  param a: quantity\n  decide {\n    when a >= -> ACCEPT\n    otherwise -> CONTINUE\n  }\n}'), (err) => {
    assert.ok(err instanceof ParseError);
    assert.equal(err.line, 4);
    return true;
  });
});

test('requires otherwise clause', () => {
  assert.throws(() => parse('rule "T" version 1 {\n  param a: quantity\n  decide { when a >= 1 -> ACCEPT }\n}'), /otherwise/);
});
