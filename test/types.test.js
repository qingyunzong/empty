import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/types.js';

const checkSrc = (src) => check(parse(lex(src)));
const typeError = (src) => assert.throws(() => checkSrc(src), (e) => e.code === 'E_TYPE');

test('accepts a well-typed plan', () => {
  checkSrc(`
    param reason = "chargeback";
    for t in [txn:1, txn:2] {
      let amt = t.amount;
      if t.status == SETTLED and amt > 0 { reverse t; }
      else if t.status == PENDING { cancel t; }
    }
    move 2.50 from acc:revenue.fees to acc:cash.operating;
  `);
});

test('move statically pairs debit and credit accounts', () => {
  // missing target account is rejected by the grammar itself
  assert.throws(() => checkSrc('move 1.00 from acc:a;'), (e) => e.code === 'E_PARSE');
  // non-numeric amount is a type error
  typeError('move "x" from acc:a to acc:b;');
});

test('reverse/cancel require txn operands', () => {
  typeError('reverse 42;');
  typeError('cancel "txn:1";');
});

test('scopes: global params, txn locals, loop temporaries', () => {
  // loop variable is a loop temporary: not visible after the loop
  typeError('for t in [txn:1] { reverse t; } reverse t;');
  // txn-local let is not visible outside the loop body
  typeError('for t in [txn:1] { let a = t.amount; } let b = a;');
  // params live in the global scope and cannot be redeclared
  typeError('param p = 1; param p = 2;');
  // params are visible inside loops
  checkSrc('param limit = 10.00; for t in [txn:1] { if t.amount > limit { reverse t; } }');
});

test('status machine: LOCKED is not a txn status literal', () => {
  typeError('for t in [txn:1] { if t.status == LOCKED { reverse t; } }');
  checkSrc('for t in [txn:1] { if t.locked { reverse t; } }');
});

test('operand type mismatches are rejected', () => {
  typeError('let x = "a" + 1;');
  typeError('for t in [txn:1] { if t.amount { reverse t; } }');
  typeError('let y = [txn:1, 2];');
});
