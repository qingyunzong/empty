import test from 'node:test';
import assert from 'node:assert/strict';
import { solveObservations, isUnsatObservations } from '../src/solver.js';
import { validateModel } from '../src/enumerator.js';

const LIMITS = { coords: 3, mags: 2, creds: 2, capacity: 2 };
const BIG = { propagation: 1000, backtracking: 1000 };

let nextOrigin = 0;
const wrap = (v) => (Array.isArray(v) ? v : [v]);
function obs(id, star, night, coord, mag = 0, cred = 0) {
  const o = { id, star, night, coord: wrap(coord), mag: wrap(mag), cred: wrap(cred), origin: nextOrigin, touches: [] };
  nextOrigin += 1;
  return o;
}

test('SAT returns a valid model and budget accounting', () => {
  nextOrigin = 0;
  const list = [obs('o1', 'A', 0, 0), obs('o2', 'B', 0, 1), obs('o3', 'C', 1, 2)];
  const res = solveObservations(list, LIMITS, BIG);
  assert.equal(res.status, 'SAT');
  assert.ok(validateModel(list, LIMITS, res.model));
  assert.equal(res.budget.propagation.used, 0);
  assert.equal(res.budget.backtracking.used, 0);
});

test('UNSAT via exclusive_attribution with a minimal core', () => {
  nextOrigin = 0;
  const list = [obs('o1', 'A', 0, 0), obs('o2', 'B', 0, 1), obs('o3', 'C', 1, 0), obs('o4', 'D', 1, 2)];
  // A, B, C, D pinned to 0, 1, 0, 2 over 3 coord bins: A and C collide.
  const res = solveObservations(list, LIMITS, BIG);
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.constraints, ['exclusive_attribution']);
  const coreIds = res.coreObs.map((o) => o.id).sort();
  assert.deepEqual(coreIds, ['o1', 'o3'], 'core is exactly the colliding pair');
  for (const o of res.coreObs) {
    assert.equal(isUnsatObservations(res.coreObs.filter((x) => x !== o), LIMITS), false,
      'removing any core observation restores satisfiability');
  }
});

test('UNSAT via night_capacity names the constraint', () => {
  nextOrigin = 0;
  const list = [obs('o1', 'A', 0, 0), obs('o2', 'B', 0, 1), obs('o3', 'C', 0, 2)];
  const res = solveObservations(list, LIMITS, BIG);
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.constraints, ['night_capacity']);
  assert.equal(res.coreObs.length, 3, 'capacity 2 needs 3 observations to break');
});

test('UNSAT via time_order (same star, non-increasing nights)', () => {
  nextOrigin = 0;
  const list = [obs('o1', 'A', 1, 0), obs('o2', 'A', 0, 0)];
  const res = solveObservations(list, LIMITS, BIG);
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.constraints, ['time_order']);
});

test('UNSAT via unique_pk for duplicate ids', () => {
  nextOrigin = 0;
  const list = [obs('o1', 'A', 0, 0), obs('o1', 'B', 1, 1)];
  const res = solveObservations(list, LIMITS, BIG);
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.constraints, ['unique_pk']);
});

test('UNSAT via attribution_consistency when one star demands two coords', () => {
  nextOrigin = 0;
  const list = [obs('o1', 'A', 0, 0), obs('o2', 'A', 1, 1)];
  const res = solveObservations(list, LIMITS, BIG);
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.constraints, ['attribution_consistency']);
});

test('propagation budget boundary yields PENDING, never UNSAT', () => {
  nextOrigin = 0;
  // A pinned to bin 0; B localized to bins {0, 1}: one propagation step is required.
  const list = [obs('o1', 'A', 0, 0), obs('o2', 'B', 0, [0, 1])];
  const pending = solveObservations(list, LIMITS, { propagation: 0, backtracking: 100 });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.reason, 'BUDGET_EXCEEDED');
  assert.equal(pending.exhausted, 'propagation');
  assert.deepEqual(pending.facts.B.coord, [0, 1], 'propagated facts are preserved');
  const solved = solveObservations(list, LIMITS, { propagation: 1, backtracking: 100 });
  assert.equal(solved.status, 'SAT');
  assert.equal(solved.budget.propagation.used, 1);
});

test('backtracking budget boundary yields PENDING, never UNSAT', () => {
  nextOrigin = 0;
  // A and B both have domain {0, 1}: branching is required.
  const list = [obs('o1', 'A', 0, [0, 1]), obs('o2', 'B', 0, [0, 1])];
  const pending = solveObservations(list, LIMITS, { propagation: 100, backtracking: 0 });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.reason, 'BUDGET_EXCEEDED');
  assert.equal(pending.exhausted, 'backtracking');
  assert.ok(pending.facts.A, 'partial facts are preserved');
  const solved = solveObservations(list, LIMITS, { propagation: 100, backtracking: 10 });
  assert.equal(solved.status, 'SAT');
  assert.ok(validateModel(list, LIMITS, solved.model));
});

test('budgets are charged separately', () => {
  nextOrigin = 0;
  const list = [obs('o1', 'A', 0, 0), obs('o2', 'B', 0, [0, 1])];
  const res = solveObservations(list, LIMITS, { propagation: 5, backtracking: 0 });
  assert.equal(res.status, 'SAT', 'propagation alone solves it; no backtracking needed');
  assert.equal(res.budget.backtracking.used, 0);
});
