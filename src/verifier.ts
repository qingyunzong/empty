import { planFingerprint } from './fingerprint.ts';
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
 * Exhaustive plan-space verifier.
 *
 * Unlike the branch-and-bound optimizer, this enumerates every feasible
 * physical plan for a (group, required properties) pair without cost pruning.
 * It shares the exact candidate/enforcer catalog with the optimizer, so the
 * finite enumerated space is precisely the space the optimizer searches.
 * Enforcer chains are depth-capped at two layers, guaranteeing termination.
 *
 * The verifier confirms:
 *  1. every enumerated plan delivers the required properties,
 *  2. the optimizer's winner is present in the space,
 *  3. no enumerated plan is strictly cheaper than the winner,
 *  4. the winner equals the lexicographic fingerprint tie-break choice.
 */

const MAX_ENFORCER_DEPTH = 2;

export interface EnumeratedPlan {
  plan: PhysicalPlan;
  cost: number;
  rows: number;
  fingerprint: string;
}

export interface ExhaustiveReport {
  plans: EnumeratedPlan[];
  planCount: number;
  best: EnumeratedPlan;
}

export interface VerificationVerdict {
  ok: boolean;
  planCount: number;
  reasons: string[];
  best: EnumeratedPlan;
}

export interface VerifyOptions {
  memo: Memo;
  rootGroup: number;
  required: PhysicalProps;
  stats: StatsCatalog;
  costModel: CostModel;
}

