import { findCycle, reachable, topoOrder } from "./graph";
import { NormalizedProblem } from "./types";

export interface Feasibility {
  ok: boolean;
  cost: number;
  /** why infeasible (first reason found) */
  reason?: string;
}

/**
 * Expand a deletion mask to its group-prerequisite closure.
 * Deleting any edge of group G forces deletion of every edge of each group
 * required by G (transitively). Returns null when the closure would delete a
 * locked edge.
 */
export function groupClosure(p: NormalizedProblem, mask: number): number | null {
  let result = mask;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [group, members] of p.groupEdges) {
      const anyDeleted = members.some((i) => (result & (1 << i)) !== 0);
      if (!anyDeleted) continue;
      for (const req of p.groupRequires.get(group) ?? []) {
        for (const j of p.groupEdges.get(req) ?? []) {
          if ((result & (1 << j)) === 0) {
            if (p.edges[j]!.locked) return null;
            result |= 1 << j;
            changed = true;
          }
        }
      }
    }
  }
  return result;
}

export function maskCost(p: NormalizedProblem, mask: number): number {
  let c = 0;
  for (let i = 0; i < p.edges.length; i++) if (mask & (1 << i)) c += p.edges[i]!.cost;
  return c;
}

/** full feasibility check of a deletion mask (must already be closed) */
export function checkFeasible(p: NormalizedProblem, mask: number): Feasibility {
  for (let i = 0; i < p.edges.length; i++) {
    if (mask & (1 << i)) {
      if (p.edges[i]!.locked) return { ok: false, cost: 0, reason: `locked edge ${p.edges[i]!.id} deleted` };
    }
  }
  const closed = groupClosure(p, mask);
  if (closed === null) return { ok: false, cost: 0, reason: "group closure deletes a locked edge" };
  if (closed !== mask) return { ok: false, cost: 0, reason: "deletion set is not closed under group prerequisites" };
  const cost = maskCost(p, mask);
  if (cost > p.budget) return { ok: false, cost, reason: `cost ${cost} exceeds budget ${p.budget}` };
  const keep = (i: number) => (mask & (1 << i)) === 0;
  if (topoOrder(p, keep) === null) {
    return { ok: false, cost, reason: `remaining graph has cycle: ${(findCycle(p, keep) ?? []).join(" -> ")}` };
  }
  for (const r of p.reachability) {
    if (!reachable(p, keep, r.from, r.to)) {
      return { ok: false, cost, reason: `reachability ${r.from} -> ${r.to} broken` };
    }
  }
  return { ok: true, cost };
}

function better(cost: number, mask: number, bestCost: number, bestMask: number): boolean {
  if (cost !== bestCost) return cost < bestCost;
  const pc = popcount(mask);
  const pb = popcount(bestMask);
  if (pc !== pb) return pc < pb;
  return mask < bestMask;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

export interface SolveResult {
  feasible: boolean;
  bestMask: number;
  bestCost: number;
  enumeration: { subsetsChecked: number; bestCost: number | null };
  branchAndBound: { nodesExplored: number; bestCost: number | null };
  agree: boolean;
}

/** exhaustive check of all 2^n deletion subsets (n <= 18) */
export function enumerateAll(p: NormalizedProblem): { bestMask: number; bestCost: number; checked: number } {
  const n = p.edges.length;
  const total = 1 << n;
  let bestMask = -1;
  let bestCost = Infinity;
  let checked = 0;
  for (let mask = 0; mask < total; mask++) {
    // skip masks deleting locked edges
    let lockedHit = false;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        if (p.edges[i]!.locked) {
          lockedHit = true;
          break;
        }
      }
    }
    if (lockedHit) continue;
    const closed = groupClosure(p, mask);
    if (closed === null || closed !== mask) continue; // evaluate each closed set exactly once
    checked++;
    const f = checkFeasible(p, mask);
    if (f.ok && (bestMask === -1 || better(f.cost, mask, bestCost, bestMask))) {
      bestCost = f.cost;
      bestMask = mask;
    }
  }
  return { bestMask, bestCost, checked };
}

/**
 * Branch and bound over keep/delete decisions. Prunes on:
 *  - cost bound (costs are non-negative, so partial cost is a valid lower bound)
 *  - kept edges alone forming a cycle (can never be repaired by keeping more)
 *  - a required reachability pair already disconnected in kept+undecided edges
 *  - group closure of the partial deletion set exceeding the bound
 */
export function branchAndBound(p: NormalizedProblem): { bestMask: number; bestCost: number; nodes: number } {
  const n = p.edges.length;
  let bestMask = -1;
  let bestCost = Infinity;
  let nodes = 0;

  const rec = (i: number, delMask: number, keepMask: number, cost: number) => {
    nodes++;
    if (cost >= bestCost || cost > p.budget) return;
    const closed = groupClosure(p, delMask);
    if (closed === null) return;
    const closedCost = maskCost(p, closed);
    if (closedCost >= bestCost || closedCost > p.budget) return;
    if (findCycle(p, (j) => (keepMask & (1 << j)) !== 0) !== null) return;
    const undecidedKeep = (j: number) =>
      (keepMask & (1 << j)) !== 0 || (j >= i && (closed & (1 << j)) === 0);
    for (const r of p.reachability) {
      if (!reachable(p, undecidedKeep, r.from, r.to)) return;
    }
    if (i === n) {
      if (closed !== delMask) return; // not closed; the closed version is reached via other branches
      const f = checkFeasible(p, delMask);
      if (f.ok && (bestMask === -1 || better(f.cost, delMask, bestCost, bestMask))) {
        bestCost = f.cost;
        bestMask = delMask;
      }
      return;
    }
    // branch 1: keep edge i
    rec(i + 1, delMask, keepMask | (1 << i), cost);
    // branch 2: delete edge i (if allowed)
    if (!p.edges[i]!.locked) {
      rec(i + 1, delMask | (1 << i), keepMask, cost + p.edges[i]!.cost);
    }
  };
  rec(0, 0, 0, 0);
  return { bestMask, bestCost, nodes };
}

/** solve with both methods and cross-check that they agree */
export function solve(p: NormalizedProblem): SolveResult {
  const en = enumerateAll(p);
  const bb = branchAndBound(p);
  const enBest = en.bestMask === -1 ? null : en.bestCost;
  const bbBest = bb.bestMask === -1 ? null : bb.bestCost;
  return {
    feasible: en.bestMask !== -1,
    bestMask: en.bestMask,
    bestCost: en.bestCost,
    enumeration: { subsetsChecked: en.checked, bestCost: enBest },
    branchAndBound: { nodesExplored: bb.nodes, bestCost: bbBest },
    agree: enBest === bbBest,
  };
}
