import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { solve } from '../src/solver.js';
import { Rational } from '../src/rational.js';

const task = (id, deps = []) => ({
  id, priority: 1, cost: [1, 2], duration: [1, 1], precedence: deps,
});

test('cyclic dependency rolls back the whole batch; prior plan unchanged', () => {
  const store = new Store();
  store.importBatch([task('a'), task('b', ['a'])]);
  const budget = Rational.parse(10);
  const limit = Rational.parse(10);
  const before = solve(store.list(), budget, limit);

  assert.throws(
    () => store.importBatch([task('c', ['d']), task('d', ['c'])]),
    (e) => e.code === 'E_CYCLE',
  );
  assert.equal(store.size, 2);
  assert.deepEqual(solve(store.list(), budget, limit), before);

  // store still accepts valid batches afterwards
  store.importBatch([task('c', ['b'])]);
  assert.equal(store.size, 3);
});

test('cl>ch rolls back the entire batch atomically', () => {
  const store = new Store();
  store.importBatch([task('ok')]);
  assert.throws(
    () => store.importBatch([task('good'), { ...task('bad'), cost: [3, 1] }]),
    (e) => e.code === 'E_INTERVAL',
  );
  assert.equal(store.size, 1);
  assert.ok(!store.has('good'));
});

test('duplicate id rolls back the whole batch', () => {
  const store = new Store();
  store.importBatch([task('a')]);
  assert.throws(() => store.importBatch([task('b'), task('a')]), (e) => e.code === 'E_DUPLICATE');
  assert.throws(() => store.importBatch([task('x'), task('x')]), (e) => e.code === 'E_DUPLICATE');
  assert.equal(store.size, 1);
  assert.ok(!store.has('b'));
});

test('invalid rational in a batch raises E_RATIONAL and rolls back', () => {
  const store = new Store();
  assert.throws(
    () => store.importBatch([{ ...task('a'), priority: 'not-a-number' }]),
    (e) => e.code === 'E_RATIONAL',
  );
  assert.equal(store.size, 0);
});

test('undo of an import restores the empty state; redo reapplies it', () => {
  const store = new Store();
  store.importBatch([task('a'), task('b', ['a'])]);
  store.importBatch([task('c')]);
  assert.equal(store.size, 3);

  store.undo();
  assert.equal(store.size, 2);
  store.undo();
  assert.equal(store.size, 0);
  assert.deepEqual(store.list(), []);
  const empty = solve(store.list(), Rational.parse(0), Rational.parse(0));
  assert.deepEqual(empty.selected, []);
  assert.equal(empty.priority, '0');
  assert.deepEqual(empty.costInterval, ['0', '0']);

  assert.throws(() => store.undo(), (e) => e.code === 'E_HISTORY');

  store.redo();
  assert.equal(store.size, 2);
  store.redo();
  assert.equal(store.size, 3);
  assert.ok(store.has('c'));
});

test('a new import clears the redo stack', () => {
  const store = new Store();
  store.importBatch([task('a')]);
  store.undo();
  store.importBatch([task('b')]);
  assert.throws(() => store.redo(), (e) => e.code === 'E_HISTORY');
  assert.equal(store.size, 1);
  assert.ok(store.has('b'));
});

test('unknown precedent is rejected', () => {
  const store = new Store();
  assert.throws(() => store.importBatch([task('a', ['ghost'])]), (e) => e.code === 'E_UNKNOWN_PRECEDENT');
  assert.equal(store.size, 0);
});
