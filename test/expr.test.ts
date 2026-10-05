import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpr, type Expr } from '../src/expr.js';

const row = { id: 'r1', dept: 'eng', level: 3, active: true, nickname: null };

test('missing field evaluates to UNKNOWN for every operator', () => {
  const cases: Expr[] = [
    { op: 'eq', field: 'ghost', value: 1 },
    { op: 'neq', field: 'ghost', value: 1 },
    { op: 'lt', field: 'ghost', value: 1 },
    { op: 'lte', field: 'ghost', value: 1 },
    { op: 'gt', field: 'ghost', value: 1 },
    { op: 'gte', field: 'ghost', value: 1 },
    { op: 'in', field: 'ghost', values: [1, 2] },
  ];
  for (const expr of cases) {
    assert.equal(evalExpr(expr, row), 'U', JSON.stringify(expr));
  }
});

test('null field value evaluates to UNKNOWN', () => {
  assert.equal(evalExpr({ op: 'eq', field: 'nickname', value: 'x' }, row), 'U');
  assert.equal(evalExpr({ op: 'neq', field: 'nickname', value: 'x' }, row), 'U');
  assert.equal(evalExpr({ op: 'gt', field: 'nickname', value: 1 }, row), 'U');
  assert.equal(evalExpr({ op: 'in', field: 'nickname', values: ['x'] }, row), 'U');
});

test('eq / neq', () => {
  assert.equal(evalExpr({ op: 'eq', field: 'dept', value: 'eng' }, row), 'T');
  assert.equal(evalExpr({ op: 'eq', field: 'dept', value: 'sales' }, row), 'F');
  assert.equal(evalExpr({ op: 'neq', field: 'dept', value: 'sales' }, row), 'T');
  assert.equal(evalExpr({ op: 'eq', field: 'active', value: true }, row), 'T');
  assert.equal(evalExpr({ op: 'eq', field: 'level', value: 3 }, row), 'T');
  assert.equal(evalExpr({ op: 'eq', field: 'level', value: '3' }, row), 'F');
});

test('ordering comparisons', () => {
  assert.equal(evalExpr({ op: 'lt', field: 'level', value: 4 }, row), 'T');
  assert.equal(evalExpr({ op: 'lte', field: 'level', value: 3 }, row), 'T');
  assert.equal(evalExpr({ op: 'gt', field: 'level', value: 3 }, row), 'F');
  assert.equal(evalExpr({ op: 'gte', field: 'level', value: 3 }, row), 'T');
  assert.equal(evalExpr({ op: 'lt', field: 'dept', value: 'fin' }, row), 'T');
});

test('ordering comparison with mismatched types is UNKNOWN', () => {
  assert.equal(evalExpr({ op: 'gt', field: 'dept', value: 5 }, row), 'U');
  assert.equal(evalExpr({ op: 'gt', field: 'active', value: 5 }, row), 'U');
});

test('in list', () => {
  assert.equal(evalExpr({ op: 'in', field: 'dept', values: ['eng', 'ops'] }, row), 'T');
  assert.equal(evalExpr({ op: 'in', field: 'dept', values: ['ops'] }, row), 'F');
  assert.equal(evalExpr({ op: 'in', field: 'dept', values: ['ops', null] }, row), 'U');
});

test('and / or / not propagate UNKNOWN', () => {
  const unknown: Expr = { op: 'eq', field: 'ghost', value: 1 };
  const t: Expr = { op: 'lit', value: true };
  const f: Expr = { op: 'lit', value: false };
  assert.equal(evalExpr({ op: 'and', args: [t, unknown] }, row), 'U');
  assert.equal(evalExpr({ op: 'and', args: [f, unknown] }, row), 'F');
  assert.equal(evalExpr({ op: 'or', args: [f, unknown] }, row), 'U');
  assert.equal(evalExpr({ op: 'or', args: [t, unknown] }, row), 'T');
  assert.equal(evalExpr({ op: 'not', arg: unknown }, row), 'U');
});
