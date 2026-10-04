import type { Instance, SolveResult } from "./types.js";
import { better, simulateRoute } from "./route.js";

/**
 * 穷举验证器（仅用于小图，n <= 10）：
 * 枚举所有站点子集的所有排列，模拟计时，取同一目标下的最优。
 */
export function solveBrute(inst: Instance): SolveResult {
  if (inst.n > 10) throw new Error(`穷举仅支持 n <= 10，当前 n=${inst.n}`);
  let best: SolveResult = { profit: 0, distance: 0, totalTime: 0, route: [] };
  const order: number[] = [];
  const used = new Array<boolean>(inst.n + 1).fill(false);

  const consider = (): void => {
    const sim = simulateRoute(inst, order);
    if (!sim.feasible) return;
    const cand = { profit: sim.profit, distance: sim.distance, totalTime: sim.totalTime };
    if (better(cand, best)) best = { ...cand, route: [...order] };
  };

  const dfs = (): void => {
    consider(); // 当前前缀即一条候选路线（子集任意、顺序任意）
    for (let s = 1; s <= inst.n; s++) {
      if (used[s]) continue;
      used[s] = true;
      order.push(s);
      dfs();
      order.pop();
      used[s] = false;
    }
  };
  dfs();
  return best;
}
