import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CopyStackModel } from './model';
import { execute, generateProgram, makeRng } from './random';
import { UndoLogMachine } from './transaction';

function checkSeed(seed: number): void {
  const program = generateProgram(makeRng(seed));
  const expected = execute(new CopyStackModel(), program);
  const actual = execute(new UndoLogMachine(), program);
  assert.deepEqual(actual, expected, `mismatch for seed ${seed}: ${JSON.stringify(program)}`);
}

test('random programs 0..249: undo-log machine matches copy-stack model', () => {
  for (let seed = 0; seed < 250; seed += 1) {
    checkSeed(seed);
  }
});

test('random programs 250..499: undo-log machine matches copy-stack model', () => {
  for (let seed = 250; seed < 500; seed += 1) {
    checkSeed(seed);
  }
});

test('generated programs exercise every feature (non-vacuous differential test)', () => {
  let budgetAborts = 0;
  let captures = 0;
  let capturedErrors = 0;
  let publishedActions = 0;
  let cleanRuns = 0;
  let transactionErrors = 0;
  for (let seed = 0; seed < 500; seed += 1) {
    const program = generateProgram(makeRng(seed));
    const out = execute(new CopyStackModel(), program);
    if (!out.ok && out.error === 'BudgetExhaustedError') budgetAborts += 1;
    if (!out.ok && out.error === 'TransactionError') transactionErrors += 1;
    if (out.captured.length > 0) captures += 1;
    if (out.captured.some((c) => c !== 'ok')) capturedErrors += 1;
    if (out.published.length > 0) publishedActions += 1;
    if (out.ok) cleanRuns += 1;
  }
  assert.ok(budgetAborts > 50, `expected many budget aborts, got ${budgetAborts}`);
  assert.ok(captures > 100, `expected many captures, got ${captures}`);
  assert.ok(capturedErrors > 50, `expected many captured errors, got ${capturedErrors}`);
  assert.ok(publishedActions > 50, `expected many published actions, got ${publishedActions}`);
  assert.ok(cleanRuns > 50, `expected many clean runs, got ${cleanRuns}`);
  assert.ok(transactionErrors > 0, `expected some transaction errors, got ${transactionErrors}`);
});
