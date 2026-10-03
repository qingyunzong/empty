import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { run } from '../src/cli.js';
import { execute, explain, updateStats } from '../src/engine.js';
import { loadCatalog } from '../src/catalog.js';
import { enumeratePlans } from '../src/optimizer.js';
import { SCENARIO1_QUERY, makeDb, scenario1Db } from './helpers.js';

test('scenario 1: stats change crosses join-order threshold, plan changes but results are identical', () => {
  const db = scenario1Db();
  const before = explain(db, SCENARIO1_QUERY);
  const execBefore = execute(db, SCENARIO1_QUERY);
  // old plan joins users with orders first
  assert.match(before.planString, /join_inner\(users\.id=orders\.user_id,scan\(orders\),scan\(users\)\)/);

  const report = updateStats(db, 'orders', { columns: { id: { distinct: 10000 } } });
  assert.equal(report.invalidated.length, 1);
  const entry = report.invalidated[0];
  assert.equal(entry.planChanged, true);
  assert.equal(entry.hashChanged, false);
  assert.equal(entry.oldPlan, before.planString);
  // new plan joins orders with items first
  assert.match(entry.newPlan, /join_inner\(orders\.id=items\.order_id,scan\(items\),scan\(orders\)\)/);
  assert.ok(entry.newCost < entry.oldCost);

  const execAfter = execute(db, SCENARIO1_QUERY);
  assert.equal(execAfter.hash, execBefore.hash);
  assert.deepEqual(execAfter.rows, execBefore.rows);
  assert.equal(execBefore.rowCount, 5);
});

test('scenario 1b: stats update invalidates only affected cached plans', () => {
  const db = scenario1Db();
  explain(db, SCENARIO1_QUERY);
  explain(db, { from: 'users' });
  const report = updateStats(db, 'orders', { columns: { id: { distinct: 10000 } } });
  assert.equal(report.invalidated.length, 1);
  assert.equal(report.unaffected, 1);
  assert.deepEqual(report.invalidated[0].tables, ['items', 'orders', 'users']);
});

test('scenario 2: left join with predicate on padded column is never rewritten as inner join', () => {
  const db = makeDb({
    users: {
      rowCount: 500,
      columns: { id: { distinct: 500 }, name: {} },
      rows: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 3, name: 'c' },
      ],
    },
    profiles: {
      rowCount: 500,
      columns: { user_id: { distinct: 500 }, city: { selectivity: 0.5 } },
      rows: [
        { user_id: 1, city: 'BJ' },
        { user_id: 2, city: 'SH' },
      ],
    },
  });
  const query = {
    from: 'users',
    joins: [{ type: 'left', table: 'profiles', on: { left: 'users.id', right: 'profiles.user_id' } }],
    where: [{ col: 'profiles.city', op: '=', value: 'BJ' }],
  };
  const catalog = loadCatalog(db);
  const { candidates } = enumeratePlans(catalog, query);
  // every enumerated plan keeps the left join; none converts it to inner
  assert.ok(candidates.length > 0);
  for (const c of candidates) {
    assert.match(c.planString, /join_left\(/);
    assert.doesNotMatch(c.planString, /join_inner\(/);
  }
  // the predicate on the padded column stays above the left join
  const { best } = { best: candidates[0] };
  assert.match(best.planString, /^filter\(profiles\.city="BJ",join_left\(/);
  const out = execute(db, query);
  assert.equal(out.rowCount, 1);
  assert.equal(out.rows[0]['users.name'], 'a');
});

test('scenario 2b: left join result preserves null-padded rows without null-rejecting predicates', () => {
  const db = makeDb({
    users: {
      columns: { id: {}, name: {} },
      rows: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
    },
    profiles: {
      columns: { user_id: {}, city: {} },
      rows: [{ user_id: 1, city: 'BJ' }],
    },
  });
  const out = execute(db, {
    from: 'users',
    joins: [{ type: 'left', table: 'profiles', on: { left: 'users.id', right: 'profiles.user_id' } }],
  });
  assert.equal(out.rowCount, 2);
  const padded = out.rows.find((r) => r['users.id'] === 2);
  assert.equal(padded['profiles.city'], null);
});

test('scenario 3: unknown column and nested aggregates are rejected', () => {
  const db = makeDb({
    t: {
      columns: { id: {}, v: {} },
      rows: [{ id: 1, v: 2 }],
    },
  });
  assert.throws(
    () => explain(db, { from: 't', where: [{ col: 't.nope', op: '=', value: 1 }] }),
    /unknown column: t\.nope/,
  );
  assert.throws(
    () => explain(db, { from: 't', where: [{ col: 'ghost.id', op: '=', value: 1 }] }),
    /unknown column: ghost\.id/,
  );
  assert.throws(
    () =>
      explain(db, {
        from: 't',
        groupBy: {
          keys: ['t.id'],
          aggregates: [
            { fn: 'count', col: '*', as: 'c' },
            { fn: 'sum', col: 'c', as: 's' },
          ],
        },
      }),
    /nested aggregate/,
  );
  assert.throws(
    () =>
      explain(db, {
        from: 't',
        groupBy: {
          keys: ['t.id'],
          aggregates: [{ fn: 'sum', col: { fn: 'count', col: '*' }, as: 's' }],
        },
      }),
    /nested aggregate/,
  );
});

test('scenario 3b: CLI exits non-zero with a JSON error for invalid queries', () => {
  const db = makeDb({
    t: { columns: { id: {} }, rows: [{ id: 1 }] },
  });
  const queryFile = path.join(db, 'bad.json');
  fs.writeFileSync(
    queryFile,
    JSON.stringify({ from: 't', where: [{ col: 't.nope', op: '=', value: 1 }] }),
  );
  const res = run(['explain', '--db', db, '--query', queryFile]);
  assert.equal(res.code, 1);
  assert.match(res.error, /unknown column: t\.nope/);
});
