import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/scheduler.js';

const expectError = (input, code) => {
  assert.throws(() => simulate(input), (e) => e.code === code, `expected ${code}`);
};

test('cyclic tenant tree fails with TENANT_CYCLE', () => {
  expectError(
    {
      tenants: [
        { id: 'A', parent: 'B', guarantee: 1 },
        { id: 'B', parent: 'A', guarantee: 1 },
      ],
    },
    'TENANT_CYCLE',
  );
});

test('self-referencing tenant fails with TENANT_CYCLE', () => {
  expectError({ tenants: [{ id: 'A', parent: 'A', guarantee: 1 }] }, 'TENANT_CYCLE');
});

test('negative guarantee fails with NEGATIVE_QUOTA', () => {
  expectError(
    {
      tenants: [
        { id: 'root', parent: null, guarantee: 5 },
        { id: 'A', parent: 'root', guarantee: -1 },
      ],
    },
    'NEGATIVE_QUOTA',
  );
});

test('child guarantee exceeding root cap fails', () => {
  expectError(
    {
      tenants: [
        { id: 'root', parent: null, guarantee: 2 },
        { id: 'A', parent: 'root', guarantee: 5 },
      ],
    },
    'QUOTA_EXCEEDS_PARENT',
  );
});

test('grandchild guarantee exceeding root cap fails transitively', () => {
  expectError(
    {
      tenants: [
        { id: 'root', parent: null, guarantee: 3 },
        { id: 'A', parent: 'root', guarantee: 3 },
        { id: 'B', parent: 'A', guarantee: 4 },
      ],
    },
    'QUOTA_EXCEEDS_PARENT',
  );
});

test('sum of children guarantees exceeding parent fails', () => {
  expectError(
    {
      tenants: [
        { id: 'root', parent: null, guarantee: 3 },
        { id: 'A', parent: 'root', guarantee: 2 },
        { id: 'B', parent: 'root', guarantee: 2 },
      ],
    },
    'CHILDREN_EXCEED_PARENT',
  );
});

test('missing parent reference fails', () => {
  expectError(
    {
      tenants: [
        { id: 'root', parent: null, guarantee: 1 },
        { id: 'A', parent: 'ghost', guarantee: 1 },
      ],
    },
    'MISSING_PARENT',
  );
});

test('multiple roots fail', () => {
  expectError(
    {
      tenants: [
        { id: 'r1', parent: null, guarantee: 1 },
        { id: 'r2', parent: null, guarantee: 1 },
      ],
    },
    'MULTIPLE_ROOTS',
  );
});

test('order for unknown tenant fails', () => {
  expectError(
    {
      tenants: [{ id: 'root', parent: null, guarantee: 1 }],
      orders: [{ id: 'o1', tenant: 'nope', duration: 1 }],
    },
    'UNKNOWN_TENANT',
  );
});
