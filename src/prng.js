// Deterministic SplitMix64 PRNG with a recordable seed and draw index (seq).
// The platform's non-deterministic random source is never used in this project.

const MASK64 = (1n << 64n) - 1n;
const GAMMA = 0x9e3779b97f4a7c15n;
const MIX1 = 0xbf58476d1ce4e5b9n;
const MIX2 = 0x94d049bb133111ebn;

export class Prng {
  // seed: integer (number or bigint). seq: number of draws already consumed.
  // Because SplitMix64 advances its state by a constant gamma per draw, the
  // state after `seq` draws is seed + seq * gamma (mod 2^64), so any recorded
  // (seed, seq) pair can be resumed in O(1).
  constructor(seed, seq = 0) {
    this.seed = BigInt(seed);
    this.seq = seq;
    this.state = (this.seed + BigInt(seq) * GAMMA) & MASK64;
  }

  static fromState(seed, seq) {
    return new Prng(seed, seq);
  }

  nextU64() {
    this.state = (this.state + GAMMA) & MASK64;
    this.seq += 1;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * MIX1) & MASK64;
    z = ((z ^ (z >> 27n)) * MIX2) & MASK64;
    z = z ^ (z >> 31n);
    return z & MASK64;
  }

  // Float in [0, 1) with 53 bits of precision.
  next() {
    return Number(this.nextU64() >> 11n) / 0x20000000000000;
  }

  // Integer in [0, n).
  int(n) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError(`Prng.int requires a positive integer, got ${n}`);
    }
    return Number(this.nextU64() % BigInt(n));
  }
}
