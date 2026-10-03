import { lexError } from './errors.js';

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) { const t = a % b; a = b; b = t; }
  return a === 0n ? 1n : a;
}

export class Rational {
  constructor(num, den = 1n) {
    if (den === 0n) throw new Error('division by zero');
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(num, den);
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  static zero() { return new Rational(0n); }

  static fromDecimal(str, type = 'money') {
    if (typeof str === 'number') {
      if (!Number.isFinite(str)) throw lexError(`invalid numeric literal: ${str}`);
      str = String(str);
    }
    if (typeof str !== 'string' || !/^-?\d+(\.\d+)?$/.test(str)) {
      throw lexError(`invalid decimal literal: ${JSON.stringify(str)}`);
    }
    const neg = str.startsWith('-');
    const body = neg ? str.slice(1) : str;
    const [intPart, fracPart = ''] = body.split('.');
    const maxScale = { money: 4, units: 2, bps: 0 }[type] ?? 4;
    if (fracPart.length > maxScale) {
      throw lexError(`literal ${str} exceeds precision limit for ${type} (max ${maxScale} decimal places)`);
    }
    const den = 10n ** BigInt(fracPart.length);
    let num = BigInt(intPart + (fracPart || ''));
    if (neg) num = -num;
    return new Rational(num, den);
  }

  add(o) { return new Rational(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { return new Rational(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o) { return new Rational(this.num * o.num, this.den * o.den); }
  div(o) {
    if (o.num === 0n) throw new Error('division by zero');
    return new Rational(this.num * o.den, this.den * o.num);
  }
  neg() { return new Rational(-this.num, this.den); }
  abs() { return this.num < 0n ? this.neg() : this; }
  cmp(o) {
    const d = this.num * o.den - o.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  isZero() { return this.num === 0n; }
  isInteger() { return this.den === 1n; }

  toDecimal(maxScale = 10) {
    if (this.den === 1n) return this.num.toString();
    const factor = 10n ** BigInt(maxScale);
    const scaled = this.num * factor;
    if (scaled % this.den !== 0n) {
      throw new Error(`value ${this.num}/${this.den} is not representable with ${maxScale} decimals`);
    }
    const q = scaled / this.den;
    const neg = q < 0n;
    const abs = neg ? -q : q;
    const s = abs.toString().padStart(maxScale + 1, '0');
    const intPart = s.slice(0, s.length - maxScale);
    let fracPart = s.slice(s.length - maxScale).replace(/0+$/, '');
    return (neg ? '-' : '') + intPart + (fracPart ? '.' + fracPart : '');
  }

  toDecimalFixed(scale) {
    const factor = 10n ** BigInt(scale);
    const scaled = this.num * factor;
    if (scaled % this.den !== 0n) {
      throw new Error(`value ${this.num}/${this.den} is not representable with exactly ${scale} decimals`);
    }
    const q = scaled / this.den;
    const neg = q < 0n;
    const abs = neg ? -q : q;
    const s = abs.toString().padStart(scale + 1, '0');
    const intPart = s.slice(0, s.length - scale) || '0';
    const fracPart = s.slice(s.length - scale);
    return (neg ? '-' : '') + intPart + (scale > 0 ? '.' + fracPart : '');
  }

  toString() { return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`; }
}
