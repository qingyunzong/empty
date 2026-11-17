import { ctxCanon, logicalFingerprint } from './fingerprint.ts';
import type { CorrCtx, LogicalTree } from './types.ts';

/**
 * Cascades-style memo.
 *
 * Equivalent logical expressions share a group (`Group`). Groups are scoped by
 * correlation context (`CorrCtx`): the same logical shape under different
 * `pathId`/parameter sets lands in different groups, so correlated subqueries
 * and parameterized paths can never be merged with their uncorrelated twins.
 *
 * Equivalence discovered by transformation rules is recorded with
 * `unionGroups` (union-find with path compression). Union is only ever applied
 * within one correlation context.
 */

export interface GroupExpr {
  /** Stable intern id. */
  id: number;
  tree: LogicalTree;
  /** Child group roots, aligned with `tree.children`. */
  childGroups: number[];
  /** Correlation context snapshot at intern time. */
  ctx: CorrCtx;
  key: string;
}

export interface Group {
  id: number;
  ctx: CorrCtx;
  exprs: Set<number>;
}

export class Memo {
  private nextGroupId = 0;
  private nextExprId = 0;
  private groups = new Map<number, Group>();
  private parent = new Map<number, number>();
  private exprs = new Map<number, GroupExpr>();
  /** Structural key (includes ctx) -> group root. */
  private keyToGroup = new Map<string, number>();

  /** Intern a full logical tree bottom-up and return the id of its group. */
  add(tree: LogicalTree): number {
    const childGroups = tree.children.map((child) => this.add(child));
    return this.intern(tree, childGroups);
  }

  /**
   * Intern a single group expression whose children are already memoized
   * group ids. Returns the (possibly existing) containing group.
   */
  intern(tree: LogicalTree, childGroups: number[]): number {
    const ctx = normalizeCtx(tree.ctx);
    const key = structuralKey(tree, childGroups, ctx);
    const existing = this.keyToGroup.get(key);
    if (existing !== undefined) return this.find(existing);

    const groupId = this.nextGroupId++;
    const exprId = this.nextExprId++;
    this.groups.set(groupId, { id: groupId, ctx, exprs: new Set([exprId]) });
    this.parent.set(groupId, groupId);
    this.exprs.set(exprId, {
      id: exprId,
      tree,
      childGroups: childGroups.map((g) => this.find(g)),
      ctx,
      key,
    });
    this.keyToGroup.set(key, groupId);
    return groupId;
  }

  /** Find the canonical group root with path compression. */
  find(groupId: number): number {
    let root = groupId;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    let cursor = groupId;
    while (cursor !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  /**
   * Declare two groups equivalent. Refuses to merge groups belonging to
   * different correlation contexts — that would conflate a correlated
   * subquery / parameterized path with an incompatible scope.
   */
  unionGroups(a: number, b: number): number {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    const ga = this.groups.get(ra)!;
    const gb = this.groups.get(rb)!;
    if (ctxCanon(ga.ctx) !== ctxCanon(gb.ctx)) {
      throw new Error(
        `refusing to merge groups across correlation contexts ` +
          `${ctxCanon(ga.ctx)} vs ${ctxCanon(gb.ctx)}`,
      );
    }
    // Deterministic root choice keeps fingerprints stable across runs.
    const keep = Math.min(ra, rb);
    const drop = Math.max(ra, rb);
    this.parent.set(drop, keep);
    const target = this.groups.get(keep)!;
    for (const exprId of gb.exprs) {
      target.exprs.add(exprId);
      const expr = this.exprs.get(exprId)!;
      this.keyToGroup.set(expr.key, keep);
    }
    gb.exprs.clear();
    return keep;
  }

  getGroup(groupId: number): Group {
    return this.groups.get(this.find(groupId))!;
  }

  getExpr(exprId: number): GroupExpr {
    const expr = this.exprs.get(exprId)!;
    return {
      ...expr,
      childGroups: expr.childGroups.map((g) => this.find(g)),
    };
  }

  groupCount(): number {
    let count = 0;
    for (const [id] of this.groups) if (this.find(id) === id) count++;
    return count;
  }

  exprCount(): number {
    return this.exprs.size;
  }

  /** Snapshot of all live group roots (stable ordering by id). */
  roots(): number[] {
    return [...this.groups.keys()].filter((id) => this.find(id) === id).sort((a, b) => a - b);
  }

  /** Reconstruct every equivalent logical tree of a group. */
  materialize(groupId: number): LogicalTree[] {
    const root = this.find(groupId);
    const cache = new Map<number, LogicalTree[]>();
    const build = (gid: number): LogicalTree[] => {
      const canonical = this.find(gid);
      const cached = cache.get(canonical);
      if (cached) return cached;
      const group = this.groups.get(canonical)!;
      const out: LogicalTree[] = [];
      for (const exprId of group.exprs) {
        const expr = this.exprs.get(exprId)!;
        const childOptions = expr.childGroups.map((child) => build(this.find(child)));
        for (const combo of cartesian(childOptions)) {
          out.push({ op: expr.tree.op, children: combo, ctx: expr.ctx });
        }
      }
      cache.set(canonical, out);
      return out;
    };
    return build(root);
  }
}

function normalizeCtx(ctx: CorrCtx): CorrCtx {
  return { pathId: ctx.pathId, params: [...ctx.params].sort() };
}

function structuralKey(tree: LogicalTree, childGroups: number[], ctx: CorrCtx): string {
  return `${logicalFingerprint({ ...tree, ctx })}#kids=[${childGroups.join(',')}]`;
}

function cartesian<T>(options: T[][]): T[][] {
  let result: T[][] = [[]];
  for (const option of options) {
    const next: T[][] = [];
    for (const prefix of result) {
      for (const value of option) next.push([...prefix, value]);
    }
    result = next;
  }
  return result;
}
