import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solve } from '../src/solver.js';
import { bruteForceOptimum, checkFeasible } from './brute.js';

const small = JSON.parse(
  readFileSync(new URL('../examples/small.json', import.meta.url), 'utf8'));

test('三人四任务：求解器结果与暴力枚举最优一致', () => {
  const res = solve(small, { budget: 1_000_000 });
  assert.equal(res.status, 'optimal');

  const brute = bruteForceOptimum(small);
  assert.ok(brute, 'brute force found a feasible plan');
  assert.equal(res.makespan, brute.makespan, 'makespan matches brute-force optimum');
  assert.equal(res.totalTravel, brute.travel, 'total travel matches tie-broken optimum');

  // The returned plan itself must be feasible and realize the objectives.
  const check = checkFeasible(small, res.assignments);
  assert.equal(check.makespan, res.makespan);
  assert.equal(check.totalTravel, res.totalTravel);
});
