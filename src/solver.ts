import { findCycle, reachable } from './graph.js';
import { impossibleGroups } from './parse.js';
import type { Pair, Problem, SolveStats } from './types.js';

export interface SolveResult {
  /** bitmask over `deletable` (sorted by edge id), null if infeasible */
  mask: number | null;
  cost: number | null;
  stats: SolveStats;
}

interface Ctx {
  problem: Problem;
  /** original indices of edges that may be deleted (sorted by id) */
  deletable: number[];
  /** keep[i] for every original edge: 0 undecided, 1 keep, 2 delete */
  state: Uint8Array;
  pairs: Pair[];
  /** group -> original edge indices */
  groupEdges: Map<string, number[]>;
  budget: number;
}

function buildCtx(problem: Problem): Ctx {
  const impossible = impossibleGroups(problem);
  const deletable: number[] = [];
  const state = new Uint8Array(problem.edges.length); // 0 = undecided
  problem.edges.forEach((e, i) => {
    const fixed = e.locked || (e.group !== null && impossible.has(e.group));
    if (fixed) state[i] = 1; // forced keep
    else deletable.push(i);
  });
  deletable.sort((a, b) => problem.edges[a]!.id.localeCompare(problem.edges[b]!.id));
  const groupEdges = new Map<string, number[]>();
  problem.edges.forEach((e, i) => {
    if (e.group === null) return;
    if (!groupEdges.has(e.group)) groupEdges.set(e.group, []);
    groupEdges.get(e.group)!.push(i);
  });
  return { problem, deletable, state, pairs: problem.pairs, groupEdges, budget: problem.budget };
}

const keepFromState = (ctx: Ctx) => (i: number) => ctx.state[i] === 1;
const keepOrUndecided = (ctx: Ctx) => (i: number) => ctx.state[i] !== 2;

/** Full feasibility check of a complete assignment (also used by brute force). */
export function feasible(ctx: Ctx): boolean {
  const { problem } = ctx;
  const keep = keepFromState(ctx);
  if (findCycle(problem.nodes, problem.edges, keep) !== null) return false;
  for (const p of ctx.pairs) {
    if (!reachable(p.from, p.to, problem.edges, keep)) return false;
  }
  // group prerequisites: deleting any edge of group g forces deleting ALL edges of required groups
  for (let i = 0; i < problem.edges.length; i++) {
    if (ctx.state[i] !== 2) continue;
    const g = problem.edges[i]!.group;
    if (g === null) continue;
    for (const req of problem.groupRequires.get(g) ?? []) {
      for (const j of ctx.groupEdges.get(req) ?? []) {
        if (ctx.state[j] !== 2) return false;
      }
    }
  }
  return true;
}

function costOfMask(ctx: Ctx, mask: number): number {
  let cost = 0;
  for (let b = 0; b < ctx.deletable.length; b++) {
    if (mask & (1 << b)) cost += ctx.problem.edges[ctx.deletable[b]!]!.cost;
  }
  return cost;
}

function applyMask(ctx: Ctx, mask: number): void {
  ctx.state.fill(0);
  ctx.problem.edges.forEach((e, i) => {
    const fixed = !ctx.deletable.includes(i);
    if (fixed) ctx.state[i] = 1;
  });
  for (let b = 0; b < ctx.deletable.length; b++) {
    ctx.state[ctx.deletable[b]!] = mask & (1 << b) ? 2 : 1;
  }
}

/** Compare candidates: lower cost, then fewer deletions, then smaller mask (deterministic). */
function better(costA: number, countA: number, maskA: number, costB: number, countB: number, maskB: number): boolean {
  if (costA !== costB) return costA < costB;
  if (countA !== countB) return countA < countB;
  return maskA < maskB;
}

