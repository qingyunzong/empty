import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { LexError } from '../src/errors.js';

test('lexes batch numbers, percents, counts and dates', () => {
  const toks = lex('for #B-2024-0001 let x: quantity = floor(1200 * 2.5%) effective 2025-01-31 n = 42');
  const kinds = toks.map((t) => `${t.type}:${t.value}`);
  assert.ok(kinds.includes('batchno:#B-2024-0001'));
  assert.ok(kinds.includes('percent:2.5'));
  assert.ok(kinds.includes('date:2025-01-31'));
  assert.ok(kinds.includes('num:42'));
  assert.ok(kinds.includes('num:1200'));
});

test('distinguishes date literals from subtraction', () => {
  const toks = lex('2025-01-31 3-1');
  assert.equal(toks[0].type, 'date');
  assert.deepEqual(toks.slice(1, 4).map((t) => [t.type, t.value]), [
    ['num', '3'], ['op', '-'], ['num', '1'],
  ]);
});

test('tracks line numbers and reports lexical errors with line', () => {
  const toks = lex('a\nb\nc');
  assert.deepEqual(toks.map((t) => t.line), [1, 2, 3, 3]);
  assert.throws(() => lex('ok\n@bad'), (err) => {
    assert.ok(err instanceof LexError);
    assert.equal(err.line, 2);
    return true;
  });
});

test('skips // comments', () => {
  const toks = lex('1 // comment with @ junk\n2');
  assert.deepEqual(toks.filter((t) => t.type === 'num').map((t) => t.value), ['1', '2']);
});
