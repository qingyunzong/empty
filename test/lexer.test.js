import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, LexError } from '../src/lexer.js';

test('recognizes lot numbers, dates, strings and numbers', () => {
  const tokens = tokenize('LOT-2025-0001 2025-01-15 "flour" 42');
  assert.equal(tokens[0].type, 'LOT');
  assert.equal(tokens[0].value, 'LOT-2025-0001');
  assert.equal(tokens[1].type, 'DATE');
  assert.equal(tokens[1].value, '2025-01-15');
  assert.equal(tokens[2].type, 'STRING');
  assert.equal(tokens[2].value, 'flour');
  assert.equal(tokens[3].type, 'NUMBER');
  assert.equal(tokens[3].value, 42);
  assert.equal(tokens[4].type, 'EOF');
});

test('recognizes keywords and operators', () => {
  const types = tokenize('let query where and or not == != <= >= < > = ( ) , ;')
    .map((t) => t.type);
  assert.deepEqual(types, [
    'LET', 'QUERY', 'WHERE', 'AND', 'OR', 'NOT',
    'EQEQ', 'NE', 'LE', 'GE', 'LT', 'GT', 'EQ',
    'LPAREN', 'RPAREN', 'COMMA', 'SEMI', 'EOF',
  ]);
});

test('string escapes', () => {
  const tokens = tokenize('"a\\"b\\\\c\\n"');
  assert.equal(tokens[0].value, 'a"b\\c\n');
});

test('comments and line tracking', () => {
  const tokens = tokenize('# first line\nlet\n  x');
  assert.equal(tokens[0].type, 'LET');
  assert.equal(tokens[0].line, 2);
  assert.equal(tokens[1].type, 'IDENT');
  assert.equal(tokens[1].line, 3);
});

test('rejects invalid calendar dates', () => {
  assert.throws(() => tokenize('2025-13-01'), LexError);
  assert.throws(() => tokenize('2025-02-30'), LexError);
});

test('lex errors carry line and column', () => {
  let caught;
  try {
    tokenize('query ok;\nquery @;');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LexError);
  assert.equal(caught.line, 2);
  assert.match(caught.message, /unexpected character/);
});

test('unterminated string reports its start line', () => {
  let caught;
  try {
    tokenize('let a = 1;\nquery "oops;');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LexError);
  assert.equal(caught.line, 2);
});
