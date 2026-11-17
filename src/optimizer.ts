import { fingerprintLess, planFingerprint } from './fingerprint.ts';
import { Memo } from './memo.ts';
import {
  candidatesFor,
  enforcerCandidates,
  parameterizedScanCandidates,
  planDelivers,
  satisfies,
  type CatalogContext,
} from './physical.ts';
import type {
  CostModel,
  PhysicalPlan,
  PhysicalProps,
  StatsCatalog,
  SubtreeStats,
} from './types.ts';

/**
 * Branch-and-bound memo optimizer.
 *
 * For each (group, required physical properties) pair the optimizer keeps the
 * cheapest plan found so far. During enumeration every partial plan whose
 * additive cost already reaches the incumbent bound is pruned (bound), and
 * equal-cost plans are resolved deterministically by canonical fingerprint
 * (stable tie break). Physical property requirements are pushed down onto
 * child groups as candidate requirements; Sort/Exchange enforcers close any
 * remaining property gap.
 */

export interface OptimizationResult {
  plan: PhysicalPlan;
  cost: number;
  rows: number;
  /** Number of partial plans discarded by the cost bound. */
  pruned: number;
  /** Number of plan candidates evaluated (including enforcers). */
  evaluated: number;
}

interface CacheEntry {
  plan: PhysicalPlan;
  cost: number;
  rows: number;
}

export interface OptimizeOptions {
  memo: Memo;
  rootGroup: number;
  required: PhysicalProps;
  stats: StatsCatalog;
  costModel: CostModel;
}

