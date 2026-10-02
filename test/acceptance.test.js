import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInstance } from '../src/instance.js';
import { solve } from '../src/solver.js';
import { verifySolution } from '../src/verify.js';

const solveRaw = (raw) => solve(validateInstance(raw));

test('acceptance: two machines, feasible within quota, exactly one preemption', (t) => {
  const instance = {
    machines: [{ id: 'M1' }, { id: 'M2' }],
    shifts: [{ id: 'S1', start: 0, end: 12, quotas: { A: 5, B: 5 } }],
    orders: [
      { id: 'B1', release: 0, duration: 4, deadline: 8, family: 'B', priority: 'low', machines: ['M1'] },
      { id: 'C1', release: 2, duration: 3, deadline: 5, family: 'A', priority: 'critical', machines: ['M1'] },
      { id: 'D1', release: 0, duration: 2, deadline: 10, family: 'A', priority: 'low', machines: ['M2'] },
    ],
  };
  const sol = solveRaw(instance);
  t.diagnostic(`status=${sol.status} totalTardiness=${sol.objective?.totalTardiness} preemptions=${sol.preemptions?.total}`);
  assert.equal(sol.status, 'optimal');
  // Hand analysis: the unique zero-tardiness schedule preempts B1 at slot 1:
  // B1@[0,1), changeover@[1,2), C1@[2,5), B1@[5,8); D1@[0,2) on M2.
  assert.equal(sol.objective.totalTardiness, 0);
  assert.equal(sol.preemptions.total, 1);
  assert.deepEqual(sol.preemptions.byOrder, { B1: 1 });
  assert.deepEqual(sol.preemptions.events, [{ slot: 1, machine: 'M1', preempted: 'B1', by: 'C1' }]);

  const b1 = sol.orders.find((o) => o.id === 'B1');
  const c1 = sol.orders.find((o) => o.id === 'C1');
  assert.equal(b1.segments.length, 2, 'preempted order has two segments');
  assert.equal(c1.segments.length, 1, 'critical order runs in one segment');
  assert.equal(b1.completion, 8);
  assert.equal(c1.completion, 5);

  for (const q of sol.quotaUsage) {
    assert.ok(q.used <= q.capacity, `quota ${q.shift}/${q.family} respected`);
  }
  assert.deepEqual(
    sol.quotaUsage.find((q) => q.shift === 'S1' && q.family === 'A'),
    { shift: 'S1', family: 'A', used: 5, capacity: 5 });
  assert.deepEqual(
    sol.quotaUsage.find((q) => q.shift === 'S1' && q.family === 'B'),
    { shift: 'S1', family: 'B', used: 4, capacity: 5 });

  assert.equal(sol.certificate.ok, true);
  const recheck = verifySolution(validateInstance(instance), sol);
  assert.equal(recheck.ok, true, recheck.checks.filter((c) => !c.ok).map((c) => c.name).join(','));
});

test('boundary: zero quota for a demanded family is infeasible with a reason', (t) => {
  const sol = solveRaw({
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end: 8, quotas: { A: 0 } }],
    orders: [{ id: 'J1', release: 0, duration: 1, deadline: 4, family: 'A', priority: 'low', machines: ['M1'] }],
  });
  t.diagnostic(`status=${sol.status} reasons=${(sol.reasons ?? []).join(' | ')}`);
  assert.equal(sol.status, 'infeasible');
  assert.ok(sol.reasons.some((r) => /quota/.test(r) && /A/.test(r)));
});

test('boundary: deadline earlier than release is feasible but necessarily tardy', (t) => {
  const sol = solveRaw({
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end: 10, quotas: { A: 10 } }],
    orders: [{ id: 'J1', release: 5, duration: 2, deadline: 1, family: 'A', priority: 'high', machines: ['M1'] }],
  });
  t.diagnostic(`status=${sol.status} totalTardiness=${sol.objective?.totalTardiness}`);
  assert.equal(sol.status, 'optimal');
  const j1 = sol.orders.find((o) => o.id === 'J1');
  assert.equal(j1.completion, 7);
  assert.equal(j1.tardiness, 6);
  assert.equal(sol.objective.totalTardiness, 6);
});

test('future release is schedulable, never reported as unsatisfiable', (t) => {
  const sol = solveRaw({
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end: 12, quotas: { A: 12 } }],
    orders: [{ id: 'J1', release: 8, duration: 2, deadline: 10, family: 'A', priority: 'low', machines: ['M1'] }],
  });
  t.diagnostic(`status=${sol.status}`);
  assert.equal(sol.status, 'optimal');
  const j1 = sol.orders.find((o) => o.id === 'J1');
  assert.ok(j1.segments[0].start >= 8);
  assert.equal(j1.tardiness, 0);
});

test('release beyond the last shift is infeasible with an explicit reason', (t) => {
  const sol = solveRaw({
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end: 6, quotas: { A: 6 } }],
    orders: [{ id: 'J1', release: 9, duration: 1, deadline: 12, family: 'A', priority: 'low', machines: ['M1'] }],
  });
  t.diagnostic(`status=${sol.status} reasons=${(sol.reasons ?? []).join(' | ')}`);
  assert.equal(sol.status, 'infeasible');
  assert.ok(sol.reasons.some((r) => /release 9/.test(r)));
});

test('preemption cap: an order is never preempted more than twice', (t) => {
  // Three critical orders arrive while B occupies the only machine; B may be
  // preempted at most twice, so at least one critical must wait for a gap.
  const sol = solveRaw({
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end: 20, quotas: { A: 20, B: 20 } }],
    orders: [
      { id: 'B', release: 0, duration: 5, deadline: 30, family: 'B', priority: 'low', machines: ['M1'] },
      { id: 'C1', release: 1, duration: 1, deadline: 30, family: 'A', priority: 'critical', machines: ['M1'] },
      { id: 'C2', release: 2, duration: 1, deadline: 30, family: 'A', priority: 'critical', machines: ['M1'] },
      { id: 'C3', release: 3, duration: 1, deadline: 30, family: 'A', priority: 'critical', machines: ['M1'] },
    ],
  });
  t.diagnostic(`status=${sol.status} preemptions=${JSON.stringify(sol.preemptions?.byOrder)}`);
  assert.equal(sol.status, 'optimal');
  assert.ok((sol.preemptions.byOrder.B ?? 0) <= 2);
  assert.equal(sol.certificate.ok, true);
});
