import { DeltaPackage, Problem } from "./types.js";
import { compareSeq, edgeFits } from "./solver.js";

export interface EnumResult {
  /** 是否因超过路径数上限而截断（截断后结论仅供参考）。 */
  truncated: boolean;
  /** 实际考察的 start->target 简单路径条数。 */
  pathsExamined: number;
  /** 枚举得到的最优 (总下载量, 包 ID 序列)；无可行路径时为 null。 */
  best: { cost: number; seq: string[] } | null;
}

/** 枚举路径数的安全上限。 */
export const DEFAULT_ENUM_CAP = 2_000_000;

/**
 * 小图枚举对照：DFS 枚举所有 start->target 简单路径（不重复经过版本节点），
 * 在可行边上取 (总下载量, 包 ID 序列字典序) 最小者。
 */
export function enumerateBest(problem: Problem, cap: number = DEFAULT_ENUM_CAP): EnumResult {
  const { start, target, spaceLimit } = problem;
  if (start === target) {
    return { truncated: false, pathsExamined: 1, best: { cost: 0, seq: [] } };
  }
  const adj = new Map<string, DeltaPackage[]>();
  for (const e of problem.packages) {
    if (!edgeFits(e, spaceLimit)) continue;
    const list = adj.get(e.from);
    if (list) list.push(e);
    else adj.set(e.from, [e]);
  }

  let truncated = false;
  let pathsExamined = 0;
  let best: { cost: number; seq: string[] } | null = null;
  const visited = new Set<string>([start]);
  const seq: string[] = [];

  const dfs = (node: string, cost: number): void => {
    if (truncated) return;
    if (node === target) {
      pathsExamined += 1;
      if (pathsExamined > cap) {
        truncated = true;
        return;
      }
      if (
        best === null ||
        cost < best.cost ||
        (cost === best.cost && compareSeq(seq, best.seq) < 0)
      ) {
        best = { cost, seq: [...seq] };
      }
      return;
    }
    for (const e of adj.get(node) ?? []) {
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      seq.push(e.id);
      dfs(e.to, cost + e.bytes);
      seq.pop();
      visited.delete(e.to);
      if (truncated) return;
    }
  };
  dfs(start, 0);
  return { truncated, pathsExamined, best };
}
