/** Core model + exact solver for grid rectangle packing. */

export interface ItemSpec {
  id: string;
  w: number;
  h: number;
  profit: number;
  /** per-item rotation permission; default false */
  rotate?: boolean;
}

export interface GridSpec {
  width: number; // 1..8
  height: number; // 1..8
  /** forbidden cells as [x, y] pairs, 0-based, origin top-left */
  forbidden?: Array<[number, number]>;
}

export interface Instance {
  grid: GridSpec;
  items: ItemSpec[]; // at most 10
}

export interface Placement {
  itemIndex: number;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
  mask: bigint;
}

export interface Solution {
  placements: Placement[];
  profit: number;
  area: number;
}

export const MAX_DIM = 8;
export const MAX_ITEMS = 10;

export function validateInstance(inst: Instance): void {
  const { width, height } = inst.grid;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) {
    throw new Error(`grid must be within 1x1..${MAX_DIM}x${MAX_DIM}, got ${width}x${height}`);
  }
  if (!Array.isArray(inst.items) || inst.items.length > MAX_ITEMS) {
    throw new Error(`at most ${MAX_ITEMS} items allowed, got ${inst.items?.length}`);
  }
  const ids = new Set<string>();
  for (const it of inst.items) {
    if (!it.id || ids.has(it.id)) throw new Error(`duplicate or missing item id: ${it.id}`);
    ids.add(it.id);
    if (!Number.isInteger(it.w) || !Number.isInteger(it.h) || it.w < 1 || it.h < 1) {
      throw new Error(`item ${it.id}: bad dimensions ${it.w}x${it.h}`);
    }
    if (!Number.isFinite(it.profit)) throw new Error(`item ${it.id}: bad profit`);
  }
  for (const [x, y] of inst.grid.forbidden ?? []) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
      throw new Error(`forbidden cell out of range: [${x}, ${y}]`);
    }
  }
}

export function cellBit(x: number, y: number, width: number): bigint {
  return 1n << BigInt(y * width + x);
}

export function rectMask(x: number, y: number, w: number, h: number, width: number): bigint {
  let mask = 0n;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      mask |= cellBit(x + dx, y + dy, width);
    }
  }
  return mask;
}

export function forbiddenMask(grid: GridSpec): bigint {
  let mask = 0n;
  for (const [x, y] of grid.forbidden ?? []) mask |= cellBit(x, y, grid.width);
  return mask;
}

/** All legal placements of one item (every orientation x position not touching forbidden cells). */
export function placementsFor(inst: Instance, itemIndex: number): Placement[] {
  const it = inst.items[itemIndex];
  const { width: W, height: H } = inst.grid;
  const forb = forbiddenMask(inst.grid);
  const dims: Array<[number, number, boolean]> = [[it.w, it.h, false]];
  if (it.rotate && it.w !== it.h) dims.push([it.h, it.w, true]);
  const out: Placement[] = [];
  for (const [w, h, rotated] of dims) {
    if (w > W || h > H) continue;
    for (let y = 0; y + h <= H; y++) {
      for (let x = 0; x + w <= W; x++) {
        const mask = rectMask(x, y, w, h, W);
        if ((mask & forb) === 0n) {
          out.push({ itemIndex, id: it.id, x, y, w, h, rotated, mask });
        }
      }
    }
  }
  return out;
}

/** Better = higher profit, then smaller covered area. */
export function isBetter(profit: number, area: number, best: Solution): boolean {
  return profit > best.profit || (profit === best.profit && area < best.area);
}

/**
 * Exact branch-and-bound over items (place or skip).
 * Optimal under: maximize total profit, then minimize total covered area.
 */
function profitOf(items: ItemSpec[], mask: number): number {
  let p = 0;
  for (let i = 0; i < items.length; i++) if (((mask >> i) & 1) !== 0) p += items[i].profit;
  return p;
}

function areaOf(items: ItemSpec[], mask: number): number {
  let a = 0;
  for (let i = 0; i < items.length; i++) {
    if (((mask >> i) & 1) !== 0) a += items[i].w * items[i].h;
  }
  return a;
}

/**
 * Feasibility: can every item in `mask` be packed simultaneously?
 * MRV backtracking: always branch on the remaining item with the fewest
 * currently legal placements. Returns the placements or null.
 */
