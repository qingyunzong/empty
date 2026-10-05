/**
 * Cycle reporting over a projected graph.
 *
 * Cycles are only reported; edges are never removed automatically.
 * Every reported cycle is cross-checked by an independent
 * reachability pass (BFS) that shares no logic with the DFS detector.
 */

import type { NodeId } from "./graph.ts";

export type Projection = ReadonlyMap<NodeId, readonly NodeId[]>;

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/** DFS-based cycle detector. Returns each cycle as an ordered node path. */
export function findCycles(projection: Projection): NodeId[][] {
  const color = new Map<NodeId, number>();
  const cycles: NodeId[][] = [];
  const stack: NodeId[] = [];

  const visit = (node: NodeId): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of projection.get(node) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        cycles.push(stack.slice(stack.indexOf(next)));
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of [...projection.keys()].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }
  return cycles;
}

/** Independent BFS reachability: can `to` be reached from `from`? */
export function reachable(projection: Projection, from: NodeId, to: NodeId): boolean {
  const seen = new Set<NodeId>([from]);
  const queue: NodeId[] = [from];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === to) return true;
    for (const next of projection.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Verify reported cycle evidence using only reachability queries:
 * every consecutive hop must be a real edge, and from each successor
 * the predecessor must be reachable again (closing the loop).
 */
export function verifyCycleEvidence(projection: Projection, cycle: readonly NodeId[]): boolean {
  if (cycle.length === 0) return false;
  for (let i = 0; i < cycle.length; i += 1) {
    const current = cycle[i];
    const next = cycle[(i + 1) % cycle.length];
    const isEdge = (projection.get(current) ?? []).includes(next);
    if (!isEdge) return false;
    if (!reachable(projection, next, current)) return false;
  }
  return true;
}
