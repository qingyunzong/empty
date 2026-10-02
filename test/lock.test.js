import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  configure,
  addRecipe,
  lockSlot,
  unlockSlot,
  StateError,
} from '../src/state.js';
import { solve, UNLIMITED_BUDGETS, signatureOf } from '../src/solver.js';

const config = {
  days: 1,
  maxRunsPerDay: 1,
  slotsPerRun: 2,
  tempDelta: 100,
  gasBudget: 100,
  crucibles: { alumina: 4 },
  rampProfiles: {},
  hazardous: [],
  minCoverage: 0,
};

function buildState() {
  const state = createState();
  configure(state, config);
  addRecipe(state, {
    id: 'R1',
    priority: 5,
    temps: [700],
    atmospheres: ['air'],
    durations: [1],
    crucible: 'alumina',
    gasPerHour: 0,
  });
  addRecipe(state, {
    id: 'R2',
    priority: 5,
    temps: [900],
    atmospheres: ['air'],
    durations: [1],
    crucible: 'alumina',
    gasPerHour: 0,
  });
  return state;
}

const instance = (state) => ({
  config: state.config,
  recipes: state.recipes,
  locks: state.locks,
});

test('lock pins an unscheduled variable and forces re-scheduling', () => {
  const state = buildState();
  // One run, two slots, but |700-900| > tempDelta: only one of R1/R2 fits.
  // Equal priorities tie-break by recipe id -> R1 wins.
  let result = solve(instance(state), UNLIMITED_BUDGETS);
  assert.equal(result.status, 'OPTIMAL');
  assert.deepEqual(result.scheduled.map((s) => s.id), ['R1']);

  lockSlot(state, 'R2', { run: 0, temp: 900, atmosphere: 'air', duration: 1 });
  result = solve(instance(state), UNLIMITED_BUDGETS);
  assert.equal(result.status, 'OPTIMAL');
  assert.deepEqual(result.scheduled.map((s) => s.id), ['R2']);
  assert.equal(result.scheduled[0].run, 0);
});

test('unlock triggers full re-schedule equivalent to a fresh recompute', () => {
  const state = buildState();
  lockSlot(state, 'R2', { run: 0, temp: 900, atmosphere: 'air', duration: 1 });
  const locked = solve(instance(state), UNLIMITED_BUDGETS);
  assert.deepEqual(locked.scheduled.map((s) => s.id), ['R2']);

  unlockSlot(state, 'R2');
  assert.equal(state.lastSolution, null, 'unlock invalidates the stored solution');
  const afterUnlock = solve(instance(state), UNLIMITED_BUDGETS);

  const fresh = solve(instance(buildState()), UNLIMITED_BUDGETS);
  assert.equal(afterUnlock.status, fresh.status);
  assert.equal(afterUnlock.weight, fresh.weight);
  assert.deepEqual(signatureOf(afterUnlock.scheduled), signatureOf(fresh.scheduled));
  assert.deepEqual(afterUnlock.scheduled, fresh.scheduled);
});

test('lock is rejected on an already scheduled variable', () => {
  const state = buildState();
  const result = solve(instance(state), UNLIMITED_BUDGETS);
  state.lastSolution = {
    status: result.status,
    weight: result.weight,
    scheduled: result.scheduled.map((s) => ({ recipe: s.id, run: s.run })),
  };
  assert.throws(
    () => lockSlot(state, 'R1', { run: 0, temp: 700, atmosphere: 'air', duration: 1 }),
    /scheduled/,
  );
  // R2 is unscheduled in the stored solution, so locking it is allowed.
  lockSlot(state, 'R2', { run: 0, temp: 900, atmosphere: 'air', duration: 1 });
});

test('lock validation rejects unknown recipes and out-of-domain values', () => {
  const state = buildState();
  assert.throws(() => lockSlot(state, 'NOPE', { run: 0, temp: 700, atmosphere: 'air', duration: 1 }), StateError);
  assert.throws(() => lockSlot(state, 'R1', { run: 5, temp: 700, atmosphere: 'air', duration: 1 }), StateError);
  assert.throws(() => lockSlot(state, 'R1', { run: 0, temp: 999, atmosphere: 'air', duration: 1 }), StateError);
  assert.throws(() => lockSlot(state, 'R1', { run: 0, temp: 700, atmosphere: 'H2', duration: 1 }), StateError);
  assert.throws(() => unlockSlot(state, 'R1'), StateError);
});
