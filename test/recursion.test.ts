import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BudgetExhaustedError, evaluate } from '../src/index.ts';

const FACT = 'def fact(n) = n == 0 ? 1 : n * fact(n - 1); fact(10)';

test('recursion works within an explicit step budget', () => {
  assert.equal(evaluate(FACT, { budget: 100000 }), 3628800n);
});

test('recursion is bounded by the step budget', () => {
  assert.throws(() => evaluate(FACT, { budget: 20 }), (error) => error instanceof BudgetExhaustedError);
});

test('unbounded recursion is stopped by the budget', () => {
  assert.throws(
    () => evaluate('def loop(n) = loop(n + 1); loop(0)', { budget: 1000 }),
    (error) => error instanceof BudgetExhaustedError,
  );
});

test('mutual recursion', () => {
  const source = `
    def isEven(n) = n == 0 ? true : isOdd(n - 1);
    def isOdd(n) = n == 0 ? false : isEven(n - 1);
    isEven(10) && !isOdd(10)
  `;
  assert.equal(evaluate(source, { budget: 100000 }), true);
});
