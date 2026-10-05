// Deterministic random generators for property-style tests.
// Node.js built-ins only; the PRNG is mulberry32 so every run is reproducible.

import { Type, tvar, tfun, tlist } from "../src/types.js";

export class Rng {
  #state: number;
  constructor(seed: number) {
    this.#state = seed >>> 0;
  }
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let z = this.#state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }
  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }
  pick<T>(items: readonly T[]): T {
    const v = items[this.int(items.length)];
    if (v === undefined) throw new Error("pick from empty array");
    return v;
  }
}

/** Random type of bounded depth over a small variable pool. */
export function randomType(rng: Rng, depth: number, varPool: number): Type {
  if (depth <= 0) {
    return tvar(rng.int(varPool));
  }
  switch (rng.int(4)) {
    case 0:
    case 1:
      return tvar(rng.int(varPool));
    case 2:
      return tfun(randomType(rng, depth - 1, varPool), randomType(rng, depth - 1, varPool));
    default:
      return tlist(randomType(rng, depth - 1, varPool));
  }
}

export interface RawConstraint {
  name: string;
  lhs: Type;
  rhs: Type;
}

/** A batch of uniquely named random equality constraints. */
export function randomConstraints(rng: Rng, count: number, varPool: number): RawConstraint[] {
  const out: RawConstraint[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      name: `c${i}`,
      lhs: randomType(rng, 3, varPool),
      rhs: randomType(rng, 3, varPool),
    });
  }
  return out;
}
