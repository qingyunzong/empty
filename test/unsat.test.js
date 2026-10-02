import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, UNLIMITED_BUDGETS } from '../src/solver.js';

const baseConfig = {
  days: 1,
  maxRunsPerDay: 1,
  slotsPerRun: 4,
  tempDelta: 1000,
  gasBudget: 100,
  crucibles: { alumina: 4 },
  rampProfiles: {},
  hazardous: ['H2', 'CO'],
  minCoverage: 10,
};

const recipe = (id, atmosphere, priority = 5) => ({
  id,
  priority,
  temps: [800],
  atmospheres: [atmosphere],
  durations: [1],
  crucible: 'alumina',
  gasPerHour: 0,
});

test('hazardous atmosphere mutual exclusion yields UNSAT with minimal recipe core', () => {
  const instance = {
    config: { ...baseConfig },
    recipes: [recipe('R1', 'H2'), recipe('R2', 'CO'), recipe('R3', 'air', 1)],
    locks: {},
  };
  // Only one furnace run exists; H2 and CO cannot share it, and coverage 10
  // requires both. R3 (priority 1) is irrelevant to the conflict.
  const result = solve(instance, UNLIMITED_BUDGETS);
  assert.equal(result.status, 'UNSAT');
  assert.deepEqual(result.core, ['R1', 'R2']);
});

test('same instance with a second run is feasible', () => {
  const instance = {
    config: { ...baseConfig, maxRunsPerDay: 2 },
    recipes: [recipe('R1', 'H2'), recipe('R2', 'CO'), recipe('R3', 'air', 1)],
    locks: {},
  };
  const result = solve(instance, UNLIMITED_BUDGETS);
  assert.equal(result.status, 'OPTIMAL');
  assert.equal(result.weight, 11);
});

test('locked hazardous conflict yields UNSAT with the locked pair as core', () => {
  const instance = {
    config: { ...baseConfig, minCoverage: 0 },
    recipes: [recipe('R1', 'H2'), recipe('R2', 'CO'), recipe('R3', 'air', 1)],
    locks: {
      R1: { run: 0, temp: 800, atmosphere: 'H2', duration: 1 },
      R2: { run: 0, temp: 800, atmosphere: 'CO', duration: 1 },
    },
  };
  const result = solve(instance, UNLIMITED_BUDGETS);
  assert.equal(result.status, 'UNSAT');
  assert.deepEqual(result.core, ['R1', 'R2']);
});

test('core is minimal: removing either member restores feasibility', () => {
  const instance = {
    config: { ...baseConfig },
    recipes: [recipe('R1', 'H2'), recipe('R2', 'CO')],
    locks: {},
  };
  const result = solve(instance, UNLIMITED_BUDGETS);
  assert.equal(result.status, 'UNSAT');
  assert.deepEqual(result.core, ['R1', 'R2']);
  for (const drop of ['R1', 'R2']) {
    const sub = {
      ...instance,
      recipes: instance.recipes.filter((r) => r.id !== drop),
    };
    // Coverage rescales to the remaining subset, mirroring core semantics.
    sub.config = {
      ...sub.config,
      minCoverage: Math.min(
        sub.config.minCoverage,
        sub.recipes.reduce((s, r) => s + r.priority, 0),
      ),
    };
    assert.equal(solve(sub, UNLIMITED_BUDGETS).status, 'OPTIMAL');
  }
});
