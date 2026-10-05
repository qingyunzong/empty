/**
 * Download/decode scheduling under a scratch-memory budget.
 *
 * Model (justified in README):
 *  - Downloading package p and decoding it are adjacent atomic steps: holding
 *    downloaded-but-undecoded bytes only wastes memory, so an optimal schedule
 *    never separates them.
 *  - Decoding p needs p's bytes (transient), p's dictionary, and the
 *    dictionaries of all of p's dependencies resident.
 *  - A dictionary is released as soon as every package depending on it has
 *    been decoded; releasing earlier never hurts, so greedy release is optimal.
 *
 * Therefore a schedule is just a topological order of the dependency DAG, and
 * the memory while decoding p from decoded-set S is
 *     resident(S) + bytes[p] + dict[p]
 * where resident(S) = sum of dict[q] for decoded q that still have an
 * undecoded dependent. The exact min-peak order is found by subset DP.
 */

export interface StepEvent {
  pkg: number;
  memStart: number;
  memAfterDownload: number;
  memPeak: number;
  memAfterDecode: number;
  memAfterRelease: number;
  released: number[];
}

export interface Simulation {
  peak: number;
  steps: StepEvent[];
}

export function checkAcyclic(deps: number[][]): void {
  const n = deps.length;
  const color = new Array<number>(n).fill(0); // 0=white 1=gray 2=black
  const visit = (u: number, stack: number[]): void => {
    color[u] = 1;
    for (const v of deps[u]!) {
      if (color[v] === 1) throw new Error(`dependency cycle detected: ${[...stack, u, v].join(" -> ")}`);
      if (color[v] === 0) visit(v, [...stack, u]);
    }
    color[u] = 2;
  };
  for (let i = 0; i < n; i++) if (color[i] === 0) visit(i, []);
}

function dependentsOf(deps: number[][]): number[][] {
  const n = deps.length;
  const dependents: number[][] = Array.from({ length: n }, () => []);
  for (let j = 0; j < n; j++) for (const d of deps[j]!) dependents[d]!.push(j);
  return dependents;
}

/** Simulate download -> decode -> release for a given order; independent of the DP. */
export function simulate(order: number[], bytes: number[], dict: number[], deps: number[][]): Simulation {
  const dependents = dependentsOf(deps);
  const decoded = new Set<number>();
  const resident = new Set<number>();
  let mem = 0;
  let peak = 0;
  const steps: StepEvent[] = [];
  for (const p of order) {
    for (const d of deps[p]!) {
      if (!resident.has(d)) throw new Error(`schedule violation: decoding ${p} without dictionary of ${d}`);
    }
    const memStart = mem;
    mem += bytes[p]!;
    const memAfterDownload = mem;
    mem += dict[p]!;
    const memPeak = mem;
    mem -= bytes[p]!; // downloaded payload freed once decoded
    const memAfterDecode = mem;
    resident.add(p);
    decoded.add(p);
    const released: number[] = [];
    for (const q of [...resident]) {
      if (dependents[q]!.every((j) => decoded.has(j))) {
        resident.delete(q);
        mem -= dict[q]!;
        released.push(q);
      }
    }
    peak = Math.max(peak, memPeak);
    steps.push({ pkg: p, memStart, memAfterDownload, memPeak, memAfterDecode, memAfterRelease: mem, released });
  }
  if (mem !== 0) throw new Error("internal: resident memory not fully released");
  return { peak, steps };
}

export interface ScheduleResult {
  order: number[];
  peak: number;
  lowerBound: number;
  upperBound: number;
  steps: StepEvent[];
}

/** Lower/upper bounds valid for ANY valid schedule. */
export function memoryBounds(bytes: number[], dict: number[], deps: number[][]): { lower: number; upper: number } {
  const n = bytes.length;
  if (n === 0) return { lower: 0, upper: 0 };
  let lower = 0;
  for (let p = 0; p < n; p++) {
    // While decoding p, its bytes, its dictionary and all dependency
    // dictionaries must be resident simultaneously.
    let need = bytes[p]! + dict[p]!;
    for (const d of deps[p]!) need += dict[d]!;
    if (need > lower) lower = need;
  }
  // One download in flight at a time; in the worst case every dictionary is resident.
  const upper = dict.reduce((s, d) => s + d, 0) + Math.max(...bytes);
  return { lower, upper };
}

const MAX_EXACT = 24;

/**
 * Exact min-peak-memory topological order via subset DP.
 * dp[S] = min achievable peak memory to decode exactly the set S.
 */
export function optimalSchedule(bytes: number[], dict: number[], deps: number[][]): ScheduleResult {
  const n = bytes.length;
  checkAcyclic(deps);
  const { lower, upper } = memoryBounds(bytes, dict, deps);
  if (n === 0) return { order: [], peak: 0, lowerBound: 0, upperBound: 0, steps: [] };
  if (n > MAX_EXACT) throw new Error(`too many packages (${n}) for exact scheduling; limit is ${MAX_EXACT}`);

  const depMask = deps.map((ds) => ds.reduce((m, d) => m | (1 << d), 0));
  const dependents = dependentsOf(deps);
  const dependentMask = dependents.map((ds) => ds.reduce((m, d) => m | (1 << d), 0));

  // resident[S]: dictionaries that must stay loaded once exactly S is decoded.
  const size = 1 << n;
  const resident = new Float64Array(size);
  for (let S = 1; S < size; S++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if ((S & (1 << i)) !== 0 && (dependentMask[i]! & ~S) !== 0) sum += dict[i]!;
    }
    resident[S] = sum;
  }

  const dp = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const choice = new Int32Array(size).fill(-1);
  dp[0] = 0;
  for (let S = 1; S < size; S++) {
    let best = Number.POSITIVE_INFINITY;
    let bestP = -1;
    for (let p = 0; p < n; p++) {
      const bit = 1 << p;
      if ((S & bit) === 0) continue;
      if ((depMask[p]! & ~S) !== 0) continue; // dependencies must be decoded first
      const prev = S ^ bit;
      const spike = resident[prev]! + bytes[p]! + dict[p]!;
      const cand = Math.max(dp[prev]!, spike);
      if (cand < best) { best = cand; bestP = p; }
    }
    dp[S] = best;
    choice[S] = bestP;
  }

  const order: number[] = [];
  let S = size - 1;
  while (S !== 0) {
    const p = choice[S]!;
    if (p < 0) throw new Error("internal: no valid schedule (cycle?)");
    order.push(p);
    S ^= 1 << p;
  }
  order.reverse();

  const sim = simulate(order, bytes, dict, deps);
  return { order, peak: sim.peak, lowerBound: lower, upperBound: upper, steps: sim.steps };
}

/**
 * Independent check for small instances: enumerate every topological order
 * and simulate it, returning the true minimum peak. Exponential; tests and
 * the verifier only call it for tiny n.
 */
export function exhaustiveMinPeak(bytes: number[], dict: number[], deps: number[][], maxN = 10): number | null {
  const n = bytes.length;
  if (n > maxN) return null;
  checkAcyclic(deps);
  let best = Number.POSITIVE_INFINITY;
  const done = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  const rec = (): void => {
    if (order.length === n) {
      const { peak } = simulate(order, bytes, dict, deps);
      if (peak < best) best = peak;
      return;
    }
    for (let p = 0; p < n; p++) {
      if (done[p]) continue;
      if (!deps[p]!.every((d) => done[d])) continue;
      done[p] = true;
      order.push(p);
      rec();
      order.pop();
      done[p] = false;
    }
  };
  rec();
  return best;
}
