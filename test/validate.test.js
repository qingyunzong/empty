import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuery, QueryError } from '../src/query.js';

const catalog = {
  tables: {
    users: {
      rowCount: 100,
      pages: 10,
      columns: { id: {}, name: {}, dept: {} },
    },
  },
};

test('unknown column in filter is rejected', () => {
  assert.throws(
    () => validateQuery({ scan: 'users', filter: [{ col: 'users.nope', op: '=', value: 1 }] }, catalog),
    (e) => e instanceof QueryError && /unknown column: users\.nope/.test(e.message),
  );
});

test('unknown column in group by key is rejected', () => {
  assert.throws(
    () => validateQuery({ scan: 'users', groupBy: { keys: ['users.nope'], aggregates: [] } }, catalog),
    /unknown column: users\.nope/,
  );
});

test('unknown table is rejected', () => {
  assert.throws(() => validateQuery({ scan: 'ghost' }, catalog), /unknown table: ghost/);
  assert.throws(
    () => validateQuery({ scan: 'users', joins: [{ type: 'inner', table: 'ghost', on: [['users.id', 'users.id']] }] }, catalog),
    /unknown table: ghost/,
  );
});

test('nested aggregate is rejected', () => {
  assert.throws(
    () => validateQuery(
      { scan: 'users', groupBy: { keys: ['users.dept'], aggregates: [{ fn: 'sum', col: { fn: 'avg', col: 'users.id' } }] } },
      catalog,
    ),
    /nested aggregate is not allowed/,
  );
});

test('aggregate value in filter is rejected', () => {
  assert.throws(
    () => validateQuery({ scan: 'users', filter: [{ col: 'users.id', op: '=', value: { fn: 'sum', col: 'users.id' } }] }, catalog),
    /filter value must be a non-null scalar/,
  );
});

test('unknown aggregate function and bad star usage are rejected', () => {
  assert.throws(
    () => validateQuery({ scan: 'users', groupBy: { keys: [], aggregates: [{ fn: 'median', col: 'users.id' }] } }, catalog),
    /unknown aggregate function: median/,
  );
  assert.throws(
    () => validateQuery({ scan: 'users', groupBy: { keys: [], aggregates: [{ fn: 'sum', col: '*' }] } }, catalog),
    /does not accept \*/,
  );
});

test('valid query normalizes operators and defaults', () => {
  const q = validateQuery(
    { scan: 'users', filter: [{ col: 'users.id', op: 'gte', value: 2 }], groupBy: { keys: ['users.dept'], aggregates: [{ fn: 'count', col: '*' }] } },
    catalog,
  );
  assert.equal(q.filter[0].op, '>=');
  assert.equal(q.groupBy.aggregates[0].as, 'count_star');
});
