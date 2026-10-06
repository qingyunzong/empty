import type { DeltaPackage, Problem } from "./model.js";

export interface Plan {
  packages: DeltaPackage[];
  totalBytes: number;
}

export function planIds(plan: Plan): string[] {
  return plan.packages.map((p) => p.id);
}

export function compareIdSeq(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

export function comparePlans(a: Plan, b: Plan): number {
  if (a.totalBytes !== b.totalBytes) return a.totalBytes - b.totalBytes;
  return compareIdSeq(planIds(a), planIds(b));
}

export function eligiblePackages(problem: Problem): DeltaPackage[] {
  return problem.packages.filter((p) => p.bytes <= problem.spaceLimitBytes);
}

function buildAdjacency(packages: readonly DeltaPackage[], reverse: boolean): Map<string, DeltaPackage[]> {
  const adj = new Map<string, DeltaPackage[]>();
  for (const p of packages) {
    const key = reverse ? p.to : p.from;
    const list = adj.get(key);
    if (list) list.push(p);
    else adj.set(key, [p]);
  }
  return adj;
}

export function minCostFrom(packages: readonly DeltaPackage[], start: string, reverse = false): Map<string, number> {
  const adj = buildAdjacency(packages, reverse);
  const dist = new Map<string, number>();
  dist.set(start, 0);
  const settled = new Set<string>();
  for (;;) {
    let bestVersion: string | null = null;
    let bestDist = Infinity;
    for (const [version, d] of dist) {
      if (!settled.has(version) && d < bestDist) {
        bestDist = d;
        bestVersion = version;
      }
    }
    if (bestVersion === null) break;
    settled.add(bestVersion);
    for (const p of adj.get(bestVersion) ?? []) {
      const next = reverse ? p.from : p.to;
      const candidate = bestDist + p.bytes;
      if (candidate < (dist.get(next) ?? Infinity)) {
        dist.set(next, candidate);
      }
    }
  }
  return dist;
}

export function planUpgrade(problem: Problem): Plan | null {
  if (problem.source === problem.target) {
    return { packages: [], totalBytes: 0 };
  }
  const packages = eligiblePackages(problem);
  const fromSource = minCostFrom(packages, problem.source);
  const toTarget = minCostFrom(packages, problem.target, true);
  const total = fromSource.get(problem.target);
  if (total === undefined) {
    return null;
  }
  const chosen: DeltaPackage[] = [];
  let spent = 0;
  let current = problem.source;
  while (spent < total) {
    if (fromSource.get(current) !== spent) {
      throw new Error(`内部不变量失效: d1[${current}] !== ${spent}`);
    }
    let best: DeltaPackage | null = null;
    for (const p of packages) {
      if (p.from !== current) continue;
      const rest = toTarget.get(p.to);
      if (rest === undefined) continue;
      if (spent + p.bytes + rest !== total) continue;
      if (best === null || p.id < best.id) best = p;
    }
    if (best === null) {
      throw new Error(`内部错误: 版本 ${current} 处找不到可延续最优路径的包`);
    }
    chosen.push(best);
    spent += best.bytes;
    current = best.to;
  }
  if (current !== problem.target) {
    throw new Error("内部错误: 规划结束未到达目标版本");
  }
  return { packages: chosen, totalBytes: total };
}
