import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstance, solve, verifySolution } from '../src/index.js';
import { enumerateOptimal } from '../testlib/enumerate.mjs';

test('two machines: feasible within quota, exactly one preemption with one changeover slot', () => {
  const inst = parseInstance({
    machines: ['M1', 'M2'],
    shifts: [{ id: 'S1', start: 0, end: 12, quotas: { A: 24 } }],
    orders: [
      { id: 'J1', release: 0, duration: 6, deadline: 8, family: 'A', priority: 'normal', machines: ['M1'] },
      { id: 'J2', release: 2, duration: 2, deadline: 4, family: 'A', priority: 'critical', machines: ['M1'] },
      { id: 'J3', release: 0, duration: 2, deadline: 12, family: 'A', priority: 'low', machines: ['M2'] },
    ],
  });
  const sol = solve(inst);
  assert.equal(sol.status, 'optimal');
  assert.equal(sol.objective.totalTardiness, 1);

  const j1 = sol.orders.find((o) => o.id === 'J1');
  const j2 = sol.orders.find((o) => o.id === 'J2');
  assert.equal(j1.preemptions, 1);
  assert.equal(j2.preemptions, 0);
  assert.equal(sol.preemptions.total, 1);

  const m1 = sol.machines.find((m) => m.id === 'M1');
  const changeovers = m1.timeline.filter((e) => e.type === 'changeover');
  assert.equal(changeovers.length, 1);
  assert.equal(changeovers[0].end - changeovers[0].start, 1);
  assert.equal(changeovers[0].to, 'J2');
  assert.equal(changeovers[0].preempted, 'J1');

  // quota usage reported and within quota
  const s1 = sol.shifts.find((s) => s.id === 'S1');
  assert.equal(s1.usage.A, 10);
  assert.ok(s1.usage.A <= s1.quotas.A);

  // certificate verifies item by item
  assert.equal(sol.certificate.ok, true);
  assert.ok(sol.certificate.checks.length > 0);
  assert.ok(sol.certificate.checks.every((c) => c.ok));

  // independent enumerator agrees on the optimum
  const brute = enumerateOptimal(inst);
  assert.ok(brute !== null);
  assert.equal(brute.total, sol.objective.totalTardiness);
  assert.deepEqual(brute.vec, sol.orders.map((o) => o.tardiness));
});

test('zero capacity for a family is infeasible with a quota reason', () => {
  const inst = parseInstance({
    machines: ['M1'],
    shifts: [{ id: 'S1', start: 0, end: 8, quotas: { A: 0 } }],
    orders: [{ id: 'J1', release: 0, duration: 2, deadline: 8, family: 'A', priority: 'normal', machines: ['M1'] }],
  });
  const sol = solve(inst);
  assert.equal(sol.status, 'infeasible');
  assert.ok(sol.reasons.some((r) => r.includes('quota')));
});

test('family absent from quotas means zero capacity', () => {
  const inst = parseInstance({
    machines: ['M1'],
    shifts: [{ id: 'S1', start: 0, end: 8, quotas: { B: 4 } }],
    orders: [{ id: 'J1', release: 0, duration: 1, deadline: 8, family: 'A', priority: 'normal', machines: ['M1'] }],
  });
  assert.equal(solve(inst).status, 'infeasible');
});

test('deadline earlier than release is infeasible with a reason', () => {
  const inst = parseInstance({
    machines: ['M1'],
    shifts: [{ id: 'S1', start: 0, end: 10, quotas: { A: 10 } }],
    orders: [{ id: 'J1', release: 5, duration: 2, deadline: 3, family: 'A', priority: 'normal', machines: ['M1'] }],
  });
  const sol = solve(inst);
  assert.equal(sol.status, 'infeasible');
  assert.ok(sol.reasons.some((r) => r.includes('deadline') && r.includes('release')));
});

test('orders not yet released are scheduled later, not reported infeasible', () => {
  const inst = parseInstance({
    now: 0,
    machines: ['M1'],
    shifts: [{ id: 'S1', start: 0, end: 12, quotas: { A: 12 } }],
    orders: [
      { id: 'J1', release: 6, duration: 2, deadline: 12, family: 'A', priority: 'normal', machines: ['M1'] },
      { id: 'J2', release: 8, duration: 1, deadline: 12, family: 'A', priority: 'high', machines: ['M1'] },
    ],
  });
  const sol = solve(inst);
  assert.equal(sol.status, 'optimal');
  assert.equal(sol.objective.totalTardiness, 0);
  for (const o of sol.orders) {
    const release = inst.orders.find((x) => x.id === o.id).release;
    for (const p of o.pieces) assert.ok(p.start >= release, `${o.id} starts at ${p.start} >= release ${release}`);
  }
  assert.equal(sol.certificate.ok, true);
});

test('certificate catches a tampered solution', () => {
  const inst = parseInstance({
    machines: ['M1'],
    shifts: [{ id: 'S1', start: 0, end: 8, quotas: { A: 8 } }],
    orders: [{ id: 'J1', release: 2, duration: 2, deadline: 8, family: 'A', priority: 'normal', machines: ['M1'] }],
  });
  const sol = solve(inst);
  assert.equal(sol.status, 'optimal');
  const tampered = JSON.parse(JSON.stringify(sol));
  delete tampered.certificate;
  tampered.orders[0].pieces[0].start = 0; // before release
  tampered.orders[0].pieces[0].end = 2;
  const res = verifySolution(inst, tampered);
  assert.equal(res.ok, false);
  assert.ok(res.checks.some((c) => !c.ok));
});

test('a single order is never preempted more than twice', () => {
  const inst = parseInstance({
    machines: ['M1'],
    shifts: [{ id: 'S1', start: 0, end: 20, quotas: { A: 20 } }],
    orders: [
      { id: 'J1', release: 0, duration: 8, deadline: 20, family: 'A', priority: 'low', machines: ['M1'] },
      { id: 'J2', release: 1, duration: 1, deadline: 3, family: 'A', priority: 'critical', machines: ['M1'] },
      { id: 'J3', release: 4, duration: 1, deadline: 6, family: 'A', priority: 'critical', machines: ['M1'] },
      { id: 'J4', release: 7, duration: 1, deadline: 9, family: 'A', priority: 'critical', machines: ['M1'] },
    ],
  });
  const sol = solve(inst);
  assert.equal(sol.status, 'optimal');
  const j1 = sol.orders.find((o) => o.id === 'J1');
  assert.ok(j1.preemptions <= 2, `J1 preempted ${j1.preemptions} times`);
  assert.equal(sol.certificate.ok, true);
  const brute = enumerateOptimal(inst);
  assert.equal(brute.total, sol.objective.totalTardiness);
});
