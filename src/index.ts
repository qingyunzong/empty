export { canonical, equal } from './canonical.js';
export { merge } from './merge.js';
export { applyPlan, buildPlan } from './plan.js';
export { ResolutionStore } from './resolution.js';
export { verifyMerge } from './verify.js';
export type {
  AppliedResolution,
  ChangePlan,
  Conflict,
  ConflictKind,
  DocFile,
  FieldValue,
  MergeResult,
  PlanOp,
  Resolution,
  ResolutionChoice,
  Snapshot,
} from './types.js';
