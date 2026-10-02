'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, alphabetOf, RegexSyntaxError } = require('../src/regex');

test('parses concatenation, alternation, repetition and groups', () => {
  assert.deepEqual(parse('AB'), {
    type: 'concat',
    parts: [{ type: 'lit', ch: 'A' }, { type: 'lit', ch: 'B' }],
  });
  assert.deepEqual(parse('A|B'), {
    type: 'alt',
    options: [{ type: 'lit', ch: 'A' }, { type: 'lit', ch: 'B' }],
  });
  assert.equal(parse('A*').type, 'star');
  assert.equal(parse('A+').type, 'plus');
  assert.equal(parse('A?').type, 'opt');
  assert.equal(parse('(AB)*').type, 'star');
  assert.equal(parse('A**').type, 'star'); // stacked repeat is fine
});

test('empty alternatives and groups are epsilon', () => {
  assert.deepEqual(parse('()'), { type: 'eps' });
  assert.deepEqual(parse(''), { type: 'eps' });
  assert.deepEqual(parse('A|'), {
    type: 'alt',
    options: [{ type: 'lit', ch: 'A' }, { type: 'eps' }],
  });
});

test('classes, ranges, negation, escapes and dot', () => {
  assert.deepEqual(parse('[AB]').chars, ['A', 'B']);
  assert.deepEqual(parse('[A-C]').chars, ['A', 'B', 'C']);
  assert.equal(parse('[^A]').negate, true);
  assert.deepEqual(parse('\\*'), { type: 'lit', ch: '*' });
  assert.deepEqual(parse('.'), { type: 'any' });
});

test('syntax errors carry a position', () => {
  const cases = [
    ['A(B', 3],
    ['A)', 1],
    ['*A', 0],
    ['[', 0],
    ['A\\', 1],
    ['[C-A]', 0],
  ];
  for (const [pattern, pos] of cases) {
    assert.throws(
      () => parse(pattern),
      (e) => e instanceof RegexSyntaxError && e.pos === pos,
      `expected RegexSyntaxError at ${pos} for ${JSON.stringify(pattern)}`
    );
  }
});

test('alphabet collection ignores dot, negated classes and epsilon', () => {
  const ast = parse('(AB|C)*.[^Z]');
  assert.deepEqual([...alphabetOf(ast)].sort(), ['A', 'B', 'C']);
});
