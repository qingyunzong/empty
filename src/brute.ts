/**
 * 暴力枚举器：独立地枚举所有分配向量，用于在小例子上核验求解器。
 */
import {
  Assignment, Evaluated, NormalizedProblem, Problem,
  UNSERVED, allConstraintsHold, compareEvaluated, evaluate, normalize,
} from './model';

export function bruteForce(problem: Problem): Evaluated {
  const np = normalize(problem);
  const options = [UNSERVED, ...np.tiers.map((_, i) => i)];
  const assignment: Assignment = new Array(np.users).fill(UNSERVED);
  let best: Evaluated | null = null;

  const rec = (u: number, used1: number, used2: number): void => {
    if (u === np.users) {
      if (!allConstraintsHold(np, assignment)) return;
      const ev = evaluate(np, assignment);
      if (best === null || compareEvaluated(np, ev, best) < 0) best = ev;
      return;
    }
    for (const opt of options) {
      const tier = opt === UNSERVED ? null : np.tiers[opt];
      const u1 = used1 + (tier?.r1 ?? 0);
      const u2 = used2 + (tier?.r2 ?? 0);
      if (u1 > np.budget1 || u2 > np.budget2) continue;
      assignment[u] = opt;
      rec(u + 1, u1, u2);
    }
    assignment[u] = UNSERVED;
  };
  rec(0, 0, 0);
  return best!;
}
