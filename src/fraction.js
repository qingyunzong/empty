'use strict';

function gcdAbs(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

class Frac {
  constructor(num, den = 1n) {
    if (typeof num !== 'bigint' || typeof den !== 'bigint') {
      throw new TypeError('Frac requires BigInt numerator/denominator');
    }
    if (den === 0n) throw new RangeError('fraction with zero denominator');
    if (den < 0n) { num = -num; den = -den; }
    const g = gcdAbs(num, den);
    this.n = num / g;
    this.d = den / g;
    Object.freeze(this);
  }

  static zero() { return ZERO; }
  static one() { return ONE; }

  static from(value) {
    if (value instanceof Frac) return value;
    if (typeof value === 'bigint') return new Frac(value, 1n);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError(`non-finite number: ${value}`);
      return Frac.parse(String(value));
    }
    if (typeof value === 'string') return Frac.parse(value);
    throw new TypeError(`cannot convert to fraction: ${JSON.stringify(value)}`);
  }

  static parse(text) {
    const s = text.trim();
    const m = /^([+-]?\d+)(?:\/([+-]?\d+))?$/.exec(s);
    if (m) {
      const num = BigInt(m[1]);
      const den = m[2] === undefined ? 1n : BigInt(m[2]);
      return new Frac(num, den);
    }
    const d = /^([+-]?)(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (d && (d[2] !== '' || d[3] !== undefined)) {
      const intPart = d[2] === '' ? '0' : d[2];
      const fracPart = d[3] === undefined ? '' : d[3];
      let num = BigInt(intPart + fracPart);
      let den = 10n ** BigInt(fracPart.length);
      const exp = d[4] === undefined ? 0n : BigInt(d[4]);
      if (exp >= 0n) num *= 10n ** exp;
      else den *= 10n ** (-exp);
      if (d[1] === '-') num = -num;
      return new Frac(num, den);
    }
    throw new SyntaxError(`invalid rational literal: ${JSON.stringify(text)}`);
  }

  add(o) { o = Frac.from(o); return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { o = Frac.from(o); return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { o = Frac.from(o); return new Frac(this.n * o.n, this.d * o.d); }
  div(o) {
    o = Frac.from(o);
    if (o.n === 0n) throw new RangeError('division by zero fraction');
    return new Frac(this.n * o.d, this.d * o.n);
  }
  neg() { return new Frac(-this.n, this.d); }
  abs() { return this.n < 0n ? this.neg() : this; }

  cmp(o) {
    o = Frac.from(o);
    const lhs = this.n * o.d;
    const rhs = o.n * this.d;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }
  eq(o) { return this.cmp(o) === 0; }
  lt(o) { return this.cmp(o) < 0; }
  gt(o) { return this.cmp(o) > 0; }
  isZero() { return this.n === 0n; }
  isPositive() { return this.n > 0n; }
  isNegative() { return this.n < 0n; }

  toString() {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
  }
  toJSON() { return this.toString(); }
}

const ZERO = new Frac(0n, 1n);
const ONE = new Frac(1n, 1n);

function minFrac(a, b) { return a.cmp(b) <= 0 ? a : b; }
function maxFrac(a, b) { return a.cmp(b) >= 0 ? a : b; }

module.exports = { Frac, minFrac, maxFrac };
