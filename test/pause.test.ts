import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BudgetExhaustedError, evaluate, parse, start } from '../src/index.ts';

const SOURCE = 'def fact(n) = n == 0 ? 1 : n * fact(n - 1); fact(30)';

test('pause and resume produces the same result as a single run', () => {
  const oneShot = start(SOURCE, { budget: 1000000 });
  assert.equal(oneShot.status, 'done');

  let result = start(SOURCE, { budget: 1000000, pauseEvery: 5 });
  let pauses = 0;
  while (result.status === 'paused') {
    pauses++;
    result = result.resume();
  }
  assert.ok(pauses > 0);
  assert.equal(result.status, 'done');
  assert.equal(result.value, evaluate(SOURCE));
  if (oneShot.status === 'done') {
    assert.equal(result.steps, oneShot.steps);
  }
});

test('resuming works for any pause interval', () => {
  const expected = evaluate(SOURCE);
  for (const pauseEvery of [1, 2, 3, 7, 100]) {
    let result = start(parse(SOURCE), { pauseEvery });
    while (result.status === 'paused') result = result.resume();
    assert.equal(result.value, expected);
  }
});

test('no pause happens when the interval exceeds the step count', () => {
  const result = start('1 + 2', { pauseEvery: 1000 });
  assert.equal(result.status, 'done');
  assert.equal(result.status === 'done' && result.value, 3n);
});

test('the step budget is still enforced across resumes', () => {
  let result = start(SOURCE, { budget: 50, pauseEvery: 3 });
  assert.throws(
    () => {
      while (result.status === 'paused') result = result.resume();
    },
    (error) => error instanceof BudgetExhaustedError,
  );
});
