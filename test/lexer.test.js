import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, Diagnostic } from '../src/lexer.js';

test('lexes numbers, units, currency and operators', () => {
  const toks = tokenize('total 1.5 kg; budget >= 3 CNY; x == 80000 ppm;');
  const sig = toks.map((t) => `${t.type}:${t.value}`);
  assert.deepEqual(sig, [
    'ident:total', 'num:1.5', 'ident:kg', 'punct:;',
    'ident:budget', 'punct:>=', 'num:3', 'ident:CNY', 'punct:;',
    'ident:x', 'punct:==', 'num:80000', 'ident:ppm', 'punct:;',
    'eof:',
  ]);
});

test('skips line and block comments', () => {
  const toks = tokenize('// nothing here\nmacro /* inline */ x = 1; /* multi\nline */ total 2 g;');
  const idents = toks.filter((t) => t.type === 'ident').map((t) => t.value);
  assert.deepEqual(idents, ['macro', 'x', 'total', 'g']);
});

test('tracks line and column', () => {
  const toks = tokenize('macro x = 1;\n  total 2 g;');
  const total = toks.find((t) => t.value === 'total');
  assert.equal(total.line, 2);
  assert.equal(total.col, 3);
});

test('reports unterminated block comment with position', () => {
  assert.throws(
    () => tokenize('ok 1;\n/* never ends'),
    (e) => e instanceof Diagnostic && e.line === 2 && e.col === 1 && /unterminated/.test(e.message),
  );
});

test('reports unexpected character with position', () => {
  assert.throws(
    () => tokenize('total 1 g; @'),
    (e) => e instanceof Diagnostic && e.line === 1 && e.col === 12,
  );
});
