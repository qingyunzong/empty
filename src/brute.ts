/**
 * Brute-force verifier: enumerates all set partitions of the items
 * (restricted growth strings), filters by the packing constraints, and
 * picks the optimum under the same objective as the solver:
 * fewest bins, then lexicographically smallest canonical load sequence.
 * Intended for small instances (roughly n <= 10).
 */

import { InfeasibleError, Problem, Solution, validate } from "./solver.js";

export const BRUTE_FORCE_MAX_ITEMS = 12;

export function bruteForce(problem: Problem): Solution {
  validate(problem);
  const n = problem.items.length;
  if (n > BRUTE_FORCE_MAX_ITEMS) {
    throw new Error(`brute force supports at most ${BRUTE_FORCE_MAX_ITEMS} items, got ${n}`);
  }
  const capacity = problem.capacity;
  const items = problem.items;

  const groupOf = items.map((item) => (item.group === undefined ? null : item.group));
  const forbidden = (problem.forbidden ?? []).map(([a, b]) => {
    const ia = items.findIndex((item) => item.id === a);
    const ib = items.findIndex((item) => item.id === b);
    return [ia, ib] as [number, number];
  });

  const assign = new Array<number>(n).fill(0);
  const loads: number[] = [items[0]!.size];

  let bestLoads: number[] | null = null; // canonical load vector
  let bestBins = 0;
  let bestAssign: number[] | null = null;

  const lexLess = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]!;
    }
    return a.length < b.length;
  };

  const consider = (binCount: number): void => {
    for (const [ia, ib] of forbidden) {
      if (assign[ia] === assign[ib]) return;
    }
    const seenGroupBin = new Map<string | number, number>();
    for (let i = 0; i < n; i++) {
      const g = groupOf[i];
      if (g === null) continue;
      const prev = seenGroupBin.get(g);
      if (prev === undefined) seenGroupBin.set(g, assign[i]!);
      else if (prev !== assign[i]) return;
    }
    // Canonical loads: bins ordered by their minimum item id.
    const binMin = new Array<number>(binCount).fill(Number.POSITIVE_INFINITY);
    for (let i = 0; i < n; i++) {
      const b = assign[i]!;
      if (items[i]!.id < binMin[b]) binMin[b] = items[i]!.id;
    }
    const canonical = loads
      .slice(0, binCount)
      .map((load, b) => ({ load, min: binMin[b]! }))
      .sort((x, y) => x.min - y.min)
      .map(({ load }) => load);
    if (
      bestLoads === null ||
      binCount < bestBins ||
      (binCount === bestBins && lexLess(canonical, bestLoads))
    ) {
      bestLoads = canonical;
      bestBins = binCount;
      bestAssign = assign.slice();
    }
  };

  const dfs = (i: number, binCount: number): void => {
    if (bestLoads !== null && binCount > bestBins) return; // cannot improve bin count
    if (i === n) {
      consider(binCount);
      return;
    }
    const size = items[i]!.size;
    for (let b = 0; b < binCount; b++) {
      if (loads[b]! + size > capacity) continue;
      loads[b]! += size;
      assign[i] = b;
      dfs(i + 1, binCount);
      loads[b]! -= size;
    }
    loads[binCount] = size;
    assign[i] = binCount;
    dfs(i + 1, binCount + 1);
  };

  dfs(1, 1);

  if (bestAssign === null) {
    throw new InfeasibleError("no feasible packing exists");
  }

  // Rebuild the normalized solution from the best assignment.
  const binMin = new Array<number>(bestBins).fill(Number.POSITIVE_INFINITY);
  for (let i = 0; i < n; i++) {
    const b = bestAssign[i]!;
    if (items[i]!.id < binMin[b]) binMin[b] = items[i]!.id;
  }
  const order = Array.from({ length: bestBins }, (_, b) => b).sort((a, b) => binMin[a]! - binMin[b]!);
  const normalized = new Map<number, number>();
  order.forEach((b, rank) => normalized.set(b, rank + 1));

  const bins: number[][] = Array.from({ length: bestBins }, () => []);
  const outLoads = new Array<number>(bestBins).fill(0);
  const assignment: Record<number, number> = {};
  for (let i = 0; i < n; i++) {
    const binNo = normalized.get(bestAssign[i]!)!;
    bins[binNo - 1]!.push(items[i]!.id);
    outLoads[binNo - 1] += items[i]!.size;
    assignment[items[i]!.id] = binNo;
  }
  for (const bin of bins) bin.sort((a, b) => a - b);

  return { binCount: bestBins, loads: outLoads, bins, assignment };
}
