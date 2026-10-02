'use strict';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

function toBigInt(value, what) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new ValidationError(`${what} 必须是整数或有理分数，得到: ${JSON.stringify(value)}`);
}

class Fraction {
  constructor(num, den = 1n) {
    num = toBigInt(num, '分子');
    den = toBigInt(den, '分母');
    if (den === 0n) throw new ValidationError('分母为0');
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(num, den);
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  static parse(value, what = '值') {
    if (value instanceof Fraction) return value;
    if (typeof value === 'string') {
      const m = value.trim().match(/^([+-]?\d+)(?:\/([+-]?\d+))?$/);
      if (m) return new Fraction(BigInt(m[1]), m[2] !== undefined ? BigInt(m[2]) : 1n);
      throw new ValidationError(`${what} 不是合法有理分数: ${JSON.stringify(value)}`);
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return new Fraction(toBigInt(value, what), 1n);
    }
    if (value && typeof value === 'object') {
      const num = value.num !== undefined ? value.num : value.numerator;
      const den = value.den !== undefined ? value.den : value.denominator;
      if (num !== undefined) return new Fraction(toBigInt(num, `${what}.num`), den !== undefined ? toBigInt(den, `${what}.den`) : 1n);
    }
    throw new ValidationError(`${what} 不是合法有理分数: ${JSON.stringify(value)}`);
  }

  static zero() { return new Fraction(0n, 1n); }

  add(o) { o = Fraction.parse(o); return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { o = Fraction.parse(o); return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o) { o = Fraction.parse(o); return new Fraction(this.num * o.num, this.den * o.den); }
  div(o) {
    o = Fraction.parse(o);
    if (o.num === 0n) throw new ValidationError('除以0');
    return new Fraction(this.num * o.den, this.den * o.num);
  }
  neg() { return new Fraction(-this.num, this.den); }

  cmp(o) {
    o = Fraction.parse(o);
    const lhs = this.num * o.den;
    const rhs = o.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }
  eq(o) { return this.cmp(o) === 0; }
  lt(o) { return this.cmp(o) < 0; }
  lte(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  gte(o) { return this.cmp(o) >= 0; }

  sign() { return this.num < 0n ? -1 : this.num > 0n ? 1 : 0; }
  isZero() { return this.num === 0n; }

  static min(a, b) { return a.cmp(b) <= 0 ? a : b; }
  static max(a, b) { return a.cmp(b) >= 0 ? a : b; }

  toString() { return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`; }
  toJSON() { return this.toString(); }
}

module.exports = { Fraction, ValidationError };
