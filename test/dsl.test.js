import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, DslSyntaxError, DslTypeError } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';
import { compileQuery } from '../src/query.js';

test('lexer: time literals, device patterns, numeric units', () => {
  const toks = tokenize('ts >= 2026-10-01T08:00:00Z and device =~ "pump-?" and value > 1.5k');
  const time = toks.find((t) => t.type === 'TIME');
  assert.equal(time.value, Date.parse('2026-10-01T08:00:00Z'));
  const str = toks.find((t) => t.type === 'STRING');
  assert.equal(str.value, 'pump-?');
  const num = toks.find((t) => t.type === 'NUMBER');
  assert.equal(num.value, 1500);
});

test('lexer: unit suffixes k/M/G and date-only literal', () => {
  const toks = tokenize('1k 2M 3g 2026-01-02');
  assert.equal(toks[0].value, 1e3);
  assert.equal(toks[1].value, 2e6);
  assert.equal(toks[2].value, 3e9);
  assert.equal(toks[3].type, 'TIME');
  assert.equal(toks[3].value, Date.parse('2026-01-02T00:00:00Z'));
});

test('lexer: rejects bad characters and unterminated strings', () => {
  assert.throws(() => tokenize('value > $'), DslSyntaxError);
  assert.throws(() => tokenize('device == "abc'), DslSyntaxError);
});

test('parser: precedence not > and > or', () => {
  const p = parse('not value > 1 and value < 2 or code == "E1"');
  // top-level must be an or whose left is an and
  assert.equal(p.filter.type, 'or');
  assert.equal(p.filter.left.type, 'and');
  assert.equal(p.filter.left.left.type, 'not');
  assert.equal(p.filter.right.type, 'cmp');
});

test('parser: parentheses override precedence', () => {
  const p = parse('value > 1 and (code == "E1" or code == "E2")');
  assert.equal(p.filter.type, 'and');
  assert.equal(p.filter.right.type, 'or');
});

test('parser: non-associative comparisons are rejected', () => {
  assert.throws(() => parse('1 < value < 2'), DslSyntaxError);
});

test('parser: let subqueries with lexical scoping and shadowing', () => {
  const p = parse('let x = value > 1; let y = x and code == "E"; let x = value > 9; x and y');
  assert.equal(p.lets.length, 3);
  // y references the first x (letIndex 0), not the shadowing one
  const yBody = p.lets[1].expr;
  assert.equal(yBody.left.type, 'ref');
  assert.equal(yBody.left.letIndex, 0);
  // final x reference binds to the shadowing definition (letIndex 2)
  assert.equal(p.filter.left.type, 'ref');
  assert.equal(p.filter.left.letIndex, 2);
});

test('parser: use-before-definition falls through to unknown field', () => {
  const p = parse('let a = b; let b = value > 1; a');
  assert.equal(p.lets[0].expr.type, 'field');
  assert.throws(() => check(p), /unknown field 'b'/);
});

test('parser: syntax errors carry positions', () => {
  assert.throws(() => parse('value >'), DslSyntaxError);
  assert.throws(() => parse('let x = value > 1'), DslSyntaxError); // missing ';'
  assert.throws(() => parse('(value > 1'), DslSyntaxError);
});

test('checker: unknown field', () => {
  assert.throws(() => check(parse('temperature > 3')), (e) => {
    assert.ok(e instanceof DslTypeError);
    assert.match(e.message, /unknown field 'temperature'/);
    return true;
  });
});

test('checker: type mismatches', () => {
  assert.throws(() => check(parse('value < "abc"')), /cannot compare number with string/);
  assert.throws(() => check(parse('ts < 5')), /cannot compare time with number/);
  assert.throws(() => check(parse('value =~ "x*"')), /pattern match/);
  assert.throws(() => check(parse('value > 1 and device')), /expects boolean/);
  assert.throws(() => check(parse('not value')), /expects boolean/);
});

test('checker: aggregation typing', () => {
  assert.throws(() => check(parse('value > 1 | avg(device)')), /avg\(\) requires a number field/);
  assert.throws(() => check(parse('value > 1 | count by ts')), /by clause requires a string field/);
  assert.throws(() => check(parse('value > 1 | sum(nope)')), /unknown field 'nope'/);
  check(parse('value > 1 | count, avg(value), min(value), max(value) by device'));
});

test('compiler: extracts exact ts window from top-level conjuncts', () => {
  const c = compileQuery('ts >= 2026-10-01T00:00:00Z and ts < 2026-10-02T00:00:00Z and value > 1');
  assert.deepEqual(c.tsRange, {
    lo: Date.parse('2026-10-01T00:00:00Z'),
    loInclusive: true,
    hi: Date.parse('2026-10-02T00:00:00Z'),
    hiInclusive: false,
  });
  const none = compileQuery('value > 1');
  assert.equal(none.tsRange, null);
});
