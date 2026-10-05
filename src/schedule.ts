import type { Problem } from "./types.js";

export interface ScheduleEvent {
  action: "download" | "decode" | "release";
  package: string;
  /** Staging memory in bytes immediately after this event. */
  memory: number;
}

export interface ScheduleResult {
  feasible: boolean;
  reason: string;
  /** All packages that must be downloaded: selected plus transitive dict deps. */
  required: string[];
  /** Dependencies pulled in beyond the selected set. */
  extraDependencies: string[];
  order: string[];
  events: ScheduleEvent[];
  /** Peak staging memory of the produced schedule. */
  peak: number;
  /** Lower bound on the peak any valid schedule must reach. */
  lowerBound: number;
  /** Upper bound on the optimal peak (equals `peak` of this schedule). */
  upperBound: number;
  /** True when `peak` is provably optimal (exhaustive subset DP). */
  exact: boolean;
  totalDownloadBytes: number;
  memoryLimit: number;
}

interface PkgInfo {
  id: string;
  bytes: number;
  dictBytes: number;
  needs: string[];
}

/**
 * Transitive closure of dictionary dependencies. Throws on unknown ids
 * (already validated) and dependency cycles.
 */
export function dependencyClosure(selected: string[], packages: PkgInfo[]): {
  required: string[];
  extra: string[];
} {
  const byId = new Map(packages.map((p) => [p.id, p]));
  const required = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    if (stack.includes(id)) {
      throw new Error(`dictionary dependency cycle: ${[...stack, id].join(" -> ")}`);
    }
    if (required.has(id)) return;
    const pkg = byId.get(id);
    if (!pkg) throw new Error(`unknown package ${id}`);
    for (const n of pkg.needs) visit(n, [...stack, id]);
    required.add(id);
  };
  for (const id of selected) visit(id, []);
  const extra = [...required].filter((id) => !selected.includes(id));
  return { required: [...required], extra };
}

/**
 * Memory model (packages are atomic — never split):
 *  - download i: buffer of `bytes_i` is allocated;
 *  - decode i: its dictionary `dictBytes_i` is loaded alongside the buffer;
 *  - after decode the buffer is freed; the dictionary stays resident until
 *    every package that directly needs it has been decoded, then released.
 * Peak memory is the maximum over all event boundaries.
 */
