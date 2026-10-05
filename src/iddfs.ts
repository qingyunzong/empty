/**
 * Backtracking search (iterative deepening DFS) with sound learning.
 *
 * Learning rule (sound — never excludes an unexplored feasible path):
 * when dfs(s, r) returns false, we record `failed[key(s)] = r` ONLY IF
 * the exploration of s was complete in every context, i.e.
 *   - no applicable child was skipped by the cycle cut (onPath), and
 *   - every applicable child itself has a learned failure entry with
 *     budget >= r-1 (either it was pruned by prior learning, or it was
 *     fully explored and recorded itself).
 * By induction, such an entry certifies: no feasible path of length
 * <= r exists from s, regardless of how s was reached. A later visit
 * with remaining budget r' <= r is pruned soundly.
 *
 * Cycle cut: a state key already on the current path is never
 * re-entered. This is sound for optimality because any plan containing
 * a repeated key contains a cycle that can be removed (identical bits
 * AND resources, so all later actions stay applicable), yielding a
 * strictly shorter valid plan. Hence a shortest plan is always
 * cycle-free and the cut cannot remove it.
 */

import {
  Problem,
  applyAction,
  initialState,
  isGoal,
  stateKey,
} from "./model.js";

export interface IddfsResult {
  plan: number[] | null;
  length: number | null;
  iterations: number;
  expansions: number;
  /** Prunes justified by learned failure entries. */
  learnedPrunes: number;
  /** States for which a sound failure certificate was learned. */
  learnedStates: number;
}

export function iddfs(p: Problem, maxDepth: number): IddfsResult {
  let expansions = 0;
  let learnedPrunes = 0;
  // key -> certified "no feasible path of length <= value from here".
  const failed = new Map<string, number>();

  for (let limit = 0; limit <= maxDepth; limit++) {
    const onPath = new Set<string>();
    const path: number[] = [];

    const dfs = (bits: number, res: number[], remaining: number): boolean => {
      if (isGoal(p, bits)) return true;
      const key = stateKey(bits, res);
      if (remaining === 0) {
        // Context-free certificate: a non-goal state has no 0-length
        // continuation to the goal.
        if (!failed.has(key)) failed.set(key, 0);
        return false;
      }
      const learned = failed.get(key);
      if (learned !== undefined && learned >= remaining) {
        learnedPrunes++;
        return false;
      }
      onPath.add(key);
      let fullyExplored = true;
      for (const a of p.actions) {
        const next = applyAction(p, { bits, res }, a);
        if (!next) continue;
        const nkey = stateKey(next.bits, next.res);
        if (onPath.has(nkey)) {
          fullyExplored = false; // cycle-cut child: cannot certify this state
          continue;
        }
        expansions++;
        path.push(a.index);
        const found = dfs(next.bits, next.res, remaining - 1);
        if (found) return true;
        path.pop();
        const cf = failed.get(nkey);
        if (cf === undefined || cf < remaining - 1) fullyExplored = false;
      }
      onPath.delete(key);
      if (fullyExplored) {
        const prev = failed.get(key);
        if (prev === undefined || prev < remaining) failed.set(key, remaining);
      }
      return false;
    };

    const s0 = initialState(p);
    if (dfs(s0.bits, s0.res, limit)) {
      return {
        plan: [...path],
        length: path.length,
        iterations: limit + 1,
        expansions,
        learnedPrunes,
        learnedStates: failed.size,
      };
    }
  }
  return {
    plan: null,
    length: null,
    iterations: maxDepth + 1,
    expansions,
    learnedPrunes,
    learnedStates: failed.size,
  };
}

/**
 * Plain DFS reachability (visited set, no depth limit). Returns the set
 * of reachable state keys; used to cross-check that backtracking
 * exploration and BFS agree on the reachable closure.
 */
export function dfsClosure(p: Problem): Set<string> {
  const s0 = initialState(p);
  const seen = new Set<string>([stateKey(s0.bits, s0.res)]);
  const stack: Array<{ bits: number; res: number[] }> = [s0];
  while (stack.length > 0) {
    const s = stack.pop()!;
    for (const a of p.actions) {
      const next = applyAction(p, s, a);
      if (!next) continue;
      const k = stateKey(next.bits, next.res);
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(next);
    }
  }
  return seen;
}
