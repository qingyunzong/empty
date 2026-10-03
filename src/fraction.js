import { ZoneError } from './errors.js';

function bgcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) { const r = a % b; a = b; b = r; }
  return a;
}

/** Exact rational number backed by BigInt. Immutable. */
export class Frac {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new ZoneError('E_INPUT', 'zero denominator');
    if (den < 0n) { num = -num; den = -den; }
    const g = bgcd(num, den) || 1n;
    this.n = num / g;
    this.d = den / g;
    Object.freeze(this);
  }

  static of(v) { return v instanceof Frac ? v : new Frac(v); }

  /** Parse from: Frac, bigint, integer number, "p/q" or "p" string, {num, den}. */
  static parse(value) {
    if (value instanceof Frac) return value;
    if (typeof value === 'bigint') return new Frac(value);
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        throw new ZoneError('E_INPUT', `non-integer number not allowed: ${value}`);
      }
      return new Frac(BigInt(value));
    }
    if (typeof value === 'string') {
      const m = /^([+-]?\d+)(?:\/([+-]?\d+))?$/.exec(value.trim());
      if (!m) throw new ZoneError('E_INPUT', `invalid rational: ${value}`);
      return new Frac(BigInt(m[1]), m[2] !== undefined ? BigInt(m[2]) : 1n);
    }
    if (value && typeof value === 'object' && 'num' in value) {
      return new Frac(BigInt(value.num), value.den !== undefined ? BigInt(value.den) : 1n);
    }
    throw new ZoneError('E_INPUT', `cannot parse rational: ${JSON.stringify(value)}`);
  }

  add(o) { o = Frac.of(o); return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { o = Frac.of(o); return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { o = Frac.of(o); return new Frac(this.n * o.n, this.d * o.d); }
  div(o) {
    o = Frac.of(o);
    if (o.n === 0n) throw new ZoneError('E_INPUT', 'division by zero');
    return new Frac(this.n * o.d, this.d * o.n);
  }
  neg() { return new Frac(-this.n, this.d); }
  abs() { return this.n < 0n ? new Frac(-this.n, this.d) : this; }
  cmp(o) { o = Frac.of(o); const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  lt(o) { return this.cmp(o) < 0; }
  le(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  ge(o) { return this.cmp(o) >= 0; }
  eq(o) { return this.cmp(o) === 0; }
  isZero() { return this.n === 0n; }
  sign() { return this.n < 0n ? -1 : this.n > 0n ? 1 : 0; }
  toString() { return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`; }
  toJSON() { return this.toString(); }
}

export const F0 = new Frac(0n);
export const F1 = new Frac(1n);
