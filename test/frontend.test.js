import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { DslError } from '../src/errors.js';

test('lexer: signal names, booleans, durations and enum literals', () => {
  const toks = tokenize('signal door_closed : input bool = true\nsignal t : timer ms = 250ms');
  const values = toks.map((t) => t.value);
  assert.deepEqual(values, [
    'signal', 'door_closed', ':', 'input', 'bool', '=', 'true',
    'signal', 't', ':', 'timer', 'ms', '=', 250,
    '<eof>',
  ]);
  assert.equal(toks[6].type, 'ident');
  assert.equal(toks[13].type, 'duration');
});

test('lexer: comments and comparison operators', () => {
  const toks = tokenize('# comment\n// another\na >= 500ms and b != c');
  const values = toks.map((t) => t.value);
  assert.deepEqual(values, ['a', '>=', 500, 'and', 'b', '!=', 'c', '<eof>']);
});

test('lexer: reports line and column of unexpected character', () => {
  assert.throws(
    () => tokenize('signal a : input bool\nsignal b : input bo$l'),
    (e) => e instanceof DslError && e.line === 2 && e.col === 20,
  );
});

test('lexer: bare number without ms is an error with position', () => {
  assert.throws(
    () => tokenize('x = 500'),
    (e) => e instanceof DslError && e.line === 1 && e.col === 5,
  );
});

function parseGuard(src) {
  const program = parse(tokenize(`invariant ${src}`));
  return program.invariants[0].expr;
}

test('pratt parser: and binds tighter than or', () => {
  const e = parseGuard('a or b and c');
  assert.equal(e.kind, 'or');
  assert.equal(e.right.kind, 'and');
});

test('pratt parser: not binds tighter than and', () => {
  const e = parseGuard('not a and b');
  assert.equal(e.kind, 'and');
  assert.equal(e.left.kind, 'not');
});

test('pratt parser: comparisons bind tighter than and, looser than not', () => {
  const e = parseGuard('not a == b and c');
  assert.equal(e.kind, 'and');
  assert.equal(e.left.kind, 'cmp');
  assert.equal(e.left.left.kind, 'not');
});

test('pratt parser: parentheses override precedence', () => {
  const e = parseGuard('(a or b) and c');
  assert.equal(e.kind, 'and');
  assert.equal(e.left.kind, 'or');
});

test('pratt parser: relational operators on durations', () => {
  const e = parseGuard('t >= 500ms or t <= 100ms');
  assert.equal(e.kind, 'or');
  assert.equal(e.left.kind, 'cmp');
  assert.equal(e.left.op, '>=');
  assert.equal(e.left.right.kind, 'duration');
  assert.equal(e.left.right.value, 500);
});

test('parser: error carries line and column', () => {
  assert.throws(
    () => parse(tokenize('signal a : input bool\nsignal b :')),
    (e) => e instanceof DslError && e.line === 2 && e.col === 11,
  );
});

test('parser: reserved words cannot be used as names', () => {
  assert.throws(
    () => parse(tokenize('signal and : input bool')),
    (e) => e instanceof DslError && e.line === 1 && e.col === 8,
  );
});
