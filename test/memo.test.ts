import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explore, fnv1aHash, logicalFingerprint, Memo, planFingerprint } from '../src/index.ts';
import type { LogicalTree } from '../src/types.ts';
import { andPred, col, columnOwners, ctx, eq, get, join, lt, select } from './helpers.ts';

test('identical trees intern into the same group', () => {
  const memo = new Memo();
  const tree: LogicalTree = select([eq(col('a'), col('b'))], get('t'));
  const g1 = memo.add(tree);
  const g2 = memo.add(tree);
  assert.equal(memo.find(g1), memo.find(g2));
  assert.equal(memo.groupCount(), 2);
});

test('fingerprints are order-stable for symmetric predicates', () => {
  const t1 = select([eq(col('a'), col('b'))], get('t'));
  const t2 = select([eq(col('b'), col('a'))], get('t'));
  assert.equal(logicalFingerprint(t1), logicalFingerprint(t2));

  const and1 = select([andPred(eq(col('a'), col('b')), lt(col('c'), col('d')))], get('t'));
  const and2 = select([andPred(lt(col('c'), col('d')), eq(col('b'), col('a')))], get('t'));
  assert.equal(logicalFingerprint(and1), logicalFingerprint(and2));

  // FNV hash is deterministic.
  assert.equal(fnv1aHash('abc'), fnv1aHash('abc'));
  assert.ok(fnv1aHash('abc') !== fnv1aHash('abd'));
});

test('the same shape under different correlation contexts stays in separate groups', () => {
  const memo = new Memo();
  const plain = get('lineitem', ctx('root'));
  const parameterized = get('lineitem', ctx('subq1', ['lineitem_order']));
  const g1 = memo.add(plain);
  const g2 = memo.add(parameterized);
  assert.notEqual(memo.find(g1), memo.find(g2));

  // Re-interning the parameterized shape reuses its own group only.
  const g3 = memo.add(get('lineitem', ctx('subq1', ['lineitem_order'])));
  assert.equal(memo.find(g2), memo.find(g3));
  assert.notEqual(memo.find(g1), memo.find(g3));
});

test('unionGroups refuses cross-context merges', () => {
  const memo = new Memo();
  const g1 = memo.add(get('t', ctx('root')));
  const g2 = memo.add(get('t', ctx('subq', ['p'])));
  assert.throws(
    () => memo.unionGroups(g1, g2),
    /refusing to merge groups across correlation contexts/,
  );
});

test('join commutativity and associativity populate one equivalence group', () => {
  const memo = new Memo();
  const tree = join(
    [eq(col('a'), col('b'))],
    join([eq(col('b'), col('c'))], get('orders'), get('customer')),
    get('lineitem'),
  );
  const root = memo.add(tree);
  explore(memo, root, { columnOwners: columnOwners() });

  const equivalent = memo.materialize(root);
  const fingerprints = new Set(equivalent.map(logicalFingerprint));
  // Commute + associate must produce structurally distinct alternatives.
  assert.ok(fingerprints.size >= 4, `expected >=4 alternatives, got ${fingerprints.size}`);
  // Every alternative is still a join over the same three relations.
  for (const alt of equivalent) {
    assert.equal(alt.op.kind, 'InnerJoin');
  }
  // Every alternative lives in one merged group.
  assert.equal(memo.groupCount(), memo.roots().length);
});

test('select pushdown moves single-table predicates below the join', () => {
  const memo = new Memo();
  const tree = select(
    [eq(col('customer_nation'), col('customer_id')), lt(col('orders_id'), col('customer_id'))],
    join([eq(col('orders_cust'), col('customer_id'))], get('orders'), get('customer')),
  );
  const root = memo.add(tree);
  explore(memo, root, { columnOwners: columnOwners() });

  const alternatives = memo.materialize(root);
  const pushed = alternatives.find((alt) => {
    const walk = (node: LogicalTree): boolean => {
      if (node.op.kind === 'Select' && node.children[0].op.kind === 'Get') return true;
      return node.children.some(walk);
    };
    return walk(alt);
  });
  assert.ok(pushed, 'expected at least one alternative with a pushed-down Select');
});

test('plan fingerprints are canonical across equal physical shapes', () => {
  const planA = {
    op: 'HashJoin' as const,
    children: [
      { op: 'SeqScan' as const, children: [], relation: 'a', ctx: ctx('root') },
      { op: 'SeqScan' as const, children: [], relation: 'b', ctx: ctx('root') },
    ],
    predicates: [eq(col('x'), col('y'))],
    ctx: ctx('root'),
  };
  const planB = {
    ...planA,
    predicates: [eq(col('y'), col('x'))],
  };
  assert.equal(planFingerprint(planA), planFingerprint(planB));
});
