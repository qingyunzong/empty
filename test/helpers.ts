import { NetworkSpec, Segment } from "../src/types";

/** Deterministic PRNG (mulberry32) so test runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * Generate a random network that is guaranteed to contain no negative-cost
 * cycle: every marginal fee on edge u->v is at least `pot[v] - pot[u]` for
 * fixed node potentials, so every directed cycle telescopes to >= 0.
 */
export function randomNetwork(rand: () => number): NetworkSpec {
  const nodeCount = randInt(rand, 2, 5);
  const nodes = Array.from({ length: nodeCount }, (_, i) => `N${i}`);
  const potential = nodes.map(() => randInt(rand, -4, 4));

  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nodeCount; i++) pairs.push([i, i + 1]); // guarantee s~>t path
  const extra = randInt(rand, 0, nodeCount);
  for (let i = 0; i < extra; i++) {
    const u = randInt(rand, 0, nodeCount - 1);
    const v = randInt(rand, 0, nodeCount - 1);
    if (u !== v) pairs.push([u, v]);
  }

  const chainLength = nodeCount - 1;
  const edges = pairs.map(([u, v], idx) => {
    // Chain edges carry the s~>t path, so give them roomier capacities to
    // keep most random instances feasible.
    const capacity = idx < chainLength ? randInt(rand, 2, 4) : randInt(rand, 1, 3);
    const segments: Segment[] = [];
    let prev = 0;
    let cost = potential[v]! - potential[u]! + randInt(rand, 0, 3);
    while (prev < capacity) {
      const upTo = Math.min(capacity, prev + randInt(rand, 1, capacity));
      segments.push({ upTo, unitCost: cost });
      cost += randInt(rand, 0, 3);
      prev = upTo;
    }
    return { from: nodes[u]!, to: nodes[v]!, capacity, segments };
  });

  return {
    nodes,
    edges,
    source: nodes[0]!,
    sink: nodes[nodeCount - 1]!,
    amount: randInt(rand, 0, 5),
  };
}
