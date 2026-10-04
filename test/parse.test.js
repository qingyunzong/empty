'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/sql');

test('parses a full query', () => {
  const ast = parse(
    `SELECT m.station, COUNT(*) AS n, AVG(m.temp) AS a
     FROM measure m JOIN station s ON m.station = s.code
     WHERE m.hum IS NULL OR m.hum > 30
     GROUP BY m.station
     HAVING AVG(m.temp) > 5`
  );
  assert.equal(ast.select.length, 3);
  assert.equal(ast.from.joins.length, 1);
  assert.equal(ast.groupBy.length, 1);
  assert.ok(ast.having);
});

test('operator precedence: NOT binds looser than comparison', () => {
  const ast = parse('SELECT x FROM t WHERE NOT a = 1 AND b < 2');
  assert.equal(ast.where.t, 'bin');
  assert.equal(ast.where.op, 'AND');
  assert.equal(ast.where.l.t, 'not');
  assert.equal(ast.where.l.e.op, '=');
});

test('E_PARSE on malformed input', () => {
  for (const sql of [
    'SELECT FROM t',
    'SELECT 1 FROM',
    "SELECT 'abc FROM t",
    'SELECT x y z FROM t WHERE',
    'SELECT * FROM t WHERE a ==== 1',
    'SELECT * FROM t WHERE a = ',
    'SELECT SUM(*) FROM t',
  ]) {
    assert.throws(() => parse(sql), (e) => e.code === 'E_PARSE', sql);
  }
});

test('E_UNSUPPORTED on out-of-scope constructs', () => {
  for (const sql of [
    'SELECT DISTINCT x FROM t',
    'SELECT * FROM t LEFT JOIN u ON t.x = u.x',
    'SELECT * FROM t CROSS JOIN u',
    'SELECT * FROM t ORDER BY x',
    'SELECT * FROM t LIMIT 5',
    'SELECT * FROM (SELECT 1) t',
    'SELECT * FROM t WHERE x IN (1, 2)',
    'SELECT ABS(x) FROM t',
    'SELECT * FROM t UNION SELECT * FROM u',
  ]) {
    assert.throws(() => parse(sql), (e) => e.code === 'E_UNSUPPORTED', sql);
  }
});
