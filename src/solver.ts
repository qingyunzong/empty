import type { Instance, Placement, RectSpec, Solution } from './types.js';

export interface PlacementMask {
  mask: bigint;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Prepared {
  width: number;
  height: number;
  freeCells: number;
  forbiddenMask: bigint;
  perRect: PlacementMask[][];
  signatures: string[];
}

export class BudgetExceeded extends Error {
  constructor(public readonly limit: number) {
    super(`搜索节点数超过预算 ${limit}`);
    this.name = 'BudgetExceeded';
  }
}

function placementsFor(r: RectSpec, width: number, height: number, forbidden: bigint): PlacementMask[] {
  const out: PlacementMask[] = [];
  const seen = new Set<bigint>();
  const dims: Array<[number, number]> = [[r.w, r.h]];
  if (r.rotate && r.w !== r.h) dims.push([r.h, r.w]);
  for (const [w, h] of dims) {
    for (let y = 0; y + h <= height; y++) {
      for (let x = 0; x + w <= width; x++) {
        let mask = 0n;
        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) {
            mask |= 1n << BigInt((y + dy) * width + x + dx);
          }
        }
        if ((mask & forbidden) !== 0n || seen.has(mask)) continue;
        seen.add(mask);
        out.push({ mask, x, y, w, h });
      }
    }
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

export function prepare(inst: Instance): Prepared {
  const { width, height } = inst.grid;
  let forbiddenMask = 0n;
  for (const [x, y] of inst.grid.forbidden) {
    forbiddenMask |= 1n << BigInt(y * width + x);
  }
  const perRect = inst.rectangles.map((r) => placementsFor(r, width, height, forbiddenMask));
  const signatures = inst.rectangles.map((r) => `${r.w}x${r.h}:${r.rotate ? 1 : 0}`);
  const freeCells = width * height - inst.grid.forbidden.length;
  return { width, height, freeCells, forbiddenMask, perRect, signatures };
}

export interface Choice {
  rect: number;
  placement: number;
}

/**
 * 判定一组矩形能否互不重叠地放入网格（避开禁区），可行则返回放置方案。
 * 相同规格的矩形按放置序号递增约束，消除排列对称性。
 */
export function placeSubset(
  rectIndices: number[],
  perRect: PlacementMask[][],
  signatures: string[],
  budget: { nodes: number; limit: number },
): Choice[] | null {
  const order = [...rectIndices].sort(
    (a, b) =>
      perRect[a]!.length - perRect[b]!.length ||
      signatures[a]!.localeCompare(signatures[b]!) ||
      a - b,
  );
  const chosen = new Array<number>(order.length).fill(0);

  const dfs = (k: number, occ: bigint): boolean => {
    if (k === order.length) return true;
    if (++budget.nodes > budget.limit) throw new BudgetExceeded(budget.limit);
    for (let j = k; j < order.length; j++) {
      const ps = perRect[order[j]!]!;
      let any = false;
      for (const p of ps) {
        if ((p.mask & occ) === 0n) {
          any = true;
          break;
        }
      }
      if (!any) return false;
    }
    const rect = order[k]!;
    const ps = perRect[rect]!;
    let start = 0;
    if (k > 0 && signatures[order[k]!] === signatures[order[k - 1]!]) {
      start = chosen[k - 1]! + 1;
    }
    for (let pi = start; pi < ps.length; pi++) {
      const p = ps[pi]!;
      if ((p.mask & occ) !== 0n) continue;
      chosen[k] = pi;
      if (dfs(k + 1, occ | p.mask)) return true;
    }
    return false;
  };

  if (!dfs(0, 0n)) return null;
  return order.map((rect, k) => ({ rect, placement: chosen[k]! }));
}

export interface SolveStats {
  nodes: number;
  subsetsTried: number;
}

export interface SolveOptions {
  nodeLimit?: number;
  stats?: SolveStats;
}

/**
 * 精确求解：枚举全部 2^n 个子集，按 (收益降序, 面积升序) 排序，
 * 第一个可放置的子集即为 (最大收益, 最小面积) 最优解。
 */
export function solve(inst: Instance, opts: SolveOptions = {}): Solution {
  const prep = prepare(inst);
  const n = inst.rectangles.length;
  const budget = { nodes: 0, limit: opts.nodeLimit ?? 50_000_000 };

  interface Cand {
    idxs: number[];
    profit: number;
    area: number;
  }
  const cands: Cand[] = [];
  for (let bits = 0; bits < 1 << n; bits++) {
    const idxs: number[] = [];
    let profit = 0;
    let area = 0;
    for (let i = 0; i < n; i++) {
      if (bits & (1 << i)) {
        const r = inst.rectangles[i]!;
        idxs.push(i);
        profit += r.profit;
        area += r.w * r.h;
      }
    }
    cands.push({ idxs, profit, area });
  }
  cands.sort((a, b) => b.profit - a.profit || a.area - b.area);

  let tried = 0;
  for (const c of cands) {
    if (c.area > prep.freeCells) continue;
    tried++;
    const choices = placeSubset(c.idxs, prep.perRect, prep.signatures, budget);
    if (choices) {
      if (opts.stats) {
        opts.stats.nodes = budget.nodes;
        opts.stats.subsetsTried = tried;
      }
      const placements: Placement[] = choices.map((ch) => {
        const p = prep.perRect[ch.rect]![ch.placement]!;
        return { id: inst.rectangles[ch.rect]!.id, x: p.x, y: p.y, w: p.w, h: p.h };
      });
      return { profit: c.profit, area: c.area, placements };
    }
  }
  throw new Error('不可达：空子集必定可行');
}
