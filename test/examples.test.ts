import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { examples } from '../src/examples.js';
import { run, formatTrace, type Phase, type RunResult } from '../src/simulator.js';

type TraceTuple = [Phase, string, number];

interface Expectation {
  status: 'settled' | 'budget-exceeded';
  steps: number;
  time: number;
  trace: TraceTuple[];
  pending: { timers: number; microtasks: number };
  log?: string[];
}

/** 手工推导的期望轨迹（与 examples.ts 一一对应）。 */
const expectations: Record<string, Expectation> = {
  'micro-before-timer': {
    status: 'settled',
    steps: 3,
    time: 0,
    trace: [
      ['macro', 'main', 0],
      ['micro', 'micro', 0],
      ['macro', 'timer', 0],
    ],
    pending: { timers: 0, microtasks: 0 },
    log: ['script', 'micro task', 'timer'],
  },
  'micro-chain': {
    status: 'settled',
    steps: 5,
    time: 5,
    trace: [
      ['macro', 'main', 0],
      ['micro', 'm1', 0],
      ['micro', 'm2', 0],
      ['micro', 'm3', 0],
      ['macro', 'timer', 5],
    ],
    pending: { timers: 0, microtasks: 0 },
  },
  'timer-tie-fifo': {
    status: 'settled',
    steps: 5,
    time: 10,
    trace: [
      ['macro', 'main', 0],
      ['macro', 'early', 5],
      ['macro', 'a', 10],
      ['macro', 'b', 10],
      ['macro', 'c', 10],
    ],
    pending: { timers: 0, microtasks: 0 },
    log: ['early', 'a', 'b', 'c'],
  },
  'micro-inside-timer': {
    status: 'settled',
    steps: 4,
    time: 10,
    trace: [
      ['macro', 'main', 0],
      ['macro', 't1', 5],
      ['micro', 'm', 5],
      ['macro', 't2', 10],
    ],
    pending: { timers: 0, microtasks: 0 },
    log: ['t1', 'm between timers', 't2'],
  },
  'unclosed-microtask-loop': {
    status: 'budget-exceeded',
    steps: 7,
    time: 0,
    trace: [
      ['macro', 'main', 0],
      ['micro', 'spin', 0],
      ['micro', 'spin', 0],
      ['micro', 'spin', 0],
      ['micro', 'spin', 0],
      ['micro', 'spin', 0],
      ['micro', 'spin', 0],
    ],
    pending: { timers: 0, microtasks: 1 },
  },
  'unclosed-timer-chain': {
    status: 'budget-exceeded',
    steps: 5,
    time: 4,
    trace: [
      ['macro', 'main', 0],
      ['macro', 'tick', 1],
      ['macro', 'tick', 2],
      ['macro', 'tick', 3],
      ['macro', 'tick', 4],
    ],
    pending: { timers: 1, microtasks: 0 },
  },
};

function simplify(result: RunResult) {
  return {
    status: result.status,
    steps: result.steps,
    time: result.time,
    trace: result.trace.map((e): TraceTuple => [e.phase, e.label, e.time]),
    pending: result.pending,
  };
}

for (const example of examples) {
  test(`example ${example.name} matches hand-computed trace`, () => {
    const expected = expectations[example.name];
    if (expected === undefined) throw new Error(`missing expectation for ${example.name}`);
    const result = run(example.program, { maxSteps: example.maxSteps });
    deepEqual(simplify(result), {
      status: expected.status,
      steps: expected.steps,
      time: expected.time,
      trace: expected.trace,
      pending: expected.pending,
    });
    if (expected.log !== undefined) deepEqual(result.log, expected.log);
  });
}

test('every example is covered by a hand-written expectation', () => {
  deepEqual(
    examples.map((e) => e.name).sort(),
    Object.keys(expectations).sort(),
  );
});

test('formatTrace renders a readable timeline', () => {
  const example = examples.find((e) => e.name === 'micro-before-timer')!;
  const text = formatTrace(run(example.program, { maxSteps: example.maxSteps }));
  const lines = text.split('\n');
  equal(lines.length, 4);
  equal(lines[0], '#000 macro main @t=0');
  equal(lines[1], '#001 micro micro @t=0');
  equal(lines[2], '#002 macro timer @t=0');
  equal(lines[3], 'status=settled steps=3 time=0 pending={timers:0, microtasks:0}');
});
