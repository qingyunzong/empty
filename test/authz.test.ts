import { test } from 'node:test';
import { deepEqual, equal, notDeepEqual, ok } from 'node:assert/strict';
import {
  buildSnapshot,
  crossCheck,
  evalCondition,
  evalPolicy,
  runAuthorizeFirst,
  runInline,
  tvAnd,
  tvNot,
  tvOr,
  type Policy,
  type Query,
  type Row,
} from '../src/index.js';

test('three-valued logic follows Kleene truth tables', () => {
  equal(tvAnd('allow', 'allow'), 'allow');
  equal(tvAnd('allow', 'unknown'), 'unknown');
  equal(tvAnd('unknown', 'deny'), 'deny');
  equal(tvAnd('allow', 'deny'), 'deny');
  equal(tvOr('deny', 'deny'), 'deny');
  equal(tvOr('deny', 'unknown'), 'unknown');
  equal(tvOr('unknown', 'allow'), 'allow');
  equal(tvOr('deny', 'allow'), 'allow');
  equal(tvNot('allow'), 'deny');
  equal(tvNot('deny'), 'allow');
  equal(tvNot('unknown'), 'unknown');
});

test('missing field evaluates to unknown', () => {
  const row: Row = { id: 1, dept: 'eng' };
  equal(evalCondition({ op: 'gte', field: 'clearance', value: 2 }, row), 'unknown');
  equal(evalCondition({ op: 'eq', field: 'clearance', value: 2 }, row), 'unknown');
  equal(evalCondition({ op: 'in', field: 'clearance', values: [1, 2] }, row), 'unknown');
  equal(evalCondition({ op: 'exists', field: 'clearance' }, row), 'deny');
  equal(evalCondition({ op: 'exists', field: 'dept' }, row), 'allow');
});

const policy: Policy = {
  rules: [
    { name: 'cleared', when: { op: 'gte', field: 'clearance', value: 2 }, effect: 'allow' },
    { name: 'no-hr', when: { op: 'eq', field: 'dept', value: 'hr' }, effect: 'deny' },
  ],
  default: 'deny',
  fields: [{ field: 'ssn', when: { op: 'gte', field: 'clearance', value: 3 } }],
};

const table: Row[] = [
  { id: 1, dept: 'eng', clearance: 2, salary: 100, ssn: '111' },
  { id: 2, dept: 'eng', clearance: 1, salary: 200, ssn: '222' },
  { id: 3, dept: 'hr', clearance: 3, salary: 150, ssn: '333' },
  { id: 4, dept: 'eng', salary: 120, ssn: '444' },
  { id: 5, dept: 'eng', clearance: 3, salary: 300, ssn: '555' },
];

test('policy decisions: deny overrides allow, missing field yields unknown', () => {
  const decisions = table.map((r) => evalPolicy(policy, r));
  deepEqual(decisions, ['allow', 'deny', 'deny', 'unknown', 'allow']);
});

test('snapshot is the single source for filter and mask', () => {
  const snap = buildSnapshot(table, policy);
  deepEqual(
    snap.decisions.map((d) => [d.id, d.access, d.fields['ssn']]),
    [
      [1, 'allow', 'deny'],
      [2, 'deny', 'deny'],
      [3, 'deny', 'allow'],
      [4, 'unknown', 'unknown'],
      [5, 'allow', 'allow'],
    ],
  );
});

test('filter returns only authorized source row ids, masking applied from same snapshot', () => {
  const result = runAuthorizeFirst(table, policy);
  deepEqual(
    result.rows.map((r) => r.id),
    [1, 5],
  );
  deepEqual(result.rows[0], { id: 1, dept: 'eng', clearance: 2, salary: 100, ssn: null });
  deepEqual(result.rows[1], { id: 5, dept: 'eng', clearance: 3, salary: 300, ssn: '555' });
});

test('aggregation never includes unauthorized rows', () => {
  const query: Query = {
    aggregates: [
      { op: 'count', as: 'n' },
      { op: 'sum', field: 'salary', as: 'total' },
      { op: 'avg', field: 'salary', as: 'mean' },
    ],
  };
  const result = runAuthorizeFirst(table, policy, query);
  deepEqual(result.aggregates, { n: 2, total: 400, mean: 200 });
  const naiveSum = table.reduce((a, r) => a + (r['salary'] as number), 0);
  equal(naiveSum, 870);
  notDeepEqual(result.aggregates['total'], naiveSum);
});

