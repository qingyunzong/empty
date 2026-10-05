import { Type } from "./types.js";

/** Deterministic PRNG (mulberry32) so randomized tests are reproducible. */
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

export interface RandomSpec {
  readonly varCount: number;
  readonly maxDepth: number;
}

export function randomType(rand: () => number, spec: RandomSpec, depth = 0): Type {
  const atLeaf = depth >= spec.maxDepth;
  const pick = rand();
  if (atLeaf || pick < 0.45) {
    return { kind: "var", id: Math.floor(rand() * spec.varCount) };
  }
  if (pick < 0.75) {
    return {
      kind: "fun",
      arg: randomType(rand, spec, depth + 1),
      ret: randomType(rand, spec, depth + 1),
    };
  }
  return { kind: "list", elem: randomType(rand, spec, depth + 1) };
}

export interface RandomConstraint {
  readonly name: string;
  readonly left: Type;
  readonly right: Type;
}

export function randomConstraints(
  rand: () => number,
  count: number,
  spec: RandomSpec,
): RandomConstraint[] {
  const out: RandomConstraint[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      name: `c${i}`,
      left: randomType(rand, spec),
      right: randomType(rand, spec),
    });
  }
  return out;
}
