import { qerror } from './errors.js';

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

const RATIONAL_RE = /^([+-]?\d+)(?:\/(\d+))?$/;
const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d+))?$/;

export class Rational {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) {
      throw qerror('E_RATIONAL', 'rational denominator is zero');
    }
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  static zero() {
    return new Rational(0n);
  }

  static from(value) {
    if (value instanceof Rational) return value;
    if (typeof value === 'bigint') return new Rational(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw qerror('E_RATIONAL', `cannot convert non-finite number ${value} to rational`);
      }
      if (Number.isInteger(value)) return new Rational(BigInt(value));
      return Rational.from(String(value));
    }
    if (typeof value === 'string') {
      const s = value.trim();
      let m = RATIONAL_RE.exec(s);
      if (m) {
        return new Rational(BigInt(m[1]), m[2] !== undefined ? BigInt(m[2]) : 1n);
      }
      m = DECIMAL_RE.exec(s);
      if (m && (m[2] !== '' || m[3] !== undefined)) {
        const sign = m[1] === '-' ? -1n : 1n;
        const intPart = m[2] === '' ? 0n : BigInt(m[2]);
        const fracPart = m[3] === undefined ? '' : m[3];
        const scale = 10n ** BigInt(fracPart.length);
        const fracNum = fracPart === '' ? 0n : BigInt(fracPart);
        return new Rational(sign * (intPart * scale + fracNum), scale);
      }
      throw qerror('E_RATIONAL', `cannot parse rational from ${JSON.stringify(value)}`);
    }
    throw qerror('E_RATIONAL', `cannot convert ${typeof value} to rational`);
  }

  add(o) {
    o = Rational.from(o);
    return new Rational(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o) {
    o = Rational.from(o);
    return new Rational(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o) {
    o = Rational.from(o);
    return new Rational(this.num * o.num, this.den * o.den);
  }

  div(o) {
    o = Rational.from(o);
    if (o.num === 0n) throw qerror('E_RATIONAL', 'division by zero rational');
    return new Rational(this.num * o.den, this.den * o.num);
  }

  neg() {
    return new Rational(-this.num, this.den);
  }

  cmp(o) {
    o = Rational.from(o);
    const d = this.num * o.den - o.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }

  eq(o) { return this.cmp(o) === 0; }
  lt(o) { return this.cmp(o) < 0; }
  le(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  ge(o) { return this.cmp(o) >= 0; }

  isZero() { return this.num === 0n; }
  sign() { return this.num < 0n ? -1 : this.num > 0n ? 1 : 0; }

  toString() {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  toJSON() {
    return this.toString();
  }
}