test('query where is three-valued: unknown rows are excluded', () => {
  const query: Query = { where: { op: 'gt', field: 'bonus', value: 10 } };
  const result = runAuthorizeFirst(table, policy, query);
  deepEqual(result.rows, []);
  const query2: Query = { where: { op: 'gte', field: 'salary', value: 100 } };
  const result2 = runAuthorizeFirst(table, policy, query2);
  deepEqual(
    result2.rows.map((r) => r.id),
    [1, 5],
  );
});

test('select projection keeps id and masks per snapshot', () => {
  const result = runAuthorizeFirst(table, policy, { select: ['ssn', 'salary'] });
  deepEqual(result.rows, [
    { id: 1, ssn: null, salary: 100 },
    { id: 5, ssn: '555', salary: 300 },
  ]);
});

test('empty authorized set yields count 0 and null avg/min/max', () => {
  const denyAll: Policy = { rules: [], default: 'deny' };
  const result = runAuthorizeFirst(table, denyAll, {
    aggregates: [
      { op: 'count', as: 'n' },
      { op: 'sum', field: 'salary', as: 's' },
      { op: 'avg', field: 'salary', as: 'a' },
      { op: 'min', field: 'salary', as: 'lo' },
    ],
  });
  deepEqual(result.rows, []);
  deepEqual(result.aggregates, { n: 0, s: 0, a: null, lo: null });
});

test('fixed scenario: authorize-first and inline engines agree', () => {
  const query: Query = {
    where: { op: 'gte', field: 'salary', value: 100 },
    aggregates: [
      { op: 'count', as: 'n' },
      { op: 'sum', field: 'salary', as: 'total' },
    ],
  };
  const check = crossCheck(table, policy, query);
  ok(check.ok);
  deepEqual(check.authorizeFirst, check.inline);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized cross-check: 300 generated tables/policies/queries agree', () => {
  const rand = mulberry32(20261006);
  const depts = ['eng', 'hr', 'ops', 'fin'];
  const fields = ['dept', 'clearance', 'salary', 'region'];
  for (let iter = 0; iter < 300; iter++) {
    const rows: Row[] = [];
    const n = 1 + Math.floor(rand() * 40);
    for (let i = 1; i <= n; i++) {
      const row: Row = { id: i };
      if (rand() < 0.9) row['dept'] = depts[Math.floor(rand() * depts.length)];
      if (rand() < 0.8) row['clearance'] = Math.floor(rand() * 5);
      if (rand() < 0.9) row['salary'] = Math.floor(rand() * 500);
      if (rand() < 0.7) row['region'] = `r${Math.floor(rand() * 3)}`;
      if (rand() < 0.8) row['ssn'] = `s${i}`;
      rows.push(row);
    }
    const p: Policy = {
      rules: [
        { name: 'r1', when: { op: 'gte', field: 'clearance', value: Math.floor(rand() * 4) }, effect: 'allow' },
        { name: 'r2', when: { op: 'eq', field: 'dept', value: depts[Math.floor(rand() * depts.length)]! }, effect: rand() < 0.5 ? 'deny' : 'allow' },
        { name: 'r3', when: { op: 'in', field: 'region', values: ['r0', 'r1'] }, effect: rand() < 0.5 ? 'deny' : 'allow' },
      ],
      default: rand() < 0.5 ? 'deny' : 'allow',
      fields: [
        { field: 'ssn', when: { op: 'gte', field: 'clearance', value: Math.floor(rand() * 4) } },
        { field: 'salary', when: { op: 'eq', field: 'dept', value: 'eng' } },
      ],
    };
    const q: Query = {
      where: rand() < 0.7 ? { op: 'gte', field: 'salary', value: Math.floor(rand() * 400) } : undefined,
      select: rand() < 0.5 ? fields.filter(() => rand() < 0.6).concat('ssn') : undefined,
      aggregates: [
        { op: 'count', as: 'n' },
        { op: 'sum', field: 'salary', as: 'total' },
        { op: 'avg', field: 'clearance', as: 'meanClearance' },
        { op: 'max', field: 'salary', as: 'top' },
      ],
    };
    const check = crossCheck(rows, p, q);
    if (!check.ok) {
      deepEqual(check.authorizeFirst, check.inline, `iteration ${iter} diverged`);
    }
    ok(check.ok, `iteration ${iter} diverged`);
  }
});

test('inline engine alone also respects authorize-before-aggregate', () => {
  const result = runInline(table, policy, {
    aggregates: [{ op: 'sum', field: 'salary', as: 'total' }],
  });
  equal(result.aggregates['total'], 400);
  deepEqual(
    result.rows.map((r) => r.id),
    [1, 5],
  );
});
