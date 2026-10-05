/**
 * Admissible heuristic with checkable lower bounds.
 *
 * h(s) = ceil(missingGoalBits(s) / maxFix), where maxFix is the maximum
 * number of goal bits any single action can set to their required values
 * (optimistically ignoring preconditions, effect conditions and resources).
 * Each action fixes at most maxFix missing bits, so h never overestimates.
 * If no action can fix any missing bit, h = Infinity (goal unreachable).
 *
 * certifiedAStar returns, for every expanded node, the record
 * { key, g, h, f } — an independently checkable lower bound f = g + h on
 * the cost of any solution through that node. verifyLowerBounds re-checks
 * every record against exact goal distances from a complete BFS.
 */

import { Problem, State, bitOf, isGoal } from "./model.js";
import { goalDistances } from "./bfs.js";
import { Search } from "./frontier.js";

export interface BoundRecord {
  key: string;
  g: number;
  h: number;
  f: number;
}

export function makeHeuristic(p: Problem): (s: State) => number {
  const goalBits = Object.entries(p.goal.bits ?? {}).map(([k, v]) => [Number(k), v] as const);

  // Max number of goal bits a single action can set to their required value.
  let maxFix = 0;
  for (const a of p.actions) {
    let fix = 0;
    for (const [bit, want] of goalBits) {
      const can = a.effects.some((e) => e.set && e.set[String(bit)] === want);
      if (can) fix++;
    }
    if (fix > maxFix) maxFix = fix;
  }

  return (s: State): number => {
    if (isGoal(p, s)) return 0;
    let missing = 0;
    for (const [bit, want] of goalBits) {
      if (bitOf(s, bit) !== want) missing++;
    }
    if (missing === 0) return 0; // only resource goals remain; bit relaxation is 0
    if (maxFix === 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(missing / maxFix);
  };
}

export interface CertifiedResult {
  plan: string[] | null;
  length: number | null;
  /** Checkable lower-bound records, one per expanded node. */
  bounds: BoundRecord[];
  visitLog: string[];
}

export function certifiedAStar(p: Problem): CertifiedResult {
  const h = makeHeuristic(p);
  const search = new Search(p, "astar", h);
  const bounds: BoundRecord[] = [];
  for (;;) {
    const before = search.visitLog.length;
    search.step();
    if (search.visitLog.length > before) {
      const e = search.lastExpanded!;
      const hv = h(e.state);
      bounds.push({ key: e.key, g: e.g, h: hv, f: e.g + hv });
    }
    if (search.solved || search.exhausted) break;
  }
  const plan = search.plan();
  return {
    plan,
    length: plan ? plan.length : null,
    bounds,
    visitLog: [...search.visitLog],
  };
}

/**
 * Verify every recorded lower bound against exact goal distances computed
 * by a complete BFS. Returns the list of violations (empty = all bounds
 * valid, i.e. h(s) <= true remaining cost for every expanded node).
 */
export function verifyLowerBounds(p: Problem, bounds: BoundRecord[]): string[] {
  const dist = goalDistances(p);
  const violations: string[] = [];
  for (const rec of bounds) {
    if (rec.f !== rec.g + rec.h) {
      violations.push(`${rec.key}: f=${rec.f} != g+h=${rec.g + rec.h}`);
    }
    const d = dist.get(rec.key);
    if (d === undefined) continue; // goal unreachable: any finite h bounds Infinity
    if (rec.h > d) {
      violations.push(`${rec.key}: h=${rec.h} > true distance ${d}`);
    }
  }
  return violations;
}
