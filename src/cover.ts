/**
 * Minimum-total-bytes package selection covering the gaps.
 *
 * Packages with identical coverage intervals are indivisible ("同覆盖包不可拆"):
 * they are grouped into bundles that are selected or rejected as a unit, with
 * cost equal to the sum of member bytes (paid once, overlaps are free).
 *
 * Because every bundle covers a contiguous interval, the set of elementary gap
 * segments a bundle covers is contiguous, so the exact optimum under a
 * package-count limit is found by DP. A brute-force subset enumeration is
 * provided to cross-check the DP on small instances.
 */

import type { Pkg } from "./model";
import { mergeIntervals, type Interval } from "./gaps";

export interface Bundle {
  /** Bundle key: the shared coverage interval, e.g. "3..9". */
  key: string;
  members: Pkg[];
  coverL: number;
  coverR: number;
  /** Sum of member bytes; paid once when the bundle is selected. */
  bytes: number;
  /** Sum of member dictionary sizes; resident together while needed. */
  dict: number;
  /** Bundle indices this bundle depends on (union of member deps, self removed). */
  depBundles: number[];
}

/** Group packages by identical coverage; bundles are indivisible units. */
export function buildBundles(packages: Pkg[]): Bundle[] {
  const byKey = new Map<string, Pkg[]>();
  for (const p of packages) {
    const key = `${p.coverL}..${p.coverR}`;
    const group = byKey.get(key);
    if (group) group.push(p);
    else byKey.set(key, [p]);
  }
  const bundles: Bundle[] = [];
  const bundleOf = new Map<string, number>();
  for (const [key, members] of [...byKey.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const [l, r] = key.split("..").map(Number);
    bundleOf.set(key, bundles.length);
    bundles.push({
      key,
      members,
      coverL: l!,
      coverR: r!,
      bytes: members.reduce((s, m) => s + m.bytes, 0),
      dict: members.reduce((s, m) => s + m.dict, 0),
      depBundles: [],
    });
  }
  const indexOfPkg = new Map<string, number>();
  for (const b of bundles) {
    const idx = bundles.indexOf(b);
    for (const m of b.members) indexOfPkg.set(m.id, idx);
  }
  for (let i = 0; i < bundles.length; i++) {
    const deps = new Set<number>();
    for (const m of bundles[i]!.members) {
      for (const d of m.deps) {
        const bi = indexOfPkg.get(d)!;
        if (bi !== i) deps.add(bi);
      }
    }
    bundles[i]!.depBundles = [...deps].sort((a, b) => a - b);
  }
  return bundles;
}

/**
 * Split the gaps into elementary segments at every bundle coverage boundary,
 * so each bundle covers a contiguous whole number of segments.
 */
export function elementarySegments(gaps: Interval[], bundles: Bundle[]): Interval[] {
  const bounds = new Set<number>();
  for (const [a, b] of gaps) { bounds.add(a); bounds.add(b + 1); }
  for (const b of bundles) { bounds.add(b.coverL); bounds.add(b.coverR + 1); }
  const sorted = [...bounds].sort((x, y) => x - y);
  const merged = mergeIntervals(gaps);
  const out: Interval[] = [];
  let gi = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]! - 1;
    if (a > b) continue;
    while (gi < merged.length && merged[gi]![1] < a) gi++;
    if (gi < merged.length && merged[gi]![0] <= a && b <= merged[gi]![1]) out.push([a, b]);
  }
  return out;
}

/** Segment index range [L, R] fully covered by each bundle, or null. */
export function bundleSegmentRanges(segments: Interval[], bundles: Bundle[]): Array<[number, number] | null> {
  const starts = segments.map((s) => s[0]);
  const lowerBound = (x: number): number => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid]! < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return bundles.map((b) => {
    // coverL is a segment boundary, so no segment straddles it: the first
    // segment with start >= coverL is the first one the bundle can fully cover.
    const L = lowerBound(b.coverL);
    if (L >= segments.length || segments[L]![1] > b.coverR) return null;
    let R = L;
    while (R + 1 < segments.length && segments[R + 1]![1] <= b.coverR) R++;
    return [L, R] as [number, number];
  });
}

export interface CoverResult {
  feasible: boolean;
  reason: string | null;
  segments: Interval[];
  chosen: number[];
  totalBytes: number;
  /** Total number of member packages across chosen bundles. */
  packageCount: number;
}

/**
 * Exact DP: f[t][c] = min total bytes to cover segments 0..t-1 using bundles
 * whose member-package counts sum to at most c. A bundle covering segment t-1
 * also covers every segment back to its left edge, so the subproblem is a
 * prefix. Ties are broken toward fewer packages.
 */
