import { Problem } from "../src/search";

/** Deterministic PRNG (mulberry32) so tests need no external deps. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds a deterministic directed graph with `size` states (0..size-1).
 * A chain i -> i+1 guarantees the goal (state size-1) is reachable;
 * extra random edges make the search non-trivial. Edge costs are in
 * 1..9, so h(i) = size-1-i is an admissible heuristic.
 */
export function makeGraphProblem(
  seed: number,
  size: number,
  extraEdges: number,
): Problem<number> {
  const rand = mulberry32(seed);
  const edges: Array<Array<{ state: number; cost: number }>> = [];
  for (let i = 0; i < size; i++) edges.push([]);
  for (let i = 0; i + 1 < size; i++) {
    edges[i]!.push({ state: i + 1, cost: 1 + Math.floor(rand() * 9) });
  }
  for (let e = 0; e < extraEdges; e++) {
    const from = Math.floor(rand() * size);
    const to = Math.floor(rand() * size);
    if (from === to) continue;
    edges[from]!.push({ state: to, cost: 1 + Math.floor(rand() * 9) });
  }
  return {
    start: 0,
    isGoal: (s) => s === size - 1,
    successors: (s) => edges[s]!,
    key: (s) => `s${s}`,
    heuristic: (s) => size - 1 - s,
  };
}
