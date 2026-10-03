'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, parse, QuerySyntaxError } = require('../src');

const parseQuery = (q) => parse(tokenize(q));

test('parses field predicates', () => {
  assert.deepStrictEqual(parseQuery('source:email'), {
    type: 'field', field: 'source', value: 'email', match: 'word',
  });
  assert.deepStrictEqual(parseQuery('title:"phishing link"'), {
    type: 'field', field: 'title', value: 'phishing link', match: 'phrase',
  });
  assert.deepStrictEqual(parseQuery('notes:/link/i'), {
    type: 'field', field: 'notes', value: 'link', flags: 'i', match: 'regex',
  });
});

test('parses comparisons', () => {
  assert.deepStrictEqual(parseQuery('severity >= 4'), {
    type: 'compare', field: 'severity', op: '>=', value: '4',
  });
  assert.deepStrictEqual(parseQuery('resolved = false'), {
    type: 'compare', field: 'resolved', op: '=', value: 'false',
  });
});

test('precedence: and binds tighter than or', () => {
  const ast = parseQuery('a and b or c');
  assert.strictEqual(ast.type, 'binary');
  assert.strictEqual(ast.op, 'or');
  assert.strictEqual(ast.left.op, 'and');
});

test('parentheses override precedence', () => {
  const ast = parseQuery('a and (b or c)');
  assert.strictEqual(ast.op, 'and');
  assert.strictEqual(ast.right.op, 'or');
});

test('not binds tighter than and', () => {
  const ast = parseQuery('not a and b');
  assert.strictEqual(ast.op, 'and');
  assert.strictEqual(ast.left.type, 'not');
});

test('bare word and phrase become fulltext predicates', () => {
  assert.deepStrictEqual(parseQuery('alice'), { type: 'fulltext', value: 'alice', match: 'word' });
  assert.deepStrictEqual(parseQuery('"two words"'), { type: 'fulltext', value: 'two words', match: 'phrase' });
});

test('rejects unbalanced parens and dangling operators', () => {
  assert.throws(() => parseQuery('(a or b'), QuerySyntaxError);
  assert.throws(() => parseQuery('a and'), QuerySyntaxError);
  assert.throws(() => parseQuery('a:'), QuerySyntaxError);
});
