import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluator.ts';
import { BudgetError, EvalError } from '../src/errors.ts';

function expectBudgetError(
  source: string,
  options: { maxSteps?: number; maxDigits?: number },
  kind: 'step' | 'digit',
): BudgetError {
  try {
    evaluate(source, options);
  } catch (error) {
    if (!(error instanceof BudgetError)) throw error;
    assert.equal(error.budgetKind, kind);
    return error;
  }
  assert.fail(`expected BudgetError(${kind}) for ${source}`);
}

test('step budget is enforced and the error carries the sub-expression range', () => {
  const source = '1 + 2 + 3 + 4 + 5';
  const error = expectBudgetError(source, { maxSteps: 4 }, 'step');
  assert.ok(error.range.start >= 0 && error.range.end <= source.length);
  assert.ok(error.range.start < error.range.end);
});

test('digit budget is charged for literals when evaluated', () => {
  const source = '12345';
  const error = expectBudgetError(source, { maxDigits: 4 }, 'digit');
  assert.equal(source.slice(error.range.start, error.range.end), '12345');
});

test('digit accounting is exact: literals and results consume their digits', () => {
  const outcome = evaluate('999 + 1', { maxDigits: 100 });
  assert.equal(outcome.value, 1000n);
  assert.equal(outcome.digitsUsed, 3 + 1 + 4); // 999, 1, 1000
});

test('multiplication is estimated before execution', () => {
  // 10000 * 10000 = 100000000 has 9 digits, but the conservative estimate
  // is 5 + 5 = 10 digits. After the two literals consume 10 digits of the
  // 15-digit budget, only 5 remain: the estimate alone must trigger the
  // error, proving the check runs before the multiplication.
  const source = '10000 * 10000';
  const error = expectBudgetError(source, { maxDigits: 15 }, 'digit');
  assert.equal(source.slice(error.range.start, error.range.end), '10000 * 10000');
  assert.equal(error.needed, 10n);
  // The estimate must fit the remaining budget, so the expression succeeds
  // once the budget reaches 10 (literals) + 10 (estimate) = 20, even though
  // only 19 digits are actually consumed (the true result has 9 digits).
  const outcome = evaluate(source, { maxDigits: 20 });
  assert.equal(outcome.value, 100000000n);
  assert.equal(outcome.digitsUsed, 19);
});

test('budget error range identifies the failing sub-expression, not the whole input', () => {
  const source = '7 + 123456 * 2';
  const error = expectBudgetError(source, { maxDigits: 8 }, 'digit');
  assert.equal(source.slice(error.range.start, error.range.end), '123456 * 2');
});

test('astronomical exponents are rejected reproducibly without being computed', () => {
  const source = '2 ^ 1000000000';
  const first = expectBudgetError(source, {}, 'digit');
  const second = expectBudgetError(source, {}, 'digit');
  assert.equal(first.message, second.message);
  assert.deepEqual(first.range, second.range);
  assert.equal(source.slice(first.range.start, first.range.end), source);
  assert.equal(first.needed, 1000000000n); // 1 digit of base 2 times the exponent
});

test('nested huge exponents are rejected before any big value materializes', () => {
  const source = '10 ^ (10 ^ 9)';
  const error = expectBudgetError(source, {}, 'digit');
  assert.equal(source.slice(error.range.start, error.range.end), source);
  assert.equal(error.needed, 2n * 10n ** 9n); // digits(10) * 1e9
});

test('negative exponents are evaluation errors with a range', () => {
  const source = '2 ^ (0 - 3)';
  assert.throws(
    () => evaluate(source),
    (error: unknown) => {
      if (!(error instanceof EvalError) || error instanceof BudgetError) return false;
      assert.equal(source.slice(error.range.start, error.range.end), source);
      return true;
    },
  );
});

test('short-circuited || never touches its right operand', () => {
  assert.equal(evaluate('1 || 2 ^ 1000000000').value, 1n);
});

test('short-circuited && never touches its right operand', () => {
  assert.equal(evaluate('0 && 2 ^ 1000000000').value, 0n);
});

test('unevaluated ternary branches consume no digit budget', () => {
  assert.equal(evaluate('0 ? 2 ^ 1000000000 : 42').value, 42n);
  assert.equal(evaluate('1 ? 42 : 2 ^ 1000000000').value, 42n);
});

test('dead branches do not even pay for their literals', () => {
  // The literal 999999 has 6 digits > maxDigits 5; it is only reachable in
  // the dead branch, so all of these must succeed.
  assert.equal(evaluate('1 || 999999', { maxDigits: 5 }).value, 1n);
  assert.equal(evaluate('0 && 999999', { maxDigits: 5 }).value, 0n);
  assert.equal(evaluate('1 ? 7 : 999999', { maxDigits: 5 }).value, 7n);
  // Sanity: the same literal fails when actually evaluated.
  expectBudgetError('999999', { maxDigits: 5 }, 'digit');
});

test('live branches still consume budget normally', () => {
  expectBudgetError('0 || 999999', { maxDigits: 5 }, 'digit');
  expectBudgetError('1 && 999999', { maxDigits: 5 }, 'digit');
  expectBudgetError('0 ? 7 : 999999', { maxDigits: 5 }, 'digit');
});
