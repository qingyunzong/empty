import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';

const types = (src) => lex(src).map((t) => t.type);

test('lexes device IDs and identifiers', () => {
  const toks = lex('rule r on sensor-1 { }');
  assert.equal(toks[3].type, 'IDENT');
  assert.equal(toks[3].value, 'sensor-1');
});

test('lexes temperature and current units', () => {
  const toks = lex('80C 36.5C 10A');
  assert.deepEqual(
    toks.slice(0, 3).map((t) => [t.type, t.value, t.unit]),
    [['QUANTITY', 80, 'C'], ['QUANTITY', 36.5, 'C'], ['QUANTITY', 10, 'A']],
  );
});

test('lexes 5m duration (and s/h) into milliseconds', () => {
  const toks = lex('5m 30s 1h');
  assert.deepEqual(toks.slice(0, 3).map((t) => [t.type, t.value]), [
    ['DURATION', 300_000], ['DURATION', 30_000], ['DURATION', 3_600_000],
  ]);
});

test('lexes regex device groups', () => {
  const toks = lex('/^sensor-[0-9]+$/');
  assert.equal(toks[0].type, 'REGEX');
  assert.equal(toks[0].value, '^sensor-[0-9]+$');
});

test('skips comments and tracks line/col', () => {
  const toks = lex('# hello\n  field');
  assert.equal(toks[0].type, 'KW');
  assert.equal(toks[0].line, 2);
  assert.equal(toks[0].col, 3);
});

test('rejects empty regex group and bad characters with position', () => {
  assert.throws(() => lex('//'), (e) => e.phase === 'lex' && e.line === 1);
  assert.throws(() => lex('field @'), (e) => e.phase === 'lex' && e.col === 7);
});

test('keywords vs identifiers', () => {
  assert.deepEqual(types('and or not for when alert'), ['KW', 'KW', 'KW', 'KW', 'KW', 'KW', 'EOF']);
  assert.deepEqual(types('android format'), ['IDENT', 'IDENT', 'EOF']);
});
