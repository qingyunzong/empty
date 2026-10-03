'use strict';

class TraceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TraceError';
    this.code = code;
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

class Fraction {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new TraceError('E_RATIONAL', 'denominator must not be zero');
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(num, den);
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  static zero() { return new Fraction(0n); }
  static one() { return new Fraction(1n); }

  static parse(value) {
    if (value instanceof Fraction) return value;
    if (typeof value === 'bigint') return new Fraction(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TraceError('E_RATIONAL', `invalid number: ${value}`);
      value = String(value);
    }
    if (typeof value !== 'string') {
      throw new TraceError('E_RATIONAL', `cannot parse rational from: ${String(value)}`);
    }
    const s = value.trim();
    let m = /^([+-]?\d+)\/(\d+)$/.exec(s);
    if (m) {
      const den = BigInt(m[2]);
      if (den === 0n) throw new TraceError('E_RATIONAL', `zero denominator in "${s}"`);
      return new Fraction(BigInt(m[1]), den);
    }
    m = /^([+-]?)(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (m && (m[2] !== '' || m[3] !== undefined)) {
      const intPart = m[2] === '' ? '0' : m[2];
      const fracPart = m[3] || '';
      const exp = m[4] ? BigInt(m[4]) : 0n;
      let num = BigInt(intPart + fracPart);
      let den = 10n ** BigInt(fracPart.length);
      if (m[1] === '-') num = -num;
      if (exp >= 0n) num *= 10n ** exp;
      else den *= 10n ** (-exp);
      return new Fraction(num, den);
    }
    throw new TraceError('E_RATIONAL', `invalid rational: "${s}"`);
  }

  add(o) { o = Fraction.parse(o); return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { o = Fraction.parse(o); return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o) { o = Fraction.parse(o); return new Fraction(this.num * o.num, this.den * o.den); }
  div(o) {
    o = Fraction.parse(o);
    if (o.num === 0n) throw new TraceError('E_RATIONAL', 'division by zero');
    return new Fraction(this.num * o.den, this.den * o.num);
  }
  neg() { return new Fraction(-this.num, this.den); }
  abs() { return this.num < 0n ? this.neg() : this; }
  cmp(o) {
    o = Fraction.parse(o);
    const d = this.num * o.den - o.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  eq(o) { return this.cmp(o) === 0; }
  isZero() { return this.num === 0n; }
  sign() { return this.num < 0n ? -1 : this.num > 0n ? 1 : 0; }

  toString() {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  // Round to `decimals` decimal places (half away from zero).
  // Returns { decimal, exact, error, bound } where error = |exact - decimal|
  // and bound = 1/(2*10^decimals), the half-unit rounding bound.
  toDecimal(decimals) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
      throw new TraceError('E_RATIONAL', `invalid decimals: ${decimals}`);
    }
    const scale = 10n ** BigInt(decimals);
    const scaledNum = this.num * scale;
    let q = scaledNum / this.den;
    const r = scaledNum % this.den;
    const absR2 = (r < 0n ? -r : r) * 2n;
    if (absR2 >= this.den) q += this.num < 0n ? -1n : 1n;
    const errNum = scaledNum - q * this.den;
    const error = new Fraction(errNum < 0n ? -errNum : errNum, this.den * scale);
    const bound = new Fraction(1n, 2n * scale);
    const neg = q < 0n;
    const absQ = neg ? -q : q;
    const intPart = absQ / scale;
    const fracPart = (absQ % scale).toString().padStart(decimals, '0');
    const decimal = (neg ? '-' : '') + intPart.toString() + (decimals > 0 ? '.' + fracPart : '');
    return { decimal, exact: this.toString(), error, bound };
  }
}

module.exports = { Fraction, TraceError };
