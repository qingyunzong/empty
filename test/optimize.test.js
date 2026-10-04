'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/sql');
const { buildPlan } = require('../src/plan');
const { optimize } = require('../src/optimize');
const { bestPlans } = require('../src/physical');
const { runQuery, statsFromData } = require('../src/engine');

const schemas = { t: ['x', 'y', 'z'], u: ['x', 'w'] };

function optOf(sql, data) {
  const stats = data ? statsFromData(data) : { rowCount: () => 10, isUnique: () => false, hasNullKey: () => true, keysIncluded: () => false };
  return optimize(buildPlan(parse(sql), schemas), stats);
}

test('predicate pushdown moves single-side conjuncts below the join', () => {
  const { plan, rules } = optOf('SELECT t.x FROM t JOIN u ON t.x = u.x WHERE t.y > 1 AND u.w < 5 AND t.x = u.x');
  assert.ok(rules.some((r) => r.rule === 'predicate_pushdown'));
  const g = plan.input; // project -> groupby? no: project -> join
  assert.equal(g.op, 'join');
  assert.equal(g.left.op, 'filter');
  assert.equal(g.right.op, 'filter');
});

test('projection pruning inserts lean projects above scans', () => {
  const { plan, rules } = optOf('SELECT t.x FROM t JOIN u ON t.x = u.x WHERE t.y > 1');
  const pruning = rules.filter((r) => r.rule === 'projection_pruning');
  assert.ok(pruning.some((r) => r.detail.includes('t.z')));
  assert.ok(pruning.some((r) => r.detail.includes('u.w')));
  // scan is wrapped in a project carrying only needed columns
  const filter = plan.input.left;
  assert.equal(filter.input.op, 'project');
  assert.deepEqual(filter.input.items.map((i) => i.name).sort(), ['t.x', 't.y']);
});

test('aggregate pushdown fires only under verified constraints', () => {
  // u.x unique, t.x non-null and included in u.x -> rewrite allowed
  const data = {
    t: [{ x: 1, y: 5, z: 0 }, { x: 2, y: 7, z: 1 }],
    u: [{ x: 1, w: 9 }, { x: 2, w: 8 }],
  };
  const sql = 'SELECT t.x, SUM(t.y) AS s FROM t JOIN u ON t.x = u.x GROUP BY t.x';
  const { rules } = optOf(sql, data);
  assert.ok(rules.some((r) => r.rule === 'aggregate_pushdown'));
  const r = runQuery(sql, data);
  assert.deepEqual(r.rows, [{ x: 1, s: 5 }, { x: 2, s: 7 }].sort((a, b) => a.x - b.x));
});

test('aggregate pushdown refused when it would change NULL/unknown semantics', () => {
  // t.x has a NULL key and a key (9) missing from u -> rewrite must NOT fire
  const data = {
    t: [{ x: 1, y: 5, z: 0 }, { x: null, y: 7, z: 1 }, { x: 9, y: 1, z: 2 }],
    u: [{ x: 1, w: 9 }, { x: 2, w: 8 }],
  };
  const sql = 'SELECT t.x, SUM(t.y) AS s FROM t JOIN u ON t.x = u.x GROUP BY t.x';
  const { rules } = optOf(sql, data);
  assert.ok(!rules.some((r) => r.rule === 'aggregate_pushdown'));
  // and duplicates on the join key also block it
  const data2 = { t: [{ x: 1, y: 5, z: 0 }], u: [{ x: 1, w: 9 }, { x: 1, w: 8 }] };
  const { rules: rules2 } = optOf(sql, data2);
  assert.ok(!rules2.some((r) => r.rule === 'aggregate_pushdown'));
});

test('tied minimum-cost plans are all reported', () => {
  // 2x2 rows: nested cost 2+2+4 = 8, hash cost 2+2+2+2 = 8 -> tie
  const data = {
    t: [{ x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }],
    u: [{ x: 1, w: 1 }, { x: 2, w: 2 }],
  };
  const stats = statsFromData(data);
  const { plan } = optOf('SELECT t.x FROM t JOIN u ON t.x = u.x', data);
  const tied = bestPlans(plan, stats);
  assert.equal(tied.length, 2);
  const ops = tied.map((p) => p.plan.input.op).sort();
  assert.deepEqual(ops, ['hashjoin', 'nljoin']);
  assert.ok(tied.every((p) => p.cost === tied[0].cost));
});

test('no false ties: larger inputs prefer hash join only', () => {
  const mk = (n, cols) => Array.from({ length: n }, (_, i) => Object.fromEntries(cols.map((c) => [c, i])));
  const data = { t: mk(10, ['x', 'y', 'z']), u: mk(10, ['x', 'w']) };
  const stats = statsFromData(data);
  const { plan } = optOf('SELECT t.x FROM t JOIN u ON t.x = u.x', data);
  const tied = bestPlans(plan, stats);
  assert.equal(tied.length, 1);
  assert.equal(tied[0].plan.input.op, 'hashjoin');
});
