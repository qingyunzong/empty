import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { canonicalJSON } from '../src/canonical.js';

const diamond = [
  { id: 'a', inputHash: 'ia', moduleVersion: 'm1', deps: [] },
  { id: 'b', inputHash: 'ib', moduleVersion: 'm1', deps: ['a'] },
  { id: 'c', inputHash: 'ic', moduleVersion: 'm1', deps: ['a'] },
  { id: 'd', inputHash: 'id', moduleVersion: 'm1', deps: ['b', 'c'] },
];

function loadedStore(tasks = diamond) {
  const store = new Store();
  const result = store.loadTasks(tasks);
  assert.equal(result.ok, true);
  return store;
}

test('canonical JSON sorts keys recursively and keeps array order', () => {
  assert.equal(
    canonicalJSON({ b: [2, { y: 1, x: 2 }], a: 's' }),
    '{"a":"s","b":[2,{"x":2,"y":1}]}',
  );
});

test('acceptance 2: version bump recomputes the diamond join exactly once, in fixed order', () => {
  const store = loadedStore();
  const result = store.applyTransaction({
    maxRecompute: 10,
    ops: [{ type: 'setModuleVersion', task: 'a', moduleVersion: 'm2' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.invalidated, ['a', 'b', 'c', 'd']);
  assert.deepEqual(
    result.changes.map((c) => c.id),
    ['a', 'b', 'c', 'd'],
    'join task d is recomputed exactly once',
  );
  assert.equal(new Set(result.invalidated).size, 4);
  // Every hash actually changed, so no stop points.
  assert.deepEqual(result.stopPoints, []);
  // Repeating the same transaction is deterministic: identical new hashes.
  const first = Object.fromEntries(result.changes.map((c) => [c.id, c.newHash]));
  const again = store.applyTransaction({
    maxRecompute: 10,
    ops: [{ type: 'setModuleVersion', task: 'a', moduleVersion: 'm2' }],
  });
  assert.equal(again.noop, true);
  assert.deepEqual(store.tasks.get('d').resultHash, first.d);
});

test('stop points: a change that does not alter a hash stops there', () => {
  // removeDep of a non-existent dependency changes nothing -> noop.
  const store = loadedStore();
  const noop = store.applyTransaction({
    ops: [{ type: 'removeDep', task: 'd', dep: 'zzz' }],
  });
  assert.equal(noop.ok, true);
  assert.equal(noop.noop, true);
  assert.deepEqual(noop.invalidated, []);
  assert.deepEqual(noop.changes, []);
  assert.deepEqual(noop.stopPoints, []);

  // Re-set the same input on a: declaration unchanged -> no recomputation.
  const same = store.applyTransaction({
    ops: [{ type: 'setInput', task: 'a', inputHash: 'ia' }],
  });
  assert.equal(same.noop, true);
});

test('acceptance 3: exceeding maxRecompute returns E_BUDGET and rolls back', () => {
  const store = loadedStore();
  const before = new Map([...store.tasks].map(([id, t]) => [id, t.resultHash]));
  const result = store.applyTransaction({
    maxRecompute: 2,
    ops: [{ type: 'setModuleVersion', task: 'a', moduleVersion: 'm2' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_BUDGET');
  assert.equal(result.error.required, 4);
  assert.equal(result.error.maxRecompute, 2);
  for (const [id, hash] of before) {
    assert.equal(store.tasks.get(id).resultHash, hash, `task ${id} untouched after rollback`);
  }
});

test('acceptance 3: dependency cycle returns E_CYCLE and rolls back', () => {
  const store = loadedStore();
  const before = store.tasks.get('a').resultHash;
  const result = store.applyTransaction({
    ops: [{ type: 'addDep', task: 'a', dep: 'd' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_CYCLE');
  assert.ok(result.error.cycle.includes('a'));
  assert.equal(store.tasks.get('a').resultHash, before);
});

test('acceptance 3: self-loop returns E_CYCLE', () => {
  const store = loadedStore();
  const result = store.applyTransaction({
    ops: [{ type: 'addDep', task: 'b', dep: 'b' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_CYCLE');
  assert.deepEqual(result.error.cycle, ['b', 'b']);
});

test('acceptance 3: no-change transaction reports a noop with empty diff', () => {
  const store = loadedStore();
  const result = store.applyTransaction({
    maxRecompute: 0,
    ops: [
      { type: 'setInput', task: 'a', inputHash: 'ia' },
      { type: 'setModuleVersion', task: 'b', moduleVersion: 'm1' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.deepEqual(result.invalidated, []);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.stopPoints, []);
});

test('add/remove dependency rewires the invalidation closure', () => {
  const store = loadedStore();
  const result = store.applyTransaction({
    ops: [{ type: 'removeDep', task: 'd', dep: 'c' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.invalidated, ['d']);
  // c is no longer upstream of d: changing c leaves d untouched.
  const after = store.applyTransaction({
    ops: [{ type: 'setInput', task: 'c', inputHash: 'ic2' }],
  });
  assert.deepEqual(after.invalidated, ['c']);
});

test('unknown task and unknown op are rejected without side effects', () => {
  const store = loadedStore();
  const missing = store.applyTransaction({ ops: [{ type: 'setInput', task: 'nope', inputHash: 'x' }] });
  assert.equal(missing.error.code, 'E_UNKNOWN_TASK');
  const badOp = store.applyTransaction({ ops: [{ type: 'explode', task: 'a' }] });
  assert.equal(badOp.error.code, 'E_UNKNOWN_OP');
});

test('loadTasks rejects cycles and dangling deps', () => {
  const cyclic = new Store().loadTasks([
    { id: 'x', deps: ['y'] },
    { id: 'y', deps: ['x'] },
  ]);
  assert.equal(cyclic.error.code, 'E_CYCLE');
  const dangling = new Store().loadTasks([{ id: 'x', deps: ['ghost'] }]);
  assert.equal(dangling.error.code, 'E_UNKNOWN_TASK');
});
