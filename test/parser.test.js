'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evalGlobal, expectErr } = require('./helpers');
const { lex } = require('../src/lexer');
const { parse } = require('../src/parser');

test('multiplication binds tighter than addition', () => {
  const v = evalGlobal('let x: rate = 1 + 2 * 3;');
  assert.equal(v.v, 7000000n);
});

test('parentheses override precedence', () => {
  const v = evalGlobal('let x: rate = (1 + 2) * 3;');
  assert.equal(v.v, 9000000n);
});

test('comparison and logic precedence', () => {
  const v = evalGlobal('let b: bool = 1 < 2 and 3 > 2 or false;');
  assert.deepEqual(v, { t: 'bool', v: true });
  const v2 = evalGlobal('let b: bool = not (1 == 2);');
  assert.deepEqual(v2, { t: 'bool', v: true });
});

test('money arithmetic evaluates', () => {
  const v = evalGlobal('let m: money = 1.50m + 2.25m * 2;');
  assert.deepEqual(v, { t: 'money', v: 600n });
});

test('if-then-else expression evaluates', () => {
  const v = evalGlobal('let m: money = if (1 < 2) then 10m else 20m;');
  assert.deepEqual(v, { t: 'money', v: 1000n });
});

test('syntax error reports E_PARSE with position', () => {
  const e = expectErr(() => parse(lex('let x: money = ;')), 'E_PARSE');
  assert.ok(e.line >= 1);
  expectErr(() => parse(lex('rule f( -> money { return 1m; }')), 'E_PARSE');
  expectErr(() => parse(lex('let x: money = (1m + 2m;')), 'E_PARSE');
});
