import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClaim } from '../src/verify.js';
import { memStore } from './helpers.mjs';

const countAll = (n) => ({ aggregate: { op: 'count', field: '*' }, expect: { op: 'gte', value: n } });

test('definite pass and fail with asserted rows only', () => {
  const store = memStore([
    { key: 'a', attrs: { t: 'kyc' } },
    { key: 'b', attrs: { t: 'kyc' } },
    { key: 'c', attrs: { t: 'other' } },
  ]);
  const where = [{ field: 't', op: 'eq', value: 'kyc' }];
  assert.equal(evaluateClaim(store, { where, ...countAll(2) }).conclusion, 'pass');
  assert.equal(evaluateClaim(store, { where, ...countAll(3) }).conclusion, 'fail');
});

test('unknown rows force undecided, never fail', () => {
  const store = memStore([
    { key: 'a', attrs: { t: 'kyc' } },
    { key: 'u1', state: 'unknown', attrs: { t: 'kyc' } },
    { key: 'u2', state: 'unknown', attrs: { t: 'kyc' } },
  ]);
  const where = [{ field: 't', op: 'eq', value: 'kyc' }];
  const r = evaluateClaim(store, { where, ...countAll(3) });
  assert.equal(r.conclusion, 'undecided'); // lo=1, hi=3
  assert.deepEqual(r.undecided, ['u1', 'u2']);
  // definitely unsatisfiable even with all unknowns counted -> fail
  assert.equal(evaluateClaim(store, { where, ...countAll(4) }).conclusion, 'fail');
});

test('sum/min/max with NULL semantics: empty asserted set -> undecided', () => {
  const store = memStore([
    { key: 'a', attrs: { t: 'x', v: null } },
    { key: 'u', state: 'unknown', attrs: { t: 'x', v: 5 } },
  ]);
  const where = [{ field: 't', op: 'eq', value: 'x' }];
  for (const op of ['sum', 'min', 'max']) {
    const r = evaluateClaim(store, { where, aggregate: { op, field: 'v' }, expect: { op: 'gte', value: 1 } });
    assert.equal(r.conclusion, 'undecided', op);
    assert.equal(r.aggregate.null, true, op);
  }
  // count never goes NULL
  assert.equal(evaluateClaim(store, { where, ...countAll(0) }).conclusion, 'pass');
});

test('sum bounds widen with uncertain rows on both sides', () => {
  const store = memStore([
    { key: 'a', attrs: { v: 10 } },
    { key: 'u1', state: 'unknown', attrs: { v: -4 } },
    { key: 'u2', state: 'unknown', attrs: { v: 7 } },
  ]);
  const claim = (value) => ({ aggregate: { op: 'sum', field: 'v' }, expect: { op: 'gte', value } });
  assert.equal(evaluateClaim(store, claim(6)).conclusion, 'pass'); // lo = 10-4 = 6
  assert.equal(evaluateClaim(store, claim(7)).conclusion, 'undecided');
  assert.equal(evaluateClaim(store, claim(18)).conclusion, 'fail'); // hi = 10+7 = 17
});

test('exclusion rules remove evidence from evaluation; bestRules lists all top ties', () => {
  const store = memStore(
    [
      { key: 'a', attrs: { t: 'kyc', src: 'old', region: 'cn' } },
      { key: 'b', attrs: { t: 'kyc', src: 'new' } },
    ],
    [
      { id: 'r-low', priority: 1, where: [{ field: 'src', op: 'eq', value: 'old' }] },
      { id: 'r-tie1', priority: 9, where: [{ field: 'src', op: 'eq', value: 'old' }] },
      { id: 'r-tie2', priority: 9, where: [{ field: 'region', op: 'eq', value: 'cn' }] },
    ]
  );
  const r = evaluateClaim(store, {
    where: [{ field: 't', op: 'eq', value: 'kyc' }],
    ...countAll(1),
  });
  assert.equal(r.conclusion, 'pass'); // only 'b' remains
  assert.deepEqual(r.hits, ['b']);
  assert.deepEqual(r.excluded.a, ['r-low', 'r-tie1', 'r-tie2']);
  assert.deepEqual(r.bestRules, [
    { id: 'r-tie1', priority: 9 },
    { id: 'r-tie2', priority: 9 },
  ]);
});

test('min/max bounds with uncertain rows', () => {
  const store = memStore([
    { key: 'a', attrs: { v: 10 } },
    { key: 'u1', state: 'unknown', attrs: { v: 3 } },
    { key: 'u2', state: 'unknown', attrs: { v: 15 } },
  ]);
  const min = (value) => evaluateClaim(store, { aggregate: { op: 'min', field: 'v' }, expect: { op: 'gte', value } });
  assert.equal(min(3).conclusion, 'pass');
  assert.equal(min(4).conclusion, 'undecided');
  assert.equal(min(11).conclusion, 'fail');
  const max = (value) => evaluateClaim(store, { aggregate: { op: 'max', field: 'v' }, expect: { op: 'lte', value } });
  assert.equal(max(15).conclusion, 'pass'); // hi = 15
  assert.equal(max(12).conclusion, 'undecided'); // achievable max in [10, 15]
  assert.equal(max(9).conclusion, 'fail'); // lo = 10
});
