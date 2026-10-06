import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateScript,
  runOnBusAsync,
  runOnBusSync,
  runOnInterpreter,
} from './helpers/script.js';

const SEEDS = 300;

test('sync publish traces and aggregated errors match the snapshot interpreter', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const script = generateScript(seed);
    const expected = runOnInterpreter(script);
    const actual = runOnBusSync(script);
    assert.deepEqual(actual.trace, expected.trace, `trace mismatch (seed ${seed})`);
    assert.deepEqual(actual.outcomes, expected.outcomes, `outcome mismatch (seed ${seed})`);
  }
});

test('async publish traces and aggregated errors match the snapshot interpreter', async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const script = generateScript(seed);
    const expected = runOnInterpreter(script);
    const actual = await runOnBusAsync(script);
    assert.deepEqual(actual.trace, expected.trace, `trace mismatch (seed ${seed})`);
    assert.deepEqual(actual.outcomes, expected.outcomes, `outcome mismatch (seed ${seed})`);
  }
});
