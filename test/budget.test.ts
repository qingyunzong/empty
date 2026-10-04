import { test } from 'node:test';
import { deepEqual, equal, throws } from 'node:assert/strict';
import { run, type Program } from '../src/simulator.js';
import { examples } from '../src/examples.js';

const byName = (name: string) => examples.find((e) => e.name === name)!;

test('maxSteps=0 returns unclosed state before running anything', () => {
  const example = byName('micro-before-timer');
  const result = run(example.program, { maxSteps: 0 });
  equal(result.status, 'budget-exceeded');
  equal(result.steps, 0);
  deepEqual(result.trace, []);
  deepEqual(result.pending, { timers: 0, microtasks: 0 });
});

test('maxSteps=1 runs only the main macrotask and reports remaining work', () => {
  const example = byName('micro-before-timer');
  const result = run(example.program, { maxSteps: 1 });
  equal(result.status, 'budget-exceeded');
  equal(result.steps, 1);
  deepEqual(
    result.trace.map((e) => [e.phase, e.label, e.time]),
    [['macro', 'main', 0]],
  );
  deepEqual(result.pending, { timers: 1, microtasks: 1 });
});

test('exact budget boundary: N steps settles, N-1 does not', () => {
  const example = byName('micro-chain'); // 需要恰好 5 步
  const settled = run(example.program, { maxSteps: 5 });
  equal(settled.status, 'settled');
  equal(settled.steps, 5);
  const short = run(example.program, { maxSteps: 4 });
  equal(short.status, 'budget-exceeded');
  equal(short.steps, 4);
  deepEqual(short.pending, { timers: 1, microtasks: 0 });
});

test('self-perpetuating microtask never advances the virtual clock', () => {
  const example = byName('unclosed-microtask-loop');
  const result = run(example.program, { maxSteps: 100 });
  equal(result.status, 'budget-exceeded');
  equal(result.steps, 100);
  equal(result.time, 0);
  deepEqual(result.pending, { timers: 0, microtasks: 1 });
});

test('unknown task label throws', () => {
  const program: Program = {
    main: (api) => api.queueMicrotask('nope'),
    tasks: {},
  };
  throws(() => run(program, { maxSteps: 10 }), /unknown task label: nope/);
});

test('negative or non-finite delay throws', () => {
  const program: Program = {
    main: (api) => api.setTimeout('x', -1),
    tasks: { x: () => {} },
  };
  throws(() => run(program, { maxSteps: 10 }), /invalid delay/);
  const program2: Program = {
    main: (api) => api.setTimeout('x', Number.NaN),
    tasks: { x: () => {} },
  };
  throws(() => run(program2, { maxSteps: 10 }), /invalid delay/);
});

test('virtual clock only advances when a timer is dequeued', () => {
  const program: Program = {
    main: (api) => {
      api.setTimeout('late', 50);
      api.setTimeout('early', 10);
    },
    tasks: {
      early: (api) => {
        equal(api.now(), 10);
        api.setTimeout('mid', 5); // 触发于 t=15，早于 @50
      },
      mid: (api) => equal(api.now(), 15),
      late: (api) => equal(api.now(), 50),
    },
  };
  const result = run(program, { maxSteps: 10 });
  equal(result.status, 'settled');
  equal(result.time, 50);
  deepEqual(
    result.trace.map((e) => e.label),
    ['main', 'early', 'mid', 'late'],
  );
});
