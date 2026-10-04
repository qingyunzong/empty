import { roundHalfEven } from "./rounding.js";
import { makePixel, TRANSPARENT, type Pixel } from "./pixel.js";

/**
 * Premultiplied "source over" compositing on the integer grid.
 *
 * For each channel c and alpha a, with src over dst:
 *   out = src + round_half_even(dst * (den - srcA) / den)
 *
 * The rounding is applied here, once per blending step; compositing a
 * stack of layers therefore rounds half-even at every layer boundary.
 */
export function blendOver(den: number, src: Pixel, dst: Pixel): Pixel {
  const sa = src[3];
  if (sa === 0) return dst;
  if (sa === den) return src;
  const da = dst[3];
  if (da === 0) return src;
  const inv = den - sa;
  const a = sa + roundHalfEven(da * inv, den);
  if (a === 0) return TRANSPARENT;
  return makePixel(
    den,
    src[0] + roundHalfEven(dst[0] * inv, den),
    src[1] + roundHalfEven(dst[1] * inv, den),
    src[2] + roundHalfEven(dst[2] * inv, den),
    a,
  );
}

/** Fold a stack of pixels (bottom first) into one, rounding per layer. */
export function blendStack(den: number, bottomToTop: readonly Pixel[]): Pixel {
  let acc: Pixel = TRANSPARENT;
  for (const px of bottomToTop) {
    acc = blendOver(den, px, acc);
  }
  return acc;
}
