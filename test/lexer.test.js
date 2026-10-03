'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, QuerySyntaxError } = require('../src');

test('splits on whitespace', () => {
  const tokens = tokenize('  alpha   beta\tgamma\n');
  assert.deepStrictEqual(
    tokens.map((t) => t.type),
    ['WORD', 'WORD', 'WORD', 'EOF']
  );
});

test('recognizes bare words, phrases, regex and keywords', () => {
  const tokens = tokenize('alice "exact phrase" /a\\/b+/i and or NOT');
  assert.strictEqual(tokens[0].type, 'WORD');
  assert.strictEqual(tokens[0].value, 'alice');
  assert.strictEqual(tokens[1].type, 'PHRASE');
  assert.strictEqual(tokens[1].value, 'exact phrase');
  assert.strictEqual(tokens[2].type, 'REGEX');
  assert.strictEqual(tokens[2].value, 'a\\/b+');
  assert.strictEqual(tokens[2].flags, 'i');
  assert.deepStrictEqual(
    tokens.slice(3).map((t) => t.type),
    ['AND', 'OR', 'NOT', 'EOF']
  );
});

test('recognizes comparison operators and punctuation', () => {
  const tokens = tokenize('a < b <= c >= d != e = f (g) h:i');
  assert.deepStrictEqual(
    tokens.map((t) => (t.type === 'OP' ? t.value : t.type)),
    ['WORD', '<', 'WORD', '<=', 'WORD', '>=', 'WORD', '!=', 'WORD', '=', 'WORD', 'LPAREN', 'WORD', 'RPAREN', 'WORD', 'COLON', 'WORD', 'EOF']
  );
});

test('rejects unterminated phrase and regex', () => {
  assert.throws(() => tokenize('"open'), QuerySyntaxError);
  assert.throws(() => tokenize('/open'), QuerySyntaxError);
  assert.throws(() => tokenize('a!b'), QuerySyntaxError);
});

test('keywords are case-insensitive', () => {
  const tokens = tokenize('AnD Or NoT');
  assert.deepStrictEqual(
    tokens.map((t) => t.type),
    ['AND', 'OR', 'NOT', 'EOF']
  );
});
