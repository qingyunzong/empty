import { isValidAssignment } from './problem.js';
import type { Assignment, Problem } from './types.js';

/**
 * Shrink one variable of `assignment` toward `target` as far as possible
 * while every constraint still holds. Returns the improved assignment, or
 * `undefined` when no strictly smaller step is valid.
 */
function shrinkVar(
  problem: Problem,
  assignment: Assignment,
  name: string,
  target: number,
): Assignment | undefined {
  const current = assignment[name];
  if (current === undefined || current === target) return undefined;
  // Scan from `target` toward `current` and keep the first valid value, i.e.
  // the one closest to `target`. Linear scan stays sound for non-monotonic
  // constraints (parity, modular, ...) where binary search would not be.
  const step = target < current ? 1 : -1;
  for (let value = target; value !== current; value += step) {
    const candidate: Assignment = { ...assignment, [name]: value };
    if (isValidAssignment(problem, candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Greedily shrink an assignment toward each variable's domain minimum while
 * preserving every constraint. Every intermediate candidate is validated, so
 * the result is guaranteed to satisfy the problem.
 *
 * Deterministic; intended for reducing counterexamples to minimal witnesses.
 */
export function shrinkAssignment(problem: Problem, assignment: Assignment): Assignment {
  if (!isValidAssignment(problem, assignment)) {
    throw new Error('shrinkAssignment requires a valid starting assignment');
  }
  let current: Assignment = { ...assignment };
  let improved = true;
  while (improved) {
    improved = false;
    for (const v of problem.vars) {
      const target = Math.max(v.min, Math.min(0, v.max));
      const next = shrinkVar(problem, current, v.name, target);
      if (next !== undefined) {
        current = next;
        improved = true;
      }
    }
  }
  return current;
}