export function optimize(options: OptimizeOptions): OptimizationResult {
  const { memo, rootGroup, required, stats, costModel } = options;
  const catalog: CatalogContext = { memo, stats, costModel };
  const cache = new Map<string, CacheEntry>();
  const counters = { pruned: 0, evaluated: 0 };

  const best = optimizeGroup(memo.find(rootGroup), required, 0);
  if (!best) {
    throw new Error(
      `no physical plan satisfies required properties ${JSON.stringify(required)}`,
    );
  }
  if (!satisfies(planDelivers(best.plan), required)) {
    throw new Error('internal error: winner plan fails required properties');
  }
  return { ...best, pruned: counters.pruned, evaluated: counters.evaluated };

  function optimizeGroup(
    groupId: number,
    req: PhysicalProps,
    enforcerDepth: number,
  ): CacheEntry | null {
    const root = memo.find(groupId);
    const key = `${root}:${req.order ? req.order.join(',') : '*'}:${req.distribution ?? '*'}:d${enforcerDepth}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const incumbent: { value: CacheEntry | null } = { value: null };
    const consider = (entry: CacheEntry): void => {
      counters.evaluated++;
      if (!satisfies(planDelivers(entry.plan), req)) return;
      const current = incumbent.value;
      if (current === null) {
        incumbent.value = entry;
      } else if (entry.cost < current.cost) {
        incumbent.value = entry;
      } else if (entry.cost === current.cost && fingerprintLess(entry.plan, current.plan)) {
        incumbent.value = entry;
      }
    };
    const correlatedGroup = memo.getGroup(root).ctx.params.length > 0;

    const group = memo.getGroup(root);
    for (const exprId of group.exprs) {
      const exprRecord = memo.getExpr(exprId);
      const tree = exprRecord.tree;
        const correlated = tree.ctx.params.length > 0;

      const baseCandidates = candidatesFor(tree, [0], catalog);
      const allCandidates =
        tree.op.kind === 'Get'
          ? [
              ...baseCandidates,
              ...parameterizedScanCandidates(tree.op.relation, catalog, tree.ctx.params, []),
            ]
          : baseCandidates;

      // A correlated Select directly over a Get may be implemented by a
      // parameterized index scan: the correlated equality predicates drive the
      // index probe, replacing Filter + scan entirely.
      const scanRewrites =
        tree.op.kind === 'Select' &&
        correlated &&
        tree.children.length === 1 &&
        tree.children[0].op.kind === 'Get'
          ? parameterizedScanCandidates(
              tree.children[0].op.relation,
              catalog,
              tree.ctx.params,
              tree.op.predicates,
            )
          : [];

      for (const candidate of [...allCandidates, ...scanRewrites]) {
        if (correlated && !candidate.correlationCapable) continue;
        const childEntries = enumerateChildren(
          candidate.op === 'ParamIndexScan' ? [] : exprRecord.childGroups,
          candidate.requiredChildren,
          enforcerDepth,
        );
        if (!childEntries) continue;

        const childStats: SubtreeStats[] = childEntries.map((entry) => ({ rows: entry.rows }));
        const childCost = childEntries.reduce((sum, entry) => sum + entry.cost, 0);
        const local = costModel.localCost(
          candidate.op,
          childStats,
          {
            relation: candidate.planMeta.relation,
            predicates: candidate.planMeta.predicates,
            groupCols: candidate.planMeta.groupCols,
            indexCols: candidate.planMeta.indexCols,
            stats,
          },
        );
        const total = childCost + local;

        // Branch and bound: prune against the running incumbent immediately.
        if (incumbent.value !== null && total > incumbent.value.cost) {
          counters.pruned++;
          continue;
        }

        const plan: PhysicalPlan = {
          op: candidate.op,
          children: childEntries.map((entry) => entry.plan),
          relation: candidate.planMeta.relation,
          predicates: candidate.planMeta.predicates,
          groupCols: candidate.planMeta.groupCols,
          indexCols: candidate.planMeta.indexCols,
          params: candidate.planMeta.params,
          order: candidate.delivers.order,
          distribution: candidate.delivers.distribution ?? undefined,
          ctx: tree.ctx,
        };
        consider({
          plan,
          cost: total,
          rows: candidate.outputRows(childEntries.map((entry) => entry.rows)),
        });
      }
    }

    // Enforcers: at most two layers (Sort and/or Exchange) to guarantee
    // termination of property completion.
    if (enforcerDepth < 2) {
      for (const enforcer of enforcerCandidates(req)) {
        if (correlatedGroup && !enforcer.correlationCapable) continue;
        const childReq = relaxFor(req, enforcer.op);
        const child = optimizeGroup(root, childReq, enforcerDepth + 1);
        if (!child) continue;
        const total =
          child.cost +
          costModel.localCost(
            enforcer.op,
            [{ rows: child.rows }],
            { indexCols: enforcer.planMeta.indexCols, stats },
          );
        if (incumbent.value !== null && total > incumbent.value.cost) {
          counters.pruned++;
          continue;
        }
        const plan: PhysicalPlan = {
          op: enforcer.op,
          children: [child.plan],
          indexCols: enforcer.planMeta.indexCols,
          order: enforcer.delivers.order,
          distribution: enforcer.delivers.distribution ?? undefined,
          ctx: group.ctx,
        };
        consider({ plan, cost: total, rows: enforcer.outputRows([child.rows]) });
      }
    }

    if (incumbent.value) cache.set(key, incumbent.value);
    return incumbent.value;
  }

  function enumerateChildren(
    childGroups: number[],
    requiredChildren: PhysicalProps[],
    enforcerDepth: number,
  ): CacheEntry[] | null {
    const entries: CacheEntry[] = [];
    for (let index = 0; index < childGroups.length; index++) {
      const entry = optimizeGroup(childGroups[index], requiredChildren[index], enforcerDepth);
      if (!entry) return null;
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Relax the requirement that this enforcer itself provides, so the
   * recursive search does not re-request the same enforcer forever.
   */
  function relaxFor(req: PhysicalProps, enforcer: PhysicalPlan['op']): PhysicalProps {
    if (enforcer === 'Sort') return { order: null, distribution: req.distribution };
    if (enforcer === 'Exchange') return { order: req.order, distribution: null };
    return req;
  }
}

export function explain(result: OptimizationResult): string {
  return planFingerprint(result.plan);
}
