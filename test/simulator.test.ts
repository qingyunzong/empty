import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Instruction, Simulator } from '../src/simulator';
import { enumerateSchedules, resultKey } from '../src/exhaustive';
import { runSequential, verifySequential } from '../src/sequential';

const increment = (lock: boolean): Instruction[] => {
  const body: Instruction[] = [
    { op: 'read', shared: 'x', into: 't' },
    { op: 'add', local: 't', value: 1 },
    { op: 'write', shared: 'x', from: { local: 't' } },
  ];
  return lock
    ? [{ op: 'lock', lock: 'L' }, ...body, { op: 'unlock', lock: 'L' }]
    : body;
};

test('schedule drives read/write step by step', () => {
  const programs: Instruction[][] = [
    [{ op: 'write', shared: 'x', from: 1 }],
    [
      { op: 'read', shared: 'x', into: 'a' },
      { op: 'write', shared: 'y', from: { local: 'a' } },
    ],
  ];
  const sim = new Simulator(programs);
  sim.step(0);
  assert.deepEqual(sim.shared, { x: 1 });
  assert.equal(sim.result().status, 'incomplete');
  sim.step(1);
  sim.step(1);
  const result = sim.result();
  assert.equal(result.status, 'finished');
  assert.deepEqual(result.shared, { x: 1, y: 1 });
});

