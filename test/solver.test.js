import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/solver.js';

const baseConfig = {
  days: 2,
  maxRunsPerDay: 2,
  slots: 3,
  gasBudget: 10,
  maxTempDiff: 2,
  crucibles: { alumina: 3, graphite: 2 },
  gasUsage: { air: 0, n2: 2, h2: 5, o2: 3 },
  hazards: [['h2', 'o2']],
};

const recipe = (id, priority, over = {}) => ({
  id,
  priority,
  temps: [1, 2],
  atmos: ['n2'],
  durs: [1],
  crucible: 'alumina',
  ...over,
});

test('schedules everything when resources are ample', () => {
  const res = solve({
    config: baseConfig,
    recipes: [recipe('R1', 5), recipe('R2', 3)],
    locks: [],
  });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective, 8);
  assert.deepEqual(Object.keys(res.assignment).sort(), ['R1', 'R2']);
  assert.deepEqual(res.unscheduled, []);
});

test('maximizes priority weight and drops the cheapest recipe under one slot', () => {
  const config = { ...baseConfig, days: 1, maxRunsPerDay: 1, slots: 1 };
  const res = solve({
    config,
    recipes: [recipe('R1', 5), recipe('R2', 3), recipe('R3', 4)],
    locks: [],
  });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective, 5);
  assert.deepEqual(Object.keys(res.assignment), ['R1']);
  assert.deepEqual(res.unscheduled, ['R2', 'R3']);
});

test('breaks weight ties by ascending recipe id', () => {
  const config = { ...baseConfig, days: 1, maxRunsPerDay: 1, slots: 1 };
  const res = solve({
    config,
    recipes: [recipe('R2', 5), recipe('R1', 5)],
    locks: [],
  });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective, 5);
  assert.deepEqual(Object.keys(res.assignment), ['R1']);
});

test('enforces same-batch temperature difference', () => {
  const config = { ...baseConfig, days: 1, maxRunsPerDay: 1, slots: 2, maxTempDiff: 0 };
  const res = solve({
    config,
    recipes: [
      recipe('R1', 5, { temps: [1] }),
      recipe('R2', 5, { temps: [3] }),
    ],
    locks: [],
  });
  // Same ramp class (ceil(t/1) differs: 1 vs 3) and temp diff 2 > 0 force
  // the two recipes apart, but there is only one batch: one must be dropped.
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective, 5);
  assert.equal(Object.keys(res.assignment).length, 1);
});

test('enforces ramp-profile compatibility within a batch', () => {
  const config = { ...baseConfig, days: 1, maxRunsPerDay: 1, slots: 2, maxTempDiff: 5 };
  const res = solve({
    config,
    recipes: [
      recipe('R1', 5, { temps: [2], durs: [1] }), // ramp 2
      recipe('R2', 5, { temps: [2], durs: [2] }), // ramp 1
    ],
    locks: [],
  });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective, 5);
  assert.equal(Object.keys(res.assignment).length, 1);
});

test('enforces daily gas budget across batches of the same day', () => {
  const config = { ...baseConfig, days: 1, maxRunsPerDay: 2, slots: 1, gasBudget: 5 };
  const res = solve({
    config,
    recipes: [
      recipe('R1', 5, { atmos: ['h2'] }), // gas 5
      recipe('R2', 4, { atmos: ['h2'] }), // gas 5, same day would exceed 5
    ],
    locks: [],
  });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective, 5);
  assert.deepEqual(Object.keys(res.assignment), ['R1']);
});

test('enforces crucible capacity per batch', () => {
  const config = { ...baseConfig, days: 1, maxRunsPerDay: 1, slots: 3, crucibles: { graphite: 1, alumina: 3 } };
  const res = solve({
    config,
    recipes: [
      recipe('R1', 5, { crucible: 'graphite' }),
      recipe('R2', 4, { crucible: 'graphite' }),
    ],
    locks: [],
  });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective, 5);
  assert.deepEqual(Object.keys(res.assignment), ['R1']);
});

test('hazardous atmospheres are mutually exclusive within a batch', () => {
  const config = { ...baseConfig, days: 2, maxRunsPerDay: 1, slots: 2 };
  const res = solve({
    config,
    recipes: [
      recipe('R1', 5, { atmos: ['h2'] }),
      recipe('R2', 5, { atmos: ['o2'] }),
    ],
    locks: [],
  });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective, 10);
  assert.notEqual(res.assignment.R1.batch, res.assignment.R2.batch);
});

test('UNSAT on forced hazardous coexistence returns the minimal recipe core', () => {
  const config = {
    ...baseConfig,
    days: 1,
    maxRunsPerDay: 1,
    slots: 4,
    requiredPriority: 10,
  };
  const res = solve({
    config,
    recipes: [
      recipe('R1', 10, { atmos: ['h2'] }),
      recipe('R2', 10, { atmos: ['o2'] }),
      recipe('R3', 10, { atmos: ['n2'] }), // compatible, droppable from the core
      recipe('R4', 1, { atmos: ['air'] }), // optional, never part of the core
    ],
    locks: [],
  });
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.core, ['R1', 'R2']);
});

test('conflicting locks are UNSAT and the core names the locked recipes', () => {
  const config = { ...baseConfig, days: 1, maxRunsPerDay: 1, slots: 2 };
  const res = solve({
    config,
    recipes: [
      recipe('R1', 5, { atmos: ['h2'] }),
      recipe('R2', 5, { atmos: ['o2'] }),
      recipe('R3', 5),
    ],
    locks: [
      { recipe: 'R1', batch: 0, temp: 1, atmo: 'h2', dur: 1 },
      { recipe: 'R2', batch: 0, temp: 1, atmo: 'o2', dur: 1 },
    ],
  });
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.core, ['R1', 'R2']);
});

test('exhausted backtrack budget yields PENDING with bounds, never UNSAT', () => {
  const res = solve(
    {
      config: { ...baseConfig, requiredPriority: 10 },
      recipes: [recipe('R1', 10), recipe('R2', 10), recipe('R3', 10)],
      locks: [],
    },
    { backtrack: 1 },
  );
  assert.equal(res.status, 'PENDING');
  assert.equal(res.reason, 'backtrack');
  assert.ok(res.bound.lower <= res.bound.upper);
  assert.notEqual(res.status, 'UNSAT');
});

test('exhausted improve budget yields PENDING and keeps the incumbent', () => {
  const res = solve(
    {
      config: baseConfig,
      recipes: [recipe('R1', 5), recipe('R2', 3)],
      locks: [],
    },
    { improve: 0 },
  );
  assert.equal(res.status, 'PENDING');
  assert.equal(res.reason, 'improve');
  assert.equal(res.objective, null); // no improvement was allowed
});

test('exhausted propagate budget yields PENDING even on infeasible instances', () => {
  const config = { ...baseConfig, days: 1, maxRunsPerDay: 1, requiredPriority: 10 };
  const res = solve(
    {
      config,
      recipes: [recipe('R1', 10, { atmos: ['h2'] }), recipe('R2', 10, { atmos: ['o2'] })],
      locks: [],
    },
    { propagate: 0 },
  );
  assert.equal(res.status, 'PENDING');
  assert.equal(res.reason, 'propagate');
});

test('daily run cap limits batches per day', () => {
  const config = { ...baseConfig, days: 1, maxRunsPerDay: 1, slots: 1 };
  const res = solve({
    config,
    recipes: [recipe('R1', 5), recipe('R2', 5)],
    locks: [],
  });
  assert.equal(res.status, 'OPTIMAL');
  assert.equal(res.objective, 5);
  assert.equal(Object.keys(res.assignment).length, 1);
});
