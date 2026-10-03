import { TraceError } from './errors.js';

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

const RE_INT = /^[+-]?\d+$/;
const RE_FRAC = /^([+-]?\d+)\s*\/\s*(\d+)$/;
const RE_DEC = /^([+-]?)(\d*)\.(\d+)$/;

export class Rational {
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

  static get ZERO() { return new Rational(0n); }
  static get ONE() { return new Rational(1n); }

  static parse(value) {
    if (value instanceof Rational) return value;
    if (typeof value === 'bigint') return new Rational(value, 1n);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TraceError('E_RATIONAL', `not a finite number: ${value}`);
      return Rational.parse(String(value));
    }
    if (typeof value === 'string') {
      const s = value.trim();
      if (RE_INT.test(s)) return new Rational(BigInt(s), 1n);
      const frac = RE_FRAC.exec(s);
      if (frac) {
        const den = BigInt(frac[2]);
        if (den === 0n) throw new TraceError('E_RATIONAL', `zero denominator in "${value}"`);
        return new Rational(BigInt(frac[1]), den);
      }
      const dec = RE_DEC.exec(s);
      if (dec) {
        const sign = dec[1] === '-' ? '-' : '';
        const intPart = dec[2] === '' ? '0' : dec[2];
        const fracPart = dec[3];
        return new Rational(BigInt(sign + intPart + fracPart), 10n ** BigInt(fracPart.length));
      }
      throw new TraceError('E_RATIONAL', `cannot parse rational: "${value}"`);
    }
    throw new TraceError('E_RATIONAL', `cannot parse rational from ${typeof value}`);
  }

  sign() { return this.num > 0n ? 1 : this.num < 0n ? -1 : 0; }
  isZero() { return this.num === 0n; }
  neg() { return new Rational(-this.num, this.den); }
  abs() { return this.num < 0n ? this.neg() : this; }
  add(o) { o = Rational.parse(o); return new Rational(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { return this.add(Rational.parse(o).neg()); }
  mul(o) { o = Rational.parse(o); return new Rational(this.num * o.num, this.den * o.den); }
  div(o) {
    o = Rational.parse(o);
    if (o.isZero()) throw new TraceError('E_RATIONAL', 'division by zero');
    return new Rational(this.num * o.den, this.den * o.num);
  }
  cmp(o) {
    o = Rational.parse(o);
    const l = this.num * o.den;
    const r = o.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  equals(o) { return this.cmp(o) === 0; }
  toString() { return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`; }
  toJSON() { return this.toString(); }
}