/** Exhaustive enumeration of all 2^m deletion subsets. Independent optimality reference. */
export function bruteForce(problem: Problem): SolveResult {
  const ctx = buildCtx(problem);
  const m = ctx.deletable.length;
  const total = 1 << m;
  let bestMask: number | null = null;
  let bestCost = Infinity;
  let bestCount = Infinity;
  for (let mask = 0; mask < total; mask++) {
    const cost = costOfMask(ctx, mask);
    if (cost > ctx.budget || cost > bestCost) continue;
    applyMask(ctx, mask);
    if (!feasible(ctx)) continue;
    const count = popcount(mask);
    if (bestMask === null || better(cost, count, mask, bestCost, bestCount, bestMask)) {
      bestMask = mask;
      bestCost = cost;
      bestCount = count;
    }
  }
  return {
    mask: bestMask,
    cost: bestMask === null ? null : bestCost,
    stats: { deletableEdges: m, nodesExplored: total, pruned: 0 },
  };
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/**
 * Branch and bound over deletable edges.
 * Prunes: cost bound, budget, kept-edge cycles, reachability of required pairs
 * in the kept+undecided supergraph, and group-prerequisite violations.
 */
export function branchAndBound(problem: Problem): SolveResult {
  const ctx = buildCtx(problem);
  const m = ctx.deletable.length;
  const stats: SolveStats = { deletableEdges: m, nodesExplored: 0, pruned: 0 };

  let bestMask: number | null = null;
  let bestCost = Infinity;
  let bestCount = Infinity;

  // incumbent from a greedy cycle-breaking pass (improves pruning; not needed for correctness)
  const greedy = greedyIncumbent(ctx);
  if (greedy !== null) {
    bestMask = greedy;
    bestCost = costOfMask(ctx, greedy);
    bestCount = popcount(greedy);
    if (bestCost > ctx.budget) {
      bestMask = null;
      bestCost = Infinity;
      bestCount = Infinity;
    }
  }

  const decidedCost: number[] = [0];
  const decidedCount: number[] = [0];

  /** current partial mask over deletable edges (bits only meaningful for decided ones) */
  let curMask = 0;

  const violatesGroupPrereq = (): boolean => {
    for (let i = 0; i < ctx.problem.edges.length; i++) {
      if (ctx.state[i] !== 2) continue;
      const g = ctx.problem.edges[i]!.group;
      if (g === null) continue;
      for (const req of ctx.problem.groupRequires.get(g) ?? []) {
        for (const j of ctx.groupEdges.get(req) ?? []) {
          if (ctx.state[j] === 1) return true; // required edge already kept
        }
      }
    }
    return false;
  };

  const dfs = (depth: number): void => {
    stats.nodesExplored++;
    const cost = decidedCost[0]!;
    if (cost > bestCost || cost > ctx.budget) {
      stats.pruned++;
      return;
    }
    // kept edges must stay acyclic (a kept cycle can never be repaired later)
    if (findCycle(ctx.problem.nodes, ctx.problem.edges, keepFromState(ctx)) !== null) {
      stats.pruned++;
      return;
    }
    // every required pair must still be reachable in the kept+undecided supergraph
    const up = keepOrUndecided(ctx);
    for (const p of ctx.pairs) {
      if (!reachable(p.from, p.to, ctx.problem.edges, up)) {
        stats.pruned++;
        return;
      }
    }
    if (violatesGroupPrereq()) {
      stats.pruned++;
      return;
    }
    if (depth === m) {
      const count = decidedCount[0]!;
      if (bestMask === null || better(cost, count, curMask, bestCost, bestCount, bestMask)) {
        bestMask = curMask;
        bestCost = cost;
        bestCount = count;
      }
      return;
    }
    const edgeIdx = ctx.deletable[depth]!;
    // branch 1: keep (preferred — usually smaller search towards feasibility)
    ctx.state[edgeIdx] = 1;
    dfs(depth + 1);
    // branch 2: delete
    ctx.state[edgeIdx] = 2;
    decidedCost[0] = cost + ctx.problem.edges[edgeIdx]!.cost;
    decidedCount[0] = decidedCount[0]! + 1;
    curMask |= 1 << depth;
    dfs(depth + 1);
    curMask &= ~(1 << depth);
    decidedCount[0] = decidedCount[0]! - 1;
    decidedCost[0] = cost;
    ctx.state[edgeIdx] = 0;
  };

  dfs(0);
  return { mask: bestMask, cost: bestMask === null ? null : bestCost, stats };
}

/** Greedy: repeatedly break a cheapest deletable edge on some cycle; then apply prereq closure. */
function greedyIncumbent(ctx: Ctx): number | null {
  const saved = Uint8Array.from(ctx.state);
  for (const i of ctx.deletable) ctx.state[i] = 1;
  const { problem } = ctx;
  for (let iter = 0; iter <= ctx.deletable.length; iter++) {
    const cycle = findCycle(problem.nodes, problem.edges, keepFromState(ctx));
    if (cycle === null) break;
    let pick = -1;
    let pickCost = Infinity;
    for (let k = 0; k + 1 < cycle.length; k++) {
      const u = cycle[k]!;
      const v = cycle[k + 1]!;
      for (const i of ctx.deletable) {
        if (ctx.state[i] !== 1) continue;
        const e = problem.edges[i]!;
        if (e.from === u && e.to === v && e.cost < pickCost) {
          pick = i;
          pickCost = e.cost;
        }
      }
    }
    if (pick === -1) {
      ctx.state.set(saved);
      return null; // cycle of forced-keep edges
    }
    ctx.state[pick] = 2;
  }
  // prerequisite closure: deleting group g forces deleting all edges of required groups
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < problem.edges.length; i++) {
      if (ctx.state[i] !== 2) continue;
      const g = problem.edges[i]!.group;
      if (g === null) continue;
      for (const req of problem.groupRequires.get(g) ?? []) {
        for (const j of ctx.groupEdges.get(req) ?? []) {
          if (ctx.state[j] !== 2) {
            if (ctx.deletable.includes(j)) {
              ctx.state[j] = 2;
              changed = true;
            } else {
              ctx.state.set(saved);
              return null;
            }
          }
        }
      }
    }
  }
  let mask = 0;
  for (let b = 0; b < ctx.deletable.length; b++) {
    if (ctx.state[ctx.deletable[b]!] === 2) mask |= 1 << b;
  }
  const ok = feasible(ctx);
  ctx.state.set(saved);
  return ok ? mask : null;
}
