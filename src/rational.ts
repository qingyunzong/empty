const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x === 0n ? 1n : x;
};

/** Exact rational number backed by bigints, always kept in lowest terms. */
export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(numerator: bigint | number, denominator: bigint | number = 1): Rational {
    let num = BigInt(numerator);
    let den = BigInt(denominator);
    if (den === 0n) {
      throw new RangeError("rational denominator must not be zero");
    }
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    return new Rational(num / g, den / g);
  }

  static zero(): Rational {
    return new Rational(0n, 1n);
  }

  add(other: Rational): Rational {
    return Rational.of(this.num * other.den + other.num * this.den, this.den * other.den);
  }

  sub(other: Rational): Rational {
    return Rational.of(this.num * other.den - other.num * this.den, this.den * other.den);
  }

  mul(other: Rational): Rational {
    return Rational.of(this.num * other.num, this.den * other.den);
  }

  div(other: Rational): Rational {
    if (other.num === 0n) {
      throw new RangeError("division by zero rational");
    }
    return Rational.of(this.num * other.den, this.den * other.num);
  }

  neg(): Rational {
    return new Rational(-this.num, this.den);
  }

  cmp(other: Rational): number {
    const lhs = this.num * other.den;
    const rhs = other.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  equals(other: Rational): boolean {
    return this.num === other.num && this.den === other.den;
  }

  isInteger(): boolean {
    return this.den === 1n;
  }

  toBigInt(): bigint {
    if (this.den !== 1n) {
      throw new RangeError(`rational ${this.toString()} is not an integer`);
    }
    return this.num;
  }

  toString(): string {
    return this.den === 1n ? `${this.num}` : `${this.num}/${this.den}`;
  }
}
