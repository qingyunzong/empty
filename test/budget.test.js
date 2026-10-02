import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, UNLIMITED_BUDGETS } from '../src/solver.js';

const satInstance = {
  config: {
    days: 2,
    maxRunsPerDay: 2,
    slotsPerRun: 2,
    tempDelta: 100,
    gasBudget: 20,
    crucibles: { alumina: 4 },
    rampProfiles: { standard: { maxRamp: 10 } },
    hazardous: ['H2'],
    minCoverage: 3,
  },
  recipes: [
    { id: 'R1', priority: 3, temps: [700, 800], atmospheres: ['air'], durations: [1, 2], crucible: 'alumina', gasPerHour: 1 },
    { id: 'R2', priority: 2, temps: [800], atmospheres: ['H2'], durations: [1], crucible: 'alumina', gasPerHour: 1 },
    { id: 'R3', priority: 1, temps: [900], atmospheres: ['air'], durations: [2], crucible: 'alumina', gasPerHour: 2 },
  ],
  locks: {},
};

const unsatInstance = {
  config: { ...satInstance.config, maxRunsPerDay: 1, slotsPerRun: 1, minCoverage: 100 },
  recipes: satInstance.recipes,
  locks: {},
};

test('unlimited budgets solve to a definite status', () => {
  assert.equal(solve(satInstance, UNLIMITED_BUDGETS).status, 'OPTIMAL');
  assert.equal(solve(unsatInstance, UNLIMITED_BUDGETS).status, 'UNSAT');
});

test('exhausted propagation budget returns PENDING, never UNSAT', () => {
  for (const instance of [satInstance, unsatInstance]) {
    const result = solve(instance, { propagation: 0, backtrack: 1e6, improvement: 1e6 });
    assert.equal(result.status, 'PENDING');
    assert.notEqual(result.status, 'UNSAT');
  }
});

test('exhausted backtrack budget returns PENDING with a bound', () => {
  for (const instance of [satInstance, unsatInstance]) {
    const result = solve(instance, { propagation: 1e6, backtrack: 0, improvement: 1e6 });
    assert.equal(result.status, 'PENDING');
    assert.ok('bound' in result);
  }
});

test('exhausted improvement budget returns PENDING on a satisfiable instance', () => {
  const result = solve(satInstance, { propagation: 1e6, backtrack: 1e6, improvement: 0 });
  assert.equal(result.status, 'PENDING');
});

test('PENDING reports the best bound found so far', () => {
  const result = solve(satInstance, { propagation: 1e6, backtrack: 5, improvement: 1e6 });
  assert.equal(result.status, 'PENDING');
  assert.equal(typeof result.bound, 'number');
  const optimal = solve(satInstance, UNLIMITED_BUDGETS);
  assert.ok(result.bound >= optimal.weight, 'bound must remain an upper bound');
  if (result.weight !== null) {
    assert.ok(result.weight <= optimal.weight, 'incumbent cannot exceed the optimum');
  }
});
