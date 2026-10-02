// Deterministic PRNG (mulberry32). No wall-clock or nondeterministic entropy
// sources anywhere in this repo (enforced by test/prng.test.js).
// Same 32-bit seed always yields the same uint32 stream, on every platform.

export function createPrng(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be a uint32 integer, got ${seed}`);
  }
  let state = seed >>> 0;
  return {
    nextUint32() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    },
  };
}
