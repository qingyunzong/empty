// Exact rational arithmetic on BigInt. All values are kept normalized:
// denominator > 0 and gcd(|num|, den) = 1.

export function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export class Rational {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new Error('E_RATIONAL: zero denominator');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den) || 1n;
    this.num = num / g;
    this.den = den / g;
    Object.freeze(this);
  }

  static of(num, den = 1n) {
    return new Rational(num, den);
  }

  static min(a, b) {
    return a.cmp(b) <= 0 ? a : b;
  }

  static max(a, b) {
    return a.cmp(b) >= 0 ? a : b;
  }

  add(other) {
    return new Rational(
      this.num * other.den + other.num * this.den,
      this.den * other.den,
    );
  }

  sub(other) {
    return new Rational(
      this.num * other.den - other.num * this.den,
      this.den * other.den,
    );
  }

  neg() {
    return new Rational(-this.num, this.den);
  }

  mul(other) {
    return new Rational(this.num * other.num, this.den * other.den);
  }

  div(other) {
    if (other.num === 0n) throw new Error('E_RATIONAL: division by zero');
    return new Rational(this.num * other.den, this.den * other.num);
  }

  cmp(other) {
    const lhs = this.num * other.den;
    const rhs = other.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  sign() {
    return this.num < 0n ? -1 : this.num > 0n ? 1 : 0;
  }

  isZero() {
    return this.num === 0n;
  }

  toString() {
    return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
  }
}

export const ZERO = new Rational(0n);
export const ONE = new Rational(1n);
