import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { E, EvpackError } from '../src/errors.js';

function makeStore(rows, rules = []) {
  const store = new Store();
  for (const r of rows) store.addEvidence(r);
  for (const rule of rules) store.addRule(rule);
  return store;
}

const ev = (key, amount, status = 'asserted', extra = {}) =>
  ({ key, status, fields: { amount, ...extra } });

const sumClaim = (threshold) => ({
  select: { op: 'notnull', field: 'amount' },
  aggregate: { op: 'sum', field: 'amount' },
  cmp: { op: 'gte', value: threshold },
});

test('basic pass and fail conclusions', () => {
  const engine = new Engine(makeStore([ev('a', 60), ev('b', 50)]));
  assert.equal(engine.evaluate(sumClaim(100)).conclusion, 'pass');
  assert.equal(engine.evaluate(sumClaim(200)).conclusion, 'fail');
});

test('unknown evidence forces undecided, never unsatisfiable', () => {
  // 90 asserted + one unknown of 50: completions are 90 (fail) and 140 (pass).
  const engine = new Engine(makeStore([ev('a', 90), ev('u', 50, 'unknown')]));
  const r = engine.evaluate(sumClaim(100));
  assert.equal(r.conclusion, 'undecided');
  assert.notEqual(r.conclusion, 'fail');
  assert.deepEqual(r.undecided, ['u']);
});

test('unknown evidence that cannot change the outcome stays pass', () => {
  const engine = new Engine(makeStore([ev('a', 120), ev('u', -10, 'unknown')]));
  assert.equal(engine.evaluate(sumClaim(100)).conclusion, 'pass');
});

test('acceptance: retraction degrades pass to undecided, not fail', () => {
  const store = makeStore([ev('a', 60), ev('b', 50)]);
  const engine = new Engine(store);
  assert.equal(engine.evaluate(sumClaim(100)).conclusion, 'pass');
  engine.retract('b');
  const r = engine.evaluate(sumClaim(100));
  assert.equal(r.conclusion, 'undecided');
  assert.notEqual(r.conclusion, 'fail');
  assert.deepEqual(r.undecided, ['b']);
});

test('retraction of irrelevant evidence keeps the conclusion', () => {
  const store = makeStore([ev('a', 120), { key: 'x', status: 'asserted', fields: { other: 1 } }]);
  const engine = new Engine(store);
  assert.equal(engine.evaluate(sumClaim(100)).conclusion, 'pass');
  engine.retract('x');
  assert.equal(engine.evaluate(sumClaim(100)).conclusion, 'pass');
});

test('exclusion rules remove asserted evidence from the aggregate', () => {
  const store = makeStore(
    [ev('a', 60), ev('b', 50, 'asserted', { kind: 'estimate' })],
    [{ id: 'no-estimates', priority: 1, when: { op: 'eq', field: 'kind', value: 'estimate' } }],
  );
  const engine = new Engine(store);
  const r = engine.evaluate(sumClaim(100));
  assert.equal(r.conclusion, 'fail'); // only 60 remains
  assert.deepEqual(r.excludedByRule, { 'no-estimates': ['b'] });
  assert.deepEqual(r.appliedRules, ['no-estimates']);
});

test('acceptance: tied best-priority rules are all listed', () => {
  const store = makeStore(
    [
      ev('a', 10, 'asserted', { kind: 'x' }),
      ev('b', 20, 'asserted', { kind: 'y' }),
      ev('c', 30, 'asserted', { kind: 'z' }),
    ],
    [
      { id: 'r-low', priority: 1, when: { op: 'eq', field: 'kind', value: 'x' } },
      { id: 'r-tie-1', priority: 5, when: { op: 'eq', field: 'kind', value: 'y' } },
      { id: 'r-tie-2', priority: 5, when: { op: 'eq', field: 'kind', value: 'z' } },
    ],
  );
  const engine = new Engine(store);
  const r = engine.evaluate(sumClaim(0));
  assert.deepEqual(r.appliedRules, ['r-tie-1', 'r-tie-2']);
  assert.deepEqual(r.excludedByRule, {
    'r-low': ['a'],
    'r-tie-1': ['b'],
    'r-tie-2': ['c'],
  });
});

test('duplicate rule id raises E_DUP_RULE', () => {
  const store = makeStore([], [{ id: 'r1', priority: 1, when: { op: 'true' } }]);
  assert.throws(
    () => store.addRule({ id: 'r1', priority: 2, when: { op: 'true' } }),
    (e) => e instanceof EvpackError && e.code === E.DUP_RULE,
  );
});

test('retracting missing or already-retracted evidence raises E_EVIDENCE_GONE', () => {
  const store = makeStore([ev('a', 1, 'retracted')]);
  assert.throws(() => store.retract('nope'), (e) => e.code === E.EVIDENCE_GONE);
  assert.throws(() => store.retract('a'), (e) => e.code === E.EVIDENCE_GONE);
});

test('incremental: retraction does not rescan the evidence base', () => {
  const rows = [];
  for (let i = 0; i < 500; i += 1) rows.push(ev(`e${i}`, i, 'asserted', { grp: i % 2 }));
  const store = makeStore(rows, [{ id: 'r', priority: 1, when: { op: 'eq', field: 'grp', value: 1 } }]);
  const engine = new Engine(store);
  engine.evaluate(sumClaim(10));
  const scansBefore = store.scanCount;
  engine.retract('e3');
  assert.equal(store.scanCount, scansBefore, 'retract must not scan evidence');
});

test('incremental: cache invalidated only for claims depending on the key', () => {
  const store = makeStore([
    ev('a', 60, 'asserted', { grp: 0 }),
    ev('b', 50, 'asserted', { grp: 1 }),
  ]);
  const engine = new Engine(store);
  const claimA = { ...sumClaim(100), select: { op: 'eq', field: 'grp', value: 0 } };
  const claimB = { ...sumClaim(40), select: { op: 'eq', field: 'grp', value: 1 } };
  engine.evaluate(claimA);
  engine.evaluate(claimB);
  assert.equal(engine.cache.size, 2);
  engine.retract('a');
  assert.equal(engine.stats.invalidations, 1);
  assert.equal(engine.cache.size, 1, 'claimB cache entry survives');
  engine.evaluate(claimB);
  assert.equal(engine.stats.cacheHits, 1, 'claimB served from cache, no rescan');
});

test('NULL aggregate over empty relation is undecided, not fail', () => {
  const engine = new Engine(makeStore([{ key: 'a', status: 'asserted', fields: {} }]));
  const r = engine.evaluate({
    select: { op: 'eq', field: 'missing', value: 1 },
    aggregate: { op: 'sum', field: 'amount' },
    cmp: { op: 'gte', value: 0 },
  });
  assert.equal(r.conclusion, 'undecided');
});
