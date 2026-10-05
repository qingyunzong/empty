import type { Instance } from './types.js';
import { prepare } from './solver.js';

export interface ExhaustiveResult {
  profit: number;
  area: number;
  nodes: number;
  complete: boolean;
}

const STOP = Symbol('stop');

/**
 * 独立的全枚举核对器（用于极小网格）：遍历全部子集，
 * 用与主求解器不同的固定顺序朴素回溯判定可行性，找出真正的最优值。
 * 超出节点预算时 complete=false，结果不可信。
 */
export function exhaustiveOptimum(inst: Instance, nodeLimit = 5_000_000): ExhaustiveResult {
  const prep = prepare(inst);
  const n = inst.rectangles.length;
  let bestProfit = 0;
  let bestArea = 0;
  let nodes = 0;
  let complete = true;

  const feasible = (idxs: number[]): boolean => {
    let occ = 0n;
    const rec = (k: number): boolean => {
      if (k === idxs.length) return true;
      if (++nodes > nodeLimit) throw STOP;
      for (const p of prep.perRect[idxs[k]!]!) {
        if ((p.mask & occ) === 0n) {
          occ |= p.mask;
          if (rec(k + 1)) return true;
          occ ^= p.mask;
        }
      }
      return false;
    };
    return rec(0);
  };

  try {
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
      if (profit < bestProfit || (profit === bestProfit && area >= bestArea)) continue;
      if (area > prep.freeCells) continue;
      if (feasible(idxs)) {
        bestProfit = profit;
        bestArea = area;
      }
    }
  } catch (e) {
    if (e !== STOP) throw e;
    complete = false;
  }
  return { profit: bestProfit, area: bestArea, nodes, complete };
}
