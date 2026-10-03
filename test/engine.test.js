import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/engine.js';

test('inner join: NULL keys never join, not even NULL = NULL', () => {
  const tables = {
    a: { key: 'id', rows: [
      { id: 'a1', k: 'x' },
      { id: 'a2', k: null },
      { id: 'a3' }, // missing key column behaves as NULL
    ] },
    b: { key: 'id', rows: [
      { id: 'b1', k: 'x', v: 1 },
      { id: 'b2', k: null, v: 2 },
    ] },
  };
  const q = { from: 'a', joins: [{ type: 'inner', table: 'b', on: [['a.k', 'b.k']] }], select: ['a.id', 'b.v'] };
  const { outputs } = execute(q, tables);
  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0].values, { 'a.id': 'a1', 'b.v': 1 });
  assert.deepEqual(outputs[0].contributions.map((c) => `${c.table}:${c.key}`).sort(), ['a:a1', 'b:b1']);
});

test('semi-join dedups right-side matches but keeps them in lineage', () => {
  const tables = {
    o: { key: 'id', rows: [
      { id: 'o1', c: 'c1' },
      { id: 'o2', c: 'c2' },
      { id: 'o3', c: 'c3' },
    ] },
    t: { key: 'id', rows: [
      { id: 't1', cid: 'c1' },
      { id: 't2', cid: 'c1' }, // duplicate match for o1
      { id: 't3', cid: 'c3' },
    ] },
  };
  const q = { from: 'o', joins: [{ type: 'semi', table: 't', on: [['o.c', 't.cid']] }], select: ['o.id'] };
  const { outputs } = execute(q, tables);
  assert.equal(outputs.length, 2); // o1 kept once despite two matches; o2 dropped
  const o1 = outputs.find((o) => o.values['o.id'] === 'o1');
  const o3 = outputs.find((o) => o.values['o.id'] === 'o3');
  assert.deepEqual(o1.contributions.map((c) => `${c.table}:${c.key}`).sort(), ['o:o1', 't:t1', 't:t2']);
  assert.deepEqual(o3.contributions.map((c) => `${c.table}:${c.key}`).sort(), ['o:o3', 't:t3']);
});

test('unknown predicate -> partial provenance, row is neither dropped nor treated as unsatisfied', () => {
  const tables = {
    m: { key: 'id', rows: [
      { id: 'm1', x: 10 },
      { id: 'm2', x: 1 },
      { id: 'm3', x: null },
    ] },
  };
  const q = { from: 'm', where: [{ col: 'm.x', op: '>', value: 5 }], select: ['m.id'] };
  const { outputs } = execute(q, tables);
  assert.equal(outputs.length, 2); // m2 (false) dropped; m3 (unknown) kept
  const byId = Object.fromEntries(outputs.map((o) => [o.values['m.id'], o]));
  assert.equal(byId.m1.provenance, 'complete');
  assert.equal(byId.m3.provenance, 'partial');
  assert.equal(byId.m2, undefined);
});

test('aggregate contribution set matches a 150-row enumeration exactly', () => {
  const rows = [];
  for (let i = 1; i <= 150; i += 1) rows.push({ id: `m${i}`, station: 'A', v: i });
  rows.push({ id: 'x1', station: 'B', v: 1000 }); // other group must not leak in
  const tables = { m: { key: 'id', rows } };
  const q = {
    from: 'm',
    groupby: ['m.station'],
    aggregates: [{ fn: 'sum', col: 'm.v', as: 'total' }, { fn: 'count', col: '*', as: 'n' }],
    select: ['m.station', 'total', 'n'],
  };
  const { outputs } = execute(q, tables);
  const groupA = outputs.find((o) => o.values['m.station'] === 'A');
  assert.equal(groupA.values.total, (150 * 151) / 2);
  assert.equal(groupA.values.n, 150);
  const expected = [];
  for (let i = 1; i <= 150; i += 1) expected.push(`m:m${i}`);
  assert.deepEqual(groupA.contributions.map((c) => `${c.table}:${c.key}`).sort(), expected.sort());
  assert.equal(groupA.minimal.length, 150); // sum needs every row
  assert.equal(groupA.provenance, 'complete');
});

test('tied minimal contribution sets list ALL tied rows', () => {
  const tables = {
    r: { key: 'id', rows: [
      { id: 'r1', g: 'A', v: 3 },
      { id: 'r2', g: 'A', v: 3 }, // tie at the minimum
      { id: 'r3', g: 'A', v: 5 },
    ] },
  };
  const q = {
    from: 'r',
    groupby: ['r.g'],
    aggregates: [{ fn: 'min', col: 'r.v', as: 'lo' }],
    select: ['r.g', 'lo'],
  };
  const { outputs } = execute(q, tables);
  assert.equal(outputs.length, 1);
  const out = outputs[0];
  assert.equal(out.values.lo, 3);
  assert.deepEqual(out.minimal.map((c) => c.key).sort(), ['r1', 'r2']); // both ties, r3 excluded
  assert.equal(out.contributions.length, 3); // full why-provenance keeps the whole group
});

test('partial provenance propagates through join into the aggregate group', () => {
  const tables = {
    a: { key: 'id', rows: [
      { id: 'a1', k: 'x', flag: 1 },
      { id: 'a2', k: 'x', flag: null },
    ] },
    b: { key: 'id', rows: [{ id: 'b1', k: 'x', amt: 4 }] },
  };
  const q = {
    from: 'a',
    joins: [{ type: 'inner', table: 'b', on: [['a.k', 'b.k']] }],
    where: [{ col: 'a.flag', op: '=', value: 1 }],
    groupby: ['a.k'],
    aggregates: [{ fn: 'sum', col: 'b.amt', as: 'total' }],
    select: ['a.k', 'total'],
  };
  const { outputs } = execute(q, tables);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].provenance, 'partial'); // a2's predicate is unknown
  assert.equal(outputs[0].values.total, 8); // unknown rows still contribute
});
