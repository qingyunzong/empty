import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSql } from '../src/parser.js';
import { buildLogicalPlan } from '../src/plan.js';
import { optimize } from '../src/optimizer.js';
import { verifyPlans, validateCertificateRules } from '../src/verify.js';
import { runQuery, catalogOf } from './helpers.js';
import { E_NON_EQUIV } from '../src/errors.js';

const tables = {
  x: {
    columns: ['k', 'v'],
    rows: [
      { k: 1, v: 10 }, { k: 1, v: 5 }, { k: 2, v: 20 }, { k: 2, v: 2 }, { k: 3, v: null },
    ],
  },
  y: {
    columns: ['k', 'w'],
    rows: [
      { k: 1, w: 100 }, { k: 1, w: 200 }, { k: 2, w: 300 }, { k: null, w: 400 },
    ],
  },
};
const ctx = { tables };

function logicalOf(sql) {
  return buildLogicalPlan(parseSql(sql), catalogOf(tables));
}

test('verify accepts an optimized plan against its logical original', () => {
  const sql = 'SELECT x.k, SUM(y.w) AS s FROM x JOIN y ON x.k = y.k WHERE x.v >= 10 GROUP BY x.k';
  const logical = logicalOf(sql);
  const { plan: optimized } = optimize(logical);
  const result = verifyPlans(logical, optimized, ctx);
  assert.equal(result.equivalent, true);
  assert.match(result.hash, /^[0-9a-f]{64}$/);
});

// Acceptance 4: wrong rewrites are rejected, never approximated.
test('verify rejects a wrong rewrite: OR-predicate illegally pushed below join', () => {
  const correct = logicalOf('SELECT x.k, y.w FROM x JOIN y ON x.k = y.k WHERE x.v > 5 OR y.w > 250');
  // wrong rewrite: keep only the left conjunct and push it below the join,
  // silently dropping the y.w > 250 disjunct
  const join = correct.input.input; // project -> select -> join
  const wrongSelect = {
    ...join,
    left: { id: 9001, type: 'select', input: join.left, predicate: {
      kind: 'cmp', op: '>', left: { kind: 'col', ref: 'x.v' }, right: { kind: 'lit', value: 5 },
    } },
  };
  const wrong = { ...correct, input: { ...correct.input, input: wrongSelect } };
  assert.throws(() => verifyPlans(correct, wrong, ctx), (e) => e.code === E_NON_EQUIV);
});

test('verify rejects a wrong rewrite: aggregate decomposed with the wrong function', () => {
  // correct: join first (y fans out x), then SUM(x.v) per group -> w=100 gets 10+5=15
  const correct = logicalOf('SELECT y.w, SUM(x.v) AS s FROM x JOIN y ON x.k = y.k GROUP BY y.w');
  // wrong rewrite: pre-aggregate x per k with AVG but keep the alias, then SUM the
  // averages after the join -> w=100 gets 7.5 instead of 15
  const join = correct.input.input;
  const wrongPreAgg = {
    id: 9101, type: 'groupby', input: join.left,
    keys: ['x.k'], keyCols: [{ alias: 'x', name: 'k', ref: 'x.k' }],
    aggs: [{ func: 'avg', arg: 'x.v', alias: 'x.v' }], having: null,
  };
  const wrongJoin = { ...join, left: wrongPreAgg };
  const wrongGb = { ...correct.input, input: wrongJoin };
  const wrong = { ...correct, input: wrongGb };
  assert.throws(() => verifyPlans(correct, wrong, ctx), (e) => e.code === E_NON_EQUIV);
});

test('verify rejects certificate with invalid rule preconditions', () => {
  assert.throws(
    () => validateCertificateRules([{
      rule: 'predicate_pushdown',
      detail: { predicate: 'y.w > 5', target: 'join.left', refs: ['y.w'], targetSchema: ['x.k', 'x.v'] },
    }]),
    (e) => e.code === E_NON_EQUIV);
  assert.throws(
    () => validateCertificateRules([{
      rule: 'aggregate_pushdown', detail: { aggregates: ['median'], mode: 'partial-final' },
    }]),
    (e) => e.code === E_NON_EQUIV);
  assert.throws(
    () => validateCertificateRules([{ rule: 'magic_rewrite', detail: {} }]),
    (e) => e.code === E_NON_EQUIV);
});

test('verify accepts certificates produced by the real optimizer', () => {
  const { rules } = runQuery(
    'SELECT x.k, SUM(y.w) AS s FROM x JOIN y ON x.k = y.k WHERE x.v >= 10 GROUP BY x.k', tables);
  validateCertificateRules(rules); // must not throw
});
