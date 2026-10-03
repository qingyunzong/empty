import { Rational } from './rational.js';
import { TraceError } from './errors.js';

// Format an exact rational at a fixed number of decimal places.
// Returns the decimal rendering, the exact fraction, the actual rounding
// error and the guaranteed error bound (half a unit of the last place).
export function formatQuantity(value, decimals = 2) {
  const q = Rational.parse(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
    throw new TraceError('E_RATIONAL', 'decimals must be an integer in [0, 100]');
  }
  const scale = 10n ** BigInt(decimals);
  const scaledNum = q.num * scale;
  const den = q.den;
  let quot = scaledNum / den;
  const rem = scaledNum % den;
  const absRem = rem < 0n ? -rem : rem;
  if (absRem * 2n >= den) quot += scaledNum < 0n ? -1n : 1n;

  const rounded = new Rational(quot, scale);
  const error = rounded.sub(q).abs();
  const errorBound = new Rational(1n, 2n * scale);

  const neg = quot < 0n;
  const digits = (neg ? -quot : quot).toString().padStart(decimals + 1, '0');
  const intPart = decimals > 0 ? digits.slice(0, -decimals) : digits;
  const text = (neg ? '-' : '') + intPart + (decimals > 0 ? '.' + digits.slice(-decimals) : '');

  return {
    value: text,
    exact: q.toString(),
    error: error.toString(),
    errorBound: errorBound.toString(),
    withinBound: error.cmp(errorBound) <= 0,
  };
}
