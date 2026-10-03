import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  select, project, join, union, except, groupBy,
  sumAgg, countAgg, avgAgg, cmp3,
} from '../src/relalg.js';

test('cmp3: NULL comparison yields UNKNOWN', () => {
  assert.equal(cmp3(null, 1), null);
  assert.equal(cmp3(1, null), null);
  assert.equal(cmp3(null, null), null);
  assert.equal(cmp3(1, 1), true);
  assert.equal(cmp3(1, 2), false);
});

test('select: NULL predicate rows are filtered out', () => {
  const rows = [{ a: 1 }, { a: null }, { a: 3 }];
  const out = select(rows, (r) => (r.a === null ? null : r.a > 1 ? true : false));
  assert.deepEqual(out, [{ a: 3 }]);
});

test('project: keeps NULLs and selected fields', () => {
  const rows = [{ a: 1, b: null, c: 9 }];
  assert.deepEqual(project(rows, ['a', 'b']), [{ a: 1, b: null }]);
});

test('join: NULL keys never match', () => {
  const left = [{ id: 1, v: 'a' }, { id: null, v: 'b' }];
  const right = [{ id: 1, w: 'x' }, { id: null, w: 'y' }];
  assert.deepEqual(join(left, right, ['id']), [{ id: 1, v: 'a', w: 'x' }]);
});

test('union/except: set semantics with dedup', () => {
  const a = [{ x: 1 }, { x: 2 }, { x: 2 }, { x: null }];
  const b = [{ x: 2 }, { x: 3 }];
  assert.deepEqual(union(a, b), [{ x: 1 }, { x: 2 }, { x: null }, { x: 3 }]);
  assert.deepEqual(except(a, b), [{ x: 1 }, { x: null }]);
  assert.deepEqual(except(b, a), [{ x: 3 }]);
});

test('aggregates: NULL ignored, all-NULL sum is NULL not 0', () => {
  assert.equal(sumAgg([1, null, 2]), 3);
  assert.equal(sumAgg([null, null]), null);
  assert.equal(sumAgg([]), null);
  assert.equal(countAgg([1, null, 2]), 2);
  assert.equal(countAgg([null]), 0);
  assert.equal(avgAgg([2, null, 4]), 3);
  assert.equal(avgAgg([null, null]), null);
});

test('groupBy: NULL keys form one group; all-NULL group sum is NULL', () => {
  const rows = [
    { g: 'a', v: 1 },
    { g: 'a', v: null },
    { g: null, v: null },
    { g: null, v: null },
    { g: 'b', v: 5 },
  ];
  const out = groupBy(rows, ['g']).agg({
    s: { op: 'sum', field: 'v' },
    c: { op: 'count', field: 'v' },
    n: { op: 'count', field: '*' },
    m: { op: 'avg', field: 'v' },
  });
  const byG = new Map(out.map((r) => [String(r.g), r]));
  assert.equal(byG.get('a').s, 1);
  assert.equal(byG.get('null').s, null); // all-NULL group: NULL, not 0
  assert.equal(byG.get('null').c, 0);
  assert.equal(byG.get('null').n, 2);
  assert.equal(byG.get('null').m, null);
  assert.equal(byG.get('b').s, 5);
});

test('groupBy: empty input yields no groups', () => {
  assert.deepEqual(groupBy([], ['g']).agg({ s: { op: 'sum', field: 'v' } }), []);
});
