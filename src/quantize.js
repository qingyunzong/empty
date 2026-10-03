import { Rat, roundHalfUp, maxRat } from './rational.js';
import { ambiguousError, configError } from './errors.js';
import { Polynomial } from './polynomial.js';

// 10^k as BigInt; k must be a non-negative integer.
export function scaleFor(k) {
  if (!Number.isInteger(k) || k < 0) {
    throw configError(`E_CONFIG: quantization exponent k must be a non-negative integer, got ${k}`);
  }
  return 10n ** BigInt(k);
}

// Quantize one exact rational to a multiple of 10^-k, rounding half up.
export function quantizeValue(value, k) {
  const scale = scaleFor(k);
  const ticks = roundHalfUp(value.mul(new Rat(scale, 1n)));
  return new Rat(ticks, scale);
}

// Compute the oven control instruction for a zone polynomial over [lo, hi].
//
// The exact extrema come from endpoints plus all rational stationary points
// (no floating point). The instruction is accepted only when the whole value
// interval rounds (half up, quantum 10^-k) to a single tick; otherwise it
// throws E_AMBIGUOUS. The error bound is the strict maximum distance from any
// point of the exact value interval to the emitted value:
//   err = max(q - min, max - q)
export function computeInstruction(coeffs, lo, hi, k) {
  scaleFor(k); // validates k first: E_CONFIG before any other work
  const poly = coeffs instanceof Polynomial ? coeffs : new Polynomial(coeffs);
  const { min, max, argMin, argMax } = poly.extremaOnInterval(lo, hi);
  const scale = scaleFor(k);
  const tickLo = roundHalfUp(min.mul(new Rat(scale, 1n)));
  const tickHi = roundHalfUp(max.mul(new Rat(scale, 1n)));
  if (tickLo !== tickHi) {
    throw ambiguousError(
      `E_AMBIGUOUS: value interval [${min}, ${max}] spans quantization ticks ` +
        `${new Rat(tickLo, scale)} and ${new Rat(tickHi, scale)} at k=${k}`
    );
  }
  const quantized = new Rat(tickLo, scale);
  const errorBound = maxRat(quantized.sub(min), max.sub(quantized));
  return {
    interval: { min, max },
    argMin,
    argMax,
    k,
    quantum: new Rat(1n, scale),
    quantized,
    errorBound,
  };
}
