/**
 * Bin packing solver.
 *
 * Constraints:
 *  - integer bin capacity, item sizes are positive integers;
 *  - items sharing a group label must be placed in the same bin;
 *  - forbidden item pairs must not share a bin.
 *
 * Objective (lexicographic):
 *  1. minimize the number of bins;
 *  2. minimize the canonical load sequence: bins are ordered by the
 *     smallest item id they contain, and the sequence of bin loads in
 *     that order is compared lexicographically.
 *
 * Output bin numbers are normalized by minimum item id: bin 1 is the bin
 * containing the globally smallest item id, bin 2 the next, and so on.
 *
 * Method:
 *  - Phase 1 finds the minimum bin count k with a memoized feasibility DFS
 *    (units processed largest-first).
 *  - Phase 2 processes units in increasing min-id order, so the j-th bin
 *    ever opened is exactly the j-th canonical bin. "Canonical load vector
 *    <= (L1..Lk)" then means "the j-th opened bin has capacity Lj", which
 *    turns lexicographic vector minimization into k independent binary
 *    searches, each backed by a memoized capped-feasibility DFS.
 */

export interface ItemSpec {
  id: number;
  size: number;
  group?: string | number | null;
}

export interface Problem {
  capacity: number;
  items: ItemSpec[];
  forbidden?: [number, number][];
}

export interface Solution {
  binCount: number;
  /** Loads in canonical order (bins sorted by their minimum item id). */
  loads: number[];
  /** Item ids per bin, in canonical order; each bin's ids sorted ascending. */
  bins: number[][];
  /** Normalized bin number (1-based) per item id. */
  assignment: Record<number, number>;
}

export class InfeasibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfeasibleError";
  }
}

export const MAX_ITEMS = 20;

export function validate(problem: Problem): void {
  if (!Number.isInteger(problem.capacity) || problem.capacity <= 0) {
    throw new Error(`capacity must be a positive integer, got ${problem.capacity}`);
  }
  if (!Array.isArray(problem.items) || problem.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  if (problem.items.length > MAX_ITEMS) {
    throw new Error(`at most ${MAX_ITEMS} items are supported, got ${problem.items.length}`);
  }
  const seen = new Set<number>();
  for (const item of problem.items) {
    if (!Number.isInteger(item.id)) {
      throw new Error(`item id must be an integer, got ${JSON.stringify(item.id)}`);
    }
    if (seen.has(item.id)) {
      throw new Error(`duplicate item id ${item.id}`);
    }
    seen.add(item.id);
    if (!Number.isInteger(item.size) || item.size <= 0) {
      throw new Error(`item ${item.id} size must be a positive integer, got ${item.size}`);
    }
    if (item.size > problem.capacity) {
      throw new InfeasibleError(`item ${item.id} (size ${item.size}) exceeds capacity ${problem.capacity}`);
    }
  }
  for (const pair of problem.forbidden ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`forbidden entry must be a pair, got ${JSON.stringify(pair)}`);
    }
    const [a, b] = pair;
    if (!seen.has(a) || !seen.has(b)) {
      throw new Error(`forbidden pair [${a}, ${b}] references an unknown item id`);
    }
    if (a === b) {
      throw new Error(`forbidden pair [${a}, ${b}] references the same item twice`);
    }
  }
}

interface Unit {
  members: number[]; // item ids, ascending
  size: number;
  minId: number;
  conflicts: number[]; // indices of conflicting units (original unit order)
}

/** Merge items into units via union-find on group labels. */
function buildUnits(problem: Problem): Unit[] {
  const n = problem.items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const groupLeader = new Map<string | number, number>();
  problem.items.forEach((item, index) => {
    if (item.group !== undefined && item.group !== null) {
      const leader = groupLeader.get(item.group);
      if (leader === undefined) groupLeader.set(item.group, index);
      else union(leader, index);
    }
  });

  const buckets = new Map<number, number[]>();
  problem.items.forEach((_, index) => {
    const root = find(index);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(index);
    else buckets.set(root, [index]);
  });

  const units: Unit[] = [];
  for (const indices of buckets.values()) {
    const members = indices.map((i) => problem.items[i]!.id).sort((a, b) => a - b);
    const size = indices.reduce((sum, i) => sum + problem.items[i]!.size, 0);
    if (size > problem.capacity) {
      throw new InfeasibleError(
        `group ${JSON.stringify(members)} has total size ${size} exceeding capacity ${problem.capacity}`,
      );
    }
    units.push({ members, size, minId: members[0]!, conflicts: [] });
  }

  const idToUnit = new Map<number, number>();
  units.forEach((unit, index) => {
    for (const id of unit.members) idToUnit.set(id, index);
  });
  for (const [a, b] of problem.forbidden ?? []) {
    const ua = idToUnit.get(a)!;
    const ub = idToUnit.get(b)!;
    if (ua === ub) {
      throw new InfeasibleError(`items ${a} and ${b} are forbidden together but share a group`);
    }
    units[ua]!.conflicts.push(ub);
    units[ub]!.conflicts.push(ua);
  }
  return units;
}

