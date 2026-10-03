import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const ast = (src) => parse(lex(src));

test('pratt precedence: * binds tighter than +', () => {
  const prog = ast('let x = 1 + 2 * 3;');
  const expr = prog.body[0].expr;
  assert.equal(expr.op, '+');
  assert.equal(expr.rhs.op, '*');
});

test('pratt precedence: and binds tighter than or, not is prefix', () => {
  const prog = ast('let x = not a and b or c;');
  const expr = prog.body[0].expr;
  assert.equal(expr.op, 'or');
  assert.equal(expr.lhs.op, 'and');
  assert.equal(expr.lhs.lhs.kind, 'Unary');
});

test('comparison and attribute access', () => {
  const prog = ast('if t.status == SETTLED and t.amount > 0 { reverse t; }');
  const cond = prog.body[0].cond;
  assert.equal(cond.op, 'and');
  assert.equal(cond.lhs.lhs.kind, 'Attr');
});

test('for loop, else-if chains and move statements', () => {
  const prog = ast(`
    for t in [txn:1, txn:2] {
      if t.status == SETTLED { reverse t; }
      else if t.status == PENDING { cancel t; }
      else { move 1.00 from acc:a to acc:b; }
    }`);
  const loop = prog.body[0];
  assert.equal(loop.kind, 'For');
  assert.equal(loop.iterable.elements.length, 2);
  const ifStmt = loop.body[0];
  assert.equal(ifStmt.else[0].kind, 'If');
  assert.equal(ifStmt.else[0].else[0].kind, 'Move');
});

test('parse errors carry E_PARSE', () => {
  assert.throws(() => ast('reverse ;'), (e) => e.code === 'E_PARSE');
  assert.throws(() => ast('move 1.00 from acc:a;'), (e) => e.code === 'E_PARSE');
});
