import { satisfies } from './problem.js';
import type { Assignment, Problem } from './problem.js';

/**
 * Shrinks each variable toward its domain minimum, accepting a smaller value
 * only when every constraint still holds. The result is therefore always a
 * valid sample that is componentwise <= the input. Repeats to a fixpoint.
 */
export function shrink(problem: Problem, assignment: Assignment): Assignment {
  if (!satisfies(problem, assignment)) {
    throw new Error('cannot shrink: assignment does not satisfy the problem');
  }
  const current: Record<string, number> = { ...assignment };
  let improved = true;
  while (improved) {
    improved = false;
    for (const v of problem.variables) {
      const from = current[v.name] as number;
      if (from === v.min) continue;
      const tryValue = (val: number): boolean => {
        if (satisfies(problem, { ...current, [v.name]: val })) {
          current[v.name] = val;
          return true;
        }
        return false;
      };
      if (tryValue(v.min)) {
        improved = true;
        continue;
      }
      // Binary search the smallest still-valid value in (min, from].
      let lo = v.min; // known invalid (or untested)
      let hi = from; // known valid
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (tryValue(mid)) hi = mid;
        else lo = mid;
      }
      if ((current[v.name] as number) !== from) improved = true;
    }
  }
  return Object.freeze(current);
}
