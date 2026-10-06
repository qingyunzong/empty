export type {
  Assignment,
  Budget,
  Constraint,
  IntVar,
  Problem,
  SolveResult,
  SolveStatus,
} from './types.js';
export { ProblemError, defineProblem, isValidAssignment } from './problem.js';
export { enumerateSolutions, sampleRandom } from './solve.js';
export type { SampleOptions } from './solve.js';
export { shrinkAssignment } from './shrink.js';
