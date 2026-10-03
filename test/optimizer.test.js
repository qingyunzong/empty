import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, hashesOf } from './helpers.js';

const tables = {
  users: {
    columns: ['id', 'name', 'age', 'region'],
    rows: [
      { id: 1, name: 'ann', age: 30, region: 'eu' },
      { id: 2, name: 'bob', age: null, region: 'us' },
      { id: 3, name: 'cid', age: 40, region: 'eu' },
      { id: 4, name: 'dan', age: 40, region: 'eu' },
    ],
  },
  orders: {
    columns: ['id', 'uid', 'amount'],
    rows: [
      { id: 10, uid: 1, amount: 100 },
      { id: 11, uid: 1, amount: null },
      { id: 12, uid: 3, amount: 70 },
      { id: 13, uid: 3, amount: 70 },
      { id: 14, uid: null, amount: null },
    ],
  },
};

test('predicate pushdown moves single-side conjuncts below the join', () => {
  const { optimized, rules, direct, physicalResults } = runQuery(
    `SELECT u.name, o.amount FROM users u JOIN orders o ON o.uid = u.id
     WHERE u.age >= 18 AND o.amount > 10 AND u.region = 'eu'`, tables);
  const pushes = rules.filter((r) => r.rule === 'predicate_pushdown');
  assert.equal(pushes.length, 2);
  const targets = pushes.map((p) => p.detail.target).sort();
  assert.deepEqual(targets, ['join.left', 'join.right']);
  // pushed plan: select nodes must sit below the join
  const join = optimized.input;
  assert.equal(join.type, 'join');
  assert.equal(join.left.type, 'select', 'left predicate pushed below join');
  assert.equal(join.right.type, 'select', 'right predicate pushed below join');
  for (const res of physicalResults) assert.equal(hashesOf(res), hashesOf(direct));
});

test('HAVING conjuncts on group keys push below groupby', () => {
  const { optimized, rules, direct, physicalResults } = runQuery(
    `SELECT u.region, COUNT(*) AS c FROM users u GROUP BY u.region HAVING u.region = 'eu' AND COUNT(*) >= 1`, tables);
  const pushes = rules.filter((r) => r.rule === 'predicate_pushdown');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].detail.target, 'groupby.input');
  // the remaining HAVING (aggregate conjunct) stays above aggregation
  const findAggFinal = (n) => n.type === 'aggfinal' ? n : findAggFinal(n.input ?? n.left);
  assert.ok(findAggFinal(optimized).having, 'aggregate HAVING conjunct must remain');
  for (const res of physicalResults) assert.equal(hashesOf(res), hashesOf(direct));
});

test('projection pruning drops unreferenced columns but keeps join keys and preserves duplicates', () => {
  const { optimized, rules, direct, physicalResults } = runQuery(
    'SELECT u.name, o.amount FROM users u JOIN orders o ON o.uid = u.id', tables);
  const prunes = rules.filter((r) => r.rule === 'projection_pruning');
  const prunedCols = prunes.flatMap((p) => p.detail.pruned);
  assert.ok(prunedCols.includes('u.age'));
  assert.ok(prunedCols.includes('u.region'));
  assert.ok(prunedCols.includes('o.id'));
  // join keys retained
  const retained = prunes.flatMap((p) => p.detail.retained);
  assert.ok(retained.includes('u.id'));
  assert.ok(retained.includes('o.uid'));
  // duplicates preserved: uid=1 has 2 orders, uid=3 has 2 orders -> 4 rows
  assert.equal(direct.rows.length, 4);
  for (const res of physicalResults) {
    assert.equal(res.rows.length, 4);
    assert.equal(hashesOf(res), hashesOf(direct));
  }
});

test('aggregate pushdown rewrites to partial/final and preserves NULL and duplicate semantics', () => {
  const { optimized, rules, direct, physicalResults } = runQuery(
    `SELECT o.uid, SUM(o.amount) AS s, AVG(o.amount) AS a, COUNT(o.amount) AS c, COUNT(*) AS ca
     FROM orders o GROUP BY o.uid HAVING SUM(o.amount) >= 0`, tables);
  assert.ok(rules.some((r) => r.rule === 'aggregate_pushdown'));
  const json = JSON.stringify(optimized);
  assert.ok(json.includes('aggpartial') && json.includes('aggfinal'));
  // uid NULL forms its own group; uid=1 group has SUM=100 (NULL ignored), duplicates kept
  const byUid = new Map(direct.rows.map((r) => [r.uid, r]));
  assert.equal(byUid.get(1).s, 100);
  assert.equal(byUid.get(1).c, 1);
  assert.equal(byUid.get(1).ca, 2);
  assert.equal(byUid.get(3).s, 140);
  // the all-NULL-amount group (uid NULL) has SUM = NULL -> HAVING UNKNOWN -> reported, not dropped
  assert.equal(direct.unknown.length, 1);
  assert.equal(direct.unknown[0].uid, null);
  assert.equal(direct.unknown[0].s, null);
  assert.equal(direct.unknown[0].ca, 1);
  for (const res of physicalResults) assert.equal(hashesOf(res), hashesOf(direct));
});

// Acceptance 3: all plans tied at the lowest cost are reported.
test('tied lowest-cost physical plans are all reported', () => {
  const t = {
    a: { columns: ['k', 'v'], rows: [{ k: 1, v: 'a1' }, { k: 2, v: 'a2' }] },
    b: { columns: ['k', 'w'], rows: [{ k: 1, w: 'b1' }, { k: 2, w: 'b2' }] },
  };
  const { best, alts, physicalResults, direct } = runQuery(
    'SELECT a.v, b.w FROM a JOIN b ON a.k = b.k', t);
  // 2x2: hash cost = 2+2 = 4, nested cost = 2*2 = 4 -> tie, both must be reported
  assert.equal(best.length, 2, `expected 2 tied plans, got ${best.length}`);
  const ops = best.map((b) => b.node.input.op).sort();
  assert.deepEqual(ops, ['hashjoin', 'nestedjoin']);
  assert.ok(alts.every((a) => best.includes(a) || a.cost > best[0].cost));
  for (const res of physicalResults) assert.equal(hashesOf(res), hashesOf(direct));
});

test('non-tied inputs pick the cheaper algorithm only', () => {
  const mk = (n, prefix) => ({
    columns: ['k', 'v'],
    rows: Array.from({ length: n }, (_, i) => ({ k: i + 1, v: `${prefix}${i}` })),
  });
  const t = { a: mk(10, 'a'), b: mk(10, 'b') };
  const { best } = runQuery('SELECT a.v, b.v FROM a JOIN b ON a.k = b.k', t);
  assert.equal(best.length, 1);
  assert.equal(best[0].node.input.op, 'hashjoin'); // 10+10=20 < 10*10=100
});
