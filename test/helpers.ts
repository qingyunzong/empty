import type { Interval, PackageSpec, Problem } from "../src/types.js";

/** Deterministic PRNG (mulberry32) for reproducible randomized tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomProblem(rand: () => number, opts: {
  range?: number;
  packages?: number;
  receiverChunks?: number;
  withDeps?: boolean;
  memoryLimit?: number;
} = {}): Problem {
  const R = opts.range ?? 60;
  const nPkg = opts.packages ?? 8;
  const receiver: Interval[] = [];
  for (let i = 0; i < (opts.receiverChunks ?? 2); i++) {
    const s = Math.floor(rand() * (R - 4));
    receiver.push({ start: s, end: s + 1 + Math.floor(rand() * 4) });
  }
  const packages: PackageSpec[] = [];
  for (let i = 0; i < nPkg; i++) {
    const nIv = 1 + Math.floor(rand() * 2);
    const cover: Interval[] = [];
    for (let j = 0; j < nIv; j++) {
      const s = Math.floor(rand() * (R - 3));
      cover.push({ start: s, end: s + 1 + Math.floor(rand() * 6) });
    }
    // Only depend on earlier packages: acyclic by construction.
    const needs: string[] = [];
    if (opts.withDeps) {
      for (let j = 0; j < i; j++) {
        if (rand() < 0.25) needs.push(`P${j}`);
      }
    }
    packages.push({
      id: `P${i}`,
      cover,
      bytes: 1 + Math.floor(rand() * 40),
      dictBytes: Math.floor(rand() * 25),
      needs,
    });
  }
  return {
    range: { start: 0, end: R },
    receiver,
    memoryLimit: opts.memoryLimit ?? 100000,
    maxPackages: 20,
    packages,
  };
}
