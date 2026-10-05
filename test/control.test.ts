import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, EvalError } from '../src/index.js';

test('ternary evaluates only the selected branch', () => {
  assert.equal(evaluate('1 < 2 ? 10 : 1 / 0'), 10n);
  assert.equal(evaluate('1 > 2 ? 1 / 0 : 20'), 20n);
  assert.equal(evaluate('true ? 1 : 2'), 1n);
  assert.equal(evaluate('false ? 1 : 2'), 2n);
});

test('&& and || short-circuit', () => {
  assert.equal(evaluate('false && (1 / 0 == 0)'), false);
  assert.equal(evaluate('true || (1 / 0 == 0)'), true);
  assert.equal(evaluate('true && (2 == 2)'), true);
  assert.equal(evaluate('false || (2 == 2)'), true);
  assert.equal(evaluate('true && false'), false);
});

test('division by zero errors only when actually evaluated', () => {
  assert.throws(() => evaluate('1 / 0'), (e: unknown) => {
    assert.ok(e instanceof EvalError);
    assert.match((e as Error).message, /division by zero/);
    return true;
  });
  assert.throws(() => evaluate('1 % 0'), /division by zero/);
  assert.throws(() => evaluate('true && (1 / 0 == 0)'), /division by zero/);
  assert.throws(() => evaluate('false || (1 / 0 == 0)'), /division by zero/);
  assert.equal(evaluate('false && (1 / 0 == 0)'), false);
  assert.equal(evaluate('fn f() { 1 / 0 } 42'), 42n);
  assert.throws(() => evaluate('fn f() { 1 / 0 } f()'), /division by zero/);
});

test('nested ternary and boolean combinations', () => {
  assert.equal(evaluate('1 > 2 ? 10 : 2 > 3 ? 20 : 30'), 30n);
  assert.equal(evaluate('!(1 == 1)'), false);
  assert.equal(evaluate('!false && !false'), true);
  assert.equal(evaluate('1 + 2 == 3 && 4 * 5 == 20 ? 7 : 8'), 7n);
});
