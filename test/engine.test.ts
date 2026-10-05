import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicySnapshot } from '../src/policy.js';
import { createTable } from '../src/table.js';
import { runQuery } from '../src/engine.js';

const table = createTable('users', [
  { id: 'u1', dept: 'eng', level: 5, salary: 100, ssn: '111-1', clearance: 'high' },
  { id: 'u2', dept: 'eng', level: 2, salary: 60, ssn: '222-2', clearance: 'low' },
  { id: 'u3', dept: 'sales', level: 4, salary: 80, ssn: '333-3', clearance: 'high' },
  { id: 'u4', dept: 'eng', salary: 1000000, ssn: '444-4', clearance: 'low' },
  { id: 'u5', dept: 'ops', level: 1, ssn: '555-5' },
]);

const snapshot = createPolicySnapshot({
  rowFilter: {
    op: 'or',
    args: [
      { op: 'eq', field: 'dept', value: 'eng' },
      { op: 'eq', field: 'public', value: true },
    ],
  },
  masks: [
    { field: 'ssn', when: { op: 'neq', field: 'clearance', value: 'high' } },
  ],
});

test('row filter keeps only TRUE rows; FALSE and UNKNOWN are denied', () => {
  const out = runQuery(table, snapshot, { select: ['id'] });
  assert.deepEqual(
    out.map((r) => r.sourceRowIds[0]),
    ['u1', 'u2', 'u4'],
  );
});

test('every output row carries its source row id', () => {
  const out = runQuery(table, snapshot, { select: ['dept'] });
  assert.deepEqual(out, [
    { dept: 'eng', sourceRowIds: ['u1'] },
    { dept: 'eng', sourceRowIds: ['u2'] },
    { dept: 'eng', sourceRowIds: ['u4'] },
  ]);
});

test('masking: TRUE masks, FALSE shows, UNKNOWN masks (fail-closed)', () => {
  const out = runQuery(table, snapshot, { select: ['id', 'ssn'] });
  assert.equal(out[0]!.ssn, '111-1');
  assert.equal(out[1]!.ssn, '***');
  assert.equal(out[2]!.ssn, '***');
});

test('filter and masking read the same snapshot object', () => {
  const permissive = createPolicySnapshot({
    rowFilter: { op: 'lit', value: true },
    masks: [{ field: 'ssn', when: { op: 'lit', value: true } }],
  });
  const out = runQuery(table, permissive, { select: ['id', 'ssn'] });
  assert.equal(out.length, 5);
  assert.ok(out.every((r) => r.ssn === '***'));
  const again = runQuery(table, snapshot, { select: ['id'] });
  assert.deepEqual(
    again.map((r) => r.id),
    ['u1', 'u2', 'u4'],
  );
});

test('aggregates never include unauthorized rows', () => {
  const out = runQuery(table, snapshot, {
    groupBy: ['dept'],
    aggregates: [
      { alias: 'n', fn: 'count' },
      { alias: 'total', fn: 'sum', field: 'salary' },
      { alias: 'avgSalary', fn: 'avg', field: 'salary' },
      { alias: 'maxLevel', fn: 'max', field: 'level' },
    ],
  });
  assert.deepEqual(out, [
    {
      dept: 'eng',
      n: 3,
      total: 1000160,
      avgSalary: 1000160 / 3,
      maxLevel: 5,
      sourceRowIds: ['u1', 'u2', 'u4'],
    },
  ]);
});

test('aggregate sourceRowIds list exactly the authorized contributing rows', () => {
  const out = runQuery(table, snapshot, {
    aggregates: [{ alias: 'n', fn: 'count' }],
  });
  assert.deepEqual(out, [{ n: 3, sourceRowIds: ['u1', 'u2', 'u4'] }]);
});

test('query-level where is three-valued: UNKNOWN rows are dropped', () => {
  const out = runQuery(table, snapshot, {
    select: ['id'],
    where: { op: 'gte', field: 'level', value: 2 },
  });
  assert.deepEqual(
    out.map((r) => r.id),
    ['u1', 'u2'],
  );
});

test('select cannot be combined with groupBy/aggregates', () => {
  assert.throws(
    () =>
      runQuery(table, snapshot, {
        select: ['dept'],
        aggregates: [{ alias: 'n', fn: 'count' }],
      }),
    /select/,
  );
});

test('group key masking uses the group representative row', () => {
  const snap = createPolicySnapshot({
    rowFilter: { op: 'eq', field: 'dept', value: 'eng' },
    masks: [{ field: 'dept', when: { op: 'eq', field: 'clearance', value: 'low' }, replacement: '<redacted>' }],
  });
  const out = runQuery(table, snap, {
    groupBy: ['dept'],
    aggregates: [{ alias: 'n', fn: 'count' }],
  });
  assert.deepEqual(out, [{ dept: 'eng', n: 3, sourceRowIds: ['u1', 'u2', 'u4'] }]);
  const snap2 = createPolicySnapshot({
    rowFilter: { op: 'eq', field: 'dept', value: 'eng' },
    masks: [{ field: 'dept', when: { op: 'eq', field: 'clearance', value: 'high' }, replacement: '<redacted>' }],
  });
  const out2 = runQuery(table, snap2, {
    groupBy: ['dept'],
    aggregates: [{ alias: 'n', fn: 'count' }],
  });
  assert.deepEqual(out2, [{ dept: '<redacted>', n: 3, sourceRowIds: ['u1', 'u2', 'u4'] }]);
});

test('aggregates skip missing and null field values', () => {
  const t = createTable('t', [
    { id: 'a', g: 'x', v: 10 },
    { id: 'b', g: 'x' },
    { id: 'c', g: 'x', v: null },
    { id: 'd', g: 'x', v: 4 },
  ]);
  const snap = createPolicySnapshot({ rowFilter: { op: 'lit', value: true } });
  const out = runQuery(t, snap, {
    groupBy: ['g'],
    aggregates: [
      { alias: 'n', fn: 'count' },
      { alias: 'nv', fn: 'count', field: 'v' },
      { alias: 's', fn: 'sum', field: 'v' },
      { alias: 'm', fn: 'min', field: 'v' },
    ],
  });
  assert.deepEqual(out, [{ g: 'x', n: 4, nv: 2, s: 14, m: 4, sourceRowIds: ['a', 'b', 'c', 'd'] }]);
});

test('empty aggregate over no usable values yields null, count yields 0', () => {
  const t = createTable('t', [{ id: 'a', g: 'x' }]);
  const snap = createPolicySnapshot({ rowFilter: { op: 'lit', value: true } });
  const out = runQuery(t, snap, {
    groupBy: ['g'],
    aggregates: [
      { alias: 's', fn: 'sum', field: 'v' },
      { alias: 'av', fn: 'avg', field: 'v' },
      { alias: 'mx', fn: 'max', field: 'v' },
      { alias: 'c', fn: 'count', field: 'v' },
    ],
  });
  assert.deepEqual(out, [{ g: 'x', s: null, av: null, mx: null, c: 0, sourceRowIds: ['a'] }]);
});

test('table validation: finite array, unique string/number ids', () => {
  assert.throws(() => createTable('bad', [{ id: 'a' }, { id: 'a' }]), /duplicate/);
  assert.throws(() => createTable('bad', [{ name: 'x' }]), /id/);
  assert.throws(() => createTable('bad', 'nope' as never), /finite array/);
});
