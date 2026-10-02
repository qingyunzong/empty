'use strict';

function gcdBigInt(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

class Rational {
  constructor(num, den = 1n) {
    if (typeof num !== 'bigint' || typeof den !== 'bigint') {
      throw new TypeError('Rational expects BigInt numerator/denominator');
    }
    if (den === 0n) throw new Error('rational with zero denominator');
    if (den < 0n) { num = -num; den = -den; }
    const g = gcdBigInt(num, den);
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  static zero() { return new Rational(0n); }
  static one() { return new Rational(1n); }

  static from(value) {
    if (value instanceof Rational) return value;
    if (typeof value === 'bigint') return new Rational(value);
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        throw new Error(`non-integer number ${value} is not exactly representable; use a string`);
      }
      return new Rational(BigInt(value));
    }
    if (typeof value === 'string') {
      const s = value.trim();
      let m = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(s);
      if (m) return new Rational(BigInt(m[1]), BigInt(m[2]));
      m = /^([+-]?\d+)$/.exec(s);
      if (m) return new Rational(BigInt(m[1]));
      m = /^([+-]?)(\d*)\.(\d+)$/.exec(s);
      if (m) {
        const sign = m[1] === '-' ? -1n : 1n;
        const intPart = m[2] === '' ? 0n : BigInt(m[2]);
        const frac = BigInt(m[3]);
        const scale = 10n ** BigInt(m[3].length);
        return new Rational(sign * (intPart * scale + frac), scale);
      }
      throw new Error(`cannot parse rational: ${JSON.stringify(value)}`);
    }
    throw new Error(`cannot convert to rational: ${String(value)}`);
  }

  isZero() { return this.num === 0n; }
  sign() { return this.num > 0n ? 1 : this.num < 0n ? -1 : 0; }
  neg() { return new Rational(-this.num, this.den); }
  abs() { return this.num < 0n ? new Rational(-this.num, this.den) : this; }

  add(o) { o = Rational.from(o); return new Rational(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { o = Rational.from(o); return new Rational(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o) { o = Rational.from(o); return new Rational(this.num * o.num, this.den * o.den); }
  div(o) {
    o = Rational.from(o);
    if (o.isZero()) throw new Error('division by zero rational');
    return new Rational(this.num * o.den, this.den * o.num);
  }

  cmp(o) {
    o = Rational.from(o);
    const l = this.num * o.den;
    const r = o.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o) { return this.cmp(o) === 0; }
  lt(o) { return this.cmp(o) < 0; }
  gt(o) { return this.cmp(o) > 0; }

  floor() {
    let q = this.num / this.den;
    if (this.num % this.den !== 0n && this.num < 0n) q -= 1n;
    return q;
  }

  pow(n) {
    let result = Rational.one();
    for (let i = 0; i < n; i++) result = result.mul(this);
    return result;
  }

  toString() {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
  toJSON() { return this.toString(); }
}

module.exports = { Rational, gcdBigInt };
