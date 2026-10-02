import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { parseEvent } from '../src/events.js';
import { BASE, MIN } from '../testlib/helpers.js';

// Acceptance 1: a late metrology result must rewrite priorities and trigger a
// better re-plan (locked budget is released and re-allocated).
test('late metro rewrites priority and triggers a better re-plan', () => {
  const events = [
    { type: 'carrier', eventTs: BASE, carrier: 'C1', lot: 'L1', qty: 1, op: 'A' },
    { type: 'metro', eventTs: BASE, lot: 'L1', score: 10, op: 'A' },
    { type: 'carrier', eventTs: BASE + 1 * MIN, carrier: 'C2', lot: 'L2', qty: 1, op: 'A' },
    { type: 'tool', eventTs: BASE + 10 * MIN, tool: 'T1', cap: 1, windowStart: BASE, windowEnd: BASE + 120 * MIN, op: 'A' },
    // Arrives after the watermark (maxEventTs - 5min = BASE+5min) has passed it.
    { type: 'metro', eventTs: BASE + 2 * MIN, lot: 'L2', score: 99, op: 'A' },
  ].map((e) => parseEvent(e));

  const engine = new Engine();
  const applied = events.map((e) => engine.apply(e));
  assert.equal(applied[4].late, true, 'metro for L2 must be classified late');
  assert.equal(applied[4].reason, 'METRO_LATE_REWRITE');

  const { plan, budget, rework, late } = engine.finalize();

  assert.equal(late.length, 1);
  assert.equal(late[0].event.lot, 'L2');

  const rewrite = rework.find((r) => r.reason === 'METRO_LATE_REWRITE');
  assert.ok(rewrite, 'rework log must contain the late-metro rewrite');
  assert.deepEqual(rewrite.objectiveBefore, { score: 10, count: 1 });
  assert.deepEqual(rewrite.objectiveAfter, { score: 99, count: 1 });
  assert.deepEqual(
    rewrite.migrated,
    [
      { carrier: 'C1', from: 'T1', to: null },
      { carrier: 'C2', from: null, to: 'T1' },
    ],
    'budget locked by C1 must be released and re-locked by C2',
  );

  assert.deepEqual(plan.objective, { score: 99, count: 1 });
  assert.equal(plan.solutionCount, 1);
  assert.deepEqual(plan.solutions[0].assignments.map((a) => a.carrier), ['C2']);
  assert.deepEqual(plan.undispatched, ['C1']);

  assert.equal(budget.feasible, true);
  assert.equal(budget.negativeRemaining, false);
  assert.deepEqual(budget.windows, [
    {
      tool: 'T1', op: 'A',
      windowStart: BASE, windowEnd: BASE + 120 * MIN,
      cap: 1, used: 1, remaining: 0, carriers: ['C2'],
    },
  ]);
});
