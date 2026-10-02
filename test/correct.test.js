import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule, computeDrops } from '../src/scheduler.js';

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

test('acceptance 2: shortening a pass only affects intersecting tasks', () => {
  const state = {
    config: { setup: 10, lock: 30, maxRate: 1e9 },
    passes: [
      mkPass({ id: 'PA', task: 'TA', start: 0, end: 100, rate: 10 }),
      mkPass({ id: 'PB', task: 'TB', start: 1000, end: 1100, rate: 10 }),
    ],
    tasks: {},
  };
  const before = computeSchedule(state);
  state.passes[0].corrections.push({ start: 0, end: 50, at: 0, pending: false });
  const after = computeSchedule(state);
  const segB = (s) => s.segments.filter((x) => x.pass === 'PB');
  assert.deepStrictEqual(segB(after), segB(before), 'non-intersecting task untouched');
  assert.equal(after.passBytes.PA, 500, 'shortened pass loses the removed half');
  const { drops } = computeDrops(state, after);
  const da = drops.find((d) => d.pass === 'PA');
  assert.equal(da.dropped.weather, 500);
  assert.equal(da.dropped.conflict, 0);
  const db = drops.find((d) => d.pass === 'PB');
  assert.deepEqual(db.dropped, { weather: 0, conflict: 0, quota: 0 });
});

test('acceptance 2b: shortening an overlapping pass frees time for the intersecting task', () => {
  const state = {
    config: { setup: 0, lock: 0, maxRate: 1e9 },
    passes: [
      mkPass({ id: 'PA', task: 'TA', start: 0, end: 100, rate: 10 }),
      mkPass({ id: 'PB', task: 'TB', start: 0, end: 100, rate: 10 }),
    ],
    tasks: { TA: { minGuarantee: 5000 } }, // TA wins the overlap
  };
  const before = computeSchedule(state);
  assert.equal(before.served.TB ?? 0, 0);
  state.passes[0].corrections.push({ start: 0, end: 40, at: 0, pending: false });
  const after = computeSchedule(state);
  assert.equal(after.passBytes.PA, 400);
  assert.equal(after.passBytes.PB, 600, 'freed window goes to the intersecting task');
});

test('pending correction becomes weather drop only after confirm', () => {
  const pass = mkPass({ id: 'PA', task: 'TA', start: 0, end: 100, rate: 10 });
  const state = { config: { setup: 0, lock: 0, maxRate: 1e9 }, passes: [pass], tasks: {} };
  pass.corrections.push({ start: 0, end: 40, at: 0, pending: true });
  let totals = computeDrops(state, computeSchedule(state)).totals;
  assert.equal(totals.pending, 600);
  assert.equal(totals.failed, 0);
  pass.corrections[0].pending = false; // confirm
  totals = computeDrops(state, computeSchedule(state)).totals;
  assert.equal(totals.pending, 0);
  assert.equal(totals.weather, 600);
  assert.equal(totals.failed, 600);
});