function popcount(x: number): number {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

function bitIndex(bit: number): number {
  let index = 0;
  let value = bit >>> 0;
  if (value >= 1 << 16) { value >>= 16; index += 16; }
  if (value >= 1 << 8) { value >>= 8; index += 8; }
  if (value >= 1 << 4) { value >>= 4; index += 4; }
  if (value >= 1 << 2) { value >>= 2; index += 2; }
  if (value >= 1 << 1) { index += 1; }
  return index;
}

/** Exact maximum clique size via bit-parallel branch and bound (Tomita-style). */
function maxCliqueSize(adjacency: number[], n: number): number {
  let best = 0;
  const expand = (cliqueSize: number, candidates: number): void => {
    if (candidates === 0) {
      if (cliqueSize > best) best = cliqueSize;
      return;
    }
    if (cliqueSize + popcount(candidates) <= best) return;
    let rest = candidates;
    while (rest !== 0) {
      if (cliqueSize + popcount(rest) <= best) return;
      const bit = rest & -rest;
      const v = bitIndex(bit);
      rest ^= bit;
      expand(cliqueSize + 1, rest & adjacency[v]!);
    }
  };
  expand(0, (1 << n) - 1);
  return best;
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return a.length < b.length;
}

interface Order {
  sizes: number[]; // unit sizes in processing order
  confs: number[]; // conflict bitmasks in processing order
  unitOf: number[]; // processing position -> original unit index
}

function buildOrder(units: Unit[], compare: (a: Unit, b: Unit) => number): Order {
  const sorted = units.map((unit, index) => ({ unit, index })).sort((x, y) => compare(x.unit, y.unit));
  const positionOf = new Array<number>(units.length);
  sorted.forEach(({ index }, position) => {
    positionOf[index] = position;
  });
  return {
    sizes: sorted.map(({ unit }) => unit.size),
    confs: sorted.map(({ unit }) => {
      let mask = 0;
      for (const other of unit.conflicts) mask |= 1 << positionOf[other]!;
      return mask;
    }),
    unitOf: sorted.map(({ index }) => index),
  };
}

/**
 * Capped-feasibility DFS: packs all units into at most caps.length bins,
 * where the b-th opened bin has capacity caps[b]. Returns one placement
 * (processing position -> bin) or null. Failed states are memoized on the
 * sorted multiset of (load, conflict-projection, cap) triples, which fully
 * determines whether the remaining units can still be packed.
 */
function cappedPacking(order: Order, caps: number[]): number[] | null {
  const { sizes, confs } = order;
  const n = sizes.length;
  const k = caps.length;
  const loads = new Array<number>(k).fill(0);
  const binConf = new Array<number>(k).fill(0);
  const placement = new Array<number>(n).fill(-1);
  let born = 0;
  const failed = new Set<string>();
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + sizes[i]!;
  const totalCap = caps.reduce((sum, c) => sum + c, 0);

  const key = (i: number): string => {
    const high = ~((1 << i) - 1);
    const triples: string[] = [];
    for (let b = 0; b < born; b++) {
      triples.push(`${loads[b]},${binConf[b]! & high},${caps[b]}`);
    }
    triples.sort();
    return `${i}|${triples.join(";")}`;
  };

  const dfs = (i: number): boolean => {
    if (i === n) return true;
    let used = 0;
    for (let b = 0; b < born; b++) used += loads[b]!;
    if (suffix[i]! > totalCap - used) return false; // remaining units cannot fit
    const ky = key(i);
    if (failed.has(ky)) return false;
    const size = sizes[i]!;
    const mask = 1 << i;
    const conf = confs[i]!;
    for (let b = 0; b < born; b++) {
      if (loads[b]! + size > caps[b]!) continue;
      if ((binConf[b]! & mask) !== 0) continue;
      const savedConf = binConf[b]!;
      loads[b]! += size;
      binConf[b]! |= conf;
      placement[i] = b;
      if (dfs(i + 1)) return true;
      loads[b]! -= size;
      binConf[b] = savedConf;
      placement[i] = -1;
    }
    if (born < k && size <= caps[born]!) {
      loads[born] = size;
      binConf[born] = conf;
      placement[i] = born;
      born++;
      if (dfs(i + 1)) return true;
      born--;
      loads[born] = 0;
      binConf[born] = 0;
      placement[i] = -1;
    }
    failed.add(ky);
    return false;
  };

  return dfs(0) ? placement : null;
}

export function solve(problem: Problem): Solution {
  validate(problem);
  const units = buildUnits(problem);
  const capacity = problem.capacity;
  const n = units.length;

  // Phase 1: minimum bin count (largest-first order prunes best).
  const desc = buildOrder(units, (a, b) => b.size - a.size || a.minId - b.minId);
  const totalSize = units.reduce((sum, unit) => sum + unit.size, 0);
  const adjacency = desc.confs;
  const lowerBound = Math.max(Math.ceil(totalSize / capacity), maxCliqueSize(adjacency, n));

  let binCount = -1;
  for (let k = lowerBound; k <= n; k++) {
    if (cappedPacking(desc, new Array<number>(k).fill(capacity)) !== null) {
      binCount = k;
      break;
    }
  }
  if (binCount === -1) {
    // Unreachable in practice: n bins always suffice (one unit per bin).
    throw new InfeasibleError("no feasible packing exists");
  }

  // Phase 2: lexicographically smallest canonical load vector, computed by
  // a bin-completion DP. Units are processed in min-id order and bins are
  // filled one at a time in canonical order: bin j must contain the
  // smallest-id remaining unit, so a state is fully described by
  // (bins used, remaining-unit bitmask). Candidate subsets (containing that
  // unit, conflict-free, within capacity) are tried in ascending load
  // order; among subsets with the smallest feasible load the
  // lexicographically smallest suffix wins.
  const asc = buildOrder(units, (a, b) => a.minId - b.minId);
  const n2 = asc.sizes.length;
  const FULL = (1 << n2) - 1;
  interface Entry {
    vec: number[];
    pick: number; // bitmask of asc positions going into this bin
  }
  const memo = new Map<number, Entry | null>();

  const dfs = (j: number, mask: number): Entry | null => {
    if (mask === 0) return j === binCount ? { vec: [], pick: 0 } : null;
    if (j === binCount) return null;
    const key = j * (1 << n2) + mask;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let remaining = 0;
    for (let m = mask; m !== 0; m &= m - 1) remaining += asc.sizes[bitIndex(m & -m)]!;
    if (remaining > (binCount - j) * capacity) {
      memo.set(key, null);
      return null;
    }
    if (j === binCount - 1) {
      // Last bin takes everything; only conflicts can still block this.
      let conflict = false;
      for (let m = mask; m !== 0 && !conflict; m &= m - 1) {
        if ((asc.confs[bitIndex(m & -m)]! & mask) !== 0) conflict = true;
      }
      const entry = conflict ? null : { vec: [remaining], pick: mask };
      memo.set(key, entry);
      return entry;
    }

    const u0bit = mask & -mask;
    const u0 = bitIndex(u0bit);
    const rest = mask ^ u0bit;
    // Enumerate valid subsets containing u0, grouped by load.
    const bySum = new Map<number, number[]>();
    const enumSub = (pos: number, sum: number, confMask: number, picked: number): void => {
      if (pos === n2) {
        const arr = bySum.get(sum);
        if (arr) arr.push(picked);
        else bySum.set(sum, [picked]);
        return;
      }
      const bit = 1 << pos;
      if ((rest & bit) === 0) {
        enumSub(pos + 1, sum, confMask, picked);
        return;
      }
      enumSub(pos + 1, sum, confMask, picked);
      if (sum + asc.sizes[pos]! <= capacity && (confMask & bit) === 0) {
        enumSub(pos + 1, sum + asc.sizes[pos]!, confMask | asc.confs[pos]!, picked | bit);
      }
    };
    enumSub(u0 + 1, asc.sizes[u0]!, asc.confs[u0]!, u0bit);

    const sums = [...bySum.keys()].sort((a, b) => a - b);
    let best: Entry | null = null;
    for (const sum of sums) {
      let bestSuffix: number[] | null = null;
      let bestPick = 0;
      for (const sub of bySum.get(sum)!) {
        const subResult = dfs(j + 1, mask ^ sub);
        if (subResult !== null && (bestSuffix === null || lexLess(subResult.vec, bestSuffix))) {
          bestSuffix = subResult.vec;
          bestPick = sub;
        }
      }
      if (bestSuffix !== null) {
        best = { vec: [sum, ...bestSuffix], pick: bestPick };
        break;
      }
    }
    memo.set(key, best);
    return best;
  };

  const result = dfs(0, FULL);
  if (result === null) throw new InfeasibleError("no feasible packing exists");

  // Reconstruct the unit placement from the memoized picks.
  const placement = new Array<number>(n2).fill(-1);
  {
    let mask = FULL;
    for (let j = 0; j < binCount; j++) {
      const entry = memo.get(j * (1 << n2) + mask)!;
      for (let m = entry.pick; m !== 0; m &= m - 1) placement[bitIndex(m & -m)] = j;
      mask ^= entry.pick;
    }
  }
  // Bins in birth order are already in canonical (min item id) order.
  const bins: number[][] = Array.from({ length: binCount }, () => []);
  const actualLoads = new Array<number>(binCount).fill(0);
  const assignment: Record<number, number> = {};
  placement.forEach((bin, position) => {
    const unit = units[asc.unitOf[position]!]!;
    bins[bin]!.push(...unit.members);
    actualLoads[bin] += unit.size;
    for (const id of unit.members) assignment[id] = bin + 1;
  });
  for (const bin of bins) bin.sort((a, b) => a - b);

  return { binCount, loads: actualLoads, bins, assignment };
}
