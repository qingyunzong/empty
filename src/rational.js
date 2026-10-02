'use strict';

const { E_RATIONAL } = require('./errors');

function absBig(a) {
  return a < 0n ? -a : a;
}

function gcdBig(a, b) {
  a = absBig(a);
  b = absBig(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function lcmBig(a, b) {
  if (a === 0n || b === 0n) return 0n;
  return absBig(a / gcdBig(a, b) * b);
}

// Floor division for BigInt, b must be > 0.
function floorDiv(a, b) {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

class Rational {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) {
      throw E_RATIONAL('denominator must not be zero');
    }
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcdBig(num, den);
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  static zero() {
    return new Rational(0n);
  }

  static one() {
    return new Rational(1n);
  }

  // Parses "p/q", integer, or decimal string (e.g. "0.005", "-3/4").
  static parse(text) {
    const s = String(text).trim();
    if (/^[+-]?\d+\/\d+$/.test(s)) {
      const [p, q] = s.split('/');
      return new Rational(BigInt(p), BigInt(q));
    }
    if (/^[+-]?\d+$/.test(s)) {
      return new Rational(BigInt(s));
    }
    const m = s.match(/^([+-]?)(\d*)\.(\d+)$/);
    if (m) {
      const sign = m[1] === '-' ? -1n : 1n;
      const intPart = m[2] === '' ? 0n : BigInt(m[2]);
      const frac = m[3];
      const scale = 10n ** BigInt(frac.length);
      return new Rational(sign * (intPart * scale + BigInt(frac)), scale);
    }
    throw E_RATIONAL(`cannot parse rational: ${text}`);
  }

  static from(value) {
    if (value instanceof Rational) return value;
    if (typeof value === 'bigint' || typeof value === 'number') return new Rational(BigInt(value));
    if (typeof value === 'string') return Rational.parse(value);
    throw E_RATIONAL(`cannot convert to rational: ${value}`);
  }

  add(other) {
    other = Rational.from(other);
    return new Rational(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  sub(other) {
    other = Rational.from(other);
    return new Rational(this.num * other.den - other.num * this.den, this.den * other.den);
  }

  mul(other) {
    other = Rational.from(other);
    return new Rational(this.num * other.num, this.den * other.den);
  }

  div(other) {
    other = Rational.from(other);
    if (other.num === 0n) {
      throw E_RATIONAL('division by zero rational');
    }
    return new Rational(this.num * other.den, this.den * other.num);
  }

  neg() {
    return new Rational(-this.num, this.den);
  }

  abs() {
    return this.num < 0n ? this.neg() : this;
  }

  sign() {
    return this.num < 0n ? -1 : this.num > 0n ? 1 : 0;
  }

  cmp(other) {
    other = Rational.from(other);
    const d = this.num * other.den - other.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }

  equals(other) {
    other = Rational.from(other);
    return this.num === other.num && this.den === other.den;
  }

  isInteger() {
    return this.den === 1n;
  }

  toString() {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

// Round half up (ties toward +infinity) to the nearest integer; returns BigInt.
function roundHalfUpToInteger(r) {
  return floorDiv(2n * r.num + r.den, 2n * r.den);
}

module.exports = { Rational, gcdBig, lcmBig, absBig, floorDiv, roundHalfUpToInteger };
