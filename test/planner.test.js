import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuery } from '../src/query.js';
import { optimize, costOf } from '../src/planner.js';

const plan = (query, catalog) => optimize(validateQuery(query, catalog), catalog);

test('cost model: cost = scanned pages + join intermediate rows', () => {
  const catalog = {
    tables: {
      a: { rowCount: 100, pages: 10, columns: { id: {} } },
      b: { rowCount: 200, pages: 20, columns: { id: {}, a_id: {} } },
    },
    joinSelectivity: { 'a.id=b.a_id': 0.01 },
  };
  const best = plan(
    { scan: 'a', joins: [{ type: 'inner', table: 'b', on: [['a.id', 'b.a_id']] }] },
    catalog,
  );
  // pages 10 + 20 = 30, join rows 100*200*0.01 = 200
  assert.equal(best.cost, 230);
  assert.deepEqual(costOf(best.plan, catalog), { cost: 230, pages: 30, joinRows: 200 });
});

test('equal-cost join orders tie-break to lexicographically first plan string', () => {
  const catalog = {
    tables: {
      a: { rowCount: 100, pages: 10, columns: { id: {} } },
      b: { rowCount: 200, pages: 20, columns: { id: {}, a_id: {} } },
    },
    joinSelectivity: { 'a.id=b.a_id': 0.01 },
  };
  const best = plan(
    { scan: 'a', joins: [{ type: 'inner', table: 'b', on: [['a.id', 'b.a_id']] }] },
    catalog,
  );
  assert.equal(
    best.planString,
    'InnerJoin(a.id=b.a_id;SeqScan(a);SeqScan(b))',
  );
});

test('index scan is chosen when selective, seq scan when not', () => {
  const mkCatalog = (selectivity, indexPages) => ({
    tables: {
      t: {
        rowCount: 10000,
        pages: 1000,
        columns: { id: {}, k: { selectivity } },
        indexes: [{ name: 't_k_idx', columns: ['k'], selectivity, pages: indexPages }],
      },
    },
  });
  const query = { scan: 't', filter: [{ col: 't.k', op: '=', value: 7 }] };
  const cheap = plan(query, mkCatalog(0.001, 50));
  assert.match(cheap.planString, /^IndexScan\(t@t_k_idx\)\[t\.k=7\]$/);
  assert.equal(cheap.cost, 51); // 50 index pages + 1 heap page, no joins
  const expensive = plan(query, mkCatalog(0.9, 200));
  assert.match(expensive.planString, /^SeqScan\(t\)\[t\.k=7\]$/);
  assert.equal(expensive.cost, 1000);
});

test('predicate pushdown wins over filtering at the top', () => {
  const catalog = {
    tables: {
      a: { rowCount: 1000, pages: 100, columns: { id: {}, k: { selectivity: 0.01 } } },
      b: { rowCount: 1000, pages: 100, columns: { id: {}, a_id: {} } },
    },
    joinSelectivity: { 'a.id=b.a_id': 0.001 },
  };
  const best = plan(
    {
      scan: 'a',
      joins: [{ type: 'inner', table: 'b', on: [['a.id', 'b.a_id']] }],
      filter: [{ col: 'a.k', op: '=', value: 1 }],
    },
    catalog,
  );
  // pushed to the scan of a, not a Filter node above the join
  assert.match(best.planString, /SeqScan\(a\)\[a\.k=1\]/);
  assert.ok(!best.planString.startsWith('Filter('));
});

test('left join right table cannot move to the left of its left-side tables', () => {
  const catalog = {
    tables: {
      u: { rowCount: 10, pages: 1, columns: { id: {} } },
      o: { rowCount: 100000, pages: 5000, columns: { id: {}, uid: {} } },
      p: { rowCount: 5, pages: 1, columns: { uid: {} } },
    },
    joinSelectivity: { 'o.uid=u.id': 0.001, 'p.uid=u.id': 0.001 },
  };
  const best = plan(
    {
      scan: 'u',
      joins: [
        { type: 'inner', table: 'o', on: [['u.id', 'o.uid']] },
        { type: 'left', table: 'p', on: [['u.id', 'p.uid']] },
      ],
    },
    catalog,
  );
  // inner join may reorder freely, but p stays the right child of a LeftJoin
  // whose left side contains both u and o.
  assert.match(best.planString, /LeftJoin\(u\.id=p\.uid;.*;SeqScan\(p\)\)$/);
  assert.ok(best.planString.includes('InnerJoin('));
});

test('more than 5 tables is rejected', () => {
  const tables = {};
  const joins = [];
  for (const name of ['t1', 't2', 't3', 't4', 't5', 't6']) {
    tables[name] = { rowCount: 10, pages: 1, columns: { id: {}, prev: {} } };
  }
  for (let i = 2; i <= 6; i++) {
    joins.push({ type: 'inner', table: `t${i}`, on: [[`t${i - 1}.id`, `t${i}.prev`]] });
  }
  assert.throws(
    () => plan({ scan: 't1', joins }, { tables }),
    /too many tables: 6 > 5/,
  );
});

test('5-table chain join enumerates successfully', () => {
  const tables = {};
  const joins = [];
  const joinSelectivity = {};
  for (const name of ['t1', 't2', 't3', 't4', 't5']) {
    tables[name] = { rowCount: 100, pages: 10, columns: { id: {}, prev: {} } };
  }
  for (let i = 2; i <= 5; i++) {
    joins.push({ type: 'inner', table: `t${i}`, on: [[`t${i - 1}.id`, `t${i}.prev`]] });
    joinSelectivity[`t${i - 1}.id=t${i}.prev`] = 0.01;
  }
  const best = plan({ scan: 't1', joins }, { tables, joinSelectivity });
  assert.ok(best.cost > 0);
  assert.match(best.planString, /InnerJoin/);
});
