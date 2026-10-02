'use strict';

const { Rational, roundHalfUpToInteger } = require('./rational');
const { E_CONFIG, E_AMBIGUOUS } = require('./errors');

// Round half up (ties toward +infinity) to a multiple of 10^-k. Exact.
function quantizeValue(value, k) {
  validateScale(k);
  const scale = 10n ** BigInt(k);
  const rounded = roundHalfUpToInteger(Rational.from(value).mul(new Rational(scale)));
  return new Rational(rounded, scale);
}

function validateScale(k) {
  if (!Number.isInteger(k) || k < 0) {
    throw E_CONFIG(`quantization exponent k must be a non-negative integer, got ${k}`);
  }
}

// Quantize an exact interval [min, max]. Rounding half up is monotone, so the
// whole interval maps to one tick iff both endpoints map to the same tick.
// Returns { value, errorBound } where errorBound is the exact maximum distance
// from any point of the interval to the emitted value.
function quantizeInterval(min, max, k) {
  validateScale(k);
  min = Rational.from(min);
  max = Rational.from(max);
  const qMin = quantizeValue(min, k);
  const qMax = quantizeValue(max, k);
  if (!qMin.equals(qMax)) {
    throw E_AMBIGUOUS(
      `interval [${min}, ${max}] spans ticks ${qMin} and ${qMax} at 10^-${k}`
    );
  }
  const dLo = qMin.sub(min).abs();
  const dHi = qMin.sub(max).abs();
  const errorBound = dLo.cmp(dHi) >= 0 ? dLo : dHi;
  return { value: qMin, errorBound };
}

module.exports = { quantizeValue, quantizeInterval };
