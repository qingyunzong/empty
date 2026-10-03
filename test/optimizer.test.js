import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCatalog } from '../src/catalog.js';
import { enumeratePlans, optimize } from '../src/optimizer.js';
import { SCENARIO1_QUERY, makeDb, scenario1Db } from './helpers.js';

test('enumerates all binary join orders for 3 inner-joined tables', () => {
  const db = scenario1Db();
  const catalog = loadCatalog(db);
  const { candidates } = enumeratePlans(catalog, SCENARIO1_QUERY);
  // 3! orders x 2 tree shapes = 12 skeletons
  assert.equal(candidates.length, 12);
});

test('rejects queries with more than 5 tables', () => {
  const tables = {};
  const joins = [];
  for (const name of ['t0', 't1', 't2', 't3', 't4', 't5']) {
    tables[name] = { columns: { id: {} }, rows: [{ id: 1 }] };
    if (name !== 't0') {
      joins.push({ type: 'inner', table: name, on: { left: 't0.id', right: `${name}.id` } });
    }
  }
  const db = makeDb(tables);
  const catalog = loadCatalog(db);
  assert.throws(() => optimize(catalog, { from: 't0', joins }), /too many tables/);
});

test('index scan chosen when selectivity is low, full scan when high', () => {
  const db = makeDb({
    t: {
      rowCount: 10000,
      columns: { id: { selectivity: 0.001 }, v: {} },
      indexes: ['id'],
      rows: [{ id: 1, v: 'a' }],
    },
  });
  const catalog = loadCatalog(db);
  const query = { from: 't', where: [{ col: 't.id', op: '=', value: 7 }] };
  const low = optimize(catalog, query);
  assert.match(low.best.planString, /^idxscan/);
  // full scan = 100 pages; idxscan = 1 + ceil(10000*0.001) = 11
  assert.equal(low.best.cost, 11);

  catalog.tables.t.columns.id.selectivity = 0.9;
  const high = optimize(catalog, query);
  assert.match(high.best.planString, /^filter/);
  assert.equal(high.best.cost, 100);
});

test('predicates are pushed down to reduce join intermediate rows', () => {
  const db = makeDb({
    a: {
      rowCount: 1000,
      columns: { id: { distinct: 10 }, x: { selectivity: 0.01 } },
      rows: [{ id: 1, x: 1 }],
    },
    b: {
      rowCount: 1000,
      columns: { aid: { distinct: 10 }, y: {} },
      rows: [{ aid: 1, y: 1 }],
    },
  });
  const catalog = loadCatalog(db);
  const { best, candidateCount } = optimize(catalog, {
    from: 'a',
    joins: [{ type: 'inner', table: 'b', on: { left: 'a.id', right: 'b.aid' } }],
    where: [{ col: 'a.x', op: '=', value: 5 }],
  });
  // filter sits directly above scan(a), not above the join
  assert.match(best.planString, /filter\(a\.x=5,scan\(a\)\)/);
  // pushdown positions were enumerated: more candidates than the 2 join orders
  assert.ok(candidateCount > 2);
});

test('cost ties are broken by lexicographic plan string', () => {
  const db = makeDb({
    a: { rowCount: 100, columns: { id: { distinct: 10 } }, rows: [{ id: 1 }] },
    b: { rowCount: 100, columns: { aid: { distinct: 10 } }, rows: [{ aid: 1 }] },
  });
  const catalog = loadCatalog(db);
  const { candidates } = enumeratePlans(catalog, {
    from: 'a',
    joins: [{ type: 'inner', table: 'b', on: { left: 'a.id', right: 'b.aid' } }],
  });
  assert.equal(candidates[0].cost, candidates[1].cost);
  const strings = candidates.map((c) => c.planString);
  const sorted = [...strings].sort();
  assert.equal(candidates[0].planString, sorted[0]);
});
