'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rel = require('../src/relalg');

test('select: NULL predicate result (UNKNOWN) filters the row out', () => {
  const rows = [{ a: 1 }, { a: null }, { a: 3 }];
  const out = rel.select(rows, (r) => rel.sqlEq(r.a, 1));
  assert.deepEqual(out, [{ a: 1 }]);
});

test('three-valued logic: and/or/not truth table', () => {
  assert.equal(rel.sqlAnd(true, null), null);
  assert.equal(rel.sqlAnd(false, null), false);
  assert.equal(rel.sqlOr(false, null), null);
  assert.equal(rel.sqlOr(true, null), true);
  assert.equal(rel.sqlNot(null), null);
  assert.equal(rel.sqlEq(null, null), null); // NULL = NULL is UNKNOWN
});

test('project: missing keys become NULL', () => {
  const out = rel.project([{ a: 1 }], ['a', 'b']);
  assert.deepEqual(out, [{ a: 1, b: null }]);
});

test('join: NULL keys never match, non-null keys match', () => {
  const left = [{ k: 1, v: 'l1' }, { k: null, v: 'ln' }, { k: 2, v: 'l2' }];
  const right = [{ k: 1, w: 'r1' }, { k: null, w: 'rn' }];
  const out = rel.join(left, right, ['k']);
  assert.deepEqual(out, [{ k: 1, v: 'l1', w: 'r1' }]);
});

test('union: dedups rows, NULLs are equal for set semantics', () => {
  const a = [{ x: 1 }, { x: null }];
  const b = [{ x: null }, { x: 2 }];
  assert.deepEqual(rel.union(a, b), [{ x: 1 }, { x: null }, { x: 2 }]);
});

test('except: removes rows present in other side, NULL matches NULL', () => {
  const a = [{ x: 1 }, { x: null }, { x: 3 }];
  const b = [{ x: null }];
  assert.deepEqual(rel.except(a, b), [{ x: 1 }, { x: 3 }]);
});

test('sum ignores NULL; all-NULL group sums to NULL, not 0', () => {
  assert.equal(rel.sum([{ v: 1 }, { v: null }, { v: 2 }], 'v'), 3);
  assert.equal(rel.sum([{ v: null }, { v: null }], 'v'), null);
  assert.equal(rel.sum([], 'v'), null);
});

test('count(*) counts rows, count(col) counts non-NULL only', () => {
  const rows = [{ v: 1 }, { v: null }];
  assert.equal(rel.count(rows, null), 2);
  assert.equal(rel.count(rows, 'v'), 1);
});

test('avg ignores NULL and is NULL for all-NULL group', () => {
  assert.equal(rel.avg([{ v: 2 }, { v: null }, { v: 4 }], 'v'), 3);
  assert.equal(rel.avg([{ v: null }], 'v'), null);
});

test('aggregate: grouped sums keep all-NULL group as NULL', () => {
  const rows = [
    { g: 'a', v: 1 },
    { g: 'a', v: null },
    { g: 'b', v: null },
  ];
  const out = rel.aggregate(rows, ['g'], [{ fn: 'sum', col: 'v', as: 's' }]);
  const byG = Object.fromEntries(out.map((r) => [r.g, r.s]));
  assert.equal(byG.a, 1);
  assert.equal(byG.b, null);
});
