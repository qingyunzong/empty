'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lex } = require('../src/lexer');
const { expectErr } = require('./helpers');

test('tokenizes identifiers, keywords, money, rate, date', () => {
  const toks = lex('let fee_rate: rate = 0.0015; let x: money = 12.50m; let d: date = 2026-10-04;');
  const types = toks.map((t) => t.t);
  assert.deepEqual(types, [
    'let', 'IDENT', ':', 'TYPE', '=', 'RATE', ';',
    'let', 'IDENT', ':', 'TYPE', '=', 'MONEY', ';',
    'let', 'IDENT', ':', 'TYPE', '=', 'DATE', ';',
    'EOF',
  ]);
  assert.equal(toks[5].v, '0.0015');
  assert.equal(toks[12].v, '12.50');
  assert.equal(toks[19].v, '2026-10-04');
});

test('skips line comments (# and //)', () => {
  const toks = lex('let # comment\n// another\nx: money = 1m;');
  assert.deepEqual(toks.map((t) => t.t), ['let', 'IDENT', ':', 'TYPE', '=', 'MONEY', ';', 'EOF']);
});

test('tracks line and column', () => {
  const toks = lex('let\n  x: money = 1m;');
  assert.equal(toks[1].line, 2);
  assert.equal(toks[1].col, 3);
});

test('money literal with 3 decimals is E_LEX', () => {
  const e = expectErr(() => lex('let x: money = 1.005m;'), 'E_LEX');
  assert.match(e.message, /2 decimal places/);
  assert.equal(e.line, 1);
  assert.ok(e.col > 0);
});

test('scientific notation is E_LEX', () => {
  expectErr(() => lex('let x: rate = 1e5;'), 'E_LEX');
  expectErr(() => lex('let x: rate = 1.5E3;'), 'E_LEX');
});

test('rate literal with more than 6 decimals is E_LEX', () => {
  expectErr(() => lex('let r: rate = 0.1234567;'), 'E_LEX');
});

test('invalid date literal is E_LEX', () => {
  expectErr(() => lex('let d: date = 2026-13-01;'), 'E_LEX');
  expectErr(() => lex('let d: date = 2026-02-30;'), 'E_LEX');
});

test('unexpected character is E_LEX', () => {
  expectErr(() => lex('let x: money = @;'), 'E_LEX');
});
