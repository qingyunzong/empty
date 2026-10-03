const abs = (x) => (x < 0n ? -x : x);

function gcd(a, b) {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a === 0n ? 1n : a;
}

export class Fraction {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new Error('denominator is zero');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.n = num / g;
    this.d = den / g;
    Object.freeze(this);
  }

  static zero() {
    return new Fraction(0n);
  }

  static parse(value) {
    if (value instanceof Fraction) return value;
    if (typeof value === 'bigint') return new Fraction(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`invalid number: ${value}`);
      if (Number.isInteger(value)) return new Fraction(BigInt(value));
      return Fraction.parse(String(value));
    }
    if (typeof value === 'string') {
      const m = value.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?(?:\/(\d+))?$/);
      if (!m) throw new Error(`invalid fraction: ${value}`);
      const sign = m[1] === '-' ? -1n : 1n;
      if (m[4] !== undefined) {
        if (m[3] !== undefined) throw new Error(`invalid fraction: ${value}`);
        return new Fraction(sign * BigInt(m[2]), BigInt(m[4]));
      }
      if (m[3] !== undefined) {
        const scale = 10n ** BigInt(m[3].length);
        return new Fraction(sign * (BigInt(m[2]) * scale + BigInt(m[3])), scale);
      }
      return new Fraction(sign * BigInt(m[2]));
    }
    if (value && typeof value === 'object' && 'num' in value) {
      return new Fraction(BigInt(value.num), BigInt(value.den ?? 1));
    }
    throw new Error(`cannot parse fraction from: ${value}`);
  }

  add(o) {
    o = Fraction.parse(o);
    return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(o) {
    o = Fraction.parse(o);
    return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(o) {
    o = Fraction.parse(o);
    return new Fraction(this.n * o.n, this.d * o.d);
  }

  div(o) {
    o = Fraction.parse(o);
    if (o.n === 0n) throw new Error('division by zero');
    return new Fraction(this.n * o.d, this.d * o.n);
  }

  neg() {
    return new Fraction(-this.n, this.d);
  }

  cmp(o) {
    o = Fraction.parse(o);
    const lhs = this.n * o.d;
    const rhs = o.n * this.d;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  lt(o) { return this.cmp(o) < 0; }
  le(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  ge(o) { return this.cmp(o) >= 0; }
  eq(o) { return this.cmp(o) === 0; }

  isZero() { return this.n === 0n; }
  isPositive() { return this.n > 0n; }
  isNegative() { return this.n < 0n; }

  floor() {
    let q = this.n / this.d;
    if (this.n % this.d !== 0n && this.n < 0n) q -= 1n;
    return q;
  }

  ceil() {
    let q = this.n / this.d;
    if (this.n % this.d !== 0n && this.n > 0n) q += 1n;
    return q;
  }

  toString() {
    return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`;
  }

  toJSON() {
    return this.toString();
  }
}
