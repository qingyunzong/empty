export {
  compareAtoms,
  compareRows,
  compareUtf8,
  canonicalRowOrder,
  inputFingerprint,
} from './src/canonical.ts';
export { JoinEngineError, type JoinErrorCode } from './src/errors.ts';
export { buildPlan } from './src/plan.ts';
export { reduceJoin } from './src/reduction.ts';
export {
  JoinIterator,
  createJoinIterator,
  mergeVector,
  resumeJoinIterator,
} from './src/iterator.ts';
export type {
  Atom,
  DirectedEdge,
  JoinInput,
  JoinPlan,
  JoinResultBatch,
  ReductionReport,
  ReductionResult,
  ReductionStep,
  Row,
  RowReport,
} from './src/types.ts';
