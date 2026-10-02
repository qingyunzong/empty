import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, StoreError } from '../src/store.js';

const config = {
  days: 1,
  maxRunsPerDay: 2,
  slots: 2,
  gasBudget: 10,
  maxTempDiff: 2,
  crucibles: { alumina: 4 },
  gasUsage: { n2: 2, h2: 5 },
  hazards: [],
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

function freshStore() {
  const s = new Store();
  s.init(config);
  return s;
}

test('nested snapshots restore in stack order and future snapshots lapse', () => {
  const s = freshStore();
  s.addRecipe(recipe('R1', 5));
  s.snapshot(); // depth 1: {R1}
  s.addRecipe(recipe('R2', 4));
  s.snapshot(); // depth 2: {R1,R2}
  s.addRecipe(recipe('R3', 3));
  assert.deepEqual(s.state.recipes.map((r) => r.id), ['R1', 'R2', 'R3']);

  s.restore();
  assert.deepEqual(s.state.recipes.map((r) => r.id), ['R1', 'R2']);
  s.restore();
  assert.deepEqual(s.state.recipes.map((r) => r.id), ['R1']);
  assert.throws(() => s.restore(), StoreError); // stack exhausted

  // After the restores, a new snapshot starts a fresh future.
  s.addRecipe(recipe('R9', 1));
  s.snapshot();
  s.addRecipe(recipe('R10', 1));
  s.restore();
  assert.deepEqual(s.state.recipes.map((r) => r.id), ['R1', 'R9']);
  assert.throws(() => s.restore(), StoreError);
});

test('snapshots capture locks and results too', () => {
  const s = freshStore();
  s.addRecipe(recipe('R1', 5));
  s.addRecipe(recipe('R2', 5));
  s.lock('R1', { batch: 0, temp: 1, atmo: 'n2', dur: 1 });
  s.optimize();
  assert.equal(s.state.result.status, 'OPTIMAL');
  assert.equal(s.state.result.assignment.R1.batch, 0);
  s.snapshot();
  s.unlock('R1');
  s.optimize();
  assert.equal(s.state.locks.length, 0);
  s.restore();
  assert.equal(s.state.locks.length, 1);
  assert.equal(s.state.locks[0].recipe, 'R1');
  assert.equal(s.state.result.assignment.R1.batch, 0);
});

test('unlock triggers a full recompute equivalent to a fresh instance', () => {
  // R1 locked into batch 1 blocks R2 (ramp/temp-compatible twin) from the
  // better packing; after unlock the solver must recompute from scratch.
  const locked = freshStore();
  locked.addRecipe(recipe('R1', 5));
  locked.addRecipe(recipe('R2', 5));
  locked.lock('R1', { batch: 1, temp: 1, atmo: 'n2', dur: 1 });
  const withLock = locked.optimize();
  assert.equal(withLock.status, 'OPTIMAL');
  assert.equal(withLock.assignment.R1.batch, 1);

  locked.unlock('R1');
  assert.equal(locked.state.result, null); // incumbent invalidated
  const afterUnlock = locked.optimize();

  const fresh = freshStore();
  fresh.addRecipe(recipe('R1', 5));
  fresh.addRecipe(recipe('R2', 5));
  const freshResult = fresh.optimize();

  assert.deepEqual(afterUnlock, freshResult);
});

test('lock is rejected on scheduled variables and unknown recipes', () => {
  const s = freshStore();
  s.addRecipe(recipe('R1', 5));
  s.addRecipe(recipe('R2', 5));
  const res = s.optimize();
  assert.ok(res.assignment.R1);
  assert.throws(() => s.lock('R1', { batch: 0, temp: 1, atmo: 'n2', dur: 1 }), /scheduled/);
  assert.throws(() => s.lock('NOPE', { batch: 0, temp: 1, atmo: 'n2', dur: 1 }), /unknown recipe/);
});

test('lock validates slot against domain and batch range', () => {
  const s = freshStore();
  s.addRecipe(recipe('R1', 5));
  assert.throws(() => s.lock('R1', { batch: 9, temp: 1, atmo: 'n2', dur: 1 }), /batch out of range/);
  assert.throws(() => s.lock('R1', { batch: 0, temp: 7, atmo: 'n2', dur: 1 }), /temp/);
  assert.throws(() => s.lock('R1', { batch: 0, temp: 1, atmo: 'ar', dur: 1 }), /atmo/);
  assert.throws(() => s.lock('R1', { batch: 0, temp: 1, atmo: 'n2', dur: 9 }), /dur/);
  s.lock('R1', { batch: 0, temp: 1, atmo: 'n2', dur: 1 });
  assert.throws(() => s.lock('R1', { batch: 0, temp: 1, atmo: 'n2', dur: 1 }), /already locked/);
});

test('unlock of an unlocked recipe fails', () => {
  const s = freshStore();
  s.addRecipe(recipe('R1', 5));
  assert.throws(() => s.unlock('R1'), /not locked/);
});

test('adding a recipe invalidates the incumbent schedule', () => {
  const s = freshStore();
  s.addRecipe(recipe('R1', 5));
  s.optimize();
  assert.ok(s.state.result);
  s.addRecipe(recipe('R2', 5));
  assert.equal(s.state.result, null);
});

test('duplicate recipe ids are rejected', () => {
  const s = freshStore();
  s.addRecipe(recipe('R1', 5));
  assert.throws(() => s.addRecipe(recipe('R1', 5)), /duplicate/);
});

test('PENDING results are returned but never cached as incumbent', () => {
  const s = freshStore();
  s.init({ ...config, requiredPriority: 10 });
  s.addRecipe(recipe('R1', 10));
  s.addRecipe(recipe('R2', 10));
  const res = s.optimize({ backtrack: 0 });
  assert.equal(res.status, 'PENDING');
  assert.equal(s.state.result, null);
});
