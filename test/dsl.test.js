'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDir, writeJsonl } = require('./helpers');
const { appendBatch } = require('../src/storage');
const { executeQuery } = require('../src/query');
const { parse } = require('../src/parser');
const { check } = require('../src/checker');
const { QueryError } = require('../src/errors');

const T0 = Date.parse('2026-10-01T00:00:00Z');

function seedDb() {
  const dir = tmpDir('dsl-');
  const records = [
    { ts: T0 + 1000, device: 'pump-01', code: 'TEMP', value: 71.5 },
    { ts: T0 + 2000, device: 'pump-02', code: 'TEMP', value: 66.0 },
    { ts: T0 + 3000, device: 'pump-10', code: 'PRESS', value: 1200 },
    { ts: T0 + 4000, device: 'valve-1', code: 'PRESS', value: 2500 },
    { ts: T0 + 5000, device: 'valve-2', code: 'FLOW', value: 42 },
  ];
  appendBatch(dir, records);
  return dir;
}

test('range query on ts with time literals', () => {
  const dir = seedDb();
  const res = executeQuery(dir, 'where ts >= 2026-10-01T00:00:02Z and ts < 2026-10-01T00:00:05Z');
  assert.deepEqual(res.records.map((r) => r.device), ['pump-02', 'pump-10', 'valve-1']);
});

test('date-only time literal means UTC midnight', () => {
  const dir = seedDb();
  const res = executeQuery(dir, 'where ts >= 2026-10-02');
  assert.equal(res.records.length, 0);
  const res2 = executeQuery(dir, 'where ts >= 2026-10-01');
  assert.equal(res2.records.length, 5);
});

test('device pattern matching with glob', () => {
  const dir = seedDb();
  const res = executeQuery(dir, 'where device matches "pump-*"');
  assert.deepEqual(res.records.map((r) => r.device), ['pump-01', 'pump-02', 'pump-10']);
  const res2 = executeQuery(dir, 'where device matches "valve-?"');
  assert.deepEqual(res2.records.map((r) => r.device), ['valve-1', 'valve-2']);
});

test('numeric units in comparisons', () => {
  const dir = seedDb();
  const res = executeQuery(dir, 'where value > 1k');
  assert.deepEqual(res.records.map((r) => r.device), ['pump-10', 'valve-1']);
  const res2 = executeQuery(dir, 'where value >= 1.5k and value <= 2.5k');
  assert.deepEqual(res2.records.map((r) => r.device), ['valve-1']);
});

test('aggregate query: count, sum, avg, min, max', () => {
  const dir = seedDb();
  const res = executeQuery(
    dir,
    'select count(), sum(value), avg(value), min(value), max(value) where device matches "pump-*"',
  );
  assert.equal(res.kind, 'aggregate');
  assert.equal(res.result['count()'], 3);
  assert.equal(res.result['sum(value)'], 71.5 + 66.0 + 1200);
  assert.ok(Math.abs(res.result['avg(value)'] - (71.5 + 66.0 + 1200) / 3) < 1e-9);
  assert.equal(res.result['min(value)'], 66.0);
  assert.equal(res.result['max(value)'], 1200);
});

test('aggregate over empty match set', () => {
  const dir = seedDb();
  const res = executeQuery(dir, 'select count(), avg(value), min(value) where value > 1G');
  assert.equal(res.result['count()'], 0);
  assert.equal(res.result['avg(value)'], null);
  assert.equal(res.result['min(value)'], null);
});

test('let subqueries with lexical scope and shadowing', () => {
  const dir = seedDb();
  const res = executeQuery(dir, `
    let hot = value > 1k
    let pump = device matches "pump-*"
    where hot and pump
  `);
  assert.deepEqual(res.records.map((r) => r.device), ['pump-10']);
  const shadowed = executeQuery(dir, `
    let x = value > 1k
    let x = value > 2k
    where x
  `);
  assert.deepEqual(shadowed.records.map((r) => r.device), ['valve-1']);
  const nested = executeQuery(dir, `
    let a = value > 100
    let b = a and code == "PRESS"
    where b
  `);
  assert.deepEqual(nested.records.map((r) => r.device), ['pump-10', 'valve-1']);
});

test('and/or/not precedence', () => {
  const dir = seedDb();
  const res = executeQuery(dir, 'where device == "valve-1" or device == "valve-2" and value > 100');
  assert.deepEqual(res.records.map((r) => r.device), ['valve-1']);
  const res2 = executeQuery(dir, 'where not device matches "pump-*" and not code == "FLOW"');
  assert.deepEqual(res2.records.map((r) => r.device), ['valve-1']);
});

test('unknown field is a static error', () => {
  assert.throws(() => check(parse('where nosuchfield > 3')), QueryError);
  assert.throws(() => check(parse('select sum(nosuchfield)')), QueryError);
});

test('type errors are static errors', () => {
  assert.throws(() => check(parse('where ts > 5')), QueryError);
  assert.throws(() => check(parse('where value == "x"')), QueryError);
  assert.throws(() => check(parse('where device matches 5')), QueryError);
  assert.throws(() => check(parse('where value and true')), QueryError);
  assert.throws(() => check(parse('where not value')), QueryError);
  assert.throws(() => check(parse('select sum(device)')), QueryError);
});

test('syntax errors are rejected', () => {
  assert.throws(() => parse('where (value > 1'), QueryError);
  assert.throws(() => parse('let = 3'), QueryError);
  assert.throws(() => parse('where value >'), QueryError);
  assert.throws(() => parse('where value > 10zzz'), QueryError);
  assert.throws(() => parse('where ts > 2026-13-99'), QueryError);
  assert.throws(() => parse('where device == "unterminated'), QueryError);
});
