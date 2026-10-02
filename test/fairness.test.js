import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule } from '../src/scheduler.js';

const mkPass = (over) => ({
  id: 'P',
  task: 'T',
  start: 0,
  end: 100,
  elevation: 10,
  rate: 10,
  priority: 0,
  onboard: 1e9,
  corrections: [],
  ...over,
});

test('acceptance 3: equal deficit ties break by task id', () => {
  // PA (task TB) is inserted first; the tie must still go to task TA.
  const state = {
    config: { setup: 0, lock: 0, maxRate: 1e9 },
    passes: [
      mkPass({ id: 'PA', task: 'TB', start: 0, end: 100 }),
      mkPass({ id: 'PB', task: 'TA', start: 0, end: 100 }),
    ],
    tasks: {},
  };
  const sched = computeSchedule(state);
  assert.equal(sched.served.TA, 1000);
  assert.equal(sched.served.TB ?? 0, 0);
  assert.deepStrictEqual(sched.segments, [
    { pass: 'PB', task: 'TA', start: 0, end: 100, bytes: 1000 },
  ]);
});

test('acceptance 3: same task, equal deficit ties break by start second', () => {
  // Blocker keeps the antenna busy until t=10 so both candidates are eligible
  // at decision time; P1 (start 3) must beat P2 (start 5).
  const state = {
    config: { setup: 0, lock: 0, maxRate: 1e9 },
    passes: [
      mkPass({ id: 'P2', task: 'T', start: 5, end: 200 }),
      mkPass({ id: 'P1', task: 'T', start: 3, end: 200 }),
      mkPass({ id: 'PB', task: 'TZ', start: 0, end: 10 }),
    ],
    tasks: { TZ: { minGuarantee: 100000 } },
  };
  const sched = computeSchedule(state);
  assert.deepStrictEqual(
    sched.segments.map((s) => [s.pass, s.start, s.end]),
    [
      ['PB', 0, 10],
      ['P1', 10, 200],
    ]
  );
});

test('minimum guarantee: task below guarantee outranks task without deficit', () => {
  const state = {
    config: { setup: 0, lock: 0, maxRate: 1e9 },
    passes: [
      mkPass({ id: 'PZ', task: 'TZ', start: 0, end: 200 }),
      mkPass({ id: 'PG', task: 'TG', start: 0, end: 100 }),
    ],
    tasks: { TG: { minGuarantee: 1000 } },
  };
  const sched = computeSchedule(state);
  assert.deepStrictEqual(
    sched.segments.map((s) => [s.pass, s.start, s.end]),
    [
      ['PG', 0, 100],
      ['PZ', 100, 200],
    ]
  );
});

test('deficit is cumulative: served bytes reduce future priority', () => {
  // TA has a guarantee of 1500 and two passes; TB none. After TA's first pass
  // (1000 bytes) TA still has deficit 500, so it also wins the second window.
  const state = {
    config: { setup: 0, lock: 0, maxRate: 1e9 },
    passes: [
      mkPass({ id: 'PA1', task: 'TA', start: 0, end: 100 }),
      mkPass({ id: 'PB1', task: 'TB', start: 0, end: 100 }),
      mkPass({ id: 'PA2', task: 'TA', start: 100, end: 200 }),
      mkPass({ id: 'PB2', task: 'TB', start: 100, end: 200 }),
    ],
    tasks: { TA: { minGuarantee: 1500 } },
  };
  const sched = computeSchedule(state);
  assert.equal(sched.served.TA, 2000);
  assert.equal(sched.served.TB ?? 0, 0);
});