export function planSchedule(
  problem: Problem,
  selected: string[],
  exactLimit = 20,
): ScheduleResult {
  const byId = new Map(problem.packages.map((p) => [p.id, p]));
  const base: ScheduleResult = {
    feasible: false, reason: "", required: [], extraDependencies: [], order: [],
    events: [], peak: 0, lowerBound: 0, upperBound: 0, exact: false,
    totalDownloadBytes: 0, memoryLimit: problem.memoryLimit,
  };
  let closure: { required: string[]; extra: string[] };
  try {
    closure = dependencyClosure(selected, problem.packages);
  } catch (err) {
    return { ...base, reason: (err as Error).message };
  }
  const ids = closure.required;
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const bytes = ids.map((id) => byId.get(id)!.bytes);
  const dict = ids.map((id) => byId.get(id)!.dictBytes);
  const needMask = ids.map((id) => {
    let m = 0;
    for (const dep of byId.get(id)!.needs) m |= 1 << index.get(dep)!;
    return m;
  });
  // dependents[j]: packages that directly need j's dictionary.
  const dependents: number[][] = ids.map(() => []);
  for (let i = 0; i < n; i++) {
    for (const dep of byId.get(ids[i]!)!.needs) dependents[index.get(dep)!]!.push(i);
  }
  const residentOf = (decoded: number): number => {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (!(decoded & (1 << j))) continue;
      if (dependents[j]!.some((k) => !(decoded & (1 << k)))) sum += dict[j]!;
    }
    return sum;
  };

  const totalDownloadBytes = bytes.reduce((a, b) => a + b, 0);

  // Lower bound: while decoding i, every dictionary it directly needs must be
  // resident, plus its own download buffer and dictionary.
  let lowerBound = 0;
  for (let i = 0; i < n; i++) {
    let lb = bytes[i]! + dict[i]!;
    for (const dep of byId.get(ids[i]!)!.needs) lb += byId.get(dep)!.dictBytes;
    lowerBound = Math.max(lowerBound, lb);
  }

  let order: number[];
  let peak: number;
  let exact: boolean;

  if (n <= exactLimit) {
    // Exhaustive DP over decoded-set states: dp[S] = minimum achievable peak
    // to reach decoded set S. This enumerates the full state graph.
    const size = 1 << n;
    const dp = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
    const parent = new Int32Array(size).fill(-1);
    const resident = new Float64Array(size);
    for (let s = 0; s < size; s++) resident[s] = residentOf(s);
    dp[0] = 0;
    for (let s = 0; s < size; s++) {
      const cur = dp[s]!;
      if (cur === Number.POSITIVE_INFINITY) continue;
      for (let i = 0; i < n; i++) {
        if (s & (1 << i)) continue;
        if ((needMask[i]! & ~s) !== 0) continue;
        const step = resident[s]! + bytes[i]! + dict[i]!;
        const cand = Math.max(cur, step);
        const next = s | (1 << i);
        if (cand < dp[next]!) {
          dp[next] = cand;
          parent[next] = i;
        }
      }
    }
    const full = size - 1;
    if (dp[full] === Number.POSITIVE_INFINITY) {
      return { ...base, required: ids, extraDependencies: closure.extra,
        reason: "no valid decode order (dependency cycle)" };
    }
    order = [];
    let s = full;
    while (s !== 0) {
      const i = parent[s]!;
      order.push(i);
      s &= ~(1 << i);
    }
    order.reverse();
    peak = dp[full]!;
    exact = true;
  } else {
    // Greedy fallback for large dependency graphs: repeatedly decode the
    // available package that minimizes the resulting peak.
    const remaining = new Set(ids.map((_, i) => i));
    let decoded = 0;
    order = [];
    peak = 0;
    while (remaining.size > 0) {
      let bestI = -1;
      let bestStep = Number.POSITIVE_INFINITY;
      for (const i of remaining) {
        if ((needMask[i]! & ~decoded) !== 0) continue;
        const step = residentOf(decoded) + bytes[i]! + dict[i]!;
        if (step < bestStep) { bestStep = step; bestI = i; }
      }
      if (bestI < 0) {
        return { ...base, required: ids, extraDependencies: closure.extra,
          reason: "no valid decode order (dependency cycle)" };
      }
      peak = Math.max(peak, bestStep);
      decoded |= 1 << bestI;
      remaining.delete(bestI);
      order.push(bestI);
    }
    exact = false;
  }

  // Emit the event trace and recompute the peak from it (self-check).
  const events: ScheduleEvent[] = [];
  let decoded = 0;
  let released = 0;
  let tracePeak = 0;
  for (const i of order) {
    const resident = residentOf(decoded);
    events.push({ action: "download", package: ids[i]!, memory: resident + bytes[i]! });
    events.push({ action: "decode", package: ids[i]!, memory: resident + bytes[i]! + dict[i]! });
    tracePeak = Math.max(tracePeak, resident + bytes[i]! + dict[i]!);
    decoded |= 1 << i;
    // Release decoded dictionaries whose last dependent has been decoded.
    for (let j = 0; j < n; j++) {
      if (!(decoded & (1 << j)) || released & (1 << j)) continue;
      const stillNeeded = dependents[j]!.some((k) => !(decoded & (1 << k)));
      if (!stillNeeded && dict[j]! > 0) {
        released |= 1 << j;
        events.push({ action: "release", package: ids[j]!, memory: residentOf(decoded) });
      }
    }
  }
  if (tracePeak !== peak) {
    throw new Error(`internal schedule mismatch: dp peak ${peak} != trace peak ${tracePeak}`);
  }

  const feasible = peak <= problem.memoryLimit;
  return {
    feasible,
    reason: feasible ? "" : `peak memory ${peak} exceeds memoryLimit ${problem.memoryLimit} (lower bound ${lowerBound})`,
    required: ids,
    extraDependencies: closure.extra,
    order: order.map((i) => ids[i]!),
    events,
    peak,
    lowerBound,
    upperBound: peak,
    exact,
    totalDownloadBytes,
    memoryLimit: problem.memoryLimit,
  };
}

/**
 * Brute-force cross-check for small graphs: enumerate every topological
 * decode order and return the minimum peak. Returns null when n is too large.
 */
export function bruteForcePeak(problem: Problem, selected: string[], permLimit = 9): number | null {
  const byId = new Map(problem.packages.map((p) => [p.id, p]));
  const { required } = dependencyClosure(selected, problem.packages);
  const n = required.length;
  if (n > permLimit) return null;
  const index = new Map(required.map((id, i) => [id, i]));
  const bytes = required.map((id) => byId.get(id)!.bytes);
  const dict = required.map((id) => byId.get(id)!.dictBytes);
  const needMask = required.map((id) => {
    let m = 0;
    for (const dep of byId.get(id)!.needs) m |= 1 << index.get(dep)!;
    return m;
  });
  const dependents: number[][] = required.map(() => []);
  for (let i = 0; i < n; i++) {
    for (const dep of byId.get(required[i]!)!.needs) dependents[index.get(dep)!]!.push(i);
  }
  const residentOf = (decoded: number): number => {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (!(decoded & (1 << j))) continue;
      if (dependents[j]!.some((k) => !(decoded & (1 << k)))) sum += dict[j]!;
    }
    return sum;
  };
  let best = Number.POSITIVE_INFINITY;
  const walk = (decoded: number, peak: number): void => {
    if (peak >= best) return;
    if (decoded === (1 << n) - 1) { best = peak; return; }
    for (let i = 0; i < n; i++) {
      if (decoded & (1 << i)) continue;
      if ((needMask[i]! & ~decoded) !== 0) continue;
      const step = residentOf(decoded) + bytes[i]! + dict[i]!;
      walk(decoded | (1 << i), Math.max(peak, step));
    }
  };
  walk(0, 0);
  return best;
}
