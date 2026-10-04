/**
 * Independent exhaustive verifier for small instances.
 * Deliberately written in a different style from solve(): enumerates every
 * subset of items x every combination of placements, so a bug in the
 * solver's pruning cannot hide here.
 */
import {
  Instance, Placement, Solution, cellBit, isBetter, placementsFor, validateInstance,
} from "./solver.js";

export interface VerifyResult {
  ok: boolean;
  checked: boolean;          // false when skipped due to budget
  reason?: string;
  nodes?: number;            // search nodes visited by the enumeration
  bruteForce?: { profit: number; area: number };
  solver?: { profit: number; area: number };
}

export const DEFAULT_NODE_BUDGET = 20_000_000;

/** Exhaustive optimum over all subsets and all placement combinations. */
export function bruteForceOptimum(
  inst: Instance,
  nodeBudget: number = DEFAULT_NODE_BUDGET,
): { profit: number; area: number; nodes: number; exhausted: boolean } {
  validateInstance(inst);
  const n = inst.items.length;
  const perItem: Placement[][] = [];
  for (let i = 0; i < n; i++) perItem.push(placementsFor(inst, i));

  let bestProfit = 0;
  let bestArea = 0;
  let nodes = 0;
  let exhausted = false;
  const dummy: Solution = { placements: [], profit: 0, area: 0 };

  function better(p: number, a: number): boolean {
    dummy.profit = bestProfit;
    dummy.area = bestArea;
    return isBetter(p, a, dummy);
  }

  // item i decides: skip, or take one of its placements disjoint from `used`
  function dfs(i: number, used: bigint, profit: number, area: number): void {
    if (exhausted) return;
    if (++nodes > nodeBudget) { exhausted = true; return; }
    if (i === n) {
      if (better(profit, area)) { bestProfit = profit; bestArea = area; }
      return;
    }
    dfs(i + 1, used, profit, area);
    const gain = inst.items[i].profit;
    const sz = inst.items[i].w * inst.items[i].h;
    for (const p of perItem[i]) {
      if ((p.mask & used) === 0n) {
        dfs(i + 1, used | p.mask, profit + gain, area + sz);
      }
    }
  }

  dfs(0, 0n, 0, 0);
  return { profit: bestProfit, area: bestArea, nodes, exhausted };
}

/** Structural validation of a solution certificate against the instance. */
export function validateCertificate(inst: Instance, sol: Solution): string[] {
  const errors: string[] = [];
  const { width: W, height: H } = inst.grid;
  const forb = new Set((inst.grid.forbidden ?? []).map(([x, y]) => `${x},${y}`));
  const seenItems = new Set<number>();
  const occupied = new Map<string, string>();

  let profit = 0;
  let area = 0;
  for (const p of sol.placements) {
    const it = inst.items[p.itemIndex];
    if (!it) { errors.push(`placement references unknown item index ${p.itemIndex}`); continue; }
    if (it.id !== p.id) errors.push(`item ${it.id}: certificate id mismatch (${p.id})`);
    if (seenItems.has(p.itemIndex)) errors.push(`item ${it.id}: placed more than once`);
    seenItems.add(p.itemIndex);

    const dimsOk = (p.w === it.w && p.h === it.h && !p.rotated) ||
                   (p.w === it.h && p.h === it.w && p.rotated);
    if (!dimsOk) errors.push(`item ${it.id}: bad placed dims ${p.w}x${p.h} rotated=${p.rotated}`);
    if (p.rotated && !it.rotate) errors.push(`item ${it.id}: rotated but rotation not allowed`);
    if (p.x < 0 || p.y < 0 || p.x + p.w > W || p.y + p.h > H) {
      errors.push(`item ${it.id}: out of grid at (${p.x},${p.y}) size ${p.w}x${p.h}`);
    }
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) {
        const key = `${p.x + dx},${p.y + dy}`;
        if (forb.has(key)) errors.push(`item ${it.id}: covers forbidden cell ${key}`);
        const prev = occupied.get(key);
        if (prev !== undefined) errors.push(`item ${it.id}: overlaps ${prev} at ${key}`);
        occupied.set(key, it.id);
      }
    }
    profit += it.profit;
    area += it.w * it.h;
  }
  if (profit !== sol.profit) errors.push(`claimed profit ${sol.profit} != actual ${profit}`);
  if (area !== sol.area) errors.push(`claimed area ${sol.area} != actual ${area}`);
  return errors;
}

/** Full check: certificate valid + solver optimum matches exhaustive enumeration. */
export function verifyInstance(
  inst: Instance,
  sol: Solution,
  nodeBudget: number = DEFAULT_NODE_BUDGET,
): VerifyResult {
  const certErrors = validateCertificate(inst, sol);
  if (certErrors.length > 0) {
    return { ok: false, checked: true, reason: `invalid certificate: ${certErrors.join("; ")}` };
  }
  const bf = bruteForceOptimum(inst, nodeBudget);
  if (bf.exhausted) {
    return { ok: true, checked: false, reason: `enumeration budget exceeded (${bf.nodes} nodes)`, nodes: bf.nodes };
  }
  const ok = bf.profit === sol.profit && bf.area === sol.area;
  return {
    ok,
    checked: true,
    nodes: bf.nodes,
    bruteForce: { profit: bf.profit, area: bf.area },
    solver: { profit: sol.profit, area: sol.area },
    reason: ok ? undefined :
      `mismatch: solver profit=${sol.profit} area=${sol.area}, exhaustive profit=${bf.profit} area=${bf.area}`,
  };
}

/** Render the occupancy certificate as an ASCII grid. */
export function renderGrid(inst: Instance, sol: Solution): string {
  const { width: W, height: H } = inst.grid;
  const cells: string[][] = Array.from({ length: H }, () => Array<string>(W).fill("."));
  for (const [x, y] of inst.grid.forbidden ?? []) cells[y][x] = "#";
  for (const p of sol.placements) {
    const ch = p.id.length === 1 ? p.id : p.id[0];
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) cells[p.y + dy][p.x + dx] = ch;
    }
  }
  return cells.map((row) => row.join(" ")).join("\n");
}
