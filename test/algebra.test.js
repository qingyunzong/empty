import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evalPred,
  aggregateRows,
  compare,
  emptyAggState,
  aggStateOfRow,
  combineAggState,
  finalizeAgg,
} from '../src/algebra.js';

const row = (key, fields) => ({ key, status: 'asserted', fields });

test('predicate comparisons and boolean logic', () => {
  const f = { region: 'EU', amount: 50, flag: true };
  assert.equal(evalPred({ op: 'eq', field: 'region', value: 'EU' }, f), true);
  assert.equal(evalPred({ op: 'gt', field: 'amount', value: 100 }, f), false);
  assert.equal(evalPred({ op: 'and', args: [
    { op: 'eq', field: 'region', value: 'EU' },
    { op: 'gte', field: 'amount', value: 50 },
  ] }, f), true);
  assert.equal(evalPred({ op: 'not', arg: { op: 'eq', field: 'region', value: 'US' } }, f), true);
  assert.equal(evalPred({ op: 'in', field: 'region', values: ['US', 'EU'] }, f), true);
  assert.equal(evalPred({ op: 'or', args: [
    { op: 'eq', field: 'region', value: 'US' },
    { op: 'eq', field: 'flag', value: true },
  ] }, f), true);
});

test('three-valued logic: NULL field yields unknown', () => {
  const f = { region: null };
  assert.equal(evalPred({ op: 'eq', field: 'region', value: 'EU' }, f), null);
  assert.equal(evalPred({ op: 'and', args: [
    { op: 'eq', field: 'region', value: 'EU' },
    { op: 'true' },
  ] }, f), null);
  assert.equal(evalPred({ op: 'and', args: [
    { op: 'eq', field: 'region', value: 'EU' },
    { op: 'false' },
  ] }, f), false);
  assert.equal(evalPred({ op: 'or', args: [
    { op: 'eq', field: 'region', value: 'EU' },
    { op: 'true' },
  ] }, f), true);
  assert.equal(evalPred({ op: 'not', arg: { op: 'eq', field: 'region', value: 'EU' } }, f), null);
  assert.equal(evalPred({ op: 'isnull', field: 'region' }, f), true);
  assert.equal(evalPred({ op: 'notnull', field: 'missing' }, f), false);
});

test('aggregate NULL semantics', () => {
  const rows = [
    row('a', { amount: 10 }),
    row('b', { amount: null }),
    row('c', {}),
    row('d', { amount: 30 }),
  ];
  assert.equal(aggregateRows({ op: 'count', field: '*' }, rows), 4);
  assert.equal(aggregateRows({ op: 'count', field: 'amount' }, rows), 2);
  assert.equal(aggregateRows({ op: 'sum', field: 'amount' }, rows), 40);
  assert.equal(aggregateRows({ op: 'min', field: 'amount' }, rows), 10);
  assert.equal(aggregateRows({ op: 'max', field: 'amount' }, rows), 30);
});

test('aggregates over empty / all-NULL relations are NULL (except count)', () => {
  const rows = [row('a', { amount: null }), row('b', {})];
  assert.equal(aggregateRows({ op: 'count', field: '*' }, rows), 2);
  assert.equal(aggregateRows({ op: 'count', field: 'amount' }, rows), 0);
  assert.equal(aggregateRows({ op: 'sum', field: 'amount' }, rows), null);
  assert.equal(aggregateRows({ op: 'min', field: 'amount' }, rows), null);
  assert.equal(aggregateRows({ op: 'max', field: 'amount' }, rows), null);
  assert.equal(aggregateRows({ op: 'sum', field: 'amount' }, []), null);
  assert.equal(aggregateRows({ op: 'count', field: '*' }, []), 0);
});

test('incremental combine matches direct aggregation', () => {
  const rows = [
    row('a', { amount: 5 }),
    row('b', { amount: null }),
    row('c', { amount: 7 }),
    row('d', { amount: -2 }),
  ];
  for (const op of ['count', 'sum', 'min', 'max']) {
    const agg = { op, field: 'amount' };
    let state = emptyAggState();
    for (const r of rows) state = combineAggState(state, aggStateOfRow(agg, r));
    assert.equal(finalizeAgg(agg, state), aggregateRows(agg, rows), op);
  }
});

test('compare is three-valued', () => {
  assert.equal(compare(10, { op: 'gte', value: 10 }), true);
  assert.equal(compare(9, { op: 'gte', value: 10 }), false);
  assert.equal(compare(null, { op: 'gte', value: 10 }), null);
  assert.equal(compare(10, { op: 'eq', value: null }), null);
});
