import type { DeltaPackage, Problem } from "./model.js";
import { comparePlans, eligiblePackages, type Plan } from "./planner.js";

export interface EnumerationResult {
  best: Plan | null;
  pathCount: number;
  exploredStates: number;
  truncated: boolean;
}

export const DEFAULT_STATE_CAP = 2_000_000;

export function enumerateBest(problem: Problem, stateCap = DEFAULT_STATE_CAP): EnumerationResult {
  if (problem.source === problem.target) {
    return { best: { packages: [], totalBytes: 0 }, pathCount: 1, exploredStates: 1, truncated: false };
  }
  const packages = eligiblePackages(problem);
  const adj = new Map<string, DeltaPackage[]>();
  for (const p of packages) {
    const list = adj.get(p.from);
    if (list) list.push(p);
    else adj.set(p.from, [p]);
  }
  let best: Plan | null = null;
  let pathCount = 0;
  let exploredStates = 0;
  let truncated = false;
  const visited = new Set<string>([problem.source]);
  const seq: DeltaPackage[] = [];
  const dfs = (version: string, cost: number): void => {
    if (truncated) return;
    exploredStates += 1;
    if (exploredStates > stateCap) {
      truncated = true;
      return;
    }
    if (version === problem.target) {
      pathCount += 1;
      const candidate: Plan = { packages: [...seq], totalBytes: cost };
      if (best === null || comparePlans(candidate, best) < 0) {
        best = candidate;
      }
      return;
    }
    for (const p of adj.get(version) ?? []) {
      if (visited.has(p.to)) continue;
      visited.add(p.to);
      seq.push(p);
      dfs(p.to, cost + p.bytes);
      seq.pop();
      visited.delete(p.to);
      if (truncated) return;
    }
  };
  dfs(problem.source, 0);
  return { best, pathCount, exploredStates, truncated };
}
