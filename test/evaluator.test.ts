import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluator.ts';
import { evaluateExact } from '../src/interpreter.ts';

const CASES: Array<[string, bigint]> = [
  ['0', 0n],
  ['42', 42n],
  ['2 + 3 * 4', 14n],
  ['(2 + 3) * 4', 20n],
  ['2 ^ 3 ^ 2', 512n],
  ['-2 ^ 2', -4n],
  ['10 - 20', -10n],
  ['0 ^ 0', 1n],
  ['0 ^ 5', 0n],
  ['1 ^ 999999999999', 1n],
  ['(-1) ^ 999999999999', -1n],
  ['(-1) ^ 1000000000000', 1n],
  ['1 < 2', 1n],
  ['2 <= 2', 1n],
  ['3 > 4', 0n],
  ['5 == 5', 1n],
  ['5 != 5', 0n],
  ['1 && 7', 1n],
  ['7 && 0', 0n],
  ['0 || 9', 1n],
  ['0 || 0', 0n],
  ['1 ? 10 : 20', 10n],
  ['0 ? 10 : 20', 20n],
  ['2 ^ 64', 18446744073709551616n],
  ['123456789123456789 * 987654321987654321', 121932631356500531347203169112635269n],
];

for (const [source, expected] of CASES) {
  test(`evaluates ${source}`, () => {
    assert.equal(evaluate(source).value, expected);
  });
}

test('budgeted evaluator agrees with exact interpreter on fixed cases', () => {
  for (const [source] of CASES) {
    assert.equal(evaluate(source).value, evaluateExact(source), source);
  }
});

test('reports usage counters', () => {
  const outcome = evaluate('12 + 34');
  assert.equal(outcome.value, 46n);
  assert.equal(outcome.stepsUsed, 3);
  assert.equal(outcome.digitsUsed, 2 + 2 + 2); // 12, 34, 46
});
