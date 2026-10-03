import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInstance } from '../src/schema.mjs';
import { solveNormalized } from '../src/solver.mjs';
import { bruteForce } from '../testlib/brute.mjs';
import { fixture12 } from '../testlib/fixtures.mjs';

test('12 jobs: solver matches brute-force objective and every tied optimum', () => {
  const v = normalizeInstance(fixture12);
  assert.equal(v.ok, true, v.error);
  const res = solveNormalized(v.instance);
  assert.equal(res.status, 'FEASIBLE');

  const brute = bruteForce(fixture12);
  assert.deepEqual(res.objective, brute.objective);

  const solverTies = new Set(res.schedules.map((s) => s.join(',')));
  assert.deepEqual(solverTies, brute.schedules);
  assert.ok(solverTies.size > 1, 'fixture should exercise tied optima');

  // Pruning must do real work: far fewer nodes than the 12! leaf space.
  assert.ok(res.stats.p2Nodes < 479001600 / 100, `p2Nodes=${res.stats.p2Nodes}`);
});

test('solver schedule detail is consistent with the objective', () => {
  const v = normalizeInstance(fixture12);
  const res = solveNormalized(v.instance);
  const last = res.schedule[res.schedule.length - 1];
  assert.equal(last.end, res.objective.makespan);
  let energy = 0;
  for (const step of res.schedule) energy += step.setup + fixture12.jobs[step.job].energy;
  assert.equal(energy, res.objective.energy);
});
