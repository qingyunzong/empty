import test from 'node:test';
import assert from 'node:assert/strict';
import { executePlan, hashRows } from '../src/executor.js';

const catalog = {
  tables: {
    u: { rowCount: 4, pages: 1, columns: { id: {}, dept: {} } },
    p: { rowCount: 3, pages: 1, columns: { uid: {}, city: {} } },
  },
};

const data = {
  u: [
    { id: 1, dept: 'eng' },
    { id: 2, dept: null },
    { id: 3, dept: 'eng' },
    { id: null, dept: 'ops' },
  ],
  p: [
    { uid: 1, city: 'bj' },
    { uid: null, city: 'sh' },
    { uid: 9, city: 'gz' },
  ],
};

const scan = (table) => ({ type: 'scan', table, index: null, predicates: [] });

test('inner join matches only non-null keys', () => {
  const plan = {
    type: 'join', joinType: 'inner', cond: [['u.id', 'p.uid']],
    left: scan('u'), right: scan('p'),
  };
  const rows = executePlan(plan, data, catalog);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['u.id'], 1);
  assert.equal(rows[0]['p.city'], 'bj');
});

test('left join pads unmatched rows with nulls, null keys stay unmatched', () => {
  const plan = {
    type: 'join', joinType: 'left', cond: [['u.id', 'p.uid']],
    left: scan('u'), right: scan('p'),
  };
  const rows = executePlan(plan, data, catalog);
  assert.equal(rows.length, 4);
  const unmatched = rows.filter((r) => r['p.uid'] === null);
  assert.equal(unmatched.length, 3);
  assert.deepEqual(unmatched.map((r) => r['p.city']), [null, null, null]);
});

test('group by treats null as its own group', () => {
  const plan = {
    type: 'groupby',
    keys: ['u.dept'],
    aggregates: [
      { fn: 'count', col: '*', as: 'n' },
      { fn: 'count', col: 'u.id', as: 'n_ids' },
      { fn: 'sum', col: 'u.id', as: 's' },
      { fn: 'avg', col: 'u.id', as: 'a' },
      { fn: 'min', col: 'u.id', as: 'lo' },
      { fn: 'max', col: 'u.id', as: 'hi' },
    ],
    input: scan('u'),
  };
  const rows = executePlan(plan, data, catalog);
  const byDept = new Map(rows.map((r) => [r['u.dept'], r]));
  assert.equal(rows.length, 3); // eng, ops, null-group
  assert.deepEqual(byDept.get(null), {
    'u.dept': null, n: 1, n_ids: 1, s: 2, a: 2, lo: 2, hi: 2,
  });
  assert.deepEqual(byDept.get('eng'), {
    'u.dept': 'eng', n: 2, n_ids: 2, s: 4, a: 2, lo: 1, hi: 3,
  });
  assert.equal(byDept.get('ops').n_ids, 0); // count(col) skips nulls
  assert.equal(byDept.get('ops').s, null); // sum of empty set is null
});

test('filter above left join sees padded nulls (null never passes)', () => {
  const plan = {
    type: 'filter',
    predicates: [{ col: 'p.city', op: '!=', value: 'bj' }],
    input: {
      type: 'join', joinType: 'left', cond: [['u.id', 'p.uid']],
      left: scan('u'), right: scan('p'),
    },
  };
  assert.equal(executePlan(plan, data, catalog).length, 0);
});

test('hashRows is order-independent and key-order-independent', () => {
  const r1 = [{ a: 1, b: 2 }, { a: 3, b: null }];
  const r2 = [{ b: null, a: 3 }, { b: 2, a: 1 }];
  assert.equal(hashRows(r1), hashRows(r2));
  assert.notEqual(hashRows(r1), hashRows([{ a: 1, b: 2 }]));
});
