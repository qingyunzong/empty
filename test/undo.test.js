import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { undo, planUndo } from '../src/undo.js';
import { ERR } from '../src/errors.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'txundo-'));
}

//     R
//    / \
//   A   B
//  / \
// C   D
const NODES = [
  { id: 'R', parentId: null, amount: 5, reason: 'root node', state: 'active' },
  { id: 'A', parentId: 'R', amount: 10, reason: 'foo x bar refund', state: 'active' },
  { id: 'B', parentId: 'R', amount: 20, reason: 'nothing relevant', state: 'active' },
  { id: 'C', parentId: 'A', amount: 30, reason: 'bar then foo later', state: 'active' },
  { id: 'D', parentId: 'A', amount: 40, reason: 'foo bar again', state: 'active' },
];

test('acceptance 2: sufficient budget undoes parent and child with correct total', () => {
  const store = new StateStore(tmpDir());
  const cert = undo(store, NODES, { rootId: 'R', terms: ['foo', 'bar'], slop: 1, budget: 1000 });

  // Hits: A (foo x bar) and D (foo bar). D's subtree adds nothing; A's
  // subtree adds C and D. Undo set = {A, C, D}, total = 10 + 30 + 40 = 80.
  assert.equal(cert.batch, 1);
  assert.equal(cert.totalAmount, 80);
  assert.deepEqual(
    cert.nodes.map((n) => [n.id, n.level, n.amount, n.matched]),
    [['A', 1, 10, true], ['C', 2, 30, false], ['D', 2, 40, true]],
  );
  const hitA = cert.nodes.find((n) => n.id === 'A');
  assert.deepEqual(hitA.positions, [[0, 2]]);

  const committed = store.load();
  assert.equal(committed.batch, 1);
  assert.deepEqual(committed.undone, ['A', 'C', 'D']);
});

test('undo set is deterministic and sorted by node id', () => {
  const plan = planUndo(NODES, { rootId: 'R', terms: ['foo', 'bar'], slop: 1, budget: 1000 });
  assert.deepEqual(plan.hitIds, ['A', 'D']);
  assert.deepEqual([...plan.undoSet].sort(), ['A', 'C', 'D']);
});

test('acceptance 3: insufficient budget fails the whole batch with no side effects', () => {
  const dir = tmpDir();
  const store = new StateStore(dir);
  assert.throws(
    () => undo(store, NODES, { rootId: 'R', terms: ['foo', 'bar'], slop: 1, budget: 79 }),
    (err) => err.code === ERR.BUDGET_EXCEEDED && err.details.required === 80,
  );
  assert.deepEqual(store.load(), { batch: 0, undone: [], certificates: [] });
  assert.equal(fs.existsSync(path.join(dir, 'COMMIT')), false);
  assert.equal(fs.existsSync(path.join(dir, 'batches')), false);
});

test('acceptance 3: parent-chain cycle fails the whole batch with no side effects', () => {
  const cyclic = [
    { id: 'X', parentId: 'Y', amount: 2, reason: 'foo bar', state: 'active' },
    { id: 'Y', parentId: 'X', amount: 3, reason: 'foo bar', state: 'active' },
    { id: 'Z', parentId: null, amount: 1, reason: 'detached', state: 'active' },
  ];
  const dir = tmpDir();
  const store = new StateStore(dir);
  assert.throws(
    () => undo(store, cyclic, { rootId: 'X', terms: ['foo', 'bar'], slop: 0, budget: 100 }),
    (err) => err.code === ERR.CYCLE_DETECTED,
  );
  assert.deepEqual(store.load(), { batch: 0, undone: [], certificates: [] });
});

test('cycle above the root is also detected', () => {
  const cyclic = [
    { id: 'R', parentId: 'P', amount: 1, reason: 'root', state: 'active' },
    { id: 'P', parentId: 'R', amount: 1, reason: 'loop', state: 'active' },
  ];
  assert.throws(
    () => planUndo(cyclic, { rootId: 'R', terms: ['foo', 'bar'], slop: 0, budget: 10 }),
    (err) => err.code === ERR.CYCLE_DETECTED,
  );
});

test('acceptance 3: duplicate undo fails with no side effects', () => {
  const store = new StateStore(tmpDir());
  const options = { rootId: 'R', terms: ['foo', 'bar'], slop: 1, budget: 1000 };
  const first = undo(store, NODES, options);
  assert.equal(first.batch, 1);
  assert.throws(
    () => undo(store, NODES, options),
    (err) => err.code === ERR.ALREADY_UNDONE && err.details.nodes.includes('A'),
  );
  const committed = store.load();
  assert.equal(committed.batch, 1, 'batch counter must not advance');
  assert.deepEqual(committed.undone, ['A', 'C', 'D']);
});

test('root outside the data set fails with ROOT_NOT_FOUND', () => {
  const store = new StateStore(tmpDir());
  assert.throws(
    () => undo(store, NODES, { rootId: 'ZZZ', terms: ['foo', 'bar'], slop: 1, budget: 10 }),
    (err) => err.code === ERR.ROOT_NOT_FOUND,
  );
});

test('hits outside the root subtree are not undone', () => {
  const nodes = [
    ...NODES,
    { id: 'OTHER', parentId: null, amount: 99, reason: 'foo bar elsewhere', state: 'active' },
  ];
  const store = new StateStore(tmpDir());
  const cert = undo(store, nodes, { rootId: 'R', terms: ['foo', 'bar'], slop: 1, budget: 1000 });
  assert.deepEqual(cert.nodes.map((n) => n.id), ['A', 'C', 'D']);
});

test('undo survives restart: committed state is reloaded from disk', () => {
  const dir = tmpDir();
  undo(new StateStore(dir), NODES, { rootId: 'R', terms: ['foo', 'bar'], slop: 1, budget: 1000 });
  const reopened = new StateStore(dir);
  assert.equal(reopened.load().batch, 1);
  assert.throws(
    () => undo(reopened, NODES, { rootId: 'R', terms: ['foo', 'bar'], slop: 1, budget: 1000 }),
    (err) => err.code === ERR.ALREADY_UNDONE,
  );
});