function packSubset(
  inst: Instance,
  mask: number,
  perItem: Placement[][],
  freeMask: bigint,
  width: number,
): Placement[] | null {
  const remaining: number[] = [];
  for (let i = 0; i < inst.items.length; i++) {
    if (((mask >> i) & 1) !== 0) remaining.push(i);
  }
  const chosen = new Map<number, Placement>();
  const anchor = (p: Placement) => p.y * width + p.x;

  // symmetry breaking: identical items (same dims + rotation flag) must be
  // placed with strictly increasing anchors in input order, collapsing the
  // k! permutations of every k identical items into one search branch
  const signature = (i: number) => {
    const it = inst.items[i];
    return `${it.w}x${it.h}r${it.rotate ? 1 : 0}`;
  };
  const pred = new Map<number, number>(); // item -> previous identical item
  const succ = new Map<number, number>(); // item -> next identical item
  const lastOfGroup = new Map<string, number>();
  for (const i of remaining) {
    const sig = signature(i);
    const prev = lastOfGroup.get(sig);
    if (prev !== undefined) { pred.set(i, prev); succ.set(prev, i); }
    lastOfGroup.set(sig, i);
  }

  function popcount(m: bigint): number {
    let c = 0;
    let v = m;
    while (v !== 0n) { v &= v - 1n; c++; }
    return c;
  }

  function compatPlacements(i: number, used: bigint): Placement[] {
    // anchor bounds from already-placed identical neighbours
    let lo = -1;
    let hi = Infinity;
    const pr = pred.get(i);
    if (pr !== undefined && chosen.has(pr)) lo = anchor(chosen.get(pr)!);
    const su = succ.get(i);
    if (su !== undefined && chosen.has(su)) hi = anchor(chosen.get(su)!);
    return perItem[i].filter((p) => {
      if ((p.mask & used) !== 0n) return false;
      const a = anchor(p);
      return a > lo && a < hi;
    });
  }

  function dfs(used: bigint, left: number[]): Placement[] | null {
    if (left.length === 0) return [];
    // necessary condition: remaining items must fit in the remaining free cells
    let need = 0;
    for (const i of left) need += inst.items[i].w * inst.items[i].h;
    if (need > popcount(freeMask & ~used)) return null;

    // MRV: item with the fewest currently legal placements
    let pick = -1;
    let pickList: Placement[] = [];
    for (const i of left) {
      const compat = compatPlacements(i, used);
      if (compat.length === 0) return null;
      if (pick === -1 || compat.length < pickList.length) {
        pick = i;
        pickList = compat;
        if (compat.length === 1) break;
      }
    }
    const rest = left.filter((i) => i !== pick);
    for (const p of pickList) {
      chosen.set(pick, p);
      const r = dfs(used | p.mask, rest);
      if (r !== null) return [{ ...p, itemIndex: pick, id: inst.items[pick].id }, ...r];
      chosen.delete(pick);
    }
    return null;
  }

  return dfs(0n, remaining);
}

/**
 * Exact solver: enumerate item subsets in objective order (max profit, then
 * min covered area) and return the first packable one. With at most 10 items
 * there are at most 1024 subsets; each packability test is an MRV
 * backtracking search that fails fast on infeasible subsets.
 */
export function solve(inst: Instance): Solution {
  validateInstance(inst);
  const { width: W, height: H } = inst.grid;
  const n = inst.items.length;
  const forb = forbiddenMask(inst.grid);
  const freeMask = ((1n << BigInt(W * H)) - 1n) & ~forb;
  const freeCells = W * H -
    new Set((inst.grid.forbidden ?? []).map(([x, y]) => `${x},${y}`)).size;

  // group identical items: feasibility depends only on how many items of
  // each group are selected, not on which concrete ones
  const groupOf = new Array<number>(n);
  const groups: { members: number[]; placements: Placement[] }[] = [];
  const sigToGroup = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const it = inst.items[i];
    const sig = `${it.w}x${it.h}r${it.rotate ? 1 : 0}`;
    let g = sigToGroup.get(sig);
    if (g === undefined) {
      g = groups.length;
      sigToGroup.set(sig, g);
      groups.push({ members: [], placements: placementsFor(inst, i) });
    }
    groups[g].members.push(i);
    groupOf[i] = g;
  }
  const perItem = inst.items.map((_, i) => groups[groupOf[i]].placements);

  const countKey = (mask: number): string => {
    const counts = groups.map((g) =>
      g.members.reduce((c, m) => c + ((mask >> m) & 1), 0));
    return counts.join(",");
  };
  const canonicalMask = (mask: number): number => {
    let m = 0;
    for (const g of groups) {
      let need = g.members.reduce((c, mem) => c + ((mask >> mem) & 1), 0);
      for (const mem of g.members) {
        if (need === 0) break;
        m |= 1 << mem;
        need--;
      }
    }
    return m;
  };

  interface Subset { mask: number; profit: number; area: number }
  const subsets: Subset[] = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    subsets.push({ mask, profit: profitOf(inst.items, mask), area: areaOf(inst.items, mask) });
  }
  subsets.sort((a, b) => b.profit - a.profit || a.area - b.area);

  // feasibility cache keyed by group-count vector; values are placements
  // for the canonical subset (first k members of each group)
  const feasibleCache = new Map<string, Placement[] | null>();
  const infeasible: number[] = [];

  for (const { mask, profit, area } of subsets) {
    if (area > freeCells) continue;
    // infeasibility is upward-closed: skip supersets of known-infeasible sets
    if (infeasible.some((s) => (s & mask) === s)) continue;

    const key = countKey(mask);
    let canonical = feasibleCache.get(key);
    if (canonical === undefined) {
      canonical = packSubset(inst, canonicalMask(mask), perItem, freeMask, W);
      feasibleCache.set(key, canonical);
    }
    if (canonical === null) {
      infeasible.push(mask);
      continue;
    }
    // relabel canonical placements onto the concrete items of this subset
    const placed = canonical.map((p) => {
      const g = groupOf[p.itemIndex];
      const ordinal = groups[g].members.indexOf(p.itemIndex);
      const actual = groups[g].members.filter((m) => ((mask >> m) & 1) !== 0)[ordinal];
      return { ...p, itemIndex: actual, id: inst.items[actual].id };
    });
    placed.sort((a, b) => a.itemIndex - b.itemIndex);
    return { placements: placed, profit, area };
  }
  return { placements: [], profit: 0, area: 0 };
}