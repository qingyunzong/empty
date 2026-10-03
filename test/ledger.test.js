import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

test('split creates children with exact proportional quantities', () => {
  const l = new Ledger();
  l.create('R', '8');
  l.split('R', ['1/2', '1/3', '1/6'], ['A', 'B', 'C']);
  assert.equal(l.getBatch('A').quantity.toString(), '4');
  assert.equal(l.getBatch('B').quantity.toString(), '8/3');
  assert.equal(l.getBatch('C').quantity.toString(), '4/3');
  assert.deepEqual(l.descendants('R'), ['A', 'B', 'C']);
  assert.deepEqual(l.ancestors('C'), ['R']);
});

test('join output = sum(inputs) * (1 - loss)', () => {
  const l = new Ledger();
  l.create('A', '3');
  l.create('B', '4');
  l.join(['A', 'B'], 'J', '1/5');
  assert.equal(l.getBatch('J').quantity.toString(), '28/5');
});

test('invalid ratios raise E_RATIONAL', () => {
  const l = new Ledger();
  l.create('R', '10');
  assert.throws(() => l.split('R', ['1/2', '1/3'], ['A', 'B']), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => l.split('R', ['1/2', '-1/2', '1'], ['A', 'B', 'C']), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => l.split('R', ['0', '1'], ['A', 'B']), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => l.split('R', ['x', '1'], ['A', 'B']), (e) => e.code === 'E_RATIONAL');
  l.create('B', '1');
  assert.throws(() => l.join(['R', 'B'], 'J', '1'), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => l.join(['R', 'B'], 'J', '-1/2'), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => l.create('NEG', '-1'), (e) => e.code === 'E_RATIONAL');
});

test('cyclic genealogy raises E_CYCLE', () => {
  const l = new Ledger();
  l.create('M', '10');
  l.split('M', ['1/2', '1/2'], ['N1', 'N2']);
  assert.throws(() => l.join(['N1'], 'M', '0'), (e) => e.code === 'E_CYCLE');
  assert.throws(() => l.join(['M'], 'M', '0'), (e) => e.code === 'E_CYCLE');
});

test('failed transaction rolls back all of its steps', () => {
  const l = new Ledger();
  l.create('R', '10');
  const tx = l.begin();
  tx.create('T1', '1');
  tx.split('R', ['1/2', '1/2'], ['A', 'B']);
  assert.throws(() => tx.join(['A', 'B'], 'A', '0'), (e) => e.code === 'E_CYCLE');
  assert.deepEqual(l.inventory(), [{ id: 'R', quantity: '10', quarantined: false }]);
  assert.equal(l.edges.length, 0);
});

test('undo/redo of committed transactions', () => {
  const l = new Ledger();
  l.create('R', '4');
  l.split('R', ['1/2', '1/2'], ['A', 'B']);
  assert.equal(l.undo(), true); // undo split
  assert.deepEqual(l.inventory(), [{ id: 'R', quantity: '4', quarantined: false }]);
  assert.equal(l.redo(), true); // redo split
  assert.equal(l.getBatch('A').quantity.toString(), '2');
  assert.equal(l.undo(), true);
  assert.equal(l.undo(), true); // undo create
  assert.equal(l.inventory().length, 0);
  assert.equal(l.undo(), false);
  assert.equal(l.redo(), true);
  assert.equal(l.redo(), true);
  assert.equal(l.getBatch('B').quantity.toString(), '2');
});

test('new transaction clears the redo stack', () => {
  const l = new Ledger();
  l.create('R', '4');
  l.undo();
  l.create('X', '1');
  assert.equal(l.redo(), false);
});

test('persistence round-trip preserves state and undo history', () => {
  const l = new Ledger();
  l.create('R', '7');
  l.split('R', ['1/2', '1/2'], ['A', 'B']);
  l.quarantine('A');
  const l2 = Ledger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
  assert.deepEqual(l2.inventory(), l.inventory());
  assert.equal(l2.contaminates('A', 'A'), true);
  assert.equal(l2.undo(), true);
  assert.equal(l2.getBatch('A').quarantined, false);
});
