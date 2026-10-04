export interface ItemSpec {
  id: number;
  size: number;
  group?: string | number;
}

export interface Instance {
  capacity: number;
  items: ItemSpec[];
  forbidden?: [number, number][];
}

export interface Solution {
  bins: number;
  /** loads[i] is the total size of bin (i + 1); bins are ordered by smallest member item id. */
  loads: number[];
  /** item id -> 1-based bin number. */
  assignment: Map<number, number>;
}

export class InvalidInputError extends Error {}
export class InfeasibleError extends Error {}

export const MAX_ITEMS = 20;
const NODE_LIMIT = 20000000;

interface Unit {
  size: number;
  members: number[];
  minId: number;
}

function validate(inst: Instance): void {
  if (!inst || typeof inst !== "object") throw new InvalidInputError("instance must be an object");
  if (!Number.isInteger(inst.capacity) || inst.capacity <= 0) {
    throw new InvalidInputError("capacity must be a positive integer");
  }
  if (!Array.isArray(inst.items) || inst.items.length === 0) {
    throw new InvalidInputError("items must be a non-empty array");
  }
  if (inst.items.length > MAX_ITEMS) {
    throw new InvalidInputError("at most " + MAX_ITEMS + " items are supported, got " + inst.items.length);
  }
  const seen = new Set<number>();
  for (const it of inst.items) {
    if (!it || typeof it !== "object") throw new InvalidInputError("each item must be an object");
    if (!Number.isInteger(it.id)) throw new InvalidInputError("item id must be an integer");
    if (seen.has(it.id)) throw new InvalidInputError("duplicate item id " + it.id);
    seen.add(it.id);
    if (!Number.isInteger(it.size) || it.size <= 0) {
      throw new InvalidInputError("item " + it.id + ": size must be a positive integer");
    }
    if (it.group !== undefined && typeof it.group !== "string" && typeof it.group !== "number") {
      throw new InvalidInputError("item " + it.id + ": group must be a string or number");
    }
  }
  for (const pair of inst.forbidden ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new InvalidInputError("each forbidden entry must be a [idA, idB] pair");
    }
    const a = pair[0];
    const b = pair[1];
    if (!seen.has(a) || !seen.has(b)) {
      throw new InvalidInputError("forbidden pair [" + a + ", " + b + "] references an unknown item id");
    }
    if (a === b) throw new InvalidInputError("forbidden pair [" + a + ", " + b + "] uses the same id twice");
  }
}

/**
 * Solves the instance exactly.
 * Objective 1: minimize the number of bins.
 * Objective 2: among optimal solutions, minimize the load sequence of the bins
 * ordered by each bin's smallest item id (lexicographically).
 */
