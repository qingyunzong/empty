import { intersect, normalize, subtract } from "./intervals.js";
import type { Interval, Problem } from "./types.js";

export interface CoverAssignment {
  /** Gap sub-interval covered by exactly these selected packages. */
  interval: Interval;
  packages: string[];
}

export interface CoverResult {
  feasible: boolean;
  reason: string;
  gaps: Interval[];
  selected: string[];
  totalBytes: number;
  assignment: CoverAssignment[];
  /** Elementary segments used internally (exposed for the certificate). */
  segments: Interval[];
}

/**
 * Split the gaps into elementary segments: atomic intervals such that every
 * package either fully covers or fully avoids each segment.
 */
export function buildSegments(gaps: Interval[], covers: Interval[][]): Interval[] {
  const points = new Set<number>();
  for (const g of gaps) {
    points.add(g.start);
    points.add(g.end);
  }
  for (const cov of covers) {
    for (const iv of intersect(normalize(cov), gaps)) {
      points.add(iv.start);
      points.add(iv.end);
    }
  }
  const sorted = [...points].sort((a, b) => a - b);
  const segments: Interval[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (start >= end) continue;
    const mid = (start + end) / 2;
    if (gaps.some((g) => g.start <= mid && mid < g.end)) segments.push({ start, end });
  }
  return segments;
}

function coversInterval(cover: Interval[], seg: Interval): boolean {
  const mid = (seg.start + seg.end) / 2;
  return cover.some((iv) => iv.start <= mid && mid < iv.end);
}

/**
 * Exact minimum-total-byte package selection covering every gap with at most
 * `maxPackages` packages. Overlapping packages are allowed; a package's cost
 * is counted once. Packages are atomic: a package covering any needed segment
 * is taken in full (never split).
 *
 * Method: memoized DP over (package index, uncovered segment bitmask,
 * remaining package budget), with a suffix-union feasibility prune.
 */
