import { Rat, floorDiv } from './rational.js';

// Round to nearest integer, halves go up (toward +infinity):
// roundHalfUp(x) = floor(x + 1/2).
export function roundHalfUp(x) {
  return floorDiv(2n * x.n + x.d, 2n * x.d);
}

// Quantize a rational to a multiple of 10^-k, round half up.
export function quantize(x, k) {
  const scale = 10n ** BigInt(k);
  const steps = roundHalfUp(x.mul(new Rat(scale)));
  return new Rat(steps, scale);
}
