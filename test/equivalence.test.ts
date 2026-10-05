import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicySnapshot, type MaskRule } from '../src/policy.js';
import { createTable, type Table } from '../src/table.js';
import { verifyAgainstModel } from '../src/verify.js';
import type { Expr, Row } from '../src/expr.js';
import type { AggregateSpec, Query } from '../src/engine.js';

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FIELD_POOL = ['dept', 'level', 'salary', 'active', 'clearance', 'ssn'] as const;

function randomRow(rand: () => number, index: number): Row {
  const row: Record<string, unknown> = { id: `r${index}` };
  const maybe = (p: number) => rand() < p;
  if (maybe(0.85)) row.dept = ['eng', 'sales', 'ops'][Math.floor(rand() * 3)];
  if (maybe(0.8)) row.level = 1 + Math.floor(rand() * 5);
  if (maybe(0.8)) row.salary = rand() < 0.1 ? null : Math.floor(rand() * 200) + 40;
  if (maybe(0.7)) row.active = rand() < 0.5;
  if (maybe(0.7)) row.clearance = rand() < 0.4 ? 'high' : 'low';
  if (maybe(0.9)) row.ssn = `ssn-${index}`;
  return row;
}

function randomExpr(rand: () => number, depth: number): Expr {
  const roll = rand();
  if (depth > 0 && roll < 0.3) {
    const n = 1 + Math.floor(rand() * 3);
    const args: Expr[] = [];
    for (let i = 0; i < n; i++) args.push(randomExpr(rand, depth - 1));
    return { op: rand() < 0.5 ? 'and' : 'or', args };
  }
  if (depth > 0 && roll < 0.4) {
    return { op: 'not', arg: randomExpr(rand, depth - 1) };
  }
  const field = FIELD_POOL[Math.floor(rand() * FIELD_POOL.length)]!;
  const opRoll = rand();
  if (opRoll < 0.35) {
    const value = field === 'level' || field === 'salary'
      ? Math.floor(rand() * 200)
      : field === 'active'
        ? rand() < 0.5
        : ['eng', 'sales', 'ops', 'high', 'low'][Math.floor(rand() * 5)]!;
    return { op: rand() < 0.7 ? 'eq' : 'neq', field, value };
  }
  if (opRoll < 0.6) {
    const numeric = field === 'level' || field === 'salary' || rand() < 0.5;
    const value = numeric ? Math.floor(rand() * 150) : ['eng', 'high', 'm'][Math.floor(rand() * 3)]!;
    const op = (['lt', 'lte', 'gt', 'gte'] as const)[Math.floor(rand() * 4)]!;
    return { op, field, value };
  }
  if (opRoll < 0.8) {
    const values = ['eng', 'sales', 'ops', 'high', 'low', null].filter(() => rand() < 0.5);
    return { op: 'in', field, values };
  }
  return { op: 'lit', value: rand() < 0.5 };
}

function randomMasks(rand: () => number): MaskRule[] {
  const masks: MaskRule[] = [];
  for (const field of FIELD_POOL) {
    if (rand() < 0.3) {
      masks.push({
        field,
        when: randomExpr(rand, 1),
        replacement: rand() < 0.5 ? `<masked:${field}>` : undefined,
      });
    }
  }
  return masks;
}

function randomQuery(rand: () => number): Query {
  const query: {
    select?: string[];
    where?: Expr;
    groupBy?: string[];
    aggregates?: AggregateSpec[];
  } = {};
  if (rand() < 0.6) query.where = randomExpr(rand, 2);
  if (rand() < 0.5) {
    const groupBy = FIELD_POOL.filter(() => rand() < 0.25).slice(0, 2);
    const aggregates: AggregateSpec[] = [];
    const fns = ['count', 'sum', 'avg', 'min', 'max'] as const;
    for (let i = 0; i < 1 + Math.floor(rand() * 3); i++) {
      const fn = fns[Math.floor(rand() * fns.length)]!;
      aggregates.push({
        alias: `agg${i}`,
        fn,
        field: fn === 'count' && rand() < 0.5 ? undefined : FIELD_POOL[Math.floor(rand() * FIELD_POOL.length)]!,
      });
    }
    query.groupBy = groupBy;
    query.aggregates = aggregates;
  } else if (rand() < 0.7) {
    query.select = FIELD_POOL.filter(() => rand() < 0.5);
  }
  return query;
}

test('engine matches independent authorize-then-query model on randomized workloads', () => {
  const CASES = 300;
  for (let seed = 1; seed <= CASES; seed++) {
    const rand = lcg(seed * 2654435761);
    const rowCount = 1 + Math.floor(rand() * 25);
    const rows: Row[] = [];
    for (let i = 0; i < rowCount; i++) rows.push(randomRow(rand, i));
    const table: Table = createTable(`t${seed}`, rows);
    const snapshot = createPolicySnapshot({
      rowFilter: randomExpr(rand, 2),
      masks: randomMasks(rand),
    });
    const query = randomQuery(rand);
    const result = verifyAgainstModel(table, snapshot, query);
    assert.ok(
      result.ok,
      `seed ${seed} mismatch:\n${result.mismatches.join('\n')}\nquery=${JSON.stringify(query)}`,
    );
    for (const row of result.engine) {
      assert.ok(Array.isArray(row.sourceRowIds) && row.sourceRowIds.length > 0);
    }
  }
});

test('handwritten workloads: engine output equals model output exactly', () => {
  const table = createTable('users', [
    { id: 'u1', dept: 'eng', level: 5, salary: 100, ssn: 'a', clearance: 'high' },
    { id: 'u2', dept: 'eng', level: 2, salary: 60, ssn: 'b', clearance: 'low' },
    { id: 'u3', dept: 'sales', level: 4, salary: 80, ssn: 'c' },
    { id: 'u4', dept: 'eng', salary: 70, ssn: 'd', clearance: 'low' },
  ]);
  const snapshot = createPolicySnapshot({
    rowFilter: {
      op: 'and',
      args: [
        { op: 'eq', field: 'dept', value: 'eng' },
        { op: 'not', arg: { op: 'eq', field: 'level', value: 1 } },
      ],
    },
    masks: [{ field: 'ssn', when: { op: 'neq', field: 'clearance', value: 'high' } }],
  });
  const queries: Query[] = [
    {},
    { select: ['id', 'ssn'] },
    { select: ['id'], where: { op: 'gte', field: 'salary', value: 70 } },
    { groupBy: ['dept'], aggregates: [{ alias: 'n', fn: 'count' }, { alias: 's', fn: 'sum', field: 'salary' }] },
    { aggregates: [{ alias: 'm', fn: 'max', field: 'level' }, { alias: 'a', fn: 'avg', field: 'salary' }] },
    {
      where: { op: 'in', field: 'clearance', values: ['high', 'low'] },
      groupBy: ['clearance'],
      aggregates: [{ alias: 'n', fn: 'count' }],
    },
  ];
  for (const query of queries) {
    const result = verifyAgainstModel(table, snapshot, query);
    assert.ok(result.ok, `mismatch for ${JSON.stringify(query)}: ${result.mismatches.join('; ')}`);
  }
});
