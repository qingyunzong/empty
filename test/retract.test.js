// Acceptance 2: an erroneous event produces a conflict chain of events +
// rule; after retracting it the conflict disappears, propagation is undone
// incrementally, and repeated solves give identical results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Solver } from '../src/solver.js';

test('conflict chain names events and rule; retract restores feasibility repeatably', () => {
  const solver = new Solver({ window: 5 });
  solver.addEvent({ id: 'm1', device: 'M', ts: 0, vc: { M: 1 }, type: 'STOP' });
  solver.addEvent({ id: 'm2', device: 'M', ts: 1, vc: { M: 2 }, type: 'RUN' }); // erroneous: no RESET

  const bad = solver.solve({ budget: 100 });
  assert.equal(bad.status, 'infeasible');
  assert.equal(bad.conflict.rule, 'reset-before-run');
  assert.deepEqual([...bad.conflict.events].sort(), ['m1', 'm2']);
  assert.ok(bad.conflict.chain.length >= 1, 'conflict chain must show the precedence path');
  assert.equal(bad.conflict.chain.at(-1).to, 'm2');

  solver.retractEvent('m2');
  assert.equal(solver.state.size, 1, 'retract must shrink the ordinal domain');

  const ok1 = solver.solve({ budget: 100 });
  assert.equal(ok1.status, 'feasible');
  assert.deepEqual(ok1.order, ['m1']);

  // Corrected history: RESET between STOP and RUN.
  solver.addEvent({ id: 'm3', device: 'M', ts: 2, vc: { M: 2 }, type: 'RESET' });
  solver.addEvent({ id: 'm4', device: 'M', ts: 3, vc: { M: 3 }, type: 'RUN' });
  const ok2 = solver.solve({ budget: 100 });
  assert.equal(ok2.status, 'feasible');
  assert.deepEqual(ok2.order, ['m1', 'm3', 'm4']);

  const ok3 = solver.solve({ budget: 100 });
  assert.deepEqual(ok3, ok2, 'repeated solves after restore must be identical');
});

test('incremental retract of the earliest event undoes only dependent propagation', () => {
  const solver = new Solver({ window: 5 });
  solver.addEvent({ id: 'm1', device: 'M', ts: 0, vc: { M: 1 }, type: 'STOP' });
  solver.addEvent({ id: 'm3', device: 'M', ts: 2, vc: { M: 2 }, type: 'RESET' });
  solver.addEvent({ id: 'm4', device: 'M', ts: 3, vc: { M: 3 }, type: 'RUN' });
  assert.ok(solver.state.isBefore('m1', 'm4'));

  solver.retractEvent('m1'); // cut at the very first trail entry
  assert.equal(solver.state.size, 2);
  assert.ok(solver.state.isBefore('m3', 'm4'), 'unrelated propagation must survive');
  assert.ok(!solver.state.has('m1'));

  const res = solver.solve({ budget: 100 });
  assert.equal(res.status, 'feasible');
  assert.deepEqual(res.order, ['m3', 'm4']);
});

test('correctEvent replaces an erroneous event atomically', () => {
  const solver = new Solver({ window: 5 });
  solver.addEvent({ id: 'm1', device: 'M', ts: 0, vc: { M: 1 }, type: 'STOP' });
  solver.addEvent({ id: 'm2', device: 'M', ts: 1, vc: { M: 2 }, type: 'RUN' });
  assert.equal(solver.solve({ budget: 100 }).status, 'infeasible');

  solver.correctEvent({ id: 'm2', device: 'M', ts: 1, vc: { M: 2 }, type: 'RESET' });
  const res = solver.solve({ budget: 100 });
  assert.equal(res.status, 'feasible');
  assert.deepEqual(res.order, ['m1', 'm2']);
});
