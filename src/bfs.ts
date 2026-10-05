/**
 * Breadth-first search over the explicit state graph.
 *
 * - shortestPlan: unit-cost optimal plan plus per-depth layer sizes
 *   (the layer data doubles as a checkable optimality certificate).
 * - reachableClosure: full reachable state set with depths.
 * - goalDistances: exact distance-to-goal for every reachable state
 *   (reverse BFS), used to cross-check heuristics and learned nogoods.
 */

import {
  Problem,
  State,
  initialState,
  isGoal,
  stateKey,
  successors,
} from "./model.js";

export interface PlanResult {
  plan: string[];
  length: number;
  /** Number of states at each BFS depth 0..length (optimality evidence). */
  layers: number[];
  /** Total states dequeued during the search. */
  expanded: number;
  goalKey: string;
}

export function shortestPlan(p: Problem): PlanResult | null {
  const start = initialState(p);
  const startKey = stateKey(start);
  const dist = new Map<string, number>([[startKey, 0]]);
  const parent = new Map<string, { key: string; action: string }>();
  const states = new Map<string, State>([[startKey, start]]);
  const layers: number[] = [];

  let frontier: string[] = [startKey];
  let depth = 0;
  let expanded = 0;

  while (frontier.length > 0) {
    layers.push(frontier.length);
    const next: string[] = [];
    for (const key of frontier) {
      expanded++;
      const s = states.get(key)!;
      if (isGoal(p, s)) {
        return { plan: extractPlan(parent, key), length: depth, layers, expanded, goalKey: key };
      }
      for (const { action, state: ns } of successors(p, s)) {
        const nk = stateKey(ns);
        if (dist.has(nk)) continue;
        dist.set(nk, depth + 1);
        parent.set(nk, { key, action: action.name });
        states.set(nk, ns);
        next.push(nk);
      }
    }
    frontier = next;
    depth++;
  }
  return null;
}

function extractPlan(parent: Map<string, { key: string; action: string }>, goalKey: string): string[] {
  const plan: string[] = [];
  let cur = goalKey;
  for (;;) {
    const edge = parent.get(cur);
    if (!edge) break;
    plan.push(edge.action);
    cur = edge.key;
  }
  return plan.reverse();
}

export interface ClosureResult {
  count: number;
  /** depth histogram: index = depth, value = number of states */
  histogram: number[];
  depthOf: Map<string, number>;
}

export function reachableClosure(p: Problem): ClosureResult {
  const start = initialState(p);
  const startKey = stateKey(start);
  const depthOf = new Map<string, number>([[startKey, 0]]);
  let frontier: Array<{ key: string; state: State }> = [{ key: startKey, state: start }];
  let depth = 0;
  const histogram: number[] = [];

  while (frontier.length > 0) {
    histogram.push(frontier.length);
    const next: Array<{ key: string; state: State }> = [];
    for (const { state: s } of frontier) {
      for (const { state: ns } of successors(p, s)) {
        const nk = stateKey(ns);
        if (depthOf.has(nk)) continue;
        depthOf.set(nk, depth + 1);
        next.push({ key: nk, state: ns });
      }
    }
    frontier = next;
    depth++;
  }
  return { count: depthOf.size, histogram, depthOf };
}

/**
 * Exact distance-to-goal for every reachable state (states that cannot
 * reach the goal are absent from the map). Built by forward closure +
 * reverse BFS from the goal set.
 */
export function goalDistances(p: Problem): Map<string, number> {
  const start = initialState(p);
  const startKey = stateKey(start);

  // Forward pass: collect reachable states and edges.
  const states = new Map<string, State>([[startKey, start]]);
  const edges = new Map<string, string[]>();
  const queue: string[] = [startKey];
  for (let head = 0; head < queue.length; head++) {
    const key = queue[head]!;
    const outs: string[] = [];
    for (const { state: ns } of successors(p, states.get(key)!)) {
      const nk = stateKey(ns);
      outs.push(nk);
      if (!states.has(nk)) {
        states.set(nk, ns);
        queue.push(nk);
      }
    }
    edges.set(key, outs);
  }

  // Reverse adjacency.
  const rev = new Map<string, string[]>();
  for (const [from, outs] of edges) {
    for (const to of outs) {
      const list = rev.get(to);
      if (list) list.push(from);
      else rev.set(to, [from]);
    }
  }

  // Reverse BFS from all reachable goal states.
  const dist = new Map<string, number>();
  const bfsQueue: string[] = [];
  for (const [key, s] of states) {
    if (isGoal(p, s)) {
      dist.set(key, 0);
      bfsQueue.push(key);
    }
  }
  for (let head = 0; head < bfsQueue.length; head++) {
    const key = bfsQueue[head]!;
    const d = dist.get(key)!;
    for (const prev of rev.get(key) ?? []) {
      if (dist.has(prev)) continue;
      dist.set(prev, d + 1);
      bfsQueue.push(prev);
    }
  }
  return dist;
}
