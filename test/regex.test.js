'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/regex');
const { compileAst } = require('../src/automata');

const matches = (pattern, s) => compileAst(parse(pattern)).match(s);

test('supported constructs match correctly', () => {
  assert.ok(matches('abc', 'abc'));
  assert.ok(!matches('abc', 'ab'));
  assert.ok(!matches('abc', 'abcd'));
  assert.ok(matches('a|b', 'b'));
  assert.ok(!matches('a|b', 'c'));
  assert.ok(matches('(ab)*', ''));
  assert.ok(matches('(ab)*', 'abab'));
  assert.ok(!matches('(ab)*', 'aba'));
  assert.ok(matches('ab?c', 'ac'));
  assert.ok(matches('ab?c', 'abc'));
  assert.ok(!matches('ab?c', 'abbc'));
  assert.ok(matches('[a-c][a-c]', 'ca'));
  assert.ok(!matches('[a-c][a-c]', 'da'));
  assert.ok(matches('[0-9]*', '0123'));
  assert.ok(matches('[^0-9]', 'x'));
  assert.ok(!matches('[^0-9]', '5'));
  assert.ok(matches('\\*', '*'));
  assert.ok(matches('\\|', '|'));
  assert.ok(matches('[^|]*\\|[^|]*', 'abc|def'));
  assert.ok(!matches('[^|]*\\|[^|]*', 'abc'));
  assert.ok(matches('a(b|c)*d', 'abcbcd'));
  assert.ok(matches('', ''));
  assert.ok(!matches('', 'a'));
});

test('unsupported or malformed patterns report BAD_REGEX', () => {
  const cases = [
    '(a', // unclosed group
    'a)', // unbalanced paren
    'a+', // + not supported
    'a{2}', // counted repetition not supported
    '.', // dot not supported
    'a\\1', // backreference
    '\\2', // backreference
    '\\d', // unsupported escape
    '*a', // dangling star
    '?a', // dangling maybe
    '[]', // empty class
    '[^]', // empty negated class
    '[z-a]', // reversed range
    '[a', // unclosed class
    'a\\', // trailing backslash
    'x'.repeat(81), // exceeds 80-char rule limit
  ];
  for (const pattern of cases) {
    assert.throws(
      () => parse(pattern),
      (err) => err.code === 'BAD_REGEX',
      `expected BAD_REGEX for ${JSON.stringify(pattern)}`
    );
  }
});

test('backreference rejection is explicit', () => {
  assert.throws(() => parse('(a)\\1'), /backreferences are not supported/);
});
