'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/parser');
const { normalize } = require('../src/normalize');
const { typecheck } = require('../src/typecheck');
const { QueryTypeError, RegexCompileError } = require('../src/errors');

const schema = {
  fields: {
    title: 'string',
    status: 'string',
    severity: 'number',
    created: 'date',
    verified: 'boolean',
  },
};

const check = (q) => typecheck(normalize(parse(q)), schema);

test('unknown field is a compile-time error', () => {
  assert.throws(() => check('owner:alice'), QueryTypeError);
  assert.throws(() => check('owner = 3'), /Unknown field 'owner'/);
});

test('ordering comparison on a string field is a compile-time error', () => {
  assert.throws(() => check('title < "abc"'), QueryTypeError);
  assert.throws(() => check('status>=open'), /string field 'status'/);
});

test('numeric comparisons accept number and date fields', () => {
  assert.doesNotThrow(() => check('severity >= 3'));
  assert.doesNotThrow(() => check('created < 2024-03-01'));
});

test('string predicates only on string fields', () => {
  assert.doesNotThrow(() => check('title:/^dns/i'));
  assert.throws(() => check('severity:/3/'), QueryTypeError);
  assert.throws(() => check('severity:abc'), QueryTypeError);
});

test('typed literals are validated at compile time', () => {
  assert.throws(() => check('severity:high'), QueryTypeError);
  assert.throws(() => check('created:not-a-date'), QueryTypeError);
  assert.throws(() => check('verified:maybe'), QueryTypeError);
  assert.doesNotThrow(() => check('verified:true'));
});

test('invalid regex is a compile-time error', () => {
  assert.throws(() => check('title:/(unclosed/'), RegexCompileError);
  assert.throws(() => check('/[z-a]/'), RegexCompileError);
  assert.throws(() => check('/x/q'), RegexCompileError);
});

test('typecheck annotates resolved typed literals', () => {
  const ast = check('severity>=3 and created<2024-03-01');
  const sev = ast.children.find((n) => n.field === 'severity');
  const created = ast.children.find((n) => n.field === 'created');
  assert.deepEqual(sev.resolved, { type: 'number', value: 3 });
  assert.equal(created.resolved.type, 'date');
  assert.equal(created.resolved.value, Date.parse('2024-03-01'));
});
