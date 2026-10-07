import { LedgerError } from './errors.js';

const abs = (a) => (a < 0n ? -a : a);

function gcd(a, b) {
  a = abs(a);
  b = abs(b);
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a || 1n;
}

// Exact rational number backed by BigInt, always normalized (den > 0, reduced).
export class Frac {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new LedgerError('E_PARSE', 'denominator is zero');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  // Accepts "num/den", integer, or decimal strings (e.g. "12.34", "-3", "1/3").
  static parse(value) {
    if (value instanceof Frac) return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new LedgerError('E_PARSE', `bad amount: ${value}`);
      value = String(value);
    }
    if (typeof value !== 'string') {
      throw new LedgerError('E_PARSE', `bad amount: ${JSON.stringify(value)}`);
    }
    const s = value.trim();
    let m = /^([+-]?\d+)\/([+-]?\d+)$/.exec(s);
    if (m) return new Frac(BigInt(m[1]), BigInt(m[2]));
    m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s) || /^([+-]?)\.(\d+)$/.exec(s);
    if (m) {
      if (m.length === 4) {
        const den = 10n ** BigInt((m[3] || '').length);
        let num = BigInt(m[2]) * den + BigInt(m[3] || '0');
        if (m[1] === '-') num = -num;
        return new Frac(num, den);
      }
      // ".xyz" form
      const den = 10n ** BigInt(m[2].length);
      let num = BigInt(m[2]);
      if (m[1] === '-') num = -num;
      return new Frac(num, den);
    }
    throw new LedgerError('E_PARSE', `bad amount: ${JSON.stringify(value)}`);
  }

  add(o) {
    return new Frac(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o) {
    return new Frac(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  cmp(o) {
    const d = this.num * o.den - o.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }

  isZero() {
    return this.num === 0n;
  }

  isNeg() {
    return this.num < 0n;
  }

  isPos() {
    return this.num > 0n;
  }

  toString() {
    return `${this.num}/${this.den}`;
  }
}

export const ZERO = new Frac(0n);

// ROUND_HALF_EVEN (banker's rounding) to `scale` fractional units.
// Default scale 100 = cents. Returns an exact Frac with denominator `scale`.
export function roundHalfEven(frac, scale = 100n) {
  const num = frac.num * scale;
  const den = frac.den;
  const sign = num < 0n ? -1n : 1n;
  const a = abs(num);
  let q = a / den;
  const r = a % den;
  const twice = r * 2n;
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  return new Frac(sign * q, scale);
}
