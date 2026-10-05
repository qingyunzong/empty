// Short-horizon exhaustive enumeration: tries every feasible decision
// sequence and returns the lexicographic optimum. Used as a brute-force
// cross-check against the DP on small instances.

import { SolveInput, Cost, cmpCost } from "./core";

export function enumerateOptimum(input: SolveInput, maxLeaves = 2_000_000): Cost | null {
  const T = input.demand.length;
  const C = input.capacity;
  const S = input.streams.length;
  let leaves = 1;
  for (let t = 0; t < T; t++) {
    let ranges = 1;
    for (let s = 0; s < S; s++) {
      ranges *= Math.min(input.slots[t][s].max, C) - input.slots[t][s].min + 1;
    }
    leaves *= Math.max(1, ranges);
    if (leaves > maxLeaves) {
      throw new Error(`enumeration space too large (> ${maxLeaves}); use a shorter period`);
    }
  }

  let best: Cost | null = null;
  const rec = (t: number, inv: number, money: number, dev: number): void => {
    if (t === T) {
      const cand: Cost = { dev, money };
      if (best === null || cmpCost(cand, best) < 0) best = cand;
      return;
    }
    if (best !== null && (dev > best.dev || (dev === best.dev && money >= best.money))) return;
    const d = input.demand[t];
    const slotT = input.slots[t];
    const visit = (s: number, total: number, m: number, dv: number): void => {
      if (s === S) {
        if (inv + total < d) return;
        const end = inv + total - d;
        rec(t + 1, end, m + input.holdingCost * end, dv);
        return;
      }
      const slot = slotT[s];
      const stream = input.streams[s];
      const qMax = Math.min(slot.max, C - inv - total);
      for (let qq = slot.min; qq <= qMax; qq++) {
        const mm = slot.counted && qq > 0 ? stream.fixedCost + stream.unitCost * qq : 0;
        const dd = slot.devBase !== null ? Math.abs(qq - slot.devBase) : 0;
        visit(s + 1, total + qq, m + mm, dv + dd);
      }
    };
    visit(0, 0, money, dev);
  };
  rec(0, input.initialInventory, 0, 0);
  return best;
}
