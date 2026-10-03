import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, loadStore, saveStore } from '../src/project.js';

function spec() {
  return {
    name: 'versioned',
    budget: 20,
    target: { artifact: 'score', type: 'metric' },
    tasks: [
      { name: 'fetch', cost: 10, produces: [{ name: 'raw', type: 'file' }] },
      { name: 'synth', cost: 10, produces: [{ name: 'raw2', type: 'dataset' }] },
      { name: 'evaluate', cost: 10, requires: 'fetch | synth', produces: [{ name: 'score', type: 'metric' }] },
    ],
  };
}

test('revise creates a new version and keeps the old one intact', () => {
  const store = new ProjectStore();
  assert.equal(store.create(spec()), 1);
  assert.equal(store.revise('fetch', 4), 2);

  assert.equal(store.get(1).spec.tasks.find((t) => t.name === 'fetch').cost, 10);
  assert.equal(store.get(2).spec.tasks.find((t) => t.name === 'fetch').cost, 4);

  const v1 = store.plan(1);
  const v2 = store.plan(2);
  assert.equal(v1.plans.length, 2);
  assert.deepEqual(v2.plans, [{ tasks: ['evaluate', 'fetch'], cost: 14 }]);
  assert.notEqual(v1.certificate, v2.certificate);
});

test('acceptance 3: file artifact miswritten as metric is a static error and versions stay unchanged', () => {
  const store = new ProjectStore();
  assert.equal(store.create(spec()), 1);

  const bad = spec();
  bad.target = { artifact: 'raw', type: 'metric' };
  assert.throws(() => store.create(bad), (err) => err.code === 'E_TARGET_TYPE');
  assert.equal(store.latestVersion, 1);

  assert.throws(() => store.revise('ghost', 1), (err) => err.code === 'E_MISSING_REF');
  assert.throws(() => store.revise('fetch', -3), (err) => err.code === 'E_FIELD_TYPE');
  assert.equal(store.latestVersion, 1);
});

test('planning a version with an infeasible budget yields no partial plan', () => {
  const store = new ProjectStore();
  store.create(spec());
  store.revise('evaluate', 50);
  assert.throws(() => store.plan(2), (err) => err.code === 'E_NO_FEASIBLE_SET');
  assert.equal(store.latestVersion, 2);
});

test('store persists to disk and reloads with identical plans and certificate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-planner-'));
  const statePath = join(dir, 'state.json');

  const store = new ProjectStore();
  store.create(spec());
  store.revise('fetch', 4);
  saveStore(statePath, store);

  const reloaded = loadStore(statePath);
  assert.equal(reloaded.latestVersion, 2);
  assert.deepEqual(reloaded.plan(2), store.plan(2));
  assert.ok(JSON.parse(readFileSync(statePath, 'utf8')).versions.length === 2);
});

test('loading a missing state file is a clean error', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'exp-planner-')), 'nope.json');
  assert.equal(existsSync(missing), false);
  assert.throws(() => loadStore(missing), (err) => err.code === 'E_STATE_NOT_FOUND');
});
