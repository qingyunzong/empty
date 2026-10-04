import { Graph } from "../src/index";

/** Deterministic PRNG (mulberry32) so tests need no external dependencies. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomGraphSpec {
  graph: Graph<number>;
  nodeCount: number;
  scores: number[];
  priorities: number[];
}

/**
 * Builds a deterministic pseudo-random directed graph. A spanning chain
 * 0 -> 1 -> ... -> n-1 guarantees every node is reachable from node 0.
 */
export function randomGraph(seed: number, nodeCount: number, maxDegree: number): RandomGraphSpec {
  const rand = mulberry32(seed);
  const edges: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < nodeCount; i++) {
    edges[i]!.push((i + 1) % nodeCount);
    const extra = Math.floor(rand() * maxDegree);
    for (let j = 0; j < extra; j++) {
      edges[i]!.push(Math.floor(rand() * nodeCount));
    }
  }
  const priorities = Array.from({ length: nodeCount }, () => Math.floor(rand() * 20));
  const scores = Array.from({ length: nodeCount }, () => Math.floor(rand() * 1000));
  const graph: Graph<number> = {
    start: () => [0],
    neighbors: (s) => edges[s]!,
    key: (s) => String(s),
    priority: (s) => priorities[s]!,
    score: (s) => scores[s]!,
  };
  return { graph, nodeCount, scores, priorities };
}
