import test from 'node:test';
import assert from 'node:assert/strict';
import { lex, parseCsvLine } from '../src/lexer.js';

test('lexer distinguishes CSV lines, directive blocks and quoted strings', () => {
  const source = [
    'id,name,note',
    '1,"hello, world","said ""hi"""',
    '#!correction',
    'map total = price * qty',
    'map tag = "rush order"',
    '#!end',
  ].join('\n');
  const tokens = lex(source);
  assert.equal(tokens[0].type, 'CSV');
  assert.deepEqual(tokens[0].fields, ['id', 'name', 'note']);
  assert.equal(tokens[1].type, 'CSV');
  assert.deepEqual(tokens[1].fields, ['1', 'hello, world', 'said "hi"']);
  assert.equal(tokens[2].type, 'DIRECTIVE_BEGIN');
  assert.equal(tokens[3].type, 'STATEMENT');
  assert.deepEqual(
    tokens[3].tokens.map((t) => `${t.type}:${t.value}`),
    ['ident:map', 'ident:total', 'op:=', 'ident:price', 'op:*', 'ident:qty'],
  );
  const stringToken = tokens[4].tokens.find((t) => t.type === 'string');
  assert.equal(stringToken.value, 'rush order');
  assert.equal(tokens[5].type, 'DIRECTIVE_END');
});

test('parseCsvLine handles quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsvLine('a,"b,c","d""e"', 1), ['a', 'b,c', 'd"e']);
});

test('lexer rejects unterminated string and unbalanced blocks', () => {
  assert.throws(() => lex('#!correction\nmap x = "abc\n#!end'), /unterminated string/);
  assert.throws(() => lex('#!correction\nmap x = 1'), /unterminated #!correction/);
  assert.throws(() => lex('#!end'), /without #!correction/);
});
