'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, literalsOf, RegexSyntaxError } = require('../src/regex');

test('parses literals, concatenation and alternation', () => {
  assert.deepEqual(parse('AB'), {
    type: 'cat',
    parts: [{ type: 'lit', char: 'A' }, { type: 'lit', char: 'B' }],
  });
  assert.deepEqual(parse('A|B'), {
    type: 'alt',
    branches: [{ type: 'lit', char: 'A' }, { type: 'lit', char: 'B' }],
  });
});

test('parses repetition operators and groups', () => {
  const ast = parse('(AB|C)*D?E+');
  assert.equal(ast.type, 'cat');
  assert.equal(ast.parts[0].type, 'star');
  assert.equal(ast.parts[0].child.type, 'alt');
  assert.equal(ast.parts[1].type, 'opt');
  assert.equal(ast.parts[2].type, 'plus');
});

test('empty pattern and empty group are epsilon', () => {
  assert.deepEqual(parse(''), { type: 'eps' });
  assert.deepEqual(parse('()'), { type: 'eps' });
  assert.deepEqual(parse('A()B').type, 'cat');
});

test('escapes make metacharacters literal', () => {
  assert.deepEqual(parse('A\\*B'), {
    type: 'cat',
    parts: [
      { type: 'lit', char: 'A' },
      { type: 'lit', char: '*' },
      { type: 'lit', char: 'B' },
    ],
  });
  assert.deepEqual(parse('\\('), { type: 'lit', char: '(' });
});

test('literalsOf collects the alphabet', () => {
  assert.deepEqual([...literalsOf(parse('A(B|C)*'))].sort(), ['A', 'B', 'C']);
  assert.deepEqual([...literalsOf(parse(''))], []);
});

test('syntax errors carry the pattern offset', () => {
  const cases = [
    ['A(B', 3, "missing ')'"],
    ['A)', 1, "unmatched ')'"],
    [')', 0, "unmatched ')'"],
    ['*A', 0, 'nothing to repeat'],
    ['A+?', null, null], // valid: stacked repetition
    ['A\\', 1, 'trailing backslash'],
    ['(A|B', 4, "missing ')'"],
  ];
  for (const [pattern, index, message] of cases) {
    if (index === null) {
      assert.doesNotThrow(() => parse(pattern));
      continue;
    }
    assert.throws(
      () => parse(pattern),
      (err) => {
        assert.ok(err instanceof RegexSyntaxError);
        assert.equal(err.index, index, `pattern ${JSON.stringify(pattern)}`);
        assert.ok(err.message.includes(message), `${err.message} should include ${message}`);
        return true;
      },
    );
  }
});
