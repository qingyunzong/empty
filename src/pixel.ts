/**
 * Premultiplied RGBA pixels on an integer grid: every channel is a
 * numerator over the shared integer denominator `den` (e.g. 255).
 *
 * Invariants enforced at construction:
 *  - 0 <= r,g,b <= a <= den          (premultiplied)
 *  - a === 0  =>  r === g === b === 0 (transparent pixels keep no colour)
 */
export type Pixel = readonly [number, number, number, number]; // r, g, b, a

export const TRANSPARENT: Pixel = Object.freeze([0, 0, 0, 0]) as Pixel;

function clampChannel(value: number, lo: number, hi: number, name: string): number {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer numerator, got ${value}`);
  }
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** Normalise raw channel numerators into a valid premultiplied pixel. */
export function makePixel(
  den: number,
  r: number,
  g: number,
  b: number,
  a: number,
): Pixel {
  if (!Number.isInteger(den) || den <= 0) {
    throw new RangeError(`denominator must be a positive integer, got ${den}`);
  }
  const alpha = clampChannel(a, 0, den, "alpha");
  if (alpha === 0) return TRANSPARENT;
  return [
    clampChannel(r, 0, alpha, "red"),
    clampChannel(g, 0, alpha, "green"),
    clampChannel(b, 0, alpha, "blue"),
    alpha,
  ];
}

export function isTransparent(px: Pixel): boolean {
  return px[3] === 0;
}
