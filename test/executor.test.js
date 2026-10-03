import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../src/engine.js';
import { makeDb } from './helpers.js';

test('inner join matches non-null values only', () => {
  const db = makeDb({
    a: {
      columns: { id: {}, v: {} },
      rows: [
        { id: 1, v: 'x' },
        { id: null, v: 'n' },
      ],
    },
    b: {
      columns: { aid: {}, w: {} },
      rows: [
        { aid: 1, w: 'p' },
        { aid: null, w: 'q' },
      ],
    },
  });
  const out = execute(db, {
    from: 'a',
    joins: [{ type: 'inner', table: 'b', on: { left: 'a.id', right: 'b.aid' } }],
  });
  assert.equal(out.rowCount, 1);
  assert.equal(out.rows[0]['a.v'], 'x');
  assert.equal(out.rows[0]['b.w'], 'p');
});

test('left join pads unmatched rows with nulls', () => {
  const db = makeDb({
    a: {
      columns: { id: {}, v: {} },
      rows: [
        { id: 1, v: 'x' },
        { id: 2, v: 'y' },
      ],
    },
    b: {
      columns: { aid: {}, w: {} },
      rows: [{ aid: 1, w: 'p' }],
    },
  });
  const out = execute(db, {
    from: 'a',
    joins: [{ type: 'left', table: 'b', on: { left: 'a.id', right: 'b.aid' } }],
  });
  assert.equal(out.rowCount, 2);
  const padded = out.rows.find((r) => r['a.id'] === 2);
  assert.equal(padded['b.aid'], null);
  assert.equal(padded['b.w'], null);
});

test('group by treats null as its own group', () => {
  const db = makeDb({
    t: {
      columns: { g: {}, v: {} },
      rows: [
        { g: null, v: 1 },
        { g: null, v: 2 },
        { g: 'null', v: 100 },
        { g: 'a', v: 5 },
      ],
    },
  });
  const out = execute(db, {
    from: 't',
    groupBy: {
      keys: ['t.g'],
      aggregates: [
        { fn: 'count', col: '*', as: 'cnt' },
        { fn: 'sum', col: 't.v', as: 'total' },
      ],
    },
  });
  assert.equal(out.rowCount, 3);
  const nullGroup = out.rows.find((r) => r['t.g'] === null);
  assert.equal(nullGroup.cnt, 2);
  assert.equal(nullGroup.total, 3);
  const stringNullGroup = out.rows.find((r) => r['t.g'] === 'null');
  assert.equal(stringNullGroup.cnt, 1);
});

test('aggregates ignore nulls; count(col) counts non-null', () => {
  const db = makeDb({
    t: {
      columns: { g: {}, v: {} },
      rows: [
        { g: 'a', v: 1 },
        { g: 'a', v: null },
        { g: 'a', v: 3 },
      ],
    },
  });
  const out = execute(db, {
    from: 't',
    groupBy: {
      keys: ['t.g'],
      aggregates: [
        { fn: 'count', col: '*', as: 'c_all' },
        { fn: 'count', col: 't.v', as: 'c_v' },
        { fn: 'sum', col: 't.v', as: 's' },
        { fn: 'avg', col: 't.v', as: 'av' },
        { fn: 'min', col: 't.v', as: 'mn' },
        { fn: 'max', col: 't.v', as: 'mx' },
      ],
    },
  });
  const row = out.rows[0];
  assert.equal(row.c_all, 3);
  assert.equal(row.c_v, 2);
  assert.equal(row.s, 4);
  assert.equal(row.av, 2);
  assert.equal(row.mn, 1);
  assert.equal(row.mx, 3);
});

test('filter predicates never match null values', () => {
  const db = makeDb({
    t: {
      columns: { v: {} },
      rows: [{ v: 1 }, { v: null }, { v: 3 }],
    },
  });
  const out = execute(db, { from: 't', where: [{ col: 't.v', op: '!=', value: 1 }] });
  assert.equal(out.rowCount, 1);
  assert.equal(out.rows[0]['t.v'], 3);
});
