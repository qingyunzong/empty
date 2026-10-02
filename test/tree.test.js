'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BudgetTree, BudgetError } = require('../src/tree');

function makeTree() {
  return new BudgetTree({
    nodes: [
      { id: 'root', parent: null, capacity: 100 },
      { id: 'a', parent: 'root', capacity: 60 },
      { id: 'b', parent: 'root', capacity: 60 },
      { id: 'a1', parent: 'a', capacity: 40 },
    ],
  });
}

function codeOf(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof BudgetError, `expected BudgetError, got ${e}`);
    return e.code;
  }
  throw new Error('expected function to throw');
}

test('acceptance 1: cancelling one sibling batch leaves the other untouched', () => {
  const tree = makeTree();
  tree.reserve('b1', [{ node: 'a', amount: 30 }]);
  tree.reserve('b2', [{ node: 'b', amount: 25 }]);
  assert.equal(tree.read('root').aggregate.held, 55);
  tree.cancel('b1');
  assert.deepEqual(tree.read('b').direct, { capacity: 60, held: 25, used: 0, available: 35 });
  assert.equal(tree.read('b').aggregate.held, 25);
  assert.equal(tree.read('a').aggregate.held, 0);
  assert.equal(tree.read('root').aggregate.held, 25);
  assert.equal(tree.read('root').direct.available, 75);
});

test('reserve propagates occupancy to all ancestors and cancel restores the same path', () => {
  const tree = makeTree();
  tree.reserve('deep', [{ node: 'a1', amount: 10 }]);
  assert.equal(tree.read('a1').direct.held, 10);
  assert.equal(tree.read('a').direct.held, 0);
  assert.equal(tree.read('a').aggregate.held, 10);
  assert.equal(tree.read('root').aggregate.held, 10);
  assert.equal(tree.read('root').direct.available, 90);
  tree.cancel('deep');
  for (const id of ['root', 'a', 'a1']) {
    assert.equal(tree.read(id).aggregate.held, 0, `${id} held`);
    assert.equal(tree.read(id).direct.available, tree.read(id).direct.capacity === 100 ? 100 : tree.read(id).direct.capacity);
  }
});

test('acceptance 2: deep-node overflow rejects the whole batch, ancestors stay at zero', () => {
  const tree = makeTree();
  const code = codeOf(() =>
    tree.reserve('bad', [
      { node: 'b', amount: 10 },
      { node: 'a1', amount: 50 },
    ]),
  );
  assert.equal(code, 'INSUFFICIENT_BALANCE');
  for (const id of ['root', 'a', 'b', 'a1']) {
    const view = tree.read(id);
    assert.equal(view.direct.held, 0, `${id} direct held`);
    assert.equal(view.aggregate.held, 0, `${id} aggregate held`);
  }
  assert.equal(codeOf(() => tree.cancel('bad')), 'INVALID_BATCH');
});

test('ancestor overflow also rejects atomically', () => {
  const tree = makeTree();
  tree.reserve('ok', [{ node: 'a1', amount: 40 }]);
  const code = codeOf(() => tree.reserve('over', [{ node: 'b', amount: 61 }]));
  assert.equal(code, 'INSUFFICIENT_BALANCE');
  assert.equal(tree.read('b').aggregate.held, 0);
  assert.equal(tree.read('root').aggregate.held, 40);
});

test('settle converts held into used along the same path', () => {
  const tree = makeTree();
  tree.reserve('s1', [{ node: 'a1', amount: 15 }]);
  tree.settle('s1');
  assert.deepEqual(tree.read('a1').direct, { capacity: 40, held: 0, used: 15, available: 25 });
  assert.equal(tree.read('a').aggregate.used, 15);
  assert.equal(tree.read('root').aggregate.used, 15);
  assert.equal(tree.read('root').direct.available, 85);
  assert.equal(codeOf(() => tree.cancel('s1')), 'INVALID_BATCH');
  assert.equal(codeOf(() => tree.settle('s1')), 'INVALID_BATCH');
});

test('acceptance 3: cycle, duplicate batch and unknown node are rejected', () => {
  assert.equal(
    codeOf(
      () =>
        new BudgetTree({
          nodes: [
            { id: 'x', parent: 'y', capacity: 1 },
            { id: 'y', parent: 'x', capacity: 1 },
          ],
        }),
    ),
    'INVALID_TREE',
  );
  assert.equal(
    codeOf(
      () =>
        new BudgetTree({
          nodes: [
            { id: 'r', parent: null, capacity: 1 },
            { id: 'r', parent: null, capacity: 1 },
          ],
        }),
    ),
    'INVALID_TREE',
  );
  assert.equal(
    codeOf(() => new BudgetTree({ nodes: [{ id: 'n', parent: 'ghost', capacity: 1 }] })),
    'INVALID_TREE',
  );
  const tree = makeTree();
  tree.reserve('dup', [{ node: 'a', amount: 1 }]);
  assert.equal(codeOf(() => tree.reserve('dup', [{ node: 'a', amount: 1 }])), 'INVALID_BATCH');
  assert.equal(codeOf(() => tree.reserve('ghost', [{ node: 'nope', amount: 1 }])), 'INVALID_TREE');
  assert.equal(codeOf(() => tree.read('nope')), 'INVALID_TREE');
  assert.equal(codeOf(() => tree.cancel('never-seen')), 'INVALID_BATCH');
  assert.equal(codeOf(() => tree.settle('never-seen')), 'INVALID_BATCH');
  assert.equal(tree.read('a').aggregate.held, 1, 'rejected duplicate must not add occupancy');
});

test('frozen nodes reject reserve and unfreeze restores it', () => {
  const tree = makeTree();
  tree.freeze('a1');
  assert.equal(codeOf(() => tree.reserve('f', [{ node: 'a1', amount: 1 }])), 'NODE_FROZEN');
  assert.equal(tree.read('root').aggregate.held, 0);
  tree.unfreeze('a1');
  tree.reserve('f', [{ node: 'a1', amount: 1 }]);
  assert.equal(tree.read('a1').direct.held, 1);
});

test('read reports direct and descendant-aggregated values', () => {
  const tree = makeTree();
  tree.reserve('x', [
    { node: 'a', amount: 5 },
    { node: 'a1', amount: 7 },
  ]);
  const view = tree.read('a');
  assert.equal(view.direct.held, 5);
  assert.equal(view.aggregate.held, 12);
  assert.equal(view.aggregate.capacity, 100);
  assert.equal(view.direct.available, 48);
});
