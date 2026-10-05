import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, EvalError, Machine, parse } from '../src/index.js';

test('integer arithmetic with precedence', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7n);
  assert.equal(evaluate('(1 + 2) * 3'), 9n);
  assert.equal(evaluate('10 - 4 - 3'), 3n);
  assert.equal(evaluate('2 * 3 % 4'), 2n);
  assert.equal(evaluate('-3 + 5'), 2n);
  assert.equal(evaluate('-2 * -3'), 6n);
});

test('division truncates toward zero', () => {
  assert.equal(evaluate('7 / 2'), 3n);
  assert.equal(evaluate('-7 / 2'), -3n);
  assert.equal(evaluate('7 / -2'), -3n);
  assert.equal(evaluate('-7 / -2'), 3n);
  assert.equal(evaluate('-7 % 2'), -1n);
  assert.equal(evaluate('7 % -2'), 1n);
});

test('arbitrary precision integers', () => {
  const a = 123456789012345678901234567890n;
  const b = 987654321098765432109876543210n;
  assert.equal(evaluate(`${a} * ${b}`), a * b);
  assert.equal(evaluate(`${a} + ${b}`), a + b);
  assert.equal(evaluate(`-${a} / 7`), -a / 7n);
  assert.equal(
    evaluate('fn pow(b, e) { e == 0 ? 1 : b * pow(b, e - 1) } pow(2, 200)'),
    2n ** 200n,
  );
});

test('comparisons and equality', () => {
  assert.equal(evaluate('1 < 2'), true);
  assert.equal(evaluate('2 <= 2'), true);
  assert.equal(evaluate('3 > 4'), false);
  assert.equal(evaluate('4 >= 4'), true);
  assert.equal(evaluate('1 == 1'), true);
  assert.equal(evaluate('1 != 1'), false);
  assert.equal(evaluate('true == false'), false);
  assert.equal(evaluate('true != false'), true);
});

test('parsing is separated from evaluation', () => {
  const program = parse('1 / 0');
  assert.ok(program.body.kind === 'bin');
  assert.throws(() => new Machine(program).run(), EvalError);
});

test('one parsed program can be evaluated many times', () => {
  const program = parse('fn f(x) { x + 1 } f(41)');
  assert.equal(new Machine(program).run(), 42n);
  assert.equal(new Machine(program).run(), 42n);
});

test('type errors are reported', () => {
  assert.throws(() => evaluate('1 + true'), /type error: expected integer, got boolean/);
  assert.throws(() => evaluate('!1'), /type error: expected boolean, got integer/);
  assert.throws(() => evaluate('1 == true'), /cannot compare integer with boolean/);
  assert.throws(() => evaluate('1 ? 2 : 3'), /type error: expected boolean, got integer/);
});
