import { HORIZON, normalizeShifts } from "./normalize";
import { Shift } from "./types";

export interface ExhaustiveResult {
  coverage: number;
  benefit: number;
  nodes: number;
}

export function exhaustiveOptimum(
  shifts: Shift[],
  nodeLimit = 2_000_000,
): ExhaustiveResult | null {
  const norm = normalizeShifts(shifts);
  const order: number[] = [];
  for (let t = 0; t < HORIZON; t++) {
    let coverable = false;
    for (const s of norm) {
      if (s.workable[t]) {
        coverable = true;
        break;
      }
    }
    if (coverable) order.push(t);
  }
  const candidatesOf = (t: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k < norm.length; k++) {
      if (norm[k].workable[t]) out.push(k);
    }
    out.sort((a, b) => norm[b].priority - norm[a].priority);
    return out;
  };
  const candidates = new Map<number, number[]>();
  for (const t of order) candidates.set(t, candidatesOf(t));
  order.sort((a, b) => candidates.get(a)!.length - candidates.get(b)!.length || a - b);

  const n = order.length;
  const suffixMaxBenefit = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const cand = candidates.get(order[i])!;
    const best = cand.length > 0 ? Math.max(...cand.map((k) => norm[k].priority)) : 0;
    suffixMaxBenefit[i] = suffixMaxBenefit[i + 1] + Math.max(0, best);
  }

  const capsLeft = norm.map((s) => s.cap);
  let capsLeftSum = capsLeft.reduce((a, b) => a + b, 0);
  let bestCoverage = -1;
  let bestBenefit = 0;
  let nodes = 0;
  let aborted = false;
  const visited = new Map<string, [number, number]>();

  const dfs = (i: number, coverage: number, benefit: number): void => {
    if (aborted) return;
    nodes++;
    if (nodes > nodeLimit) {
      aborted = true;
      return;
    }
    const key = `${i}|${capsLeft.join(",")}`;
    const seen = visited.get(key);
    if (seen && (seen[0] > coverage || (seen[0] === coverage && seen[1] >= benefit))) {
      return;
    }
    visited.set(key, [coverage, benefit]);
    const remaining = Math.min(n - i, capsLeftSum);
    if (coverage + remaining < bestCoverage) return;
    if (
      coverage + remaining === bestCoverage &&
      benefit + suffixMaxBenefit[i] <= bestBenefit
    ) {
      return;
    }
    if (i === n) {
      if (coverage > bestCoverage || (coverage === bestCoverage && benefit > bestBenefit)) {
        bestCoverage = coverage;
        bestBenefit = benefit;
      }
      return;
    }
    const cand = candidates.get(order[i])!;
    for (const k of cand) {
      if (capsLeft[k] <= 0) continue;
      capsLeft[k]--;
      capsLeftSum--;
      dfs(i + 1, coverage + 1, benefit + norm[k].priority);
      capsLeft[k]++;
      capsLeftSum++;
    }
    dfs(i + 1, coverage, benefit);
  };
  dfs(0, 0, 0);
  if (aborted) return null;
  return { coverage: bestCoverage, benefit: bestBenefit, nodes };
}
