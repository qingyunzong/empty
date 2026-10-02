import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { validateInstance } from '../src/instance.js';
import { solve } from '../src/solver.js';
import { verifySolution } from '../src/verify.js';
import { bruteForceBest } from '../test-helpers/enumerate.js';

// Deterministic PRNG (LCG) so the recorded results are reproducible.
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Every third case uses a template that makes preemption attractive: one
// machine, a low-priority order with a tight deadline released at 0, and a
// critical order with a zero-slack deadline released a few slots later.
function preemptionProneInstance(rng, index) {
  const end = 10 + Math.floor(rng() * 5);
  const cRel = 1 + Math.floor(rng() * 3);
  const cDur = 1 + Math.floor(rng() * 2);
  const lDur = 3 + Math.floor(rng() * 3);
  const orders = [
    { id: `J${index}_L`, release: 0, duration: lDur, deadline: cDur + lDur + 1 + Math.floor(rng() * 2),
      family: 'A', priority: 'low', machines: ['M1'] },
    { id: `J${index}_C`, release: cRel, duration: cDur, deadline: cRel + cDur,
      family: 'A', priority: 'critical', machines: ['M1'] },
  ];
  const fillers = Math.floor(rng() * 3);
  for (let i = 0; i < fillers; i++) {
    orders.push({
      id: `J${index}_F${i}`,
      release: Math.floor(rng() * 4),
      duration: 1 + Math.floor(rng() * 2),
      deadline: end,
      family: 'A',
      priority: 'medium',
      machines: ['M1'],
    });
  }
  return {
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end, quotas: { A: end } }],
    orders,
  };
}

function randomInstance(rng, index) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const nOrders = 1 + Math.floor(rng() * 6); // 1..6 orders
  const nMachines = nOrders > 4 ? 1 : 1 + Math.floor(rng() * 2);
  const machines = Array.from({ length: nMachines }, (_, i) => ({ id: `M${i + 1}` }));
  const families = ['A', 'B'].slice(0, 1 + Math.floor(rng() * 2));
  const shifts = [];
  const end1 = 6 + Math.floor(rng() * 5); // 6..10
  // generous-but-not-trivial quotas keep most instances feasible while still
  // forcing contention; ~25% of instances get a zero-quota family to exercise
  // infeasibility
  shifts.push({
    id: 'S1',
    start: 0,
    end: end1,
    quotas: Object.fromEntries(families.map((f) => [f, 2 + Math.floor(rng() * 7)])),
  });
  if (rng() < 0.4) {
    const start2 = end1 + 2;
    shifts.push({
      id: 'S2',
      start: start2,
      end: start2 + 3 + Math.floor(rng() * 3),
      quotas: Object.fromEntries(families.map((f) => [f, 1 + Math.floor(rng() * 6)])),
    });
  }
  if (rng() < 0.25) {
    const fam = pick(families);
    for (const s of shifts) s.quotas[fam] = 0;
  }
  const maxDur = nOrders > 4 ? 2 : 3;
  const orders = Array.from({ length: nOrders }, (_, i) => {
    const compatible = machines.filter(() => rng() < 0.7).map((m) => m.id);
    if (compatible.length === 0) compatible.push(pick(machines).id);
    const release = Math.floor(rng() * 5);
    const duration = 1 + Math.floor(rng() * maxDur);
    const critical = rng() < 0.35;
    return {
      id: `J${index}_${i}`,
      release,
      duration,
      // critical orders get tight deadlines to force preemptions
      deadline: critical
        ? release + duration + Math.floor(rng() * 3)
        : release + duration + Math.floor(rng() * 7),
      family: pick(families),
      priority: critical ? 'critical' : pick(['high', 'medium', 'low']),
      machines: compatible,
    };
  });
  return { machines, shifts, orders };
}

test('solver matches independent brute-force enumeration on <=6 orders', (t) => {
  const rng = makeRng(20261003);
  const results = [];
  let feasibleCount = 0;
  let withPreemptions = 0;
  const t0 = Date.now();
  const CASES = 60;
  for (let k = 0; k < CASES; k++) {
    const raw = k % 3 === 0 ? preemptionProneInstance(rng, k) : randomInstance(rng, k);
    const inst = validateInstance(raw);
    const expected = bruteForceBest(inst);
    const sol = solve(inst);
    const record = {
      case: k,
      orders: raw.orders.length,
      machines: raw.machines.length,
      bruteForce: expected.feasible ? { feasible: true, tardiness: expected.tardiness } : { feasible: false },
      solver: sol.status === 'optimal'
        ? { status: 'optimal', tardiness: sol.objective.totalTardiness, preemptions: sol.preemptions.total }
        : { status: 'infeasible' },
    };
    if (!expected.feasible) {
      assert.equal(sol.status, 'infeasible',
        `case ${k}: brute force says infeasible, solver says ${sol.status}`);
    } else {
      assert.equal(sol.status, 'optimal',
        `case ${k}: brute force found tardiness ${expected.tardiness}, solver says infeasible: ${(sol.reasons ?? []).join('; ')}`);
      assert.equal(sol.objective.totalTardiness, expected.tardiness,
        `case ${k}: tardiness mismatch (brute force ${expected.tardiness})`);
      const solverCompletion = inst.orders.map((_, i) => sol.orders.find((o) => o.id === inst.orders[i].id).completion);
      assert.deepEqual(solverCompletion, expected.completion,
        `case ${k}: tie-break completion vector mismatch`);
      const cert = verifySolution(inst, sol);
      assert.equal(cert.ok, true,
        `case ${k}: certificate fails: ${cert.checks.filter((c) => !c.ok).map((c) => c.name).join(',')}`);
      feasibleCount++;
      if (sol.preemptions.total > 0) withPreemptions++;
    }
    results.push(record);
  }
  const summary = {
    seed: 20261003,
    cases: CASES,
    feasible: feasibleCount,
    infeasible: CASES - feasibleCount,
    optimalWithPreemptions: withPreemptions,
    mismatches: 0,
    elapsedMs: Date.now() - t0,
    results,
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/bruteforce-results.json', JSON.stringify(summary, null, 2));
  t.diagnostic(
    `${CASES} cases: ${feasibleCount} feasible / ${CASES - feasibleCount} infeasible, ` +
    `${withPreemptions} optima with preemptions, all matched brute force (${summary.elapsedMs} ms); ` +
    'recorded in test-results/bruteforce-results.json');
  // the suite must actually exercise both feasibility outcomes and preemptions
  assert.ok(feasibleCount >= 20, `too few feasible cases: ${feasibleCount}`);
  assert.ok(CASES - feasibleCount >= 5, `too few infeasible cases: ${CASES - feasibleCount}`);
  assert.ok(withPreemptions >= 3, `too few optima with preemptions: ${withPreemptions}`);
});
