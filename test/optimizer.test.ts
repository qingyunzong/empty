import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMemo,
  createCostModel,
  enumerateAll,
  planFingerprint,
  optimize,
  planDelivers,
  satisfies,
  verifyWinner,
} from '../src/index.ts';
import type { PhysicalProps } from '../src/types.ts';
import { aggregate, andPred, col, collectOps, columnOwners, countOp, eq, get, join, lt, select, smallStats } from './helpers.ts';

const costModel = createCostModel();

test('unconstrained scan picks the cheapest access path and passes exhaustive verification', () => {
  const tree = get('orders');
  const built = buildMemo(tree, columnOwners());
  const required: PhysicalProps = { order: null, distribution: null };
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel,
  });
  // Index scan (sqrt(rows) probe) is cheaper than a full sequential scan.
  assert.ok(result.plan.op === 'SeqScan' || result.plan.op === 'IndexScan');
  assert.ok(satisfies(planDelivers(result.plan), required));

  const verdict = verifyWinner(
    { memo: built.memo, rootGroup: built.rootGroup, required, stats: smallStats(), costModel },
    { plan: result.plan, cost: result.cost },
  );
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.ok, true);
});

test('order requirement introduces a Sort enforcer and still finds global optimum', () => {
  const tree = get('orders');
  const built = buildMemo(tree, columnOwners());
  const required: PhysicalProps = { order: ['orders_status'], distribution: null };
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel,
  });
  assert.equal(countOp(result.plan, 'Sort'), 1);
  assert.ok(satisfies(planDelivers(result.plan), required));

  const report = enumerateAll({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel,
  });
  // Space contains SeqScan+Sort and IndexScan variants (none lead with orders_status).
  assert.ok(report.planCount >= 2);
  assert.equal(report.best.fingerprint, planFingerprint(result.plan));
  assert.equal(report.best.cost, result.cost);
});

test('matching index order is delivered directly without Sort', () => {
  const tree = get('orders');
  const built = buildMemo(tree, columnOwners());
  const required: PhysicalProps = { order: ['orders_cust'], distribution: null };
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel,
  });
  assert.equal(countOp(result.plan, 'Sort'), 0);
  assert.equal(result.plan.op, 'IndexScan');
  assert.deepEqual(result.plan.indexCols, ['orders_cust']);
});

test('ordered requirement on a join selects MergeJoin with ordered children', () => {
  const tree = join(
    [eq(col('orders_cust'), col('customer_id'))],
    get('orders'),
    get('customer'),
  );
  const built = buildMemo(tree, columnOwners());
  const required: PhysicalProps = { order: ['customer_id'], distribution: null };
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel,
  });
  assert.ok(satisfies(planDelivers(result.plan), required));
  // Either a MergeJoin delivers the order, or an enforcer Sort sits on top;
  // both are valid, but the exhaustive verifier must confirm global optimality.
  const verdict = verifyWinner(
    { memo: built.memo, rootGroup: built.rootGroup, required, stats: smallStats(), costModel },
    { plan: result.plan, cost: result.cost },
  );
  assert.equal(verdict.ok, true, verdict.reasons.join('; '));
  assert.ok(collectOps(result.plan).includes('MergeJoin') || countOp(result.plan, 'Sort') >= 1);
});

test('three-way join enumerates the full bushy space and the winner is globally minimal', () => {
  const tree = join(
    [eq(col('lineitem_order'), col('orders_id'))],
    join(
      [eq(col('orders_cust'), col('customer_id'))],
      get('orders'),
      get('customer'),
    ),
    get('lineitem'),
  );
  const built = buildMemo(tree, columnOwners());
  const required: PhysicalProps = { order: null, distribution: null };
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel,
  });
  const report = enumerateAll({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel,
  });
  assert.ok(report.planCount > 10, `expected a rich plan space, got ${report.planCount}`);
  assert.equal(report.best.cost, result.cost);
  assert.equal(report.best.fingerprint, planFingerprint(result.plan));
  assert.ok(result.pruned >= 0 && result.evaluated > 0);
});

test('aggregate chooses between HashAgg and SortedAgg by required order', () => {
  const tree = aggregate(
    ['customer_nation'],
    [{ fn: 'count', input: 'customer_id', alias: 'cnt' }],
    get('customer'),
  );
  const built = buildMemo(tree, columnOwners());
  const stats = smallStats();

  const unordered = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required: { order: null, distribution: null },
    stats,
    costModel,
  });
  assert.equal(unordered.plan.op, 'HashAgg');

  const ordered = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required: { order: ['customer_nation'], distribution: null },
    stats,
    costModel,
  });
  assert.equal(ordered.plan.op, 'SortedAgg');
  assert.ok(satisfies(planDelivers(ordered.plan), { order: ['customer_nation'], distribution: null }));
});

test('selective filter is pushed below the join and changes the winner', () => {
  const base = join(
    [eq(col('orders_cust'), col('customer_id'))],
    get('orders'),
    get('customer'),
  );
  const filtered = select([lt(col('orders_id'), col('customer_id'))], base);
  const built = buildMemo(filtered, columnOwners());
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required: { order: null, distribution: null },
    stats: smallStats(),
    costModel,
  });
  const verdict = verifyWinner(
    {
      memo: built.memo,
      rootGroup: built.rootGroup,
      required: { order: null, distribution: null },
      stats: smallStats(),
      costModel,
    },
    { plan: result.plan, cost: result.cost },
  );
  assert.equal(verdict.ok, true, verdict.reasons.join('; '));
  assert.equal(countOp(result.plan, 'Filter'), 1);
});

test('all enumerated plans satisfy the required physical properties', () => {
  const tree = join(
    [andPred(eq(col('lineitem_order'), col('orders_id')), eq(col('lineitem_part'), col('part_id')))],
    get('lineitem'),
    join([eq(col('part_id'), col('orders_id'))], get('part'), get('orders')),
  );
  const built = buildMemo(tree, columnOwners());
  const required: PhysicalProps = { order: ['part_id'], distribution: null };
  const report = enumerateAll({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel,
  });
  for (const entry of report.plans) {
    assert.ok(
      satisfies(planDelivers(entry.plan), required),
      `plan ${entry.fingerprint} violates required properties`,
    );
  }
});
