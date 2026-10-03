import { Rational } from './rational.js';
import { roundError } from './errors.js';

export const ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN', 'DOWN'];

export function roundTo(rational, scale, mode) {
  if (!ROUNDING_MODES.includes(mode)) {
    throw roundError(`unknown rounding mode ${JSON.stringify(mode)}; expected HALF_UP, HALF_EVEN or DOWN`);
  }
  const factor = 10n ** BigInt(scale);
  const num = rational.num * factor;
  const den = rational.den;
  const sign = num < 0n ? -1n : 1n;
  const absNum = num < 0n ? -num : num;
  let q = absNum / den;
  const r = absNum % den;
  if (mode === 'HALF_UP') {
    if (r * 2n >= den) q += 1n;
  } else if (mode === 'HALF_EVEN') {
    const twice = r * 2n;
    if (twice > den || (twice === den && q % 2n !== 0n)) q += 1n;
  }
  const rounded = new Rational(sign * q, factor);
  return { rounded, remainder: rational.sub(rounded) };
}
