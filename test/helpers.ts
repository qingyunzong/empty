/** Deterministic seeded PRNG (mulberry32) — no external dependencies. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * Random valid premultiplied pixel: alpha first, then color channels
 * bounded by alpha. Occasionally produces a fully transparent pixel.
 */
export function randomPremulPixel(rand: () => number, denom: number): number[] {
  if (rand() < 0.15) return [0, 0, 0, 0];
  const a = randInt(rand, 0, denom);
  if (a === 0) return [0, 0, 0, 0];
  return [randInt(rand, 0, a), randInt(rand, 0, a), randInt(rand, 0, a), a];
}
