import { test } from 'node:test';
import { deepEqual, ok } from 'node:assert/strict';
import { run, replayTrace } from '../src/simulator.js';
import { runModel } from '../src/model.js';
import { examples } from '../src/examples.js';
import { genDagProgram, genCyclicProgram } from './helpers.js';

test('simulator matches independent model on 300 random DAG programs', () => {
  let settled = 0;
  let exceeded = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const program = genDagProgram(seed);
    const budget = 1 + (seed % 400);
    const expected = run(program, { maxSteps: budget });
    const actual = runModel(program, budget);
    deepEqual(actual, expected, `divergence at seed=${seed} budget=${budget}`);
    if (expected.status === 'settled') settled += 1;
    else exceeded += 1;
  }
  ok(settled > 0, 'expected at least one settled run');
  ok(exceeded > 0, 'expected at least one budget-exceeded run');
});

test('simulator matches independent model on 100 cyclic (never-settling) programs', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const program = genCyclicProgram(seed);
    const budget = 1 + (seed % 60);
    const expected = run(program, { maxSteps: budget });
    const actual = runModel(program, budget);
    deepEqual(actual, expected, `divergence at seed=${seed} budget=${budget}`);
    deepEqual(expected.status, 'budget-exceeded');
  }
});

test('simulator matches independent model on all hand-written examples', () => {
  for (const example of examples) {
    const expected = run(example.program, { maxSteps: example.maxSteps });
    const actual = runModel(example.program, example.maxSteps);
    deepEqual(actual, expected, `divergence in example ${example.name}`);
  }
});

test('traces are replayable: re-execution and JSON round-trip reproduce identical results', () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    const program = genDagProgram(seed * 7 + 3);
    const budget = 1 + (seed % 200);
    const recorded = run(program, { maxSteps: budget });
    // 直接重放
    deepEqual(replayTrace(program, { maxSteps: budget }, recorded), recorded);
    // 序列化往返后重放（轨迹可落盘再校验）
    const revived = JSON.parse(JSON.stringify(recorded));
    deepEqual(replayTrace(program, { maxSteps: budget }, revived), recorded);
  }
});

test('trace events are JSON-serializable and self-contained', () => {
  const example = examples.find((e) => e.name === 'micro-inside-timer')!;
  const result = run(example.program, { maxSteps: example.maxSteps });
  const revived = JSON.parse(JSON.stringify(result));
  deepEqual(revived, result);
  ok(result.trace.every((e) => Number.isInteger(e.step) && Number.isInteger(e.time)));
});
