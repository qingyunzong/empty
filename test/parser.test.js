'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/parser');
const { normalize, canonical } = require('../src/normalize');
const { ParseError } = require('../src/errors');

test('and binds tighter than or', () => {
  const ast = parse('a or b and c');
  assert.equal(ast.type, 'or');
  assert.equal(ast.children[1].type, 'and');
});

test('not binds tighter than and', () => {
  const ast = parse('not a and b');
  assert.equal(ast.type, 'and');
  assert.equal(ast.children[0].type, 'not');
});

test('parentheses override precedence', () => {
  const ast = parse('(a or b) and c');
  assert.equal(ast.type, 'and');
  assert.equal(ast.children[0].type, 'or');
});

test('juxtaposition is an implicit and', () => {
  const ast = normalize(parse('alpha "two words" /re[x]/'));
  assert.equal(ast.type, 'and');
  assert.equal(ast.children.length, 3);
});

test('colon field predicate with word, phrase and regex values', () => {
  assert.deepEqual(parse('status:open'), {
    type: 'match',
    field: 'status',
    value: { kind: 'word', value: 'open' },
  });
  assert.equal(parse('title:"phishing email"').value.kind, 'phrase');
  const re = parse('title:/^dns/i');
  assert.equal(re.value.kind, 'regex');
  assert.equal(re.value.flags, 'i');
});

test('comparison predicate', () => {
  const ast = parse('severity>=3');
  assert.deepEqual(
    { type: ast.type, field: ast.field, op: ast.op, value: ast.value },
    { type: 'cmp', field: 'severity', op: '>=', value: { kind: 'word', value: '3' } }
  );
});

test('normalization sorts, dedupes and flattens', () => {
  const a = canonical(normalize(parse('b and a and b and (c and a)')));
  assert.equal(a, '(and (text w"a") (text w"b") (text w"c"))');
  const x = canonical(normalize(parse('not not alpha')));
  assert.equal(x, '(text w"alpha")');
});

test('syntax errors are ParseError', () => {
  assert.throws(() => parse('(a and b'), ParseError);
  assert.throws(() => parse('a and'), ParseError);
  assert.throws(() => parse('a b)'), ParseError);
});
