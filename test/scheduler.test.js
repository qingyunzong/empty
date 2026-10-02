import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule, computeDrops, validateSchedule } from '../src/scheduler.js';
import { maxValidBytes } from '../src/oracle.js';

function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

const totalBytes = (sched) => Object.values(sched.passBytes).reduce((a, b) => a + b, 0);

test('acceptance 1: greedy schedule is valid and bounded by enumerated optimum (n<=12)', () => {
  const rand = rng(42);
  for (let iter = 0; iter < 40; iter++) {
    const n = 2 + Math.floor(rand() * 11); // 2..12 passes
    const setup = [0, 5, 25][Math.floor(rand() * 3)];
    const passes = [];
    for (let i = 0; i < n; i++) {
      const start = Math.floor(rand() * 600);
      const dur = 10 + Math.floor(rand() * 170);
      const rate = 1 + Math.floor(rand() * 40);
      const onboard = Math.floor(rate * dur * (0.5 + rand()));
      passes.push(
        mkPass({ id: `P${i}`, task: `T${i % 3}`, start, end: start + dur, rate, onboard })
      );
    }
    // lock=inf disables preemption so the greedy sequence maps 1:1 into the
    // oracle's sequence space; no quotas so the bound is exact.
    const state = { config: { setup, lock: 1e9, maxRate: 1e9 }, passes, tasks: {} };
    const sched = computeSchedule(state);
    assert.deepStrictEqual(validateSchedule(state, sched), [], `iter ${iter}: invalid schedule`);
    const greedy = totalBytes(sched);
    const opt = maxValidBytes(
      passes.map((p) => ({ start: p.start, end: p.end, rate: p.rate, onboard: p.onboard })),
      setup
    );
    assert.ok(greedy <= opt, `iter ${iter}: greedy ${greedy} exceeds enumerated max ${opt}`);
  }
});

test('acceptance 1: non-overlapping passes reach the enumerated optimum exactly', () => {
  const setup = 10;
  const passes = [0, 1, 2, 3, 4].map((i) =>
    mkPass({ id: `P${i}`, task: `T${i}`, start: i * 200, end: i * 200 + 100, rate: 10 + i })
  );
  const state = { config: { setup, lock: 0, maxRate: 1e9 }, passes, tasks: {} };
  const sched = computeSchedule(state);
  const sum = passes.reduce((a, p) => a + p.rate * 100, 0);
  const opt = maxValidBytes(
    passes.map((p) => ({ start: p.start, end: p.end, rate: p.rate, onboard: p.onboard })),
    setup
  );
  assert.equal(totalBytes(sched), sum);
  assert.equal(opt, sum);
});

test('preemption: unlocked segment preempted by higher-deficit task, bytes preserved', () => {
  const state = {
    config: { setup: 10, lock: 50, maxRate: 1e9 },
    passes: [
      mkPass({ id: 'PA', task: 'TA', start: 0, end: 1000, rate: 10 }),
      mkPass({ id: 'PB', task: 'TB', start: 100, end: 200, rate: 10 }),
    ],
    tasks: { TB: { minGuarantee: 5000 } },
  };
  const sched = computeSchedule(state);
  assert.deepStrictEqual(
    sched.segments,
    [
      { pass: 'PA', task: 'TA', start: 0, end: 100, bytes: 1000 },
      { pass: 'PB', task: 'TB', start: 110, end: 200, bytes: 900 },
      { pass: 'PA', task: 'TA', start: 210, end: 1000, bytes: 7900 },
    ],
    'preempted pass keeps its first 1000 bytes and resumes after setup'
  );
  assert.equal(sched.served.TA, 8900);
  assert.equal(sched.served.TB, 900);
});

test('preemption: locked segment is never preempted', () => {
  const state = {
    config: { setup: 10, lock: 500, maxRate: 1e9 },
    passes: [
      mkPass({ id: 'PA', task: 'TA', start: 0, end: 1000, rate: 10 }),
      mkPass({ id: 'PB', task: 'TB', start: 100, end: 200, rate: 10 }),
    ],
    tasks: { TB: { minGuarantee: 5000 } },
  };
  const sched = computeSchedule(state);
  assert.deepStrictEqual(sched.segments, [
    { pass: 'PA', task: 'TA', start: 0, end: 1000, bytes: 10000 },
  ]);
  const { drops } = computeDrops(state, sched);
  const pb = drops.find((d) => d.pass === 'PB');
  assert.equal(pb.served, 0);
  assert.equal(pb.dropped.conflict, 1000);
});

test('drop attribution: quota vs conflict vs weather', () => {
  const quotaState = {
    config: { setup: 0, lock: 0, maxRate: 1e9 },
    passes: [mkPass({ id: 'PQ', task: 'TQ', start: 0, end: 100, rate: 10, onboard: 1e9 })],
    tasks: { TQ: { quota: 400 } },
  };
  const qSched = computeSchedule(quotaState);
  const qDrop = computeDrops(quotaState, qSched).drops[0];
  assert.equal(qDrop.served, 400);
  assert.deepEqual(qDrop.dropped, { weather: 0, conflict: 0, quota: 600 });

  const weatherState = {
    config: { setup: 0, lock: 0, maxRate: 1e9 },
    passes: [
      mkPass({
        id: 'PW',
        task: 'TW',
        start: 0,
        end: 100,
        rate: 10,
        onboard: 1e9,
        corrections: [{ start: 0, end: 40, at: 0, pending: false }],
      }),
    ],
    tasks: {},
  };
  const wSched = computeSchedule(weatherState);
  const wDrop = computeDrops(weatherState, wSched).drops[0];
  assert.equal(wDrop.served, 400);
  assert.deepEqual(wDrop.dropped, { weather: 600, conflict: 0, quota: 0 });
});

test('pending weather is reported but never counted as failure', () => {
  const state = {
    config: { setup: 0, lock: 0, maxRate: 1e9 },
    passes: [
      mkPass({
        id: 'PP',
        task: 'TP',
        start: 0,
        end: 100,
        rate: 10,
        onboard: 1e9,
        corrections: [{ start: 0, end: 40, at: 0, pending: true }],
      }),
    ],
    tasks: {},
  };
  const sched = computeSchedule(state);
  const { drops, totals } = computeDrops(state, sched);
  assert.equal(drops[0].served, 400);
  assert.equal(drops[0].pending, 600);
  assert.equal(drops[0].dropped.weather, 0);
  assert.equal(totals.failed, 0, 'pending weather must not count as failure');
  assert.equal(totals.pending, 600);
});
