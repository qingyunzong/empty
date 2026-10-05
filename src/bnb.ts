import { compareSubsets, toMasked, type Problem } from "./model.js";

export interface BnbResult {
  feasible: boolean;
  cost: number | null;
  indices: number[];
  nodes: number;
  banned: number[]; // candidates that can never appear in any feasible subset
}

// Branch-and-bound over candidate include/exclude decisions.
//
// Pruning rules (all sound under deny-priority semantics):
//   - A deny-rule matching an allow-expected sample can never be selected, so
//     such candidates are excluded from the search entirely ("banned").
//   - cost > best: costs are non-negative, so no descendant can improve.
//   - A selected deny-rule already hits an allow-expected sample: dead end.
//   - An allow-expected sample has no selected allow-rule and no remaining
//     candidate could provide one: dead end.
//   - A deny-expected sample is currently allowed, not overridden by a
//     selected deny-rule, and no remaining candidate could override it: dead.
export function solveBnB(problem: Problem): BnbResult {
  const mp = toMasked(problem);
  const n = problem.candidates.length;
  const expectAllow = mp.expectAllowMask;
  const expectDeny = mp.expectDenyMask;

  const banned: number[] = [];
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    if ((mp.denyMask[i]! & expectAllow) !== 0n) banned.push(i);
    else order.push(i);
  }
  // Cheapest-first ordering finds good incumbents early.
  order.sort((a, b) => {
    const d = mp.costs[a]! - mp.costs[b]!;
    if (d !== 0) return d;
    return mp.ids[a]! < mp.ids[b]! ? -1 : 1;
  });

  const m = order.length;
  const suffixAllow = new Array<bigint>(m + 1).fill(0n);
  const suffixDeny = new Array<bigint>(m + 1).fill(0n);
  for (let p = m - 1; p >= 0; p--) {
    suffixAllow[p] = suffixAllow[p + 1]! | mp.allowMask[order[p]!]!;
    suffixDeny[p] = suffixDeny[p + 1]! | mp.denyMask[order[p]!]!;
  }

  let nodes = 0;
  let bestCost: number | null = null;
  let bestIds: string[] = [];
  let bestChosen: number[] = [];
  const chosen: number[] = [];

  function search(p: number, cost: number, allowBits: bigint, denyBits: bigint): void {
    nodes++;
    if (bestCost !== null && cost > bestCost) return;
    if ((denyBits & expectAllow) !== 0n) return;
    const missingAllow = expectAllow & ~allowBits;
    if ((missingAllow & ~suffixAllow[p]!) !== 0n) return;
    const exposedDeny = expectDeny & allowBits & ~denyBits;
    if ((exposedDeny & ~suffixDeny[p]!) !== 0n) return;
    if (p === m) {
      // Feasible leaf: every allow-sample is covered and not denied, every
      // deny-sample is either untouched or overridden by a deny-rule.
      const ids = chosen.map((i) => mp.ids[i]!).sort();
      if (bestCost === null || compareSubsets({ cost, ids }, { cost: bestCost, ids: bestIds }) < 0) {
        bestCost = cost;
        bestIds = ids;
        bestChosen = [...chosen];
      }
      return;
    }
    const cand = order[p]!;
    chosen.push(cand);
    search(p + 1, cost + mp.costs[cand]!, allowBits | mp.allowMask[cand]!, denyBits | mp.denyMask[cand]!);
    chosen.pop();
    search(p + 1, cost, allowBits, denyBits);
  }

  search(0, 0, 0n, 0n);
  return { feasible: bestCost !== null, cost: bestCost, indices: bestChosen, nodes, banned };
}
