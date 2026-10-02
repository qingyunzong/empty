// Acceptance 3: two concurrent histories (same-device pairs whose order the
// clocks cannot decide). With insufficient budget the solver must answer
// "unknown", list the unresolved events, and must not drop the conflicts it
// already discovered while exploring branches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Solver } from '../src/solver.js';

// a1/a2 and b1/b2 are pairwise concurrent: incomparable vector clocks and
// timestamps inside the skew window. Ordering STOP before RUN on a device
// violates reset-before-run; RUN before STOP is fine.
const EVENTS = [
  { id: 'a1', device: 'A', ts: 0, vc: { A: 1, X: 2 }, type: 'STOP' },
  { id: 'a2', device: 'A', ts: 1, vc: { A: 2, X: 1 }, type: 'RUN' },
  { id: 'b1', device: 'B', ts: 0, vc: { B: 1, Y: 2 }, type: 'STOP' },
  { id: 'b2', device: 'B', ts: 1, vc: { B: 2, Y: 1 }, type: 'RUN' },
];

function makeSolver() {
  const solver = new Solver({ window: 5 });
  for (const e of EVENTS) solver.addEvent(e);
  return solver;
}

test('budget 1 over two concurrent histories: unknown, conflict not missed', () => {
  const res = makeSolver().solve({ budget: 1 });
  assert.equal(res.status, 'unknown');
  assert.deepEqual(res.pending, ['a1', 'a2', 'b1', 'b2'], 'all unresolved events must be listed');
  assert.ok(
    res.conflicts.some(
      (c) => c.rule === 'reset-before-run' && c.events.includes('a1') && c.events.includes('a2'),
    ),
    'the conflict found in the explored branch must be reported',
  );
});

test('budget 0: immediately unknown with pending events', () => {
  const res = makeSolver().solve({ budget: 0 });
  assert.equal(res.status, 'unknown');
  assert.deepEqual(res.pending, ['a1', 'a2', 'b1', 'b2']);
});

test('sufficient budget finds a feasible interleaving respecting all rules', () => {
  const solver = makeSolver();
  const res = solver.solve({ budget: 100 });
  assert.equal(res.status, 'feasible');
  const pos = res.positions;
  // RUN must precede STOP on each device (the only safe branch).
  assert.ok(pos.a2 < pos.a1);
  assert.ok(pos.b2 < pos.b1);
  // No STOP -> RUN without RESET may appear in the emitted order.
  for (const device of ['A', 'B']) {
    const seq = res.order.filter((id) => solver.events.get(id).device === device);
    for (let i = 0; i < seq.length; i++) {
      for (let j = i + 1; j < seq.length; j++) {
        const si = solver.events.get(seq[i]);
        const rj = solver.events.get(seq[j]);
        if (si.type === 'STOP' && rj.type === 'RUN') {
          assert.ok(
            seq.slice(i + 1, j).some((id) => solver.events.get(id).type === 'RESET'),
            `RESET required between ${seq[i]} and ${seq[j]}`,
          );
        }
      }
    }
  }
});
