'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runQuery } = require('../src/engine');

const data = {
  a: [
    { id: 1, k: 1, v: 10 },
    { id: 2, k: null, v: 20 },
    { id: 3, k: 2, v: null },
    { id: 4, k: 2, v: 40 },
  ],
  b: [
    { k: 1, w: 'x' },
    { k: null, w: 'y' },
    { k: 3, w: 'z' },
  ],
};

test('NULL join keys never match', () => {
  const r = runQuery('SELECT a.id, b.w FROM a JOIN b ON a.k = b.k', data);
  assert.deepEqual(r.rows, [{ id: 1, w: 'x' }]);
  assert.equal(r.unknown.length, 0);
});

test('aggregates ignore NULLs; COUNT(*) counts rows', () => {
  const r = runQuery(
    'SELECT a.k, COUNT(*) AS c, COUNT(a.v) AS cv, SUM(a.v) AS s, AVG(a.v) AS av, MIN(a.v) AS mn, MAX(a.v) AS mx FROM a GROUP BY a.k',
    data
  );
  const byK = new Map(r.rows.map((row) => [String(row.k), row]));
  assert.equal(byK.get('1').c, 1);
  assert.equal(byK.get('1').s, 10);
  assert.equal(byK.get('null').c, 1);
  assert.equal(byK.get('null').cv, 1);
  assert.equal(byK.get('2').c, 2);
  assert.equal(byK.get('2').cv, 1); // one NULL v ignored
  assert.equal(byK.get('2').s, 40);
  assert.equal(byK.get('2').av, 40);
  assert.equal(byK.get('2').mn, 40);
  assert.equal(byK.get('2').mx, 40);
});

test('aggregate over empty input: COUNT(*)=0, SUM=NULL', () => {
  const r = runQuery('SELECT COUNT(*) AS c, SUM(a.v) AS s FROM a WHERE a.id > 100', data);
  assert.deepEqual(r.rows, [{ c: 0, s: null }]);
});

test('HAVING three-valued output: unknown groups are surfaced, not dropped silently', () => {
  const d = {
    t: [
      { g: 'ok', v: 10 },
      { g: 'ok', v: 20 },
      { g: 'unk', v: null },
      { g: 'no', v: 1 },
    ],
  };
  const r = runQuery('SELECT t.g, SUM(t.v) AS s FROM t GROUP BY t.g HAVING SUM(t.v) > 5', d);
  assert.deepEqual(r.rows, [{ g: 'ok', s: 30 }]);
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0]['t.g'], 'unk');
  assert.equal(r.falseCount, 1); // 'no' group evaluated false
});

test('duplicates are preserved through joins (bag semantics)', () => {
  const d = {
    l: [{ k: 1 }, { k: 1 }, { k: 2 }],
    r: [{ k: 1 }, { k: 1 }, { k: 1 }],
  };
  const res = runQuery('SELECT COUNT(*) AS c FROM l JOIN r ON l.k = r.k', d);
  assert.deepEqual(res.rows, [{ c: 6 }]); // 2*3 for k=1, none for k=2
});

test('E_TYPE surfaced through query execution', () => {
  assert.throws(() => runQuery("SELECT a.id FROM a WHERE a.k = 'str'", data), (e) => e.code === 'E_TYPE');
  assert.throws(
    () => runQuery('SELECT SUM(b.w) AS s FROM b', data),
    (e) => e.code === 'E_TYPE'
  );
  assert.throws(() => runQuery('SELECT a.id FROM a WHERE a.v', data), (e) => e.code === 'E_TYPE');
});

test('hash join and nested loop agree on NULL-heavy data', () => {
  const r = runQuery('SELECT COUNT(*) AS c FROM a JOIN b ON a.k = b.k', data);
  assert.deepEqual(r.rows, [{ c: 1 }]);
  assert.ok(r.certificate.equal);
});
