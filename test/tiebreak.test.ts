import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMemo,
  createCostModel,
  enumerateAll,
  optimize,
  planFingerprint,
  verifyWinner,
} from '../src/index.ts';
import type { CostModel, PhysicalOp, SubtreeStats } from '../src/types.ts';
import { aggregate, col, columnOwners, eq, get, join, smallStats } from './helpers.ts';

test('equal-cost plans are resolved by the lexicographic stable fingerprint', () => {
  // A cost model where HashJoin and MergeJoin have identical local cost and
  // indexes make both feasible, producing a genuine cost tie.
  const tieModel: CostModel = {
    ...createCostModel(),
    localCost(op: PhysicalOp, childStats: SubtreeStats[]) {
      if (op === 'HashJoin' || op === 'MergeJoin' || op === 'NLJoin') {
        return childStats.reduce((sum, stat) => sum + stat.rows, 0);
      }
      return createCostModel().localCost(op, childStats, { stats: smallStats() });
    },
  };

  const tree = join(
    [eq(col('orders_cust'), col('customer_id'))],
    get('orders'),
    get('customer'),
  );
  const built = buildMemo(tree, columnOwners());
  const required = { order: null, distribution: null };

  const report = enumerateAll({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel: tieModel,
  });

  const minCost = Math.min(...report.plans.map((entry) => entry.cost));
  const tied = report.plans.filter((entry) => entry.cost === minCost);
  assert.ok(tied.length >= 2, `expected a real tie, got ${tied.length} optimal plans`);

  const expectedWinner = tied.reduce((best, entry) =>
    entry.fingerprint < best.fingerprint ? entry : best,
  );

  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel: tieModel,
  });
  assert.equal(result.cost, minCost);
  assert.equal(planFingerprint(result.plan), expectedWinner.fingerprint);

  // Repeated optimization yields the same winner.
  const again = optimize({
    memo: buildMemo(tree, columnOwners()).memo,
    rootGroup: buildMemo(tree, columnOwners()).rootGroup,
    required,
    stats: smallStats(),
    costModel: tieModel,
  });
  assert.equal(planFingerprint(again.plan), expectedWinner.fingerprint);
});

test('exhaustive verifier flags a deliberately non-optimal winner', () => {
  const tree = join(
    [eq(col('lineitem_order'), col('orders_id'))],
    get('lineitem'),
    get('orders'),
  );
  const built = buildMemo(tree, columnOwners());
  const required = { order: null, distribution: null };
  const report = enumerateAll({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel: createCostModel(),
  });

  // Pick the most expensive enumerated plan as a fake "winner".
  const worst = report.plans.reduce((acc, entry) =>
    entry.cost > acc.cost ? entry : acc,
  );
  const verdict = verifyWinner(
    {
      memo: built.memo,
      rootGroup: built.rootGroup,
      required,
      stats: smallStats(),
      costModel: createCostModel(),
    },
    { plan: worst.plan, cost: worst.cost },
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes('cheaper')));
});

test('global optimality holds across every small query shape', () => {
  const costModel = createCostModel();
  const queries = [
    get('orders'),
    join([eq(col('orders_cust'), col('customer_id'))], get('orders'), get('customer')),
    join(
      [eq(col('lineitem_order'), col('orders_id'))],
      join([eq(col('orders_cust'), col('customer_id'))], get('orders'), get('customer')),
      get('lineitem'),
    ),
    aggregate(
      ['customer_nation'],
      [{ fn: 'count', input: 'customer_id', alias: 'cnt' }],
      get('customer'),
    ),
  ];

  for (const tree of queries) {
  const requirements: import('../src/types.ts').PhysicalProps[] = [
    { order: null, distribution: null },
    { order: ['customer_nation', 'customer_id'], distribution: null },
  ];
  for (const required of requirements) {
    const built = buildMemo(tree, columnOwners());
    const result = optimize({
      memo: built.memo,
      rootGroup: built.rootGroup,
      required,
      stats: smallStats(),
      costModel,
    });
      const verdict = verifyWinner(
        {
          memo: built.memo,
          rootGroup: built.rootGroup,
          required,
          stats: smallStats(),
          costModel,
        },
        { plan: result.plan, cost: result.cost },
      );
      assert.equal(verdict.ok, true, `${verdict.reasons.join('; ')} for ${planFingerprint(result.plan)}`);
      assert.ok(verdict.planCount >= 1);
    }
  }
});

test('branch-and-bound pruning never removes the globally optimal plan', () => {
  const tree = join(
    [eq(col('lineitem_part'), col('part_id'))],
    join([eq(col('lineitem_order'), col('orders_id'))], get('lineitem'), get('orders')),
    get('part'),
  );
  const built = buildMemo(tree, columnOwners());
  const required = { order: null, distribution: null };
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel: createCostModel(),
  });
  const report = enumerateAll({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel: createCostModel(),
  });
  assert.equal(result.cost, report.best.cost);
  assert.equal(planFingerprint(result.plan), report.best.fingerprint);
  // The bound actually pruned part of the space while evaluating the rest.
  assert.ok(result.evaluated > 0);
  assert.ok(result.pruned > 0, 'expected branch-and-bound to prune partial plans');
  assert.ok(
    result.evaluated < report.planCount,
    'branch-and-bound should evaluate fewer complete plans than exhaustive enumeration',
  );
});
