import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/tree.js';
import { runScenario } from '../src/engine.js';

const validTenants = () => [
  { id: 'root', parent: null, capacity: 100 },
  { id: 'a', parent: 'root', guarantee: 40 },
  { id: 'b', parent: 'root', guarantee: 50 },
];

function expectCode(fn, code) {
  assert.throws(fn, (err) => err.name === 'ValidationError' && err.code === code);
}

test('valid tenant tree builds and exposes paths', () => {
  const tree = buildTree(validTenants());
  assert.equal(tree.rootId, 'root');
  assert.deepEqual(tree.paths.get('a'), ['a', 'root']);
  assert.equal(tree.nodes.get('root').baseLimit, 100);
  assert.equal(tree.nodes.get('b').baseLimit, 50);
});

test('cyclic tenants fail (a <-> b)', () => {
  expectCode(
    () => buildTree([
      { id: 'root', parent: null, capacity: 10 },
      { id: 'a', parent: 'b', guarantee: 1 },
      { id: 'b', parent: 'a', guarantee: 1 },
    ]),
    'CYCLE',
  );
});

test('self-referencing tenant fails as cycle', () => {
  expectCode(
    () => buildTree([
      { id: 'root', parent: null, capacity: 10 },
      { id: 'a', parent: 'a', guarantee: 1 },
    ]),
    'CYCLE',
  );
});

test('negative guarantee fails', () => {
  expectCode(
    () => buildTree([
      { id: 'root', parent: null, capacity: 10 },
      { id: 'a', parent: 'root', guarantee: -1 },
    ]),
    'NEGATIVE_QUOTA',
  );
});

test('negative root capacity fails', () => {
  expectCode(
    () => buildTree([{ id: 'root', parent: null, capacity: -5 }]),
    'NEGATIVE_QUOTA',
  );
});

test('children guarantees exceeding root capacity fail', () => {
  expectCode(
    () => buildTree([
      { id: 'root', parent: null, capacity: 10 },
      { id: 'a', parent: 'root', guarantee: 6 },
      { id: 'b', parent: 'root', guarantee: 5 },
    ]),
    'ROOT_CAP_EXCEEDED',
  );
});

test('children guarantees exceeding parent guarantee fail', () => {
  expectCode(
    () => buildTree([
      { id: 'root', parent: null, capacity: 100 },
      { id: 'p', parent: 'root', guarantee: 10 },
      { id: 'c1', parent: 'p', guarantee: 7 },
      { id: 'c2', parent: 'p', guarantee: 4 },
    ]),
    'PARENT_CAP_EXCEEDED',
  );
});

test('duplicate tenant id fails', () => {
  expectCode(
    () => buildTree([
      { id: 'root', parent: null, capacity: 10 },
      { id: 'a', parent: 'root', guarantee: 1 },
      { id: 'a', parent: 'root', guarantee: 2 },
    ]),
    'DUPLICATE_TENANT',
  );
});

test('missing parent fails', () => {
  expectCode(
    () => buildTree([
      { id: 'root', parent: null, capacity: 10 },
      { id: 'a', parent: 'ghost', guarantee: 1 },
    ]),
    'MISSING_PARENT',
  );
});

test('no root and multiple roots fail', () => {
  expectCode(() => buildTree([{ id: 'a', parent: 'b', guarantee: 1 }, { id: 'b', parent: 'a', guarantee: 1 }]), 'NO_ROOT');
  expectCode(
    () => buildTree([
      { id: 'r1', parent: null, capacity: 10 },
      { id: 'r2', parent: null, capacity: 10 },
    ]),
    'MULTIPLE_ROOTS',
  );
});

test('non-integer guarantee fails', () => {
  expectCode(
    () => buildTree([
      { id: 'root', parent: null, capacity: 10 },
      { id: 'a', parent: 'root', guarantee: 1.5 },
    ]),
    'INVALID_QUOTA',
  );
});

test('order referencing unknown tenant fails', () => {
  expectCode(
    () => runScenario({
      tenants: validTenants(),
      orders: [{ id: 'o1', tenant: 'ghost', units: 1 }],
      commands: [],
    }),
    'UNKNOWN_TENANT',
  );
});

test('invalid order and command shapes fail', () => {
  expectCode(
    () => runScenario({ tenants: validTenants(), orders: [{ id: 'o1', tenant: 'a', units: 0 }], commands: [] }),
    'INVALID_ORDER',
  );
  expectCode(
    () => runScenario({ tenants: validTenants(), orders: [], commands: [{ cmd: 'boom', time: 0 }] }),
    'INVALID_COMMAND',
  );
  expectCode(
    () => runScenario({ tenants: validTenants(), orders: [], commands: [{ cmd: 'reclaim', time: 0 }] }),
    'INVALID_COMMAND',
  );
});
