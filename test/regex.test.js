'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRegex } = require('../lib/regex');
const { AuditError } = require('../lib/errors');

test('valid rules parse', () => {
  for (const src of [
    'a',
    'a(b|c)*d?',
    '[a-z0-9]',
    '[^0-9]',
    '[^]x',
    '\\|\\[\\]',
    'a**',
    '(a|)(b|)',
    'USD|EUR',
    '[^]*\\|USD\\|[^]*',
  ]) {
    assert.ok(parseRegex(src), `should parse: ${src}`);
  }
});

test('backreferences are rejected as BAD_REGEX', () => {
  for (const src of ['a\\1', '(x)\\2', '\\9']) {
    assert.throws(() => parseRegex(src), (e) => e instanceof AuditError && e.code === 'BAD_REGEX');
  }
});

test('unsupported constructs are rejected as BAD_REGEX', () => {
  for (const src of ['a+', 'a.b', 'a{2}', '^a', 'a$', '\\d', '\\w']) {
    assert.throws(() => parseRegex(src), (e) => e.code === 'BAD_REGEX', src);
  }
});

test('malformed rules are rejected as BAD_REGEX', () => {
  for (const src of ['', '(a', 'a)', '[a', '[z-a]', '*a', 'a\\']) {
    assert.throws(() => parseRegex(src), (e) => e.code === 'BAD_REGEX', JSON.stringify(src));
  }
});

test('rules longer than 80 characters are rejected', () => {
  assert.doesNotThrow(() => parseRegex('a'.repeat(80)));
  assert.throws(() => parseRegex('a'.repeat(81)), (e) => e.code === 'BAD_REGEX');
});
