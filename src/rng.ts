// Deterministic PRNG (splitmix64) driven by a JSON-serializable seed.
// The canonical seed form is a plain string; any string maps to a stream.

import { hashValue } from "./hash";

export interface Seed {
  hi: number;
  lo: number;
}

const MASK = 0xffffffffffffffffn;

export class Rng {
  private state: bigint;

  constructor(seed: Seed) {
    this.state =
      ((BigInt(seed.hi >>> 0) << 32n) | BigInt(seed.lo >>> 0)) & MASK;
  }

  nextU64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  // Inclusive integer in [min, max].
  int(min: number, max: number): number {
    if (max < min) throw new Error(`invalid range [${min}, ${max}]`);
    const span = BigInt(max - min + 1);
    return min + Number(this.nextU64() % span);
  }
}

// Any string is a valid seed; this is what makes seeds serializable.
export function seedFromString(s: string): Seed {
  const hex = hashValue(s);
  return {
    hi: parseInt(hex.slice(0, 8), 16),
    lo: parseInt(hex.slice(8, 16), 16),
  };
}

export function seedToString(seed: Seed): string {
  return (
    (seed.hi >>> 0).toString(16).padStart(8, "0") +
    (seed.lo >>> 0).toString(16).padStart(8, "0")
  );
}

// Derive the per-run stream for run `index` under master seed `master`.
export function deriveSeed(master: string, index: number): Seed {
  return seedFromString(`${master}#${index}`);
}

export function randomSeedString(): string {
  const hi = Math.floor(Math.random() * 0xffffffff);
  const lo = Math.floor(Math.random() * 0xffffffff);
  return seedToString({ hi, lo });
}
