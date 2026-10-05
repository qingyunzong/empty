import { LogEvent } from "../src/types.js";

/** Deterministic seeded PRNG (mulberry32). */
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
 * Random DAG with ids e0..e(n-1); edges only point from lower to higher
 * ids, so it is acyclic by construction. Timestamps are random and
 * independent of causality (deliberately not causally monotonic).
 */
export function randomDag(rnd: () => number, n: number, edgeProb: number): LogEvent[] {
  const sources = ["alpha", "beta", "gamma"];
  const seqs = new Map<string, number>();
  const events: LogEvent[] = [];
  for (let i = 0; i < n; i++) {
    const source = sources[Math.floor(rnd() * sources.length)];
    const seq = seqs.get(source) ?? 0;
    seqs.set(source, seq + 1);
    const deps: string[] = [];
    for (let j = 0; j < i; j++) {
      if (rnd() < edgeProb) deps.push(`e${j}`);
    }
    events.push({ id: `e${i}`, source, seq, ts: Math.floor(rnd() * (2 * n + 1)), deps });
  }
  return events;
}

export function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}
