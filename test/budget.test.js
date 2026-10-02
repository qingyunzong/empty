import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimalRepair } from '../src/solver.js';
import { SEARCH_LIMIT } from '../src/errors.js';

const rule = { id: 'r1', type: 'range', var: 'x', min: 0, max: 5 };

test('budget 0: already-valid data repairs at cost 0', () => {
  const r = optimalRepair({
    data: { x: 3 }, domains: { x: [0, 10] }, rules: [rule], budget: 0,
  });
  assert.equal(r.feasible, true);
  assert.equal(r.cost, 0);
  assert.deepEqual(r.assignment, { x: 3 });
});

test('budget 0: violated data is infeasible', () => {
  const r = optimalRepair({
    data: { x: 9 }, domains: { x: [0, 10] }, rules: [rule], budget: 0,
  });
  assert.equal(r.feasible, false);
});

test('budget exactly equal to minimum cost is feasible', () => {
  // x=9 must move to 5: minimum cost is exactly 4.
  const r = optimalRepair({
    data: { x: 9 }, domains: { x: [0, 10] }, rules: [rule], budget: 4,
  });
  assert.equal(r.feasible, true);
  assert.equal(r.cost, 4);
  assert.deepEqual(r.assignment, { x: 5 });
});

test('budget one below minimum cost is infeasible', () => {
  const r = optimalRepair({
    data: { x: 9 }, domains: { x: [0, 10] }, rules: [rule], budget: 3,
  });
  assert.equal(r.feasible, false);
});

test('per-variable costs shift the optimum across the budget boundary', () => {
  // Cheaper to move y (cost 1/unit) than x (cost 5/unit).
  const rules = [{ id: 's', type: 'sumLeq', vars: ['x', 'y'], bound: 4 }];
  const r = optimalRepair({
    data: { x: 3, y: 3 },
    domains: { x: [0, 5], y: [0, 5] },
    costs: { x: 5, y: 1 },
    rules,
    budget: 2,
  });
  assert.equal(r.feasible, true);
  assert.equal(r.cost, 2);
  assert.deepEqual(r.assignment, { x: 3, y: 1 });
  const under = optimalRepair({
    data: { x: 3, y: 3 },
    domains: { x: [0, 5], y: [0, 5] },
    costs: { x: 5, y: 1 },
    rules,
    budget: 1,
  });
  assert.equal(under.feasible, false);
});

test('node-limit abort raises SEARCH_LIMIT, never NO_FEASIBLE', () => {
  assert.throws(() => optimalRepair({
    data: { x: 9 },
    domains: { x: [0, 10] },
    rules: [rule],
    budget: 4,
    maxNodes: 1,
  }), (e) => {
    assert.equal(e.code, SEARCH_LIMIT);
    assert.notEqual(e.code, 'NO_FEASIBLE');
    return true;
  });
});
