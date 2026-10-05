/**
 * Premultiplied RGBA pixels stored as integer numerators over a fixed
 * integer denominator (default 255). A channel value of `n` represents the
 * exact fraction n / denom. Premultiplied invariant: 0 <= c <= a <= denom
 * for every color channel c.
 */

export const DEFAULT_DENOM = 255;

export interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const TRANSPARENT: Pixel = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Divide `num` by `den` rounding to the nearest integer, ties to even
 * ("round half to even" / banker's rounding). Pure integer arithmetic;
 * `num` and `den` must be non-negative safe integers, `den` > 0.
 */
export function divRoundHalfEven(num: number, den: number): number {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    throw new RangeError("divRoundHalfEven requires safe integers");
  }
  if (den <= 0 || num < 0) {
    throw new RangeError("divRoundHalfEven requires num >= 0 and den > 0");
  }
  const rem = num % den;
  const quot = (num - rem) / den;
  const twice = 2 * rem;
  if (twice > den) return quot + 1;
  if (twice === den && quot % 2 === 1) return quot + 1;
  return quot;
}

/** Throws if the pixel violates range or the premultiplied invariant. */
export function assertValidPixel(px: Pixel, denom: number, where = "pixel"): void {
  for (const ch of [px.r, px.g, px.b, px.a]) {
    if (!Number.isSafeInteger(ch) || ch < 0 || ch > denom) {
      throw new RangeError(`${where}: channel ${ch} outside [0, ${denom}]`);
    }
  }
  if (px.r > px.a || px.g > px.a || px.b > px.a) {
    throw new RangeError(`${where}: color channel exceeds alpha (not premultiplied)`);
  }
  if (px.a === 0 && (px.r !== 0 || px.g !== 0 || px.b !== 0)) {
    throw new RangeError(`${where}: transparent pixel retains residual color`);
  }
}

/**
 * Canonicalize a pixel: fully transparent pixels must not retain residual
 * color, so their color channels are zeroed. Returns the canonical pixel
 * (a new object; the input is not mutated).
 */
export function canonicalize(px: Pixel): Pixel {
  if (px.a === 0 && (px.r !== 0 || px.g !== 0 || px.b !== 0)) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  return { r: px.r, g: px.g, b: px.b, a: px.a };
}

/**
 * Source-over compositing for premultiplied pixels:
 *   outA = srcA + dstA * (1 - srcA)
 *   outC = srcC + dstC * (1 - srcA)   for C in {R, G, B}
 * evaluated with integer numerators: the product dst * (denom - srcA) is
 * divided by `denom` with round-half-to-even, applied per blend step (i.e.
 * per layer). The result is canonicalized so transparent output carries no
 * residual color.
 */
export function blendPixel(src: Pixel, dst: Pixel, denom: number): Pixel {
  const inv = denom - src.a;
  const a = src.a + divRoundHalfEven(dst.a * inv, denom);
  if (a === 0) {
    // Both inputs were fully transparent; keep the pixel clean.
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const r = src.r + divRoundHalfEven(dst.r * inv, denom);
  const g = src.g + divRoundHalfEven(dst.g * inv, denom);
  const b = src.b + divRoundHalfEven(dst.b * inv, denom);
  return { r, g, b, a };
}
