'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../src/lexer');
const { ParseError } = require('../src/errors');

test('skips whitespace and reads bare words', () => {
  const tokens = tokenize('  alpha   beta-2  ');
  assert.deepEqual(
    tokens.map((t) => t.type),
    ['WORD', 'WORD', 'EOF']
  );
  assert.equal(tokens[0].value, 'alpha');
  assert.equal(tokens[1].value, 'beta-2');
});

test('recognizes logical keywords case-insensitively', () => {
  const tokens = tokenize('a AND b Or NOT c');
  assert.deepEqual(
    tokens.map((t) => t.type),
    ['WORD', 'AND', 'WORD', 'OR', 'NOT', 'WORD', 'EOF']
  );
});

test('reads quoted phrases with escapes', () => {
  const tokens = tokenize('title:"exact \\"phrase\\" hit"');
  assert.deepEqual(
    tokens.map((t) => t.type),
    ['WORD', 'COLON', 'PHRASE', 'EOF']
  );
  assert.equal(tokens[2].value, 'exact "phrase" hit');
});

test('reads regex literals with flags', () => {
  const tokens = tokenize('/phish(ing)?/i severity>=3');
  assert.equal(tokens[0].type, 'REGEX');
  assert.equal(tokens[0].value, 'phish(ing)?');
  assert.equal(tokens[0].flags, 'i');
  assert.equal(tokens[2].type, 'OP');
  assert.equal(tokens[2].value, '>=');
});

test('reads all comparison operators', () => {
  const ops = tokenize('a=1 b==2 c!=3 d<4 e<=5 f>6 g>=7')
    .filter((t) => t.type === 'OP')
    .map((t) => t.value);
  assert.deepEqual(ops, ['=', '==', '!=', '<', '<=', '>', '>=']);
});

test('rejects unterminated phrase and regex', () => {
  assert.throws(() => tokenize('"oops'), ParseError);
  assert.throws(() => tokenize('/oops'), ParseError);
});
