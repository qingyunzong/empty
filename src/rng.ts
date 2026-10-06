/**
 * Deterministic RNG with a single 64-bit integer state (SplitMix64).
 * The entire state is one integer, so a seed fully determines a stream
 * and streams can be reproduced without any hidden/global state.
 */
export class Rng {
  private state: bigint;

  constructor(seed: number | bigint) {
    this.state = BigInt.asUintN(64, BigInt(seed));
  }

  /** Current integer state (the full state of the generator). */
  getState(): bigint {
    return this.state;
  }

  nextU64(): bigint {
    this.state = BigInt.asUintN(64, this.state + 0x9e3779b97f4a7c15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return BigInt.asUintN(64, z ^ (z >> 31n));
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** Uniform integer in [minInclusive, maxInclusive]. */
  nextInt(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) {
      throw new Error(`invalid range [${minInclusive}, ${maxInclusive}]`);
    }
    const range = BigInt(maxInclusive) - BigInt(minInclusive) + 1n;
    return Number(BigInt(minInclusive) + (this.nextU64() % range));
  }

  nextBool(): boolean {
    return (this.nextU64() & 1n) === 1n;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.nextInt(0, items.length - 1)];
  }
}

/** FNV-1a 64-bit hash of a string, used to derive per-test seeds. */
export function hashString(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

/**
 * Derive a 64-bit seed from any mix of numbers/bigints/strings.
 * Seeds depend only on the inputs — never on call order or call count —
 * which is what makes test results independent of execution order.
 */
export function deriveSeed(...parts: (number | bigint | string)[]): bigint {
  let hash = 0xcbf29ce484222325n;
  const mix = (value: bigint): void => {
    hash ^= BigInt.asUintN(64, value);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    hash ^= hash >> 29n;
  };
  for (const part of parts) {
    mix(typeof part === "string" ? hashString(part) : BigInt(part));
  }
  return hash;
}