export function enumerateAll(options: VerifyOptions): ExhaustiveReport {
  const { memo, rootGroup, required, stats, costModel } = options;
  const catalog: CatalogContext = { memo, stats, costModel };
  const cache = new Map<string, EnumeratedPlan[]>();

  const plans = enumerate(memo.find(rootGroup), required, 0);
  if (plans.length === 0) {
    throw new Error('exhaustive enumeration found zero feasible plans');
  }
  const best = selectBest(plans);
  return { plans, planCount: plans.length, best };

  function enumerate(groupId: number, req: PhysicalProps, depth: number): EnumeratedPlan[] {
    const root = memo.find(groupId);
    const key = `${root}:${req.order ? req.order.join(',') : '*'}:${req.distribution ?? '*'}:d${depth}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const found = new Map<string, EnumeratedPlan>();
    const emit = (entry: EnumeratedPlan): void => {
      if (!satisfies(planDelivers(entry.plan), req)) return;
      if (!found.has(entry.fingerprint)) found.set(entry.fingerprint, entry);
    };

    const group = memo.getGroup(root);
    for (const exprId of group.exprs) {
      const exprRecord = memo.getExpr(exprId);
      const tree = exprRecord.tree;
      const correlated = tree.ctx.params.length > 0;
      const base = candidatesFor(tree, [0], catalog);
      const all =
        tree.op.kind === 'Get'
          ? [...base, ...parameterizedScanCandidates(tree.op.relation, catalog, tree.ctx.params, [])]
          : base;
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

      for (const candidate of [...all, ...scanRewrites]) {
        if (correlated && !candidate.correlationCapable) continue;
        const childGroups = candidate.op === 'ParamIndexScan' ? [] : exprRecord.childGroups;
        const childSpaces = childGroups.map((child, index) =>
          enumerate(child, candidate.requiredChildren[index], depth),
        );
        if (childSpaces.some((space) => space.length === 0)) continue;

        for (const combo of cartesian(childSpaces)) {
          const childStats: SubtreeStats[] = combo.map((entry) => ({ rows: entry.rows }));
          const cost =
            combo.reduce((sum, entry) => sum + entry.cost, 0) +
            costModel.localCost(candidate.op, childStats, {
              relation: candidate.planMeta.relation,
              predicates: candidate.planMeta.predicates,
              groupCols: candidate.planMeta.groupCols,
              indexCols: candidate.planMeta.indexCols,
              stats,
            });
          const plan: PhysicalPlan = {
            op: candidate.op,
            children: combo.map((entry) => entry.plan),
            relation: candidate.planMeta.relation,
            predicates: candidate.planMeta.predicates,
            groupCols: candidate.planMeta.groupCols,
            indexCols: candidate.planMeta.indexCols,
            params: candidate.planMeta.params,
            order: candidate.delivers.order,
            distribution: candidate.delivers.distribution ?? undefined,
            ctx: tree.ctx,
          };
          emit({
            plan,
            cost,
            rows:
              candidate.op === 'ParamIndexScan'
                ? candidate.outputRows([])
                : candidate.outputRows(combo.map((entry) => entry.rows)),
            fingerprint: planFingerprint(plan),
          });
        }
      }
    }

    if (depth < MAX_ENFORCER_DEPTH) {
      for (const enforcer of enforcerCandidates(req)) {
        if (group.ctx.params.length > 0 && !enforcer.correlationCapable) continue;
        const childReq = relax(req, enforcer.op);
        for (const child of enumerate(root, childReq, depth + 1)) {
          const cost =
            child.cost +
            costModel.localCost(enforcer.op, [{ rows: child.rows }], {
              indexCols: enforcer.planMeta.indexCols,
              stats,
            });
          const plan: PhysicalPlan = {
            op: enforcer.op,
            children: [child.plan],
            indexCols: enforcer.planMeta.indexCols,
            order: enforcer.delivers.order,
            distribution: enforcer.delivers.distribution ?? undefined,
            ctx: group.ctx,
          };
          emit({
            plan,
            cost,
            rows: enforcer.outputRows([child.rows]),
            fingerprint: planFingerprint(plan),
          });
        }
      }
    }

    const out = [...found.values()];
    cache.set(key, out);
    return out;
  }
}

export function verifyWinner(
  options: VerifyOptions,
  winner: { plan: PhysicalPlan; cost: number },
): VerificationVerdict {
  const report = enumerateAll(options);
  const reasons: string[] = [];
  const winnerFingerprint = planFingerprint(winner.plan);

  for (const entry of report.plans) {
    if (!satisfies(planDelivers(entry.plan), options.required)) {
      reasons.push(`plan ${entry.fingerprint} violates required properties`);
    }
  }

  const exact = report.plans.find((entry) => entry.fingerprint === winnerFingerprint);
  if (!exact) {
    reasons.push('optimizer winner is not part of the exhaustive plan space');
  } else if (exact.cost !== winner.cost) {
    reasons.push(
      `winner cost ${winner.cost} disagrees with enumerated cost ${exact.cost}`,
    );
  }

  const cheaper = report.plans.filter((entry) => entry.cost < winner.cost);
  if (cheaper.length > 0) {
    reasons.push(
      `${cheaper.length} enumerated plan(s) are cheaper than the winner ` +
        `(best ${report.best.fingerprint} cost ${report.best.cost})`,
    );
  }

  if (report.best.fingerprint !== winnerFingerprint) {
    reasons.push(
      `fingerprint tie-break winner should be ${report.best.fingerprint} but got ${winnerFingerprint}`,
    );
  }

  return { ok: reasons.length === 0, planCount: report.planCount, reasons, best: report.best };
}

function selectBest(plans: EnumeratedPlan[]): EnumeratedPlan {
  return plans.reduce((best, entry) => {
    if (entry.cost < best.cost) return entry;
    if (entry.cost === best.cost && entry.fingerprint < best.fingerprint) return entry;
    return best;
  });
}

function relax(req: PhysicalProps, op: PhysicalPlan['op']): PhysicalProps {
  if (op === 'Sort') return { order: null, distribution: req.distribution };
  if (op === 'Exchange') return { order: req.order, distribution: null };
  return req;
}

function cartesian<T>(spaces: T[][]): T[][] {
  let result: T[][] = [[]];
  for (const space of spaces) {
    const next: T[][] = [];
    for (const prefix of result) for (const value of space) next.push([...prefix, value]);
    result = next;
  }
  return result;
}