test('run() consumes a full schedule and reports shared state and locks', () => {
  const programs = [increment(true), increment(true)];
  const sim = new Simulator(programs, { x: 0 });
  const result = sim.run([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  assert.equal(result.status, 'finished');
  assert.deepEqual(result.shared, { x: 2 });
  assert.deepEqual(result.locks, { L: null });
});

test('lock holder appears in the lock table while held', () => {
  const programs: Instruction[][] = [
    [{ op: 'lock', lock: 'L' }, { op: 'unlock', lock: 'L' }],
    [{ op: 'lock', lock: 'L' }, { op: 'unlock', lock: 'L' }],
  ];
  const sim = new Simulator(programs);
  sim.step(0);
  assert.deepEqual(sim.result().locks, { L: 0 });
  assert.equal(sim.isBlocked(1), true);
  assert.equal(sim.isRunnable(1), false);
  assert.throws(() => sim.step(1));
  sim.step(0);
  assert.deepEqual(sim.result().locks, { L: null });
  sim.step(1);
  assert.deepEqual(sim.result().locks, { L: 1 });
});

test('deadlock is reported when no thread is runnable and threads remain', () => {
  const programs: Instruction[][] = [
    [
      { op: 'lock', lock: 'A' },
      { op: 'lock', lock: 'B' },
      { op: 'unlock', lock: 'B' },
      { op: 'unlock', lock: 'A' },
    ],
    [
      { op: 'lock', lock: 'B' },
      { op: 'lock', lock: 'A' },
      { op: 'unlock', lock: 'A' },
      { op: 'unlock', lock: 'B' },
    ],
  ];
  const sim = new Simulator(programs);
  sim.step(0);
  sim.step(1);
  const result = sim.result();
  assert.equal(result.status, 'deadlock');
  assert.deepEqual(result.locks, { A: 0, B: 1 });
});

test('branch picks then/else based on shared state read into a local', () => {
  const programs: Instruction[][] = [
    [{ op: 'write', shared: 'flag', from: 1 }],
    [
      { op: 'read', shared: 'flag', into: 'f' },
      { op: 'branch', cond: { local: 'f', cmp: 'eq', value: 1 }, then: 2, else: 3 },
      { op: 'write', shared: 'y', from: 10 },
      { op: 'write', shared: 'y', from: 20 },
    ],
  ];
  const first = new Simulator(programs, { flag: 0 });
  first.run([0, 1, 1, 1]);
  assert.deepEqual(first.result().shared, { flag: 1, y: 10 });

  const second = new Simulator(programs, { flag: 0 });
  second.run([1, 1, 1]);
  assert.deepEqual(second.result().shared, { flag: 0, y: 20 });
});

test('exhaustive enumeration of a racy counter yields x=1 and x=2', () => {
  const programs = [increment(false), increment(false)];
  const report = enumerateSchedules(programs, { x: 0 });
  const finals = [...report.results.values()].filter((r) => r.status === 'finished');
  const xs = new Set(finals.map((r) => r.shared['x']));
  assert.deepEqual([...xs].sort(), [1, 2]);
});

test('exhaustive enumeration of a locked counter yields only x=2', () => {
  const programs = [increment(true), increment(true)];
  const report = enumerateSchedules(programs, { x: 0 });
  assert.equal(report.results.size, 1);
  const only = [...report.results.values()][0]!;
  assert.equal(only.status, 'finished');
  assert.deepEqual(only.shared, { x: 2 });
  assert.deepEqual(only.locks, { L: null });
});

test('exhaustive enumeration surfaces both deadlock and finished outcomes', () => {
  const programs: Instruction[][] = [
    [
      { op: 'lock', lock: 'A' },
      { op: 'lock', lock: 'B' },
      { op: 'unlock', lock: 'B' },
      { op: 'unlock', lock: 'A' },
    ],
    [
      { op: 'lock', lock: 'B' },
      { op: 'lock', lock: 'A' },
      { op: 'unlock', lock: 'A' },
      { op: 'unlock', lock: 'B' },
    ],
  ];
  const report = enumerateSchedules(programs);
  const statuses = new Set([...report.results.values()].map((r) => r.status));
  assert.ok(statuses.has('deadlock'));
  assert.ok(statuses.has('finished'));
});

test('step cap marks long schedules as incomplete', () => {
  const programs = [increment(false), increment(false)];
  const report = enumerateSchedules(programs, { x: 0 }, 2);
  const statuses = new Set([...report.results.values()].map((r) => r.status));
  assert.ok(statuses.has('incomplete'));
  assert.ok(!statuses.has('finished'));
});

test('sequential reference matches the locked-counter exhaustive result', () => {
  const programs = [increment(true), increment(true)];
  const verification = verifySequential(programs, { x: 0 });
  assert.equal(verification.sequential.status, 'finished');
  assert.deepEqual(verification.sequential.shared, { x: 2 });
  assert.equal(verification.contained, true);
});

test('sequential reference of a racy counter is one of the enumerated outcomes', () => {
  const programs = [increment(false), increment(false)];
  const verification = verifySequential(programs, { x: 0 });
  assert.deepEqual(verification.sequential.shared, { x: 2 });
  assert.equal(verification.contained, true);
  assert.equal(verification.resultCount, 2);
});

test('runSequential reports deadlock when a later thread blocks forever', () => {
  const programs: Instruction[][] = [
    [{ op: 'lock', lock: 'L' }],
    [{ op: 'lock', lock: 'L' }, { op: 'unlock', lock: 'L' }],
  ];
  const result = runSequential(programs);
  assert.equal(result.status, 'deadlock');
  assert.deepEqual(result.locks, { L: 0 });
});

test('invalid schedules and lock misuse throw', () => {
  const programs: Instruction[][] = [
    [{ op: 'unlock', lock: 'L' }],
    [{ op: 'write', shared: 'x', from: 1 }],
  ];
  assert.throws(() => new Simulator(programs).step(0));
  assert.throws(() => new Simulator(programs).step(2));
  const done = new Simulator([[], []]);
  assert.throws(() => done.step(0));
  assert.equal(done.result().status, 'finished');
});

test('three threads are supported, four are rejected', () => {
  const three = [increment(true), increment(true), increment(true)];
  const report = enumerateSchedules(three, { x: 0 });
  assert.equal(report.results.size, 1);
  assert.deepEqual([...report.results.values()][0]!.shared, { x: 3 });
  assert.throws(() => new Simulator([...three, increment(true)]));
});

test('resultKey dedupes identical outcomes', () => {
  const programs = [increment(false), increment(false)];
  const report = enumerateSchedules(programs, { x: 0 });
  const keys = new Set([...report.results.values()].map(resultKey));
  assert.equal(keys.size, report.results.size);
});
