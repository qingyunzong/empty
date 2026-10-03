import { SafeZoneError } from './errors.js';

function absBig(v) {
  return v < 0n ? -v : v;
}

function gcdBig(a, b) {
  a = absBig(a);
  b = absBig(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new SafeZoneError('E_PARSE', `non-integer number is not a rational literal: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!/^[+-]?\d+$/.test(s)) {
      throw new SafeZoneError('E_PARSE', `invalid integer literal: ${value}`);
    }
    return BigInt(s);
  }
  throw new SafeZoneError('E_PARSE', `cannot convert to integer: ${String(value)}`);
}

/**
 * Exact rational number backed by BigInt. Always normalized:
 * denominator > 0, gcd(|num|, den) = 1. No floats, no square roots.
 */
export class Fraction {
  constructor(num, den = 1n) {
    let n = toBigInt(num);
    let d = toBigInt(den);
    if (d === 0n) {
      throw new SafeZoneError('E_ARITHMETIC', `zero denominator in fraction ${String(num)}/${String(den)}`);
    }
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcdBig(n, d);
    this.num = n / g;
    this.den = d / g;
    Object.freeze(this);
  }

  static from(value) {
    if (value instanceof Fraction) return value;
    if (Array.isArray(value)) {
      if (value.length !== 2) {
        throw new SafeZoneError('E_PARSE', `rational array must be [num, den], got length ${value.length}`);
      }
      return new Fraction(value[0], value[1]);
    }
    if (typeof value === 'string') {
      const s = value.trim();
      const slash = s.indexOf('/');
      if (slash >= 0) {
        const a = s.slice(0, slash);
        const b = s.slice(slash + 1);
        return new Fraction(a, b);
      }
      return new Fraction(s);
    }
    if (typeof value === 'object' && value !== null) {
      if ('num' in value) {
        return new Fraction(value.num, 'den' in value ? value.den : 1n);
      }
      throw new SafeZoneError('E_PARSE', `invalid rational object: ${JSON.stringify(value)}`);
    }
    return new Fraction(value);
  }

  add(o) {
    o = Fraction.from(o);
    return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o) {
    o = Fraction.from(o);
    return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o) {
    o = Fraction.from(o);
    return new Fraction(this.num * o.num, this.den * o.den);
  }

  div(o) {
    o = Fraction.from(o);
    if (o.num === 0n) {
      throw new SafeZoneError('E_ARITHMETIC', 'division by zero fraction');
    }
    return new Fraction(this.num * o.den, this.den * o.num);
  }

  neg() {
    return new Fraction(-this.num, this.den);
  }

  abs() {
    return this.num < 0n ? this.neg() : this;
  }

  isZero() {
    return this.num === 0n;
  }

  sign() {
    return this.num === 0n ? 0 : this.num < 0n ? -1 : 1;
  }

  cmp(o) {
    o = Fraction.from(o);
    const lhs = this.num * o.den;
    const rhs = o.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  eq(o) { return this.cmp(o) === 0; }
  lt(o) { return this.cmp(o) < 0; }
  le(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  ge(o) { return this.cmp(o) >= 0; }

  static min(a, b) {
    return Fraction.from(a).le(b) ? Fraction.from(a) : Fraction.from(b);
  }

  toString() {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  toJSON() {
    return this.toString();
  }
}

export const ZERO = new Fraction(0n);
export const ONE = new Fraction(1n);