export function solveCover(problem: Problem): CoverResult {
  const gaps = subtract(problem.range, problem.receiver);
  const empty: CoverResult = {
    feasible: true, reason: "", gaps, selected: [], totalBytes: 0,
    assignment: [], segments: [],
  };
  if (gaps.length === 0) return empty;

  const covers = problem.packages.map((p) => intersect(normalize(p.cover), gaps));
  const segments = buildSegments(gaps, covers);
  const fullMask = (1n << BigInt(segments.length)) - 1n;

  const usable: { idx: number; mask: bigint; bytes: number }[] = [];
  for (let i = 0; i < problem.packages.length; i++) {
    let mask = 0n;
    for (let s = 0; s < segments.length; s++) {
      if (coversInterval(covers[i]!, segments[s]!)) mask |= 1n << BigInt(s);
    }
    if (mask !== 0n) usable.push({ idx: i, mask, bytes: problem.packages[i]!.bytes });
  }

  let unionAll = 0n;
  for (const u of usable) unionAll |= u.mask;
  if ((unionAll & fullMask) !== fullMask) {
    const uncovered = segments.filter((_, s) => ((unionAll >> BigInt(s)) & 1n) === 0n);
    return {
      feasible: false,
      reason: `no package covers gap segment(s): ${uncovered.map((iv) => `[${iv.start},${iv.end})`).join(", ")}`,
      gaps, selected: [], totalBytes: 0, assignment: [], segments,
    };
  }

  const n = usable.length;
  const suffixUnion = new Array<bigint>(n + 1).fill(0n);
  for (let i = n - 1; i >= 0; i--) suffixUnion[i] = suffixUnion[i + 1]! | usable[i]!.mask;

  const memo = new Map<string, number>();
  const INF = Number.POSITIVE_INFINITY;
  const dp = (i: number, mask: bigint, k: number): number => {
    if (mask === 0n) return 0;
    if (i >= n || k <= 0) return INF;
    if ((suffixUnion[i]! & mask) !== mask) return INF;
    const key = `${i}|${k}|${mask.toString(36)}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let best = dp(i + 1, mask, k); // skip package i
    const u = usable[i]!;
    if ((u.mask & mask) !== 0n) {
      const take = dp(i + 1, mask & ~u.mask, k - 1);
      if (take !== INF) best = Math.min(best, u.bytes + take);
    }
    memo.set(key, best);
    return best;
  };

  const optimum = dp(0, fullMask, problem.maxPackages);
  if (optimum === INF) {
    return {
      feasible: false,
      reason: `gaps cannot be covered with at most ${problem.maxPackages} packages`,
      gaps, selected: [], totalBytes: 0, assignment: [], segments,
    };
  }

  // Reconstruct one optimal selection.
  const chosen: number[] = [];
  let mask = fullMask;
  let k = problem.maxPackages;
  for (let i = 0; i < n && mask !== 0n; i++) {
    const u = usable[i]!;
    const skip = dp(i + 1, mask, k);
    let take = INF;
    if (k > 0 && (u.mask & mask) !== 0n) {
      const rest = dp(i + 1, mask & ~u.mask, k - 1);
      take = rest === INF ? INF : u.bytes + rest;
    }
    if (take <= skip && take !== INF) {
      chosen.push(u.idx);
      mask &= ~u.mask;
      k--;
    }
  }

  const assignment: CoverAssignment[] = [];
  for (const seg of segments) {
    const holders = chosen
      .filter((pi) => coversInterval(covers[pi]!, seg))
      .map((pi) => problem.packages[pi]!.id);
    const last = assignment[assignment.length - 1];
    if (last && last.interval.end === seg.start &&
        last.packages.length === holders.length &&
        last.packages.every((id, j) => id === holders[j])) {
      last.interval.end = seg.end;
    } else {
      assignment.push({ interval: { ...seg }, packages: holders });
    }
  }

  const totalBytes = chosen.reduce((acc, pi) => acc + problem.packages[pi]!.bytes, 0);
  return {
    feasible: true, reason: "", gaps,
    selected: chosen.map((pi) => problem.packages[pi]!.id), totalBytes, assignment, segments,
  };
}

export interface EnumerationResult {
  checked: boolean;
  reason: string;
  subsetsTried: number;
  feasible: boolean;
  bestBytes: number;
  bestSelected: string[];
}

/**
 * Brute-force verification for small instances: enumerate every subset of at
 * most `maxPackages` packages and find the minimum-cost cover. Used to
 * cross-check the DP solver.
 */
export function enumerateCover(problem: Problem, packageLimit = 24): EnumerationResult {
  const none: EnumerationResult = {
    checked: false, reason: "", subsetsTried: 0, feasible: false,
    bestBytes: Number.POSITIVE_INFINITY, bestSelected: [],
  };
  const gaps = subtract(problem.range, problem.receiver);
  if (gaps.length === 0) {
    return { ...none, checked: true, feasible: true, bestBytes: 0, bestSelected: [] };
  }
  const covers = problem.packages.map((p) => intersect(normalize(p.cover), gaps));
  const segments = buildSegments(gaps, covers);
  const fullMask = (1n << BigInt(segments.length)) - 1n;
  const masks = covers.map((cov) => {
    let mask = 0n;
    for (let s = 0; s < segments.length; s++) {
      if (coversInterval(cov, segments[s]!)) mask |= 1n << BigInt(s);
    }
    return mask;
  });
  const n = problem.packages.length;
  if (n > packageLimit) {
    return { ...none, reason: `enumeration skipped: ${n} packages > limit ${packageLimit}` };
  }
  let best = Number.POSITIVE_INFINITY;
  let bestSet: number[] = [];
  let tried = 0;
  const maxK = Math.min(problem.maxPackages, n);
  // Enumerate subsets via bitmask; skip those exceeding the package budget.
  for (let bits = 1; bits < 1 << n; bits++) {
    let count = 0;
    let x = bits;
    while (x) { x &= x - 1; count++; }
    if (count > maxK) continue;
    tried++;
    let mask = 0n;
    let cost = 0;
    for (let i = 0; i < n; i++) {
      if (bits & (1 << i)) {
        mask |= masks[i]!;
        cost += problem.packages[i]!.bytes;
      }
    }
    if ((mask & fullMask) === fullMask && cost < best) {
      best = cost;
      bestSet = [];
      for (let i = 0; i < n; i++) if (bits & (1 << i)) bestSet.push(i);
    }
  }
  return {
    checked: true, reason: "", subsetsTried: tried,
    feasible: best !== Number.POSITIVE_INFINITY,
    bestBytes: best,
    bestSelected: bestSet.map((i) => problem.packages[i]!.id),
  };
}
