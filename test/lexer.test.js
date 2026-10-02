import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { DslError } from '../src/errors.js';

test('lexes batch numbers, percentages, counts and dates', () => {
  const tokens = tokenize('B2024-001 5% 2.5% 42 2024-01-31');
  assert.deepEqual(
    tokens.map((t) => t.type),
    ['BATCH', 'PERCENT', 'PERCENT', 'NUMBER', 'DATE', 'EOF'],
  );
  assert.equal(tokens[0].value, 'B2024-001');
  assert.equal(tokens[1].value, '5');
  assert.equal(tokens[2].value, '2.5');
  assert.equal(tokens[3].value, '42');
  assert.equal(tokens[4].value, '2024-01-31');
});

test('keywords and identifiers are distinct', () => {
  const tokens = tokenize('rule when and or not let in otherwise sampled');
  assert.deepEqual(
    tokens.map((t) => t.type),
    ['rule', 'when', 'and', 'or', 'not', 'let', 'in', 'otherwise', 'IDENT', 'EOF'],
  );
});

test('verdict and level keywords', () => {
  const tokens = tokenize('ACCEPT REJECT CONTINUE minor major critical');
  assert.deepEqual(
    tokens.map((t) => t.type),
    ['ACCEPT', 'REJECT', 'CONTINUE', 'minor', 'major', 'critical', 'EOF'],
  );
});

test('comments and whitespace are skipped, lines tracked', () => {
  const tokens = tokenize('# header\n\n  42 # trailing\n');
  assert.equal(tokens[0].type, 'NUMBER');
  assert.equal(tokens[0].line, 3);
});

test('lexer errors carry the line number', () => {
  assert.throws(
    () => tokenize('10\n@'),
    (err) => {
      assert.ok(err instanceof DslError);
      assert.equal(err.line, 2);
      assert.match(err.message, /:2: unexpected character '@'/);
      return true;
    },
  );
});

test('invalid date literal is rejected with line number', () => {
  assert.throws(() => tokenize('2024-02-30'), /invalid date literal '2024-02-30'/);
  assert.throws(() => tokenize('\n\n2024-13-01'), (err) => err.line === 3);
});

test('bare fractional literal must be a percentage', () => {
  assert.throws(() => tokenize('0.5'), /must be written as a percentage/);
});

test('unterminated string reports its line', () => {
  assert.throws(
    () => tokenize('rule "abc\n'),
    (err) => err.line === 1 && /unterminated string/.test(err.message),
  );
});
