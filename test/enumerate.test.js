import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstance, solve, verifySolution } from '../src/index.js';
import { enumerateOptimal } from '../testlib/enumerate.mjs';
import { mulberry32, randInt } from '../testlib/prng.mjs';

const PRIORITIES = ['low', 'normal', 'high', 'critical'];

function randomInstance(rand, idx) {
  const numMachines = 2;
  const machines = ['M1', 'M2'];
  const numShifts = randInt(rand, 1, 3);
  const shifts = [];
  let cursor = 0;
  for (let s = 0; s < numShifts; s += 1) {
    const len = randInt(rand, 3, 6);
    const quotas = {};
    const numFamilies = randInt(rand, 1, 2);
    for (let f = 0; f < numFamilies; f += 1) {
      quotas[`F${f}`] = randInt(rand, 0, 6);
    }
    shifts.push({ id: `S${s + 1}`, start: cursor, end: cursor + len, quotas });
    cursor += len; // contiguous calendar keeps the horizon small
  }
  const horizon = cursor;
  const families = ['F0', 'F1'];
  const numOrders = randInt(rand, 1, 6);
  const orders = [];
  for (let i = 0; i < numOrders; i += 1) {
    const release = randInt(rand, 0, Math.max(0, horizon - 2));
    const duration = randInt(rand, 1, 3);
    const deadline = release + randInt(rand, 0, horizon);
    const family = families[randInt(rand, 0, 1)];
    const priority = PRIORITIES[randInt(rand, 0, 3)];
    const compat = rand() < 0.5 ? ['M1', 'M2'] : [machines[randInt(rand, 0, 1)]];
    orders.push({ id: `J${idx}_${i}`, release, duration, deadline, family, priority, machines: compat });
  }
  return { now: 0, machines, shifts, orders };
}

test('solver matches independent enumeration on random instances with <= 6 orders', () => {
  const rand = mulberry32(20261004);
  let feasible = 0;
  let infeasible = 0;
  for (let idx = 0; idx < 60; idx += 1) {
    const inst = parseInstance(randomInstance(rand, idx));
    const sol = solve(inst);
    const brute = enumerateOptimal(inst);

    assert.equal(
      sol.status === 'optimal',
      brute !== null,
      `feasibility mismatch on instance ${idx}: ${JSON.stringify(inst)}`,
    );
    if (sol.status === 'optimal') {
      feasible += 1;
      assert.equal(
        sol.objective.totalTardiness,
        brute.total,
        `objective mismatch on instance ${idx}`,
      );
      assert.deepEqual(
        sol.orders.map((o) => o.tardiness),
        brute.vec,
        `tie-break vector mismatch on instance ${idx}`,
      );
      for (const o of sol.orders) assert.ok(o.preemptions <= 2);
      const cert = verifySolution(inst, sol);
      assert.ok(cert.ok, `certificate failed on instance ${idx}: ${JSON.stringify(cert.checks.filter((c) => !c.ok))}`);
      assert.equal(sol.certificate.ok, true);
    } else {
      infeasible += 1;
      assert.ok(sol.reasons.length > 0);
    }
  }
  assert.ok(feasible > 0, 'expected at least one feasible random instance');
  assert.ok(infeasible > 0, 'expected at least one infeasible random instance');
  process.stdout.write(`  random instances: ${feasible} feasible, ${infeasible} infeasible\n`);
});
