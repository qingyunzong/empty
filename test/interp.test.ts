import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate } from '../src/index.js';

test('int32 wraparound arithmetic', () => {
  assert.equal(evaluate(parse('(2147483647 + 1)')).value, -2147483648);
  assert.equal(evaluate(parse('(65536 * 65536)')).value, 0);
});

test('integer division truncates toward zero', () => {
  assert.equal(evaluate(parse('((0 - 7) / 2)')).value, -3);
  assert.equal(evaluate(parse('(7 / 2)')).value, 3);
  assert.equal(evaluate(parse('((0 - 7) % 2)')).value, -1);
});

test('division by zero is the first error and keeps prior log entries', () => {
  const r = evaluate(parse('(log(1) + (1 / 0))'));
  assert.equal(r.value, null);
  assert.equal(r.error?.message, 'integer division by zero');
  assert.deepEqual(r.log, [1]);
});

test('error before later log actions keeps the log empty', () => {
  const r = evaluate(parse('((1 / 0) + log(9))'));
  assert.equal(r.error?.message, 'integer division by zero');
  assert.deepEqual(r.log, []);
});

test('modulo by zero raises an integer error', () => {
  const r = evaluate(parse('(5 % 0)'));
  assert.equal(r.error?.message, 'integer modulo by zero');
});

test('if and let semantics', () => {
  assert.equal(evaluate(parse('if (0, 1, 2)')).value, 2);
  assert.equal(evaluate(parse('if (3, 1, 2)')).value, 1);
  assert.equal(evaluate(parse('let x = 3 in (x * x)')).value, 9);
  assert.equal(evaluate(parse('let x = 1 in let x = 2 in x')).value, 2);
});

test('unbound variable error', () => {
  const r = evaluate(parse('(x + 1)'));
  assert.equal(r.error?.message, 'unbound variable: x');
});
