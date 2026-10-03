import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initStore, listCommittedBatches, loadStore, undo } from '../src/store.js';
import { ERR } from '../src/core.js';
import { makeTempDir } from '../support/helpers.js';

const parentChildTree = () => [
  { id: 'a', parentId: null, amount: 10, reason: 'pay refund now', state: 'active' },
  { id: 'b', parentId: 'a', amount: 20, reason: 'pay refund later', state: 'active' },
  { id: 'c', parentId: 'b', amount: 5, reason: 'unrelated note', state: 'active' },
];

function setup(nodes) {
  const dir = makeTempDir();
  initStore(dir, nodes);
  return dir;
}

function states(dir) {
  return Object.fromEntries(loadStore(dir).nodes.map((n) => [n.id, n.state]));
}

test('sufficient budget undoes parent and child together with correct amounts', () => {
  const dir = setup(parentChildTree());
  const result = undo(dir, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: 35 });
  assert.equal(result.ok, true);
  assert.equal(result.batchId, 'BATCH-000001');
  assert.equal(result.certificate.totalAmount, 35);
  assert.deepEqual(
    result.certificate.entries.map((e) => [e.nodeId, e.level, e.amount, e.positions, e.direct]),
    [
      ['a', 0, 10, [[0, 1]], true],
      ['b', 1, 20, [[0, 1]], true],
      ['c', 2, 5, [], false],
    ],
  );
  assert.deepEqual(states(dir), { a: 'undone', b: 'undone', c: 'undone' });
  assert.deepEqual(listCommittedBatches(dir), [1]);
});

test('budget equal to total succeeds; budget below total fails without side effects', () => {
  const dir = setup(parentChildTree());
  const exact = undo(dir, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: 35 });
  assert.equal(exact.ok, true);

  const dir2 = setup(parentChildTree());
  const short = undo(dir2, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: 34 });
  assert.equal(short.ok, false);
  assert.equal(short.error.code, ERR.BUDGET_EXCEEDED);
  assert.deepEqual(states(dir2), { a: 'active', b: 'active', c: 'active' });
  assert.deepEqual(listCommittedBatches(dir2), []);
  assert.deepEqual(fs.readdirSync(path.join(dir2, 'batches')), []);
});

test('parent chain cycle fails with CYCLE_DETECTED and no side effects', () => {
  const dir = setup([
    { id: 'r', parentId: null, amount: 1, reason: 'pay refund', state: 'active' },
    { id: 'x', parentId: 'y', amount: 2, reason: 'pay refund', state: 'active' },
    { id: 'y', parentId: 'x', amount: 3, reason: 'pay refund', state: 'active' },
  ]);
  const res = undo(dir, { rootId: 'r', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, ERR.CYCLE_DETECTED);
  assert.deepEqual(states(dir), { r: 'active', x: 'active', y: 'active' });
  assert.deepEqual(listCommittedBatches(dir), []);
});

test('missing root fails with ROOT_NOT_FOUND and no side effects', () => {
  const dir = setup(parentChildTree());
  const res = undo(dir, { rootId: 'nope', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, ERR.NOT_FOUND ?? ERR.ROOT_NOT_FOUND);
  assert.deepEqual(states(dir), { a: 'active', b: 'active', c: 'active' });
  assert.deepEqual(listCommittedBatches(dir), []);
});

test('duplicate undo fails with ALREADY_UNDONE and no new batch', () => {
  const dir = setup(parentChildTree());
  const first = undo(dir, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  assert.equal(first.ok, true);
  const second = undo(dir, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, ERR.ALREADY_UNDONE);
  assert.deepEqual(listCommittedBatches(dir), [1]);
  assert.deepEqual(states(dir), { a: 'undone', b: 'undone', c: 'undone' });
});

test('hits are processed in lexicographic id order and the result set is deterministic', () => {
  const nodes = [
    { id: 'root', parentId: null, amount: 1, reason: 'no match here', state: 'active' },
    { id: 'z9', parentId: 'root', amount: 2, reason: 'pay refund', state: 'active' },
    { id: 'a1', parentId: 'root', amount: 3, reason: 'pay refund', state: 'active' },
    { id: 'a1-kid', parentId: 'a1', amount: 4, reason: 'quiet', state: 'active' },
  ];
  const dir = setup(nodes);
  const res = undo(dir, { rootId: 'root', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.certificate.entries.map((e) => e.nodeId),
    ['a1', 'a1-kid', 'z9'],
  );

  const dir2 = setup(nodes);
  const res2 = undo(dir2, { rootId: 'root', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  assert.deepEqual(
    res2.certificate.entries.map((e) => e.nodeId),
    ['a1', 'a1-kid', 'z9'],
  );
});

test('invalid phrase and invalid budget are rejected', () => {
  const dir = setup(parentChildTree());
  const badPhrase = undo(dir, { rootId: 'a', phrase: ['only-one'], slop: 0, budget: 10 });
  assert.equal(badPhrase.ok, false);
  assert.equal(badPhrase.error.code, ERR.INVALID_PHRASE);
  const badBudget = undo(dir, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: -1 });
  assert.equal(badBudget.ok, false);
  assert.equal(badBudget.error.code, ERR.INVALID_INPUT);
  assert.deepEqual(listCommittedBatches(dir), []);
});