export function minCostCover(
  segments: Interval[],
  bundles: Bundle[],
  maxPackages: number,
): CoverResult {
  const m = segments.length;
  const empty: CoverResult = { feasible: true, reason: null, segments, chosen: [], totalBytes: 0, packageCount: 0 };
  if (m === 0) return empty;

  const ranges = bundleSegmentRanges(segments, bundles);
  const weight = bundles.map((b) => b.members.length);
  const INF = Number.POSITIVE_INFINITY;

  // f[t][c]: min bytes covering segments 0..t-1 with <= c packages.
  const f: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(maxPackages + 1).fill(INF));
  const parent: Array<Array<{ prevT: number; prevC: number; bundle: number } | null>> =
    Array.from({ length: m + 1 }, () => new Array(maxPackages + 1).fill(null));
  for (let c = 0; c <= maxPackages; c++) f[0]![c] = 0;

  for (let t = 1; t <= m; t++) {
    for (let c = 0; c <= maxPackages; c++) {
      let best = INF;
      let bestPar: { prevT: number; prevC: number; bundle: number } | null = null;
      for (let b = 0; b < bundles.length; b++) {
        const rg = ranges[b];
        if (!rg) continue;
        const [L, R] = rg;
        if (t - 1 < L || t - 1 > R) continue;
        const w = weight[b]!;
        if (w > c) continue;
        const prev = f[L]![c - w]!;
        if (prev === INF) continue;
        const cand = prev + bundles[b]!.bytes;
        if (cand < best) {
          best = cand;
          bestPar = { prevT: L, prevC: c - w, bundle: b };
        }
      }
      f[t]![c] = best;
      parent[t]![c] = bestPar;
    }
  }

  // Pick the cheapest column; tie-break toward fewer packages.
  let bestC = -1;
  let bestCost = INF;
  for (let c = 0; c <= maxPackages; c++) {
    if (f[m]![c]! < bestCost) { bestCost = f[m]![c]!; bestC = c; }
  }
  if (bestC < 0) {
    return {
      feasible: false,
      reason: `gaps cannot be covered within the limit of ${maxPackages} packages`,
      segments, chosen: [], totalBytes: 0, packageCount: 0,
    };
  }

  const chosen: number[] = [];
  let t = m, c = bestC;
  while (t > 0) {
    const par = parent[t]![c];
    if (!par) throw new Error("internal: broken DP parent chain");
    chosen.push(par.bundle);
    t = par.prevT;
    c = par.prevC;
  }
  chosen.reverse();
  return {
    feasible: true,
    reason: null,
    segments,
    chosen,
    totalBytes: bestCost,
    packageCount: chosen.reduce((s, b) => s + weight[b]!, 0),
  };
}

export interface BruteForceResult {
  feasible: boolean;
  chosen: number[];
  totalBytes: number;
  packageCount: number;
  subsetsChecked: number;
}

/**
 * Independent check: enumerate every bundle subset within the package limit,
 * verify full segment coverage via bitmasks, and keep the cheapest
 * (ties broken toward fewer packages). Returns null when the instance is too
 * large to enumerate.
 */
export function bruteForceCover(
  segments: Interval[],
  bundles: Bundle[],
  maxPackages: number,
  maxBundlesToEnumerate = 24,
): BruteForceResult | null {
  const n = bundles.length;
  if (n > maxBundlesToEnumerate) return null;
  const m = segments.length;
  const ranges = bundleSegmentRanges(segments, bundles);
  const segMask = ranges.map((rg) => {
    if (!rg) return 0n;
    let mask = 0n;
    for (let i = rg[0]; i <= rg[1]; i++) mask |= 1n << BigInt(i);
    return mask;
  });
  const full = m === 0 ? 0n : (1n << BigInt(m)) - 1n;
  const weight = bundles.map((b) => b.members.length);

  let bestCost = Number.POSITIVE_INFINITY;
  let bestCount = Number.POSITIVE_INFINITY;
  let bestMask = -1;
  let checked = 0;
  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    let cost = 0;
    let count = 0;
    let cover = 0n;
    for (let b = 0; b < n; b++) {
      if (mask & (1 << b)) {
        cost += bundles[b]!.bytes;
        count += weight[b]!;
        cover |= segMask[b]!;
        if (cost >= bestCost && count >= bestCount) break;
      }
    }
    if (count > maxPackages) continue;
    checked++;
    if (cover !== full) continue;
    if (cost < bestCost || (cost === bestCost && count < bestCount)) {
      bestCost = cost;
      bestCount = count;
      bestMask = mask;
    }
  }
  if (bestMask < 0) return { feasible: false, chosen: [], totalBytes: 0, packageCount: 0, subsetsChecked: checked };
  const chosen: number[] = [];
  for (let b = 0; b < n; b++) if (bestMask & (1 << b)) chosen.push(b);
  return { feasible: true, chosen, totalBytes: bestCost, packageCount: bestCount, subsetsChecked: checked };
}
