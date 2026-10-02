import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { parseEvent } from '../src/events.js';
import { BASE, MIN } from '../testlib/helpers.js';

function seed() {
  return [
    { type: 'metro', eventTs: BASE, lot: 'L1', score: 100, op: 'A' },
    { type: 'metro', eventTs: BASE, lot: 'L2', score: 50, op: 'A' },
    { type: 'metro', eventTs: BASE, lot: 'L3', score: 10, op: 'A' },
    { type: 'carrier', eventTs: BASE, carrier: 'C1', lot: 'L1', qty: 1, op: 'A' },
    { type: 'carrier', eventTs: BASE, carrier: 'C2', lot: 'L2', qty: 1, op: 'A' },
    { type: 'carrier', eventTs: BASE, carrier: 'C3', lot: 'L3', qty: 1, op: 'A' },
    { type: 'tool', eventTs: BASE, tool: 'T1', cap: 1, windowStart: BASE, windowEnd: BASE + 60 * MIN, op: 'A' },
    { type: 'tool', eventTs: BASE, tool: 'T2', cap: 1, windowStart: BASE, windowEnd: BASE + 60 * MIN, op: 'A' },
  ].map((e) => parseEvent(e));
}

// Acceptance 2: retracting a tool window must cascade-migrate its carriers and
// never produce negative remaining capacity.
test('tool window retraction cascades carrier migration without negative remaining', () => {
  const engine = new Engine();
  engine.applyAll(seed());

  let out = engine.finalize();
  assert.deepEqual(out.plan.objective, { score: 150, count: 2 });
  assert.deepEqual(out.budget.windows.map((w) => [w.tool, w.carriers]), [
    ['T1', ['C1']],
    ['T2', ['C2']],
  ]);

  engine.apply(parseEvent({ type: 'retract', eventTs: BASE + 1 * MIN, kind: 'tool', id: 'T1' }));
  out = engine.finalize();

  const retract = out.rework.find((r) => r.reason === 'TOOL_WINDOW_RETRACT');
  assert.ok(retract, 'rework log must record the tool window retraction');
  assert.deepEqual(
    retract.migrated,
    [
      { carrier: 'C1', from: 'T1', to: 'T2' },
      { carrier: 'C2', from: 'T2', to: null },
    ],
    'C1 must cascade onto T2, bumping the lower-scored C2',
  );

  assert.deepEqual(out.plan.objective, { score: 100, count: 1 });
  assert.deepEqual(out.plan.solutions[0].assignments.map((a) => [a.carrier, a.tool]), [['C1', 'T2']]);
  assert.deepEqual(out.budget.windows, [
    {
      tool: 'T2', op: 'A',
      windowStart: BASE, windowEnd: BASE + 60 * MIN,
      cap: 1, used: 1, remaining: 0, carriers: ['C1'],
    },
  ]);
  assert.equal(out.budget.negativeRemaining, false);
});

// Metro retraction releases the budget its score had locked and re-plans.
test('metro retraction releases locked budget and re-plans', () => {
  const engine = new Engine();
  engine.applyAll(seed());
  engine.apply(parseEvent({ type: 'retract', eventTs: BASE + 1 * MIN, kind: 'metro', id: 'L1' }));
  const out = engine.finalize();

  const retract = out.rework.find((r) => r.reason === 'METRO_RETRACT');
  assert.ok(retract, 'rework log must record the metro retraction');
  assert.deepEqual(retract.objectiveBefore, { score: 150, count: 2 });
  assert.deepEqual(retract.objectiveAfter, { score: 60, count: 2 });
  assert.deepEqual(
    retract.migrated,
    [
      { carrier: 'C1', from: 'T1', to: null },
      { carrier: 'C2', from: 'T2', to: 'T1' },
      { carrier: 'C3', from: null, to: 'T2' },
    ],
    'C1 loses its priority; the released budget cascades to C3',
  );
  assert.equal(out.plan.solutionCount, 2, 'C2/C3 may swap windows: both optima must be listed');
  assert.equal(out.budget.negativeRemaining, false);
});
