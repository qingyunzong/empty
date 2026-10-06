import { Problem, Solution, compareSolutions, evaluate, feasible, validateProblem } from "./types.js";

/**
 * 暴力枚举全部档向量，作为小规模算例的核验基准。
 * 枚举顺序与求解器一致（用户顺序、档升序），且仅严格更优才替换，
 * 因此并列时同样保留字典序最小的向量。
 */
export function bruteForce(p: Problem): Solution | null {
  validateProblem(p);
  const n = p.users.length;
  const assign = new Array<number>(n).fill(0);
  let best: Solution | null = null;
  const rec = (u: number): void => {
    if (u === n) {
      if (!feasible(p, assign)) return;
      const s = evaluate(p, assign);
      if (!best || compareSolutions(s, best) > 0) best = s;
      return;
    }
    for (let t = 0; t < p.users[u].length; t++) {
      assign[u] = t;
      rec(u + 1);
    }
  };
  rec(0);
  return best;
}
