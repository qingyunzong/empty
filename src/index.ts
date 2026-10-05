import { merge, MergeInput, MergeResult } from './merge.js';
import { MergedFile, Snapshot } from './model.js';
import { buildPlan, ChangePlan, verifyPlan } from './plan.js';

export * from './model.js';
export * from './merge.js';
export * from './plan.js';

export interface SyncOutcome {
  merge: MergeResult;
  /** 存在未解决冲突时为 null；否则为已通过原子性校验的变更计划。 */
  plan: ChangePlan | null;
}

/** 高层入口：三方合并 -> 无冲突则产出并校验原子变更计划。 */
export function synchronize(input: MergeInput): SyncOutcome {
  const result = merge(input);
  if (result.conflicts.length > 0) return { merge: result, plan: null };
  const plan = buildPlan(input.base as Snapshot, result.state as Record<string, MergedFile>);
  verifyPlan(input.base as Snapshot, result.state as Record<string, MergedFile>, plan);
  return { merge: result, plan };
}
