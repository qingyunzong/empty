import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/engine.js';
import { ProvError, E_KEY } from '../src/errors.js';

const T = (rows, key = 'id') => ({ key, rows });

const empRows = [
  { id: 1, dept: 10, name: 'ada', age: 36 },
  { id: 2, dept: 10, name: 'bob', age: null },
  { id: 3, dept: 99, name: 'cy', age: 41 },
  { id: 4, dept: null, name: 'di', age: 28 },
];
const deptRows = [
  { id: 10, dname: 'sci' },
  { id: 20, dname: 'ops' },
  { id: 30, dname: 'ghost' },
];

function baseTables() {
  return new Map([
    ['emp', T(structuredClone(empRows))],
    ['dept', T(structuredClone(deptRows))],
  ]);
}

test('inner join captures provenance from both sides', () => {
  const out = execute(
    {
      from: 'emp',
      joins: [{ table: 'dept', on: [['emp.dept', 'dept.id']] }],
      select: ['emp.name', 'dept.dname'],
    },
    baseTables(),
  );
  assert.equal(out.length, 2); // cy (dept 99) and di (NULL) do not connect
  const ada = out.find((o) => o.row.name === 'ada');
  assert.deepEqual(ada.provenance.contributors, ['dept:10', 'emp:1']);
  assert.deepEqual(ada.row, { name: 'ada', dname: 'sci' });
});

test('NULL join keys never connect, not even NULL = NULL', () => {
  const tables = new Map([
    ['a', T([{ id: 1, k: null }, { id: 2, k: 5 }])],
    ['b', T([{ id: 1, k: null }, { id: 2, k: 5 }])],
  ]);
  const out = execute(
    { from: 'a', joins: [{ table: 'b', on: [['a.k', 'b.k']] }], select: ['a.id'] },
    tables,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].provenance.contributors, ['a:2', 'b:2']);
});

test('semi join de-duplicates and lists every witness', () => {
  const tables = new Map([
    ['a', T([{ id: 1, k: 7 }, { id: 2, k: 8 }])],
    ['b', T([{ id: 10, k: 7 }, { id: 11, k: 7 }, { id: 12, k: 9 }])],
  ]);
  const out = execute(
    { from: 'a', joins: [{ table: 'b', type: 'semi', on: [['a.k', 'b.k']] }], select: ['a.id'] },
    tables,
  );
  assert.equal(out.length, 1); // a:1 kept once despite two matches
  assert.deepEqual(out[0].provenance.contributors, ['a:1', 'b:10', 'b:11']);
});

test('unknown predicate keeps the row and marks provenance partial', () => {
  const out = execute(
    { from: 'emp', where: [{ col: 'emp.age', op: '>', value: 30 }], select: ['emp.name'] },
    baseTables(),
  );
  const names = out.map((o) => o.row.name).sort();
  assert.deepEqual(names, ['ada', 'bob', 'cy']); // bob kept: unknown is not false
  const bob = out.find((o) => o.row.name === 'bob');
  assert.equal(bob.provenance.partial, true);
  assert.equal(bob.provenance.unknowns.length, 1);
  assert.deepEqual(bob.provenance.unknowns[0].inputs, ['emp:2']);
  const ada = out.find((o) => o.row.name === 'ada');
  assert.equal(ada.provenance.partial, false);
});

test('false predicate drops the row', () => {
  const out = execute(
    { from: 'emp', where: [{ col: 'emp.age', op: '<', value: 30 }], select: ['emp.name'] },
    baseTables(),
  );
  const di = out.find((o) => o.row.name === 'di');
  const bob = out.find((o) => o.row.name === 'bob');
  assert.equal(out.length, 2); // ada (36) false -> dropped; cy (41) false -> dropped
  assert.equal(di.provenance.partial, false);
  assert.equal(bob.provenance.partial, true); // NULL age: unknown, kept as partial
});

test('aggregate contribution set matches a 150-row enumeration', () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, g: 'a', v: i + 1 }));
  const tables = new Map([['m', T(rows)]]);
  const out = execute(
    {
      from: 'm',
      groupBy: ['m.g'],
      aggregates: [
        { fn: 'sum', col: 'm.v', as: 'total' },
        { fn: 'count', as: 'n' },
      ],
    },
    tables,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].row.total, (150 * 151) / 2);
  assert.equal(out[0].row.n, 150);
  const expected = Array.from({ length: 150 }, (_, i) => `m:${i + 1}`).sort();
  assert.deepEqual(out[0].provenance.contributors, expected);
  assert.deepEqual(out[0].provenance.minimal, expected);
});

test('min/max ties list every tied row in the minimal contribution set', () => {
  const rows = [
    { id: 1, g: 'a', v: 5 },
    { id: 2, g: 'a', v: 5 },
    { id: 3, g: 'a', v: 9 },
  ];
  const out = execute(
    { from: 'm', groupBy: ['m.g'], aggregates: [{ fn: 'min', col: 'm.v', as: 'lo' }] },
    new Map([['m', T(rows)]]),
  );
  assert.equal(out[0].row.lo, 5);
  assert.deepEqual(out[0].provenance.minimal, ['m:1', 'm:2']); // both tied rows listed
  assert.deepEqual(out[0].provenance.contributors, ['m:1', 'm:2', 'm:3']);
});

test('avg and count(col) ignore NULL values', () => {
  const rows = [
    { id: 1, g: 'a', v: 10 },
    { id: 2, g: 'a', v: null },
    { id: 3, g: 'a', v: 20 },
  ];
  const out = execute(
    {
      from: 'm',
      groupBy: ['m.g'],
      aggregates: [
        { fn: 'avg', col: 'm.v', as: 'mean' },
        { fn: 'count', col: 'm.v', as: 'nn' },
      ],
    },
    new Map([['m', T(rows)]]),
  );
  assert.equal(out[0].row.mean, 15);
  assert.equal(out[0].row.nn, 2);
});

test('group provenance is partial when any member tuple is partial', () => {
  const rows = [
    { id: 1, g: 'a', v: 10 },
    { id: 2, g: 'a', v: null },
  ];
  const out = execute(
    {
      from: 'm',
      where: [{ col: 'm.v', op: '>', value: 0 }],
      groupBy: ['m.g'],
      aggregates: [{ fn: 'sum', col: 'm.v', as: 'total' }],
    },
    new Map([['m', T(rows)]]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].provenance.partial, true);
  assert.deepEqual(out[0].provenance.contributors, ['m:1', 'm:2']);
});

test('duplicate or missing keys raise E_KEY', () => {
  assert.throws(
    () => execute({ from: 'm', select: ['m.id'] }, new Map([['m', T([{ id: 1 }, { id: 1 }])]])),
    (e) => e instanceof ProvError && e.code === E_KEY,
  );
  assert.throws(
    () => execute({ from: 'm', select: ['m.id'] }, new Map([['m', T([{ id: 1 }, { nope: 2 }])]])),
    (e) => e instanceof ProvError && e.code === E_KEY,
  );
  assert.throws(
    () => execute({ from: 'nope', select: ['m.id'] }, new Map([['m', T([{ id: 1 }])]])),
    (e) => e instanceof ProvError && e.code === E_KEY,
  );
});
