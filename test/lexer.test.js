import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, TT } from '../src/lexer.js';
import { DslError } from '../src/errors.js';

test('lexes identifiers, numbers, units and comments', () => {
  const toks = lex('power 50 kW # 主泵\nenergy 2.5 kWh');
  assert.deepEqual(
    toks.map((t) => [t.type, t.value]),
    [
      [TT.IDENT, 'power'],
      [TT.NUM, '50'],
      [TT.IDENT, 'kW'],
      [TT.IDENT, 'energy'],
      [TT.NUM, '2.5'],
      [TT.IDENT, 'kWh'],
      [TT.EOF, '<eof>'],
    ],
  );
});

test('lexes time literals, ranges, arrows and minutes unit', () => {
  const toks = lex('window 08:00 .. 12:30 duration 90 min');
  assert.equal(toks[1].type, TT.TIME);
  assert.equal(toks[1].value, '08:00');
  assert.equal(toks[2].value, '..');
  assert.equal(toks[3].value, '12:30');
  assert.equal(toks[6].value, 'min');
});

test('lexes price with 元 unit and tariff arrows', () => {
  const toks = lex('08:00 .. 12:00 -> 0.95 元');
  assert.deepEqual(toks.map((t) => t.value), ['08:00', '..', '12:00', '->', '0.95', '元', '<eof>']);
});

test('tracks line and column across lines', () => {
  const toks = lex('site S {\n  slots 96\n}');
  assert.equal(toks[3].line, 2);
  assert.equal(toks[3].col, 3);
});

test('reports unexpected character with line and column', () => {
  assert.throws(
    () => lex('site S {\n  @\n}', 'bad.dsl'),
    (e) => e instanceof DslError && e.line === 2 && e.col === 3 && /unexpected character/.test(e.message),
  );
});
