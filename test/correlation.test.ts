import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMemo,
  createCostModel,
  Memo,
  optimize,
  planDelivers,
  satisfies,
  verifyWinner,
} from '../src/index.ts';
import type { CorrCtx, LogicalTree, PhysicalProps } from '../src/types.ts';
import { apply, col, columnOwners, ctx, eq, get, lt, param, select, smallStats } from './helpers.ts';

const costModel = createCostModel();

/**
 * Outer query:
 *   Apply(outer=orders, inner=Select(lineitem_order = $orders_id, Get(lineitem)))
 * where the inner subquery is correlated on orders.orders_id.
 */
function correlatedApply(): LogicalTree {
  const innerCtx: CorrCtx = ctx('subq:lineitem', ['o_id']);
  const inner = select(
    [eq(col('lineitem_order'), param('o_id')), lt(param('o_id'), col('lineitem_id'))],
    get('lineitem', innerCtx),
    innerCtx,
  );
  return apply(['o_id'], get('orders', ctx('root')), inner, ctx('root'));
}

test('correlated subquery groups never merge with root-context groups', () => {
  const built = buildMemo(correlatedApply(), columnOwners());
  const memo = built.memo;

  const contexts = new Set<string>();
  for (const root of memo.roots()) {
    contexts.add(memo.getGroup(root).ctx.pathId);
  }
  assert.ok(contexts.has('root'));
  assert.ok(contexts.has('subq:lineitem'));

  // The two Get(lineitem) shapes exist exactly once per context and stay apart.
  const materialized = memo.materialize(built.rootGroup);
  assert.ok(materialized.length >= 1);
  const innerGetGroups = memo
    .roots()
    .filter((id) => memo.getGroup(id).ctx.pathId === 'subq:lineitem');
  assert.ok(innerGetGroups.length >= 1);
  for (const id of innerGetGroups) {
    assert.deepEqual(memo.getGroup(id).ctx.params, ['o_id']);
  }
});

test('parameterized index scan is chosen inside the correlated scope', () => {
  const built = buildMemo(correlatedApply(), columnOwners());
  const required: PhysicalProps = { order: null, distribution: null };
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: smallStats(),
    costModel,
  });

  // Walk the plan; the correlated fragment must use ParamIndexScan on lineitem_order.
  const found = findPlan(result.plan, (node) => node.op === 'ParamIndexScan');
  assert.ok(found, 'expected a ParamIndexScan in the correlated fragment');
  assert.deepEqual(found!.indexCols, ['lineitem_order']);
  assert.deepEqual(found!.ctx.params, ['o_id']);
  assert.equal(found!.relation, 'lineitem');

  const verdict = verifyWinner(
    { memo: built.memo, rootGroup: built.rootGroup, required, stats: smallStats(), costModel },
    { plan: result.plan, cost: result.cost },
  );
  assert.equal(verdict.ok, true, verdict.reasons.join('; '));
});

test('parameterized scans are not exposed in the uncorrelated root scope', () => {
  const built = buildMemo(get('lineitem', ctx('root')));
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required: { order: null, distribution: null },
    stats: smallStats(),
    costModel,
  });
  const found = findPlan(result.plan, (node) => node.op === 'ParamIndexScan');
  assert.equal(found, undefined);
});

test('two distinct parameterized paths are kept apart even with identical shape', () => {
  const memo = new Memo();
  const pathA = get('lineitem', ctx('subq:a', ['o_id']));
  const pathB = get('lineitem', ctx('subq:b', ['o_id']));
  const gA = memo.add(pathA);
  const gB = memo.add(pathB);
  assert.notEqual(memo.find(gA), memo.find(gB));

  assert.throws(() => memo.unionGroups(gA, gB), /correlation contexts/);
});

test('different parameter sets on the same path id are not merged', () => {
  const memo = new Memo();
  const g1 = memo.add(get('part', ctx('subq', ['part_id'])));
  const g2 = memo.add(get('part', ctx('subq', ['part_id', 'part_type'])));
  assert.notEqual(memo.find(g1), memo.find(g2));
  assert.throws(() => memo.unionGroups(g1, g2), /correlation contexts/);
});

test('re-optimizing the same correlated query is deterministic', () => {
  const tree = correlatedApply();
  const run = () => {
    const built = buildMemo(tree, columnOwners());
    return optimize({
      memo: built.memo,
      rootGroup: built.rootGroup,
      required: { order: null, distribution: null },
      stats: smallStats(),
      costModel,
    });
  };
  const first = run();
  const second = run();
  assert.equal(first.cost, second.cost);
  assert.ok(satisfies(planDelivers(first.plan), { order: null, distribution: null }));
});

function findPlan(
  node: import('../src/types.ts').PhysicalPlan,
  predicate: (node: import('../src/types.ts').PhysicalPlan) => boolean,
): import('../src/types.ts').PhysicalPlan | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const hit = findPlan(child, predicate);
    if (hit) return hit;
  }
  return undefined;
}
