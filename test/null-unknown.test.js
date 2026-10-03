import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery } from './helpers.js';

const tables = {
  users: {
    columns: ['id', 'name', 'age'],
    rows: [
      { id: 1, name: 'ann', age: 30 },
      { id: 2, name: 'bob', age: null },
      { id: 3, name: 'cid', age: 40 },
    ],
  },
  orders: {
    columns: ['id', 'uid', 'amount'],
    rows: [
      { id: 10, uid: 1, amount: 100 },
      { id: 11, uid: 1, amount: null },
      { id: 12, uid: null, amount: 50 },
      { id: 13, uid: 99, amount: 70 },
    ],
  },
};

// Acceptance 2: NULL / unknown boundary behavior.
test('NULL join keys never join (inner join, both hash and nested)', () => {
  const { direct, physicalResults } = runQuery(
    'SELECT u.name, o.id FROM users u JOIN orders o ON o.uid = u.id', tables);
  // only order 10 and 11 match (uid=1); uid NULL and uid 99 do not join
  assert.equal(direct.rows.length, 2);
  assert.deepEqual(direct.rows.map((r) => r.id).sort(), [10, 11]);
  for (const res of physicalResults) assert.equal(res.rows.length, 2);
});

test('aggregates ignore NULLs; all-NULL input yields NULL except COUNT', () => {
  const { direct } = runQuery(
    `SELECT COUNT(o.id) AS c_id, COUNT(o.amount) AS c_amt, COUNT(*) AS c_all,
            SUM(o.amount) AS s, AVG(o.amount) AS a, MIN(o.amount) AS lo, MAX(o.amount) AS hi
     FROM orders o`, tables);
  assert.equal(direct.rows.length, 1);
  const r = direct.rows[0];
  assert.equal(r.c_id, 4);
  assert.equal(r.c_amt, 3);
  assert.equal(r.c_all, 4);
  assert.equal(r.s, 220);
  assert.equal(r.a, 220 / 3);
  assert.equal(r.lo, 50);
  assert.equal(r.hi, 100);
});

test('SUM/AVG/MIN/MAX over all-NULL group yield NULL, COUNT yields 0', () => {
  const t = {
    t: { columns: ['g', 'v'], rows: [{ g: 'x', v: null }, { g: 'x', v: null }] },
  };
  const { direct } = runQuery(
    'SELECT t.g, SUM(t.v) AS s, AVG(t.v) AS a, MIN(t.v) AS lo, MAX(t.v) AS hi, COUNT(t.v) AS c, COUNT(*) AS ca FROM t GROUP BY t.g', t);
  assert.deepEqual(direct.rows, [{ g: 'x', s: null, a: null, lo: null, hi: null, c: 0, ca: 2 }]);
});

test('HAVING three-valued output: unknown groups are reported, never silently dropped', () => {
  // AVG(u.age) > 35 is UNKNOWN for bob's group (all NULL ages)
  const { direct, physicalResults } = runQuery(
    'SELECT u.name, AVG(u.age) AS avg_age FROM users u GROUP BY u.name HAVING AVG(u.age) > 35', tables);
  assert.deepEqual(direct.rows, [{ name: 'cid', avg_age: 40 }]);
  assert.equal(direct.unknown.length, 1, 'unknown group must be reported');
  assert.equal(direct.unknown[0].name, 'bob');
  assert.equal(direct.unknown[0].avg_age, null);
  for (const res of physicalResults) {
    assert.equal(res.unknown.length, 1, 'physical plans must also report unknown rows');
    assert.equal(res.unknown[0].name, 'bob');
  }
});

test('WHERE with UNKNOWN drops the row (standard SQL), IS NULL finds NULLs', () => {
  const { direct: d1 } = runQuery('SELECT u.id FROM users u WHERE u.age > 25', tables);
  assert.deepEqual(d1.rows.map((r) => r.id).sort(), [1, 3]); // bob: UNKNOWN -> dropped
  const { direct: d2 } = runQuery('SELECT u.id FROM users u WHERE u.age IS NULL', tables);
  assert.deepEqual(d2.rows.map((r) => r.id), [2]);
  const { direct: d3 } = runQuery('SELECT u.id FROM users u WHERE u.age IS NOT NULL', tables);
  assert.deepEqual(d3.rows.map((r) => r.id).sort(), [1, 3]);
});

test('NOT over UNKNOWN stays UNKNOWN in WHERE', () => {
  const { direct } = runQuery('SELECT u.id FROM users u WHERE NOT (u.age > 25)', tables);
  assert.deepEqual(direct.rows.map((r) => r.id), []); // 30>25 true->false, 40>25 true->false, NULL->unknown->dropped
});
