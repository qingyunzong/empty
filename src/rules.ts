import { Memo } from './memo.ts';
import {
  createColumnOwnerResolver,
  flattenAnd,
  predicateBelongsTo,
  predicateColumns,
  relationNames,
  type ColumnOwnerResolver,
} from './rules-helpers.ts';
import type { LogicalTree, Predicate } from './types.ts';

/**
 * Logical exploration rules.
 *
 * Rules only ever read and produce expressions within one correlation
 * context. Equivalent groups are merged via `Memo.unionGroups`, which itself
 * rejects cross-context merges, so correlated subqueries and parameterized
 * paths can never be incorrectly combined.
 */

export interface RuleResult {
  tree: LogicalTree;
  /** Group id of the produced tree (interned). */
  groupId: number;
  rule: string;
}

export interface ExploreOptions {
  /** Explicit column -> base relation ownership; prefix convention is the fallback. */
  columnOwners?: Record<string, string>;
}

type Rule = (
  expr: LogicalTree,
  childGroups: number[],
  memo: Memo,
  ownerOf: ColumnOwnerResolver,
) => RuleResult[];

const RULES: Rule[] = [ruleSelectPushdown, ruleJoinCommute, ruleJoinAssociate];

export function explore(memo: Memo, rootGroup: number, options: ExploreOptions = {}): RuleResult[] {
  const ownerOf = createColumnOwnerResolver(options.columnOwners);
  const fired: RuleResult[] = [];
  const seen = new Set<string>();
  const dirty = new Set<number>(memo.roots());

  while (dirty.size > 0) {
    const groupId = dirty.values().next().value!;
    dirty.delete(groupId);
    const root = memo.find(groupId);
    if (root !== groupId) {
      dirty.add(root);
      continue;
    }
    const group = memo.getGroup(root);
    let producedNewExpression = false;
    for (const exprId of group.exprs) {
      const expr = memo.getExpr(exprId);
      for (const rule of RULES) {
        const token = `${rule.name}:${expr.id}`;
        if (seen.has(token)) continue;
        seen.add(token);
        for (const result of rule(expr.tree, expr.childGroups, memo, ownerOf)) {
          const resultRoot = memo.find(result.groupId);
          if (resultRoot !== root) {
            memo.unionGroups(root, resultRoot);
            producedNewExpression = true;
          }
          fired.push(result);
        }
      }
    }
    if (producedNewExpression) dirty.add(memo.find(root));
  }

  void memo.find(rootGroup);
  return dedupeResults(fired);
}

function dedupeResults(results: RuleResult[]): RuleResult[] {
  const seen = new Set<string>();
  const out: RuleResult[] = [];
  for (const result of results) {
    const token = `${result.rule}:${result.groupId}`;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(result);
  }
  return out;
}

/**
 * Select pushdown: push each conjunct down to the smallest input whose
 * relation set owns all of the predicate's columns. Predicates that reference
 * multiple inputs stay above the join.
 */
function ruleSelectPushdown(
  expr: LogicalTree,
  _childGroups: number[],
  memo: Memo,
  ownerOf: ColumnOwnerResolver,
): RuleResult[] {
  if (expr.op.kind !== 'Select' || expr.children.length !== 1) return [];
  const child = expr.children[0];
  const conjuncts = flattenAnd(expr.op.predicates);
  if (conjuncts.length === 0 || child.op.kind === 'Get') return [];

  const stay: Predicate[] = [];
  const perChild: Predicate[][] = child.children.map(() => []);
  const childRelations = child.children.map((sub) => relationNames(sub));

  for (const pred of conjuncts) {
    let target = -1;
    childRelations.forEach((relations, index) => {
      if (predicateBelongsTo(pred, relations, ownerOf)) target = index;
    });
    if (target >= 0) perChild[target].push(pred);
    else stay.push(pred);
  }

  if (perChild.every((list) => list.length === 0)) return [];

  const newChildren = child.children.map((sub, index) => {
    if (perChild[index].length === 0) return sub;
    const filtered: LogicalTree = {
      op: { kind: 'Select', predicates: perChild[index] },
      children: [sub],
      ctx: expr.ctx,
    };
    return filtered;
  });

  let newChild: LogicalTree = { ...child, children: newChildren };
  if (stay.length > 0) {
    newChild = {
      op: { kind: 'Select', predicates: stay },
      children: [newChild],
      ctx: expr.ctx,
    };
  }

  const groupId = memo.add(newChild);
  return [{ tree: newChild, groupId, rule: 'SelectPushdown' }];
}

/** Inner join commutativity: A ⨝ B -> B ⨝ A (predicates are symmetric). */
function ruleJoinCommute(
  expr: LogicalTree,
  childGroups: number[],
  memo: Memo,
): RuleResult[] {
  if (expr.op.kind !== 'InnerJoin' || expr.children.length !== 2) return [];
  const swapped: LogicalTree = {
    op: expr.op,
    children: [expr.children[1], expr.children[0]],
    ctx: expr.ctx,
  };
  const groupId = memo.intern(swapped, [childGroups[1], childGroups[0]]);
  return [{ tree: swapped, groupId, rule: 'JoinCommute' }];
}

/**
 * Inner join associativity.
 *
 * (A ⨝p1 B) ⨝p2 C -> A ⨝ (B ⨝ (p1+p2_BC) C), moving conjuncts of p2 that
 * only reference B/C columns into the inner join. Combined with commutativity
 * this reaches every bushy and left/right-deep join ordering.
 */
function ruleJoinAssociate(
  expr: LogicalTree,
  _childGroups: number[],
  memo: Memo,
  ownerOf: ColumnOwnerResolver,
): RuleResult[] {
  if (expr.op.kind !== 'InnerJoin' || expr.children.length !== 2) return [];
  const left = expr.children[0];
  const right = expr.children[1];
  if (left.op.kind !== 'InnerJoin' || left.children.length !== 2) return [];

  const a = left.children[0];
  const b = left.children[1];
  const namesA = relationNames(a);
  const namesBC = new Set([...relationNames(b), ...relationNames(right)]);

  const moveInner: Predicate[] = [];
  const keepOuter: Predicate[] = [];
  for (const pred of flattenAnd(expr.op.predicates)) {
    const cols = predicateColumns(pred);
    const touchesA = cols.some((column) => namesA.has(ownerOf(column) ?? ''));
    const insideBC = predicateBelongsTo(pred, namesBC, ownerOf);
    if (!touchesA && insideBC) moveInner.push(pred);
    else keepOuter.push(pred);
  }

  const innerJoin: LogicalTree = {
    op: {
      kind: 'InnerJoin',
      predicates: [...flattenAnd(left.op.predicates), ...moveInner],
    },
    children: [b, right],
    ctx: expr.ctx,
  };
  const reassociated: LogicalTree = {
    op: { kind: 'InnerJoin', predicates: keepOuter },
    children: [a, innerJoin],
    ctx: expr.ctx,
  };

  const groupId = memo.add(reassociated);
  return [{ tree: reassociated, groupId, rule: 'JoinAssociate' }];
}
