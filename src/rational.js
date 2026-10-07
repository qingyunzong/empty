'use strict';

function bgcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

class Rat {
  constructor(num, den = 1n) {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new Error('rational with zero denominator');
    if (d < 0n) { n = -n; d = -d; }
    const g = bgcd(n, d);
    this.n = n / g;
    this.d = d / g;
    Object.freeze(this);
  }

  static of(n, d = 1n) { return new Rat(n, d); }
  static zero() { return new Rat(0n); }
  static one() { return new Rat(1n); }

  isZero() { return this.n === 0n; }
  sign() { return this.n > 0n ? 1 : this.n < 0n ? -1 : 0; }
  neg() { return new Rat(-this.n, this.d); }
  inv() {
    if (this.n === 0n) throw new Error('inverse of zero');
    return new Rat(this.d, this.n);
  }
  add(o) { return new Rat(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return this.add(o.neg()); }
  mul(o) { return new Rat(this.n * o.n, this.d * o.d); }
  div(o) { return this.mul(o.inv()); }
  cmp(o) {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  equals(o) { return this.n === o.n && this.d === o.d; }
  toString() { return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`; }
}

function parseRat(value) {
  if (value instanceof Rat) return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`non-integer number not allowed: ${value}`);
    return new Rat(BigInt(value));
  }
  if (typeof value === 'bigint') return new Rat(value);
  if (typeof value === 'string') {
    const m = /^(-?\d+)(?:\/(\d+))?$/.exec(value.trim());
    if (!m) throw new Error(`bad rational string: ${value}`);
    return new Rat(BigInt(m[1]), m[2] ? BigInt(m[2]) : 1n);
  }
  if (Array.isArray(value) && value.length === 2) {
    return new Rat(BigInt(value[0]), BigInt(value[1]));
  }
  if (value && typeof value === 'object' && 'num' in value) {
    return new Rat(BigInt(value.num), BigInt(value.den === undefined ? 1 : value.den));
  }
  throw new Error(`cannot parse rational: ${JSON.stringify(value)}`);
}

module.exports = { Rat, parseRat };
