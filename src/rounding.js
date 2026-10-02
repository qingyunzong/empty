import { Frac } from './fraction.js';

export function bankersRound(frac, scale = 2) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new RangeError('scale must be an integer in [0, 18]');
  }
  const factor = 10n ** BigInt(scale);
  const scaled = frac.num * factor;
  const den = frac.den;
  let q = scaled / den;
  const r = scaled % den;
  const twice = (r < 0n ? -r : r) * 2n;
  const away = scaled >= 0n ? 1n : -1n;
  if (twice > den) {
    q += away;
  } else if (twice === den && q % 2n !== 0n) {
    q += away;
  }
  const rounded = new Frac(q, factor);
  const error = rounded.sub(frac).abs();
  const bound = new Frac(1n, 2n * factor);
  return { rounded, error, bound };
}

export function formatDecimal(frac, scale) {
  const factor = 10n ** BigInt(scale);
  const num = frac.num * factor;
  if (num % frac.den !== 0n) {
    throw new RangeError('fraction is not exactly representable at this scale');
  }
  const q = num / frac.den;
  const neg = q < 0n;
  const digits = (neg ? -q : q).toString().padStart(scale + 1, '0');
  if (scale === 0) return (neg ? '-' : '') + digits;
  const intPart = digits.slice(0, -scale);
  const fracPart = digits.slice(-scale);
  return `${neg ? '-' : ''}${intPart}.${fracPart}`;
}
