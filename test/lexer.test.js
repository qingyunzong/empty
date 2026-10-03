import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, Diagnostic } from '../src/lexer.js';

test('lexes numbers with units g, kg, ppm and currency', () => {
  const toks = lex('1 g 2.5 kg 300 ppm 0.05 CNY 7 ¥');
  const kinds = toks.slice(0, -1).map((t) => `${t.t}:${t.v}`);
  assert.deepEqual(kinds, [
    'num:1', 'unit:g',
    'num:2.5', 'unit:kg',
    'num:300', 'unit:ppm',
    'num:0.05', 'unit:CNY',
    'num:7', 'unit:¥',
  ]);
});

test('skips # and // comments', () => {
  const toks = lex('target: 1 g; # trailing\n// full line\nstep: 1 g;');
  const idents = toks.filter((t) => t.t === 'ident').map((t) => t.v);
  assert.deepEqual(idents, ['target', 'step']);
});

test('tracks line and column for diagnostics', () => {
  assert.throws(
    () => lex('a: 1;\nb: 2;\nc: @;'),
    (e) => e instanceof Diagnostic && e.line === 3 && e.col === 4,
  );
});

test('token positions point at the token start', () => {
  const toks = lex('\n  hello');
  assert.equal(toks[0].v, 'hello');
  assert.equal(toks[0].line, 2);
  assert.equal(toks[0].col, 3);
});
