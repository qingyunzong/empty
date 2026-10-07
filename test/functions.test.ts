import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EvalError, evaluate } from '../src/index.ts';

test('named function definitions and calls', () => {
  assert.equal(evaluate('def add(a, b) = a + b; add(2, 3)'), 5n);
});

test('function expressions', () => {
  assert.equal(evaluate('let add = fn(a, b) => a + b in add(4, 5)'), 9n);
});

test('lexical scoping: inner bindings do not leak into closures', () => {
  assert.equal(evaluate('let x = 1 in (let f = fn() => x in (let x = 2 in f()))'), 1n);
});

test('closures see sibling definitions (shared definition frame)', () => {
  assert.equal(evaluate('def a() = b(); def b() = 7; a()'), 7n);
});

test('unused arguments are never evaluated, even if erroneous', () => {
  assert.equal(evaluate('def const_(a, b) = a; const_(1, 1 / 0)'), 1n);
  assert.equal(evaluate('def const_(a, b) = a; const_(1, missing_variable)'), 1n);
  assert.equal(evaluate('def ignore(x) = 42; ignore(1 / 0)'), 42n);
});

test('arguments are evaluated on first read and cached', () => {
  let calls = 0;
  const value = evaluate('def twice(x) = x + x; twice(expensive)', {
    vars: {
      expensive: () => {
        calls++;
        return 21n;
      },
    },
  });
  assert.equal(value, 42n);
  assert.equal(calls, 1);
});

test('a cached argument failure is rethrown without re-evaluating', () => {
  let calls = 0;
  assert.throws(
    () =>
      evaluate('def use(x) = x + x; use(boom)', {
        vars: {
          boom: () => {
            calls++;
            throw new Error('boom');
          },
        },
      }),
    /boom/,
  );
  assert.equal(calls, 1);
});

test('closures capture bindings, not copies of values', () => {
  let calls = 0;
  const value = evaluate('def make(x) = fn() => x; let c = make(expensive) in c() + c()', {
    vars: {
      expensive: () => {
        calls++;
        return 5n;
      },
    },
  });
  assert.equal(value, 10n);
  assert.equal(calls, 1);
});

test('call protocol errors', () => {
  assert.throws(() => evaluate('def f(a) = a; f(1, 2)'), /Arity mismatch/);
  assert.throws(() => evaluate('1(2)'), (error) => error instanceof EvalError);
});
