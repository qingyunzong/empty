import test from 'node:test';
import assert from 'node:assert/strict';
import { solveAll } from '../src/solver.js';
import { Engine } from '../src/engine.js';
import { parseEvent } from '../src/events.js';
import { BASE } from '../testlib/helpers.js';

const window = { tool: 'T1', cap: 1, windowStart: BASE, windowEnd: BASE + 3_600_000, op: 'A' };

// Acceptance 4: same event time + same score ties must enumerate every
// optimal solution, deterministically ordered by due, lot, carrier.
test('same-event same-score ties enumerate all optimal solutions', () => {
  const carriers = [
    { carrier: 'C1', lot: 'L1', qty: 1, op: 'A', eventTs: BASE, due: BASE },
    { carrier: 'C2', lot: 'L2', qty: 1, op: 'A', eventTs: BASE, due: BASE },
  ];
  const out = solveAll({ carriers, windows: [window], scoreOf: () => 7 });
  assert.equal(out.solutions.length, 2, 'one slot, two equal carriers -> two tied optima');
  assert.deepEqual(out.solutions.map((s) => s.assignments[0].carrier), ['C1', 'C2']);
});

test('three equal carriers for two slots yield all C(3,2)=3 tied optima', () => {
  const carriers = ['C1', 'C2', 'C3'].map((id, i) => ({
    carrier: id, lot: `L${i + 1}`, qty: 1, op: 'A', eventTs: BASE, due: BASE,
  }));
  const out = solveAll({
    carriers,
    windows: [{ ...window, cap: 2 }],
    scoreOf: () => 5,
  });
  assert.equal(out.solutions.length, 3);
  assert.deepEqual(
    out.solutions.map((s) => s.assignments.map((a) => a.carrier).join('+')).sort(),
    ['C1+C2', 'C1+C3', 'C2+C3'],
  );
});

test('assignments inside a solution are ordered by due, then lot, then carrier', () => {
  const carriers = [
    { carrier: 'C9', lot: 'L1', qty: 1, op: 'A', eventTs: BASE, due: BASE + 2 },
    { carrier: 'C1', lot: 'L2', qty: 1, op: 'A', eventTs: BASE, due: BASE },
    { carrier: 'C2', lot: 'L1', qty: 1, op: 'A', eventTs: BASE, due: BASE + 1 },
  ];
  const out = solveAll({
    carriers,
    windows: [{ ...window, cap: 3 }],
    scoreOf: () => 1,
  });
  assert.equal(out.solutions.length, 1);
  assert.deepEqual(
    out.solutions[0].assignments.map((a) => a.carrier),
    ['C1', 'C2', 'C9'],
  );
});

test('engine end-to-end keeps every tied solution in plan output', () => {
  const engine = new Engine();
  engine.applyAll([
    { type: 'metro', eventTs: BASE, lot: 'L1', score: 5, op: 'A' },
    { type: 'metro', eventTs: BASE, lot: 'L2', score: 5, op: 'A' },
    { type: 'carrier', eventTs: BASE, carrier: 'C1', lot: 'L1', qty: 1, op: 'A' },
    { type: 'carrier', eventTs: BASE, carrier: 'C2', lot: 'L2', qty: 1, op: 'A' },
    { type: 'tool', eventTs: BASE, tool: 'T1', cap: 1, windowStart: BASE, windowEnd: BASE + 3_600_000, op: 'A' },
  ].map((e) => parseEvent(e)));
  const { plan } = engine.finalize();
  assert.equal(plan.solutionCount, 2);
  assert.deepEqual(plan.solutions.map((s) => s.assignments[0].carrier), ['C1', 'C2']);
});
