export * from './types.ts';
export * from './fingerprint.ts';
export { Memo } from './memo.ts';
export type { Group, GroupExpr } from './memo.ts';
export { explore } from './rules.ts';
export { createCostModel, defaultLocalCost, defaultSelectivity, defaultAggregateRows } from './cost.ts';
export {
  candidatesFor,
  enforcerCandidates,
  parameterizedScanCandidates,
  satisfies,
  planDelivers,
} from './physical.ts';
export type { PhysicalCandidate, CatalogContext } from './physical.ts';
export { optimize, explain } from './optimizer.ts';
export type { OptimizationResult, OptimizeOptions } from './optimizer.ts';
export { enumerateAll, verifyWinner } from './verifier.ts';
export type { EnumeratedPlan, ExhaustiveReport, VerificationVerdict } from './verifier.ts';

import { Memo } from './memo.ts';
import { explore } from './rules.ts';
import { optimize, type OptimizationResult } from './optimizer.ts';
import { verifyWinner, type VerificationVerdict } from './verifier.ts';
import type {
  CostModel,
  LogicalTree,
  PhysicalProps,
  StatsCatalog,
} from './types.ts';

export interface BuiltMemo {
  memo: Memo;
  rootGroup: number;
}

/** Intern a logical tree and run all logical exploration rules. */
export function buildMemo(tree: LogicalTree, columnOwners?: Record<string, string>): BuiltMemo {
  const memo = new Memo();
  const rootGroup = memo.add(tree);
  explore(memo, rootGroup, { columnOwners });
  return { memo, rootGroup: memo.find(rootGroup) };
}

export interface OptimizeQueryOptions {
  tree: LogicalTree;
  stats: StatsCatalog;
  costModel: CostModel;
  required?: PhysicalProps;
}

/** One-shot entry point: build memo, optimize with branch and bound. */
export function optimizeQuery(options: OptimizeQueryOptions): OptimizationResult {
  const built = buildMemo(options.tree);
  return optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required: options.required ?? { order: null, distribution: null },
    stats: options.stats,
    costModel: options.costModel,
  });
}

/**
 * Full correctness harness: optimize then independently enumerate the whole
 * plan space and verify global optimality, property satisfaction and the
 * fingerprint tie break.
 */
export function optimizeAndVerify(options: OptimizeQueryOptions): {
  result: OptimizationResult;
  verdict: VerificationVerdict;
} {
  const built = buildMemo(options.tree);
  const required = options.required ?? { order: null, distribution: null };
  const result = optimize({
    memo: built.memo,
    rootGroup: built.rootGroup,
    required,
    stats: options.stats,
    costModel: options.costModel,
  });
  const verdict = verifyWinner(
    {
      memo: built.memo,
      rootGroup: built.rootGroup,
      required,
      stats: options.stats,
      costModel: options.costModel,
    },
    { plan: result.plan, cost: result.cost },
  );
  return { result, verdict };
}