export function solve(inst: Instance): Solution {
  validate(inst);
  const capacity = inst.capacity;

  // Merge same-group items into indivisible units.
  const unitIndexByKey = new Map<string, number>();
  const units: Unit[] = [];
  const unitOfItem = new Map<number, number>();
  for (const it of inst.items) {
    const key = it.group === undefined ? " " + it.id : "g:" + String(it.group);
    let ui = unitIndexByKey.get(key);
    if (ui === undefined) {
      ui = units.length;
      unitIndexByKey.set(key, ui);
      units.push({ size: 0, members: [], minId: Infinity });
    }
    const u = units[ui]!;
    u.size += it.size;
    u.members.push(it.id);
    if (it.id < u.minId) u.minId = it.id;
    unitOfItem.set(it.id, ui);
  }

  const m = units.length;
  const conflict = new Array<number>(m).fill(0);
  for (const pair of inst.forbidden ?? []) {
    const ua = unitOfItem.get(pair[0])!;
    const ub = unitOfItem.get(pair[1])!;
    if (ua === ub) {
      throw new InfeasibleError(
        "items " + pair[0] + " and " + pair[1] + " are forbidden together but share a group",
      );
    }
    conflict[ua]! |= 1 << ub;
    conflict[ub]! |= 1 << ua;
  }
  for (const u of units) {
    if (u.size > capacity) {
      throw new InfeasibleError(
        "group with items [" + u.members.join(", ") + "] has size " + u.size + " > capacity " + capacity,
      );
    }
  }

  // Units are placed in ascending order of their smallest member item id.
  // A bin's smallest item id is therefore fixed at creation and bins are
  // created in canonical (smallest-item-id) order, so the load sequence of
  // the bins in creation order is exactly the canonical key. The tie-break
  // then decomposes: minimize the final load of bin 0, then of bin 1, etc.,
  // each solved as a constrained feasibility problem with binary search.
  const order = units.map((_, i) => i).sort((a, b) => units[a]!.minId - units[b]!.minId);
  const n = order.length;
  const uSize = order.map((i) => units[i]!.size);
  const uMinId = order.map((i) => units[i]!.minId);
  const uConf = order.map((i) => {
    let mask = 0;
    for (let j = 0; j < n; j++) {
      if (conflict[i]! & (1 << order[j]!)) mask |= 1 << j;
    }
    return mask;
  });
  const total = uSize.reduce((a, b) => a + b, 0);
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + uSize[i]!;

  let nodes = 0;
  const loads = new Array<number>(n).fill(0);
  const binConf = new Array<number>(n).fill(0);
  const assign = new Array<number>(n).fill(-1);
  let found = false;
  let foundAssign: number[] = [];
  // Per-bin load caps and how many leading bins must match their cap exactly.
  let capPerBin: number[] = [];
  let eqPrefix = 0;

  function place(p: number, b: number, size: number, conf: number): void {
    loads[b]! += size;
    binConf[b]! |= conf;
    assign[p] = b;
  }

  function unplace(p: number, b: number, size: number): void {
    loads[b]! -= size;
    assign[p] = -1;
    // Recompute the conflict mask: other units in the bin may share it.
    let mask = 0;
    for (let q = 0; q < n; q++) {
      if (assign[q] === b) mask |= uConf[q]!;
    }
    binConf[b] = mask;
  }

  function dfs(p: number, used: number, k: number): void {
    if (++nodes > NODE_LIMIT) throw new Error("search node limit exceeded");
    if (p === n) {
      for (let b = 0; b < eqPrefix; b++) {
        if (loads[b] !== capPerBin[b]) return;
      }
      found = true;
      foundAssign = assign.slice();
      return;
    }
    if (found) return;
    const restCaps = capPerBin.slice(used, k).sort((x, y) => y - x);
    // Remaining-capacity bound, honoring per-bin load caps: the remaining
    // units must fit into the free space of the used bins plus the caps of
    // the largest remaining new bins.
    let avail = 0;
    for (let b = 0; b < used; b++) avail += capPerBin[b]! - loads[b]!;
    for (let i = 0; i < restCaps.length && avail < suffix[p]!; i++) {
      avail += restCaps[i]!;
    }
    if (avail < suffix[p]!) return;
    // Pinned bins must still reach their exact caps.
    let deficit = 0;
    for (let b = 0; b < eqPrefix; b++) deficit += capPerBin[b]! - loads[b]!;
    if (deficit > suffix[p]!) return;

    const size = uSize[p]!;
    const conf = uConf[p]!;
    // Bins with equal load, conflict mask and load cap are interchangeable;
    // swapping their contents preserves every per-bin load, so caps still hold.
    const tried = new Set<string>();
    for (let b = 0; b < used; b++) {
      const load = loads[b]!;
      if (load + size > capPerBin[b]!) continue;
      if (binConf[b]! & (1 << p)) continue;
      const sig = load + "," + binConf[b]! + "," + capPerBin[b]!;
      if (tried.has(sig)) continue;
      tried.add(sig);
      place(p, b, size, conf);
      dfs(p + 1, used, k);
      unplace(p, b, size);
    }
    if (used < k && size <= capPerBin[used]!) {
      place(p, used, size, conf);
      dfs(p + 1, used + 1, k);
      unplace(p, used, size);
    }
  }

  function feasible(k: number, caps: number[], eq: number): boolean {
    capPerBin = caps;
    eqPrefix = eq;
    found = false;
    dfs(0, 0, k);
    return found;
  }

  const lowerBound = Math.max(1, Math.ceil(total / capacity));
  let k = -1;
  for (let cand = lowerBound; cand <= n; cand++) {
    nodes = 0;
    if (feasible(cand, new Array<number>(cand).fill(capacity), 0)) {
      k = cand;
      break;
    }
  }
  if (k < 0) throw new InfeasibleError("no feasible packing exists");

  // Tie-break: determine the canonical load sequence one position at a time.
  // Positions before b are pinned to their optimum (equality checked at
  // leaves); position b is minimized by binary search over its load cap.
  const key: number[] = [];
  for (let b = 0; b < k; b++) {
    if (b === k - 1) {
      // The last bin's load is fixed by the total.
      key.push(total - key.reduce((a, x) => a + x, 0));
      break;
    }
    let lo = 0; // infeasible cap (bins are never empty at minimal k)
    let hi = capacity; // feasible: the optimum itself respects it
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      nodes = 0;
      if (feasible(k, [...key, mid, ...new Array<number>(k - b - 1).fill(capacity)], b)) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    key.push(hi);
  }

  // Reconstruct one assignment attaining the optimal key.
  nodes = 0;
  if (!feasible(k, key, k)) throw new Error("internal error: reconstruction failed");
  return toSolution(foundAssign, units, order);
}

function toSolution(assign: number[], units: Unit[], order: number[]): Solution {
  const n = order.length;
  const binOfUnit = new Array<number>(units.length).fill(-1);
  for (let p = 0; p < n; p++) binOfUnit[order[p]!] = assign[p]!;
  const usedBins = [...new Set(assign)];
  // Normalize: bin containing the smallest item id becomes bin 1, and so on.
  const sortedBins = usedBins.sort((a, b) => {
    let minA = Infinity;
    let minB = Infinity;
    for (let u = 0; u < units.length; u++) {
      if (binOfUnit[u] === a && units[u]!.minId < minA) minA = units[u]!.minId;
      if (binOfUnit[u] === b && units[u]!.minId < minB) minB = units[u]!.minId;
    }
    return minA - minB;
  });
  const numberOf = new Map<number, number>();
  sortedBins.forEach((b, i) => numberOf.set(b, i + 1));
  const loads = sortedBins.map(() => 0);
  const assignment = new Map<number, number>();
  for (let u = 0; u < units.length; u++) {
    const no = numberOf.get(binOfUnit[u]!)!;
    loads[no - 1]! += units[u]!.size;
    for (const id of units[u]!.members) assignment.set(id, no);
  }
  return { bins: sortedBins.length, loads, assignment };
}
