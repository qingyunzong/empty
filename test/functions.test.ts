import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetExceededError,
  Closure,
  evaluate,
  Machine,
  parse,
} from '../src/index.js';

test('arguments are lazy: unused erroring argument is never evaluated', () => {
  const m = new Machine(parse('fn const42(x) { 42 } const42(1 / 0)'));
  assert.equal(m.run(), 42n);
  assert.equal(m.thunks.length, 1);
  assert.equal(m.thunks[0].state, 'pending');
  assert.equal(m.stats.thunkForces, 0);
});

test('argument is evaluated on first read and cached afterwards', () => {
  const m = new Machine(parse('fn dup(x) { x + x } dup(21 * 2)'));
  assert.equal(m.run(), 84n);
  assert.equal(m.stats.thunkForces, 1);
  assert.equal(m.thunks[0].state, 'value');
  assert.equal(m.thunks[0].value, 42n);
});

test('closures capture bindings, not copies of values', () => {
  assert.equal(evaluate('fn a() { b() } fn b() { 42 } a()'), 42n);
  assert.equal(evaluate('fn adder(a) { fn (b) { a + b } } adder(10)(5)'), 15n);
  assert.equal(
    evaluate(
      'fn isEven(n) { n == 0 ? true : isOdd(n - 1) } ' +
        'fn isOdd(n) { n == 0 ? false : isEven(n - 1) } ' +
        'isEven(10) && isOdd(7)',
    ),
    true,
  );
});

test('captured lazy argument stays lazy inside the closure', () => {
  const result = evaluate('fn f(x) { fn () { x } } f(1 / 0)');
  assert.ok(result instanceof Closure);
  assert.throws(() => evaluate('fn f(x) { fn () { x } } f(1 / 0)()'), /division by zero/);
});

test('recursion is bounded by an explicit step budget', () => {
  assert.equal(
    evaluate('fn fact(n) { n <= 1 ? 1 : n * fact(n - 1) } fact(20)', { budget: 100_000 }),
    2432902008176640000n,
  );
  assert.throws(
    () => evaluate('fn fact(n) { n <= 1 ? 1 : n * fact(n - 1) } fact(20)', { budget: 10 }),
    BudgetExceededError,
  );
  assert.throws(
    () => evaluate('fn loop(n) { loop(n + 1) } loop(0)', { budget: 500 }),
    (e: unknown) => {
      assert.ok(e instanceof BudgetExceededError);
      assert.match((e as Error).message, /step budget exhausted/);
      return true;
    },
  );
});

test('call errors: arity and calling non-functions', () => {
  assert.throws(() => evaluate('fn f(a, b) { a } f(1)'), /arity mismatch: expected 2 argument\(s\), got 1/);
  assert.throws(() => evaluate('1(2)'), /cannot call integer/);
});
