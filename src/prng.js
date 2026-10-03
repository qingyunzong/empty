// Deterministic counter-based PRNG.
//
// Every draw is a pure function of (seed, index), so recording the seed and
// the sampling index is enough to replay any sequence of draws. The global
// random source is never used anywhere in this project.

export function mix32(seed, index) {
  let z = (seed + Math.imul((index + 1) >>> 0, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = (z ^ (z >>> 15)) >>> 0;
  z = Math.imul(z, 0x735a2d97);
  z = (z ^ (z >>> 15)) >>> 0;
  return z >>> 0;
}

export class Prng {
  constructor(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new Error(`seed must be a uint32 integer, got ${seed}`);
    }
    this.seed = seed >>> 0;
    this.index = 0;
  }

  nextU32() {
    const value = mix32(this.seed, this.index);
    this.index += 1;
    return value;
  }

  int(bound) {
    if (!Number.isInteger(bound) || bound < 1) {
      throw new Error(`bound must be a positive integer, got ${bound}`);
    }
    return this.nextU32() % bound;
  }

  pick(items) {
    if (items.length === 0) {
      throw new Error('cannot pick from an empty list');
    }
    return items[this.int(items.length)];
  }

  snapshot() {
    return { seed: this.seed, index: this.index };
  }
}
