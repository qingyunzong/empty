import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';

test('lexes money, bps, units and rounding keywords strictly', () => {
  const toks = lex('100.00 120bps 7 HALF_UP HALF_EVEN DOWN');
  assert.deepEqual(toks.map((t) => t.t), ['MONEY', 'BPS', 'UNITS', 'KW', 'KW', 'KW', 'EOF']);
  assert.equal(toks[0].value, 10000n);
  assert.equal(toks[1].value, 120n);
  assert.equal(toks[2].value, 7n);
  assert.equal(toks[3].value, 'HALF_UP');
});

test('money literal pads to cents', () => {
  const [a, b, c] = lex('1.5 0.05 42');
  assert.equal(a.value, 150n);
  assert.equal(b.value, 5n);
  assert.equal(c.value, 42n);
});

test('over-precision money literal raises E_LEX', () => {
  assert.throws(() => lex('1.001'), (e) => e.code === 'E_LEX');
  assert.throws(() => lex('0.123'), (e) => e.code === 'E_LEX');
});

test('fractional bps literal raises E_LEX', () => {
  assert.throws(() => lex('12.5bps'), (e) => e.code === 'E_LEX');
});

test('malformed tokens raise E_LEX', () => {
  assert.throws(() => lex('1.'), (e) => e.code === 'E_LEX');
  assert.throws(() => lex('@'), (e) => e.code === 'E_LEX');
  assert.throws(() => lex('"unterminated'), (e) => e.code === 'E_LEX');
});

test('comments and punctuation', () => {
  const toks = lex('a == b # comment\n// line\nc -> d');
  assert.deepEqual(
    toks.filter((t) => t.t !== 'EOF').map((t) => t.value),
    ['a', '==', 'b', 'c', '->', 'd'],
  );
});
