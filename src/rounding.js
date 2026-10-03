import { Rational } from './rational.js';
import { qerror } from './errors.js';

export function assertPrecision(k) {
  if (!Number.isInteger(k) || k < 0 || k > 100) {
    throw qerror('E_CONFIG', `precision must be an integer in [0, 100], got ${k}`);
  }
  return k;
}

// Round-half-away-from-zero to k decimal places, exact via BigInt.
// Returns the scaled integer round(r * 10^k).
export function roundScaled(r, k) {
  r = Rational.from(r);
  const scale = 10n ** BigInt(k);
  const num = r.num * scale;
  const den = r.den;
  let q = num / den;
  const rem = num % den;
  if (rem !== 0n) {
    const absRem = rem < 0n ? -rem : rem;
    if (2n * absRem >= den) {
      q += num >= 0n ? 1n : -1n;
    }
  }
  return q;
}

export function formatScaled(scaled, k) {
  const neg = scaled < 0n;
  const digits = (neg ? -scaled : scaled).toString().padStart(k + 1, '0');
  const intPart = k === 0 ? digits : digits.slice(0, -k);
  const fracPart = k === 0 ? '' : '.' + digits.slice(-k);
  return (neg ? '-' : '') + intPart + fracPart;
}

export function roundToString(r, k) {
  return formatScaled(roundScaled(r, k), k);
}

// Maximum absolute rounding error when rounding to k decimals: 1 / (2 * 10^k).
export function roundingErrorBound(k) {
  return new Rational(1n, 2n * 10n ** BigInt(k));
}
