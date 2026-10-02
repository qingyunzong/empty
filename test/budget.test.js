'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BudgetTree, INVALID_TREE, INVALID_BATCH } = require('../src/tree');

function siblingSpec() {
  return {
    nodes: [
      { id: 'root', parent: null, limit: 100 },
      { id: 'a', parent: 'root', limit: 60 },
      { id: 'b', parent: 'root', limit: 60 },
    ],
  };
}

function deepSpec() {
  return {
    nodes: [
      { id: 'root', parent: null, limit: 100 },
      { id: 'a', parent: 'root', limit: 50 },
      { id: 'b', parent: 'a', limit: 30 },
      { id: 'c', parent: 'b', limit: 10 },
    ],
  };
}

function assertCode(code, fn) {
  assert.throws(fn, (err) => err.code === code);
}

test('acceptance 1: cancelling one sibling batch leaves the other untouched', () => {
  const tree = new BudgetTree(siblingSpec());
  tree.reserve('b1', [{ node: 'a', amount: 10 }]);
  tree.reserve('b2', [{ node: 'b', amount: 20 }]);
  assert.equal(tree.read('root').subtree.held, 30);

  tree.cancel('b1');

  assert.deepEqual(tree.read('a').direct, { held: 0, used: 0 });
  assert.deepEqual(tree.read('a').subtree, { held: 0, used: 0 });
  assert.deepEqual(tree.read('b').direct, { held: 20, used: 0 });
  assert.deepEqual(tree.read('b').subtree, { held: 20, used: 0 });
  assert.deepEqual(tree.read('root').subtree, { held: 20, used: 0 });
  assert.equal(tree.verifyInvariants(), null);
});

test('acceptance 2: deep over-limit reserve rejects the whole batch, ancestors stay at zero', () => {
  const tree = new BudgetTree(deepSpec());
  assertCode(INVALID_BATCH, () =>
    tree.reserve('deep', [
      { node: 'c', amount: 8 },
      { node: 'a', amount: 45 },
    ]),
  );
  for (const id of ['root', 'a', 'b', 'c']) {
    const view = tree.read(id);
    assert.deepEqual(view.direct, { held: 0, used: 0 }, `direct of ${id}`);
    assert.deepEqual(view.subtree, { held: 0, used: 0 }, `subtree of ${id}`);
  }
  tree.reserve('deep', [{ node: 'c', amount: 8 }]);
  assert.equal(tree.read('root').subtree.held, 8);
});

test('acceptance 3: cycle, duplicate batch and unknown node are rejected', () => {
  assertCode(INVALID_TREE, () =>
    new BudgetTree({
      nodes: [
        { id: 'root', parent: null, limit: 10 },
        { id: 'x', parent: 'y', limit: 5 },
        { id: 'y', parent: 'x', limit: 5 },
      ],
    }),
  );
  assertCode(INVALID_TREE, () => new BudgetTree({ nodes: [{ id: 'x', parent: 'x', limit: 5 }] }));
  assertCode(INVALID_TREE, () =>
    new BudgetTree({
      nodes: [
        { id: 'root', parent: null, limit: 10 },
        { id: 'x', parent: 'ghost', limit: 5 },
      ],
    }),
  );

  const tree = new BudgetTree(siblingSpec());
  tree.reserve('b1', [{ node: 'a', amount: 1 }]);
  assertCode(INVALID_BATCH, () => tree.reserve('b1', [{ node: 'a', amount: 1 }]));
  assertCode(INVALID_TREE, () => tree.reserve('b2', [{ node: 'ghost', amount: 1 }]));
  assertCode(INVALID_BATCH, () => tree.cancel('ghost-batch'));
});

test('child holds propagate occupancy to every ancestor, direct values stay local', () => {
  const tree = new BudgetTree(deepSpec());
  tree.reserve('b1', [{ node: 'c', amount: 4 }]);
  assert.deepEqual(tree.read('c').direct, { held: 4, used: 0 });
  assert.deepEqual(tree.read('b').direct, { held: 0, used: 0 });
  assert.deepEqual(tree.read('b').subtree, { held: 4, used: 0 });
  assert.deepEqual(tree.read('a').subtree, { held: 4, used: 0 });
  assert.deepEqual(tree.read('root').subtree, { held: 4, used: 0 });
  assert.equal(tree.read('root').available, 96);
});

test('multi-node batch charges every touched path exactly once per hold', () => {
  const tree = new BudgetTree(deepSpec());
  tree.reserve('b1', [
    { node: 'c', amount: 3 },
    { node: 'b', amount: 5 },
  ]);
  assert.deepEqual(tree.read('b').subtree, { held: 8, used: 0 });
  assert.deepEqual(tree.read('a').subtree, { held: 8, used: 0 });
  tree.cancel('b1');
  assert.deepEqual(tree.read('root').subtree, { held: 0, used: 0 });
});

test('settle converts held into used along the same path; cancel afterwards fails', () => {
  const tree = new BudgetTree(deepSpec());
  tree.reserve('b1', [{ node: 'c', amount: 6 }]);
  tree.settle('b1');
  assert.deepEqual(tree.read('c').direct, { held: 0, used: 6 });
  assert.deepEqual(tree.read('root').subtree, { held: 0, used: 6 });
  assertCode(INVALID_BATCH, () => tree.cancel('b1'));
  assertCode(INVALID_BATCH, () => tree.settle('b1'));
});

test('release is an exact rollback alias of cancel', () => {
  const tree = new BudgetTree(deepSpec());
  tree.reserve('b1', [{ node: 'c', amount: 6 }]);
  tree.release('b1');
  assert.deepEqual(tree.read('root').subtree, { held: 0, used: 0 });
  assertCode(INVALID_BATCH, () => tree.release('b1'));
});

test('frozen nodes on the hold path reject reserve; unfreeze restores it', () => {
  const tree = new BudgetTree(deepSpec());
  tree.freeze('b');
  assertCode(INVALID_BATCH, () => tree.reserve('b1', [{ node: 'c', amount: 1 }]));
  assert.deepEqual(tree.read('root').subtree, { held: 0, used: 0 });
  tree.unfreeze('b');
  tree.reserve('b1', [{ node: 'c', amount: 1 }]);
  assert.equal(tree.read('root').subtree.held, 1);
});

test('read of an unknown node is INVALID_TREE', () => {
  const tree = new BudgetTree(siblingSpec());
  assertCode(INVALID_TREE, () => tree.read('ghost'));
});

test('state hash is deterministic and changes with state transitions', () => {
  const left = new BudgetTree(siblingSpec());
  const right = new BudgetTree(siblingSpec());
  assert.equal(left.stateHash(), right.stateHash());
  left.reserve('b1', [{ node: 'a', amount: 2 }]);
  assert.notEqual(left.stateHash(), right.stateHash());
  right.reserve('b1', [{ node: 'a', amount: 2 }]);
  assert.equal(left.stateHash(), right.stateHash());
});
