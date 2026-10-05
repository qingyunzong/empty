import { Problem } from "../src/model";
import { buildDistinguishData } from "../src/solver";

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

export function randomProblemRaw(
  rng: () => number,
  strategyCount: number,
  sampleCount: number,
  alphabet: number
): unknown {
  return {
    samples: Array.from({ length: sampleCount }, (_, i) => `s${i}`),
    strategies: Array.from({ length: strategyCount }, (_, i) => ({
      id: `P${i}`,
      outputs: Array.from({ length: sampleCount }, () => Math.floor(rng() * alphabet)),
    })),
  };
}

function lexCompare(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}

export interface BruteForceResult {
  min: number;
  count: number;
  lexicographicFirst: string[];
}

/** Reference implementation: enumerates every subset, small problems only. */
export function bruteForceOptimum(problem: Problem): BruteForceResult {
  const data = buildDistinguishData(problem);
  const sampleCount = problem.sampleIds.length;
  for (let size = 0; size <= sampleCount; size++) {
    const feasible: number[][] = [];
    const chosen: number[] = [];
    const visit = (position: number, acc: bigint): void => {
      if (chosen.length === size) {
        if (acc === data.fullCover) feasible.push(chosen.slice());
        return;
      }
      const remaining = size - chosen.length;
      for (let i = position; i <= sampleCount - remaining; i++) {
        chosen.push(i);
        visit(i + 1, acc | data.sampleCover[i]!);
        chosen.pop();
      }
    };
    visit(0, 0n);
    if (feasible.length > 0) {
      const tuples = feasible.map((indexes) =>
        indexes.map((i) => problem.sampleIds[i]!).sort()
      );
      tuples.sort(lexCompare);
      return { min: size, count: feasible.length, lexicographicFirst: tuples[0]! };
    }
  }
  throw new Error("unreachable: the full set always covers every feasible pair");
}
