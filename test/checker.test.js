'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  tokenize, parse, check, QuerySchemaError, QueryTypeError, QueryRegexError,
} = require('../src');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'schema.json'), 'utf8'));
const compileCheck = (q) => check(parse(tokenize(q)), schema);

test('unknown field is a compile-time error', () => {
  assert.throws(() => compileCheck('unknown:value'), QuerySchemaError);
  assert.throws(() => compileCheck('severity >= 1 and nope:x'), QuerySchemaError);
});

test('string field with < is a compile-time error', () => {
  assert.throws(() => compileCheck('title < "abc"'), QueryTypeError);
  assert.throws(() => compileCheck('source >= email'), QueryTypeError);
});

test('string predicate on non-string field is a compile-time error', () => {
  assert.throws(() => compileCheck('severity:high'), QueryTypeError);
  assert.throws(() => compileCheck('resolved:/x/'), QueryTypeError);
});

test('numeric comparisons require number/date fields', () => {
  assert.doesNotThrow(() => compileCheck('severity >= 4'));
  assert.doesNotThrow(() => compileCheck('date < 2024-03-01'));
  assert.doesNotThrow(() => compileCheck('resolved = true and severity < 2'));
  assert.throws(() => compileCheck('resolved < true'), QueryTypeError);
});

test('equality requires matching literal type', () => {
  assert.throws(() => compileCheck('severity = high'), QueryTypeError);
  assert.throws(() => compileCheck('resolved = maybe'), QueryTypeError);
  assert.throws(() => compileCheck('date = not-a-date'), QueryTypeError);
  assert.doesNotThrow(() => compileCheck('resolved = false'));
});

test('invalid regex is a compile-time error', () => {
  assert.throws(() => compileCheck('notes:/[unclosed/'), QueryRegexError);
  assert.throws(() => compileCheck('notes:/x/q'), QueryRegexError);
});
