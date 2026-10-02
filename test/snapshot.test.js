import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  addRecipe,
  snapshot,
  restore,
  StateError,
} from '../src/state.js';

const recipe = (id) => ({
  id,
  priority: 1,
  temps: [800],
  atmospheres: ['air'],
  durations: [1],
  crucible: 'alumina',
});

const ids = (state) => state.recipes.map((r) => r.id);

test('nested snapshots restore in LIFO order and expire future snapshots', () => {
  const state = createState();
  addRecipe(state, recipe('R1'));
  const s1 = snapshot(state);
  addRecipe(state, recipe('R2'));
  const s2 = snapshot(state);
  addRecipe(state, recipe('R3'));
  assert.deepEqual(ids(state), ['R1', 'R2', 'R3']);

  restore(state, s2);
  assert.deepEqual(ids(state), ['R1', 'R2']);

  restore(state, s1);
  assert.deepEqual(ids(state), ['R1']);

  // s2 was taken after s1 and is now invalidated.
  assert.throws(() => restore(state, s2), StateError);
  assert.throws(() => restore(state, s1), StateError);
});

test('restore without id pops the latest snapshot; empty stack errors', () => {
  const state = createState();
  addRecipe(state, recipe('R1'));
  snapshot(state);
  addRecipe(state, recipe('R2'));
  snapshot(state);
  addRecipe(state, recipe('R3'));

  restore(state);
  assert.deepEqual(ids(state), ['R1', 'R2']);
  restore(state);
  assert.deepEqual(ids(state), ['R1']);
  assert.throws(() => restore(state), StateError);
});

test('snapshot captures locks, config and lastSolution', () => {
  const state = createState();
  addRecipe(state, recipe('R1'));
  state.config.minCoverage = 7;
  state.locks.R1 = { run: 0, temp: 800, atmosphere: 'air', duration: 1 };
  state.lastSolution = { status: 'OPTIMAL', weight: 1, scheduled: [{ recipe: 'R1', run: 0 }] };
  const s1 = snapshot(state);

  state.config.minCoverage = 0;
  delete state.locks.R1;
  state.lastSolution = null;

  restore(state, s1);
  assert.equal(state.config.minCoverage, 7);
  assert.deepEqual(state.locks, { R1: { run: 0, temp: 800, atmosphere: 'air', duration: 1 } });
  assert.equal(state.lastSolution.status, 'OPTIMAL');
});

test('restored state is a deep copy, not aliased', () => {
  const state = createState();
  addRecipe(state, recipe('R1'));
  const s1 = snapshot(state);
  state.recipes[0].priority = 99;
  restore(state, s1);
  assert.equal(state.recipes[0].priority, 1);
});
